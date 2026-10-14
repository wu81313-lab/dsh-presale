// 轮询编排：定时发现「我发的触发消息」并执行动作。
//
// 为什么是轮询而不是事件推送（这是本插件最反直觉的一处设计）：
//   dws 确实有长连接事件通道（dws event consume），但官方文档明确写着
//   「当前用户自己发送的消息会被 self-loop 过滤」——也就是说事件流**收不到
//   你自己的消息**。而本插件的触发条件恰恰是「只有我本人发才生效」，
//   所以事件通道在这里根本用不上，只能轮询。
//   轮询还有个附带好处：不需要独占事件订阅锁，也不会残留服务端订阅。
//
// 性能护栏（都实测过）：
//   · 单次全局搜索约 1 秒（进程启动仅占 67ms，其余是 API 往返）；
//   · 间隔下限 15 秒，防止面板上填出「1 秒轮询」把配额打爆；
//   · 连续无命中时自动退避（30s → 60s → 120s …封顶 300s），有命中立刻回落；
//   · 单次调用有超时，且不允许上一轮没结束就发起下一轮（防堆积）。

import { unique } from './util.js';

/** 单次搜索最多回溯多久（防止长时间停机后一次拉回几万条）。 */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** 两次「刷新会话名」之间的最小间隔。 */
const NAME_REFRESH_MS = 5 * 60 * 1000;

/**
 * 建立轮询器。
 *
 * @param {object} options
 * @param {() => object} options.getSettings - 当前设置。
 * @param {() => object} options.getIdentity - 当前身份。
 * @param {object} options.discoverer - 发现器。
 * @param {object} options.watermark - 水位。
 * @param {object} options.handlers - 动作执行器。
 * @param {object} options.activity - 活动日志。
 * @param {object} [options.authCheck] - 可选的登录态检查函数。
 * @param {{info?: Function, warn?: Function}} [options.logger] - 日志。
 * @returns {{ start: Function, stop: Function, tick: Function, status: Function, seedNow: Function }}
 */
export function createPoller({
  getSettings,
  getIdentity,
  discoverer,
  watermark,
  handlers,
  activity,
  authCheck = null,
  logger = console,
}) {
  let timer = null;
  let running = false;
  let busy = false;
  let disposed = false;
  /** 每个 (会话, 动作) 的上次触发时间，用于冷却。 */
  const lastFired = new Map();
  let namesRefreshedAt = 0;
  let consecutiveEmpty = 0;
  let consecutiveFailures = 0;
  /** 连续「搜索未读全」的轮数：用于额外退避，避免高频重扫巨大窗口。 */
  let consecutiveIncomplete = 0;

  const state = {
    startedAt: 0,
    lastTickAt: 0,
    lastSearchAt: 0,
    lastHitAt: 0,
    lastError: '',
    cycles: 0,
    hits: 0,
    currentIntervalSeconds: 0,
    authOk: true,
    authMessage: '',
  };

  /** 可中止的等待。 */
  let wakeup = null;
  function sleep(ms) {
    return new Promise(resolve => {
      timer = setTimeout(() => {
        timer = null;
        wakeup = null;
        resolve();
      }, ms);
      wakeup = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        wakeup = null;
        resolve();
      };
    });
  }

  /** 按冷却配置判断这个 (会话, 动作) 现在能不能触发。 */
  function cooldownOk(conversationId, action, seconds) {
    if (seconds <= 0) return true;
    const key = `${action}|${conversationId}`;
    const last = lastFired.get(key) ?? 0;
    return Date.now() - last >= seconds * 1000;
  }

  function markFired(conversationId, action) {
    lastFired.set(`${action}|${conversationId}`, Date.now());
  }

  /** 本轮实际使用的间隔：基础间隔 + 抖动，无命中时退避。 */
  function nextDelayMs() {
    const settings = getSettings();
    const base = Math.max(15, settings.poll?.intervalSeconds ?? 30);
    const jitterMax = Math.max(0, settings.poll?.jitterSeconds ?? 0);
    const jitter = jitterMax > 0 ? Math.floor(Math.random() * jitterMax) : 0;

    // 连续无命中 → 逐步拉长（每 3 轮无命中翻一倍，封顶 backoffMaxSeconds）
    const idleSteps = Math.floor(consecutiveEmpty / 3);
    // 连续「未读全」也拉长（未读全时水位推不动，越频繁重扫越糟）
    const incompleteSteps = Math.min(consecutiveIncomplete, 4);
    const growth = Math.min(2 ** Math.max(idleSteps, incompleteSteps), 8);
    const cap = Math.max(base, settings.poll?.backoffMaxSeconds ?? 300);
    const effective = Math.min(base * growth, cap);
    state.currentIntervalSeconds = effective + jitter;
    return (effective + jitter) * 1000;
  }

  /** 一个轮询周期。 */
  async function tick() {
    if (disposed || busy) return;
    const settings = getSettings();
    if (settings.enabled !== true) return;

    busy = true;
    state.lastTickAt = Date.now();
    state.cycles += 1;

    try {
      // 登录态：失效时暂停并把原因显示出来，而不是机械重试刷爆配额
      if (authCheck !== null) {
        const auth = await authCheck();
        state.authOk = auth.authenticated === true;
        state.authMessage = auth.message ?? '';
        if (!state.authOk) {
          state.lastError = `dws 未登录或登录已失效：${auth.message}`;
          activity.append({ action: 'system', decision: 'skipped', error: state.lastError });
          return;
        }
      }

      const identity = getIdentity();
      if (typeof identity?.myOid !== 'string' || identity.myOid.length === 0) {
        state.lastError = '身份尚未锚定；请点面板上的「重新识别身份」，或在设置里手填 openDingtalkId';
        return;
      }
      // 身份已经可用：清掉此前那条身份报错。
      // 不做这一步的话它会一直粘在面板上（早退分支不经过下面的清错逻辑），
      // 用户会以为插件还是坏的。
      if (state.lastError.startsWith('身份未锚定') || state.lastError.startsWith('身份尚未锚定')) {
        state.lastError = '';
      }

      // 首启种子：第一次真正轮询时把水位设到"现在"，不重放历史（否则装上插件就会刷屏）
      const snapshot = watermark.snapshot();
      if (snapshot.lastSeenMs === 0) {
        watermark.seed(Date.now());
        watermark.save();
        activity.append({ action: 'system', decision: 'seeded', note: '首次启动，已把水位设为当前时间，历史消息不会被重放' });
        return;
      }

      // 搜索窗口：从水位往前留出重叠（防索引延迟漏消息），但不早于水位本身太多
      const now = Date.now();
      const overlapMs = Math.max(10, settings.poll?.windowOverlapSeconds ?? 120) * 1000;
      const startMs = Math.max(snapshot.lastSeenMs - overlapMs, now - MAX_LOOKBACK_MS);

      const search = await discoverer.searchMine({ startMs, endMs: now });
      state.lastSearchAt = Date.now();
      if (!search.ok) {
        consecutiveFailures += 1;
        state.lastError = search.message;
        activity.append({ action: 'system', decision: 'failed', error: `全局搜索失败：${search.message}` });
        return;
      }
      consecutiveFailures = 0;
      // 搜索成功：先清掉上一轮的搜索类错误。
      // 必须在这里清，因为下面「无命中」分支会提前 return，
      // 而「无命中」正是最常见的状态——不清就会出现错误永远粘在面板上的假象。
      state.lastError = '';

      // 备用通道：搜索未读全时补一次（防索引延迟造成的静默漏报）
      let messages = search.messages;
      if (search.complete !== true) {
        const supplement = await discoverer.supplementConversations({ maxConversations: 8 });
        if (supplement.ok && supplement.messages.length > 0) {
          messages = [...messages, ...supplement.messages];
        }
        state.lastError = search.message;
      } else if (state.lastError.startsWith('搜索未读全')) {
        state.lastError = '';
      }

      // 合并去重
      const seenIds = new Set();
      const candidates = [];
      for (const message of messages) {
        if (message.messageId.length > 0) {
          if (seenIds.has(message.messageId)) continue;
          seenIds.add(message.messageId);
        }
        candidates.push(message);
      }

      // 刷新会话名（低频，供面板与提示词使用）
      if (Date.now() - namesRefreshedAt > NAME_REFRESH_MS) {
        try {
          await discoverer.conversationNames();
          namesRefreshedAt = Date.now();
        } catch {
          /* 会话名拿不到不影响触发，只是提示词里少个名字 */
        }
      }

      const matched = discoverer.matchTriggers(candidates);
      const pending = [...matched.provide, ...matched.summarize].sort(
        (a, b) => (a.createTimeMs ?? 0) - (b.createTimeMs ?? 0),
      );

      // 搜索未读全时，额外拉长间隔作为惩罚。
      // 理由：未读全意味着水位推不动、下一轮要重扫更大的窗口，
      // 这时候还按基础间隔高频重扫只会雪上加霜（进而触发限流）。
      if (search.complete === true) {
        consecutiveIncomplete = 0;
      } else {
        consecutiveIncomplete += 1;
      }

      if (pending.length === 0) {
        consecutiveEmpty += 1;
        // 搜索完整时才推进水位到窗口右界；不完整时保留重叠，下轮重扫
        if (search.complete === true) {
          watermark.setLastSeenMs(now);
          watermark.save();
        }
        return;
      }

      consecutiveEmpty = 0;
      state.lastHitAt = Date.now();
      state.hits += pending.length;

      for (const message of pending) {
        const isProvide = matched.provide.includes(message);
        const action = isProvide ? 'provide' : 'summarize';
        const cooldown = isProvide
          ? (settings.triggers?.provide?.cooldownSeconds ?? 60)
          : (settings.triggers?.summarize?.cooldownSeconds ?? 120);
        const conversationName = discoverer.cachedName(message.conversationId);

        // 冷却期内：记一条 skipped，明确说明原因（否则用户会以为插件挂了）
        if (!cooldownOk(message.conversationId, action, cooldown)) {
          activity.append({
            action,
            decision: 'skipped',
            reason: 'cooldown',
            conversationId: message.conversationId,
            conversationName,
            triggerMessageId: message.messageId,
            triggerText: message.text.slice(0, 200),
            note: `距上次触发不足 ${cooldown} 秒，已跳过`,
          });
          watermark.mark(message);
          continue;
        }

        try {
          if (isProvide) await handlers.runProvide(message, conversationName);
          else await handlers.runSummarize(message, conversationName);
          markFired(message.conversationId, action);
        } catch (error) {
          const detail = error instanceof Error ? error.stack ?? error.message : String(error);
          logger.warn?.(`dsh-presale: 执行 ${action} 失败：${detail}`);
          activity.append({
            action,
            decision: 'failed',
            conversationId: message.conversationId,
            conversationName,
            triggerMessageId: message.messageId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        watermark.mark(message);
      }

      if (search.complete === true) {
        watermark.setLastSeenMs(now);
      }
      watermark.save();
    } catch (error) {
      consecutiveFailures += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      logger.warn?.(`dsh-presale: 轮询周期异常：${error instanceof Error ? error.stack : String(error)}`);
    } finally {
      busy = false;
    }
  }

  /** 启动（幂等）。 */
  function start() {
    if (disposed) return false;
    if (running) return true;
    running = true;
    state.startedAt = Date.now();
    activity.append({ action: 'system', decision: 'started' });

    const loop = async () => {
      while (running && !disposed) {
        await tick();
        if (!running || disposed) break;
        await sleep(nextDelayMs());
      }
    };
    void loop();
    return true;
  }

  /** 停止：中断当前等待，不再发起新周期。 */
  function stop() {
    if (!running) return false;
    running = false;
    if (wakeup !== null) wakeup();
    watermark.save();
    activity.append({ action: 'system', decision: 'stopped' });
    return true;
  }

  /** 立即跑一轮（面板上的「立即检查」）。 */
  async function tickNow() {
    await tick();
    return status();
  }

  /** 把水位重置为「现在」（面板上的「跳过历史」）。 */
  function seedNow() {
    watermark.seed(Date.now());
    watermark.save();
    activity.append({ action: 'system', decision: 'seeded', note: '已手动把水位重置为当前时间' });
    return watermark.snapshot();
  }

  function status() {
    const settings = getSettings();
    const snapshot = watermark.snapshot();
    return {
      running,
      busy,
      enabled: settings.enabled === true,
      dryRun: settings.dryRun === true,
      startedAt: state.startedAt,
      lastTickAt: state.lastTickAt,
      lastSearchAt: state.lastSearchAt,
      lastHitAt: state.lastHitAt,
      cycles: state.cycles,
      hits: state.hits,
      lastError: state.lastError,
      consecutiveEmpty,
      consecutiveFailures,
      consecutiveIncomplete,
      currentIntervalSeconds: state.currentIntervalSeconds,
      authOk: state.authOk,
      authMessage: state.authMessage,
      watermark: {
        lastSeenMs: snapshot.lastSeenMs,
        lastSeenText: snapshot.lastSeenMs > 0 ? new Date(snapshot.lastSeenMs).toLocaleString('zh-CN') : '（未初始化）',
        seenCount: snapshot.seenCount,
      },
    };
  }

  function dispose() {
    disposed = true;
    stop();
  }

  return { start, stop, tick, tickNow, seedNow, status, dispose, isRunning: () => running };
}
