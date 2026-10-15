// Cordis 插件入口（宿主半边）。
//
// 装配顺序：设置 → 日志 → 身份 → 会话数据 → LLM → 发送 → 动作 → 轮询 → 面板/工具
//
// 两条硬约束：
//   1. **不 import 任何 `@deepseek-ai/*` 包**。插件目录不在 DSH 的解析路径里
//      （实测 `@deepseek-ai/schemastery` 解析不了），import 会让整个插件加载失败。
//      所以配置校验用自己的普通 JS（lib/config.js），宿主调用靠 ctx.get()。
//   2. **apply() 里不抛异常**。抛了会让这行配置整体加载失败，用户连面板都打不开、
//      也就没法改回来。所以每个装配环节都各自 try/catch，失败只降级 + 告警。

import { createSettings } from './settings.js';
import { createActivity } from './activity.js';
import { createIdentity } from './identity.js';
import { createDiscoverer } from './discover.js';
import { createWatermark } from './watermark.js';
import { createAttachments } from './attachments.js';
import { dirname, join } from 'node:path';
import { createConversationData } from './conversation-data.js';
import { createLlm } from './llm.js';
import { createSender } from './send.js';
import { createHandlers } from './handler.js';
import { createPoller } from './poller.js';
import { registerWebApi } from './web.js';
import { registerTools } from './tools.js';
import { checkAuth } from './dws.js';

export const name = 'dsh-presale';

/** 必需服务：tools（注册工具）。webServer / llm 用 ctx.get() 可选获取。 */
export const inject = ['tools'];

/**
 * 插件主体。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 来自 cordis.patch.yml 的配置（仅提供初值）。
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;

  // ── 1. 设置（磁盘为准，config 只播种）─────────────────────
  const settings = createSettings({
    settingsPath: typeof config.settingsPath === 'string' ? config.settingsPath : undefined,
    config,
    logger,
  });
  const initial = settings.get();
  for (const warning of settings.warnings()) logger.warn?.(`dsh-presale: ${warning}`);

  // ── 2. 活动日志 ───────────────────────────────────────────
  const activity = createActivity({
    activityPath: typeof config.activityPath === 'string' ? config.activityPath : initial.activityPath,
    logger,
  });

  // ── 3. 身份锚定 ───────────────────────────────────────────
  const identity = createIdentity({ getSettings: () => settings.get(), logger });

  // ── 4. 会话数据 / 水位 ────────────────────────────────────
  const conversationData = createConversationData({ getSettings: () => settings.get(), logger });
  const watermark = createWatermark({
    watermarkPath: typeof config.watermarkPath === 'string' ? config.watermarkPath : initial.watermarkPath,
    logger,
  });

  // ── 5. LLM（服务可能晚于本插件就绪，所以每次调用都重新取）──
  const llm = createLlm({
    getLlm: () => {
      try {
        const service = ctx.get('llm');
        return service === undefined ? null : service;
      } catch {
        // 未在 inject 里声明 llm 时，属性访问会抛；ctx.get 本身安全，这里再兜一层
        return null;
      }
    },
    getSettings: () => settings.get(),
    logger,
  });

  // ── 6. 附件（下载 + 文本提取 + 图片登记）───────────────────
  //
  // 缓存目录固定放在 DSH 家目录下，而不是 DSH 进程的工作目录——
  // dws 的 --output 只接受相对路径，落点完全由 cwd 决定，
  // 所以必须显式指定，否则文件位置会随启动方式变化。
  //
  // saveImage 取自 DSH 的 attachments 服务：图片要先经它校验与归一化，
  // 再以 `{type:'image', attachment}` 内容块交给模型。拿不到服务时降级为
  // "只登记图片、不交给模型"，而不是假装看过了。
  const attachmentsService = (() => {
    try {
      const service = ctx.get('attachments');
      if (service !== undefined && typeof service.saveImage === 'function') return service;
      logger.warn?.('dsh-presale: DSH 附件服务不可用，图片将只登记不交给模型');
      return null;
    } catch (error) {
      logger.warn?.(`dsh-presale: 获取附件服务失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  })();

  const attachments = createAttachments({
    getSettings: () => settings.get(),
    cacheDir: join(dirname(settings.path), 'attachments'),
    saveImage: attachmentsService === null ? null : input => attachmentsService.saveImage(input),
    logger,
  });

  // ── 7. 发送与发现 ─────────────────────────────────────────
  const sender = createSender({ getSettings: () => settings.get(), logger });
  const discoverer = createDiscoverer({
    getSettings: () => settings.get(),
    getIdentity: () => identity.status(),
    logger,
  });

  // ── 8. 动作层 ─────────────────────────────────────────────
  const handlers = createHandlers({
    getSettings: () => settings.get(),
    getIdentity: () => identity.status(),
    discoverer,
    conversationData,
    llm,
    sender,
    activity,
    attachments,
    logger,
  });

  // ── 8. 轮询器 ─────────────────────────────────────────────
  const poller = createPoller({
    getSettings: () => settings.get(),
    getIdentity: () => identity.status(),
    discoverer,
    watermark,
    handlers,
    activity,
    authCheck: () => checkAuth({
      dwsPath: settings.get().dwsPath,
      logger,
      timeoutMs: Math.min(settings.get().poll.commandTimeoutMs, 30000),
    }),
    logger,
  });

  // 释放：停轮询 + 落盘水位（DSH 退出时不留悬挂状态）
  ctx.effect(() => () => {
    try {
      poller.dispose();
    } catch { /* 已经停了 */ }
  }, 'dsh-presale: poller');

  // 启动：只有设置里 enabled=true 才自动开始，避免刚装上就往群里发消息
  if (initial.enabled === true) {
    void (async () => {
      try {
        const id = await identity.resolve();
        logger.info?.(`dsh-presale: 身份锚定 ${id.state}（${id.myName || '未知'} / ${id.myOid || '未解析'}）`);
      } catch (error) {
        logger.warn?.(`dsh-presale: 身份解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
      poller.start();
      logger.info?.(`dsh-presale: 轮询已启动（间隔 ${settings.get().poll.intervalSeconds}s，dryRun=${String(settings.get().dryRun)}）`);
    })();
  } else {
    logger.info?.('dsh-presale: 已加载但未启动轮询（设置里 enabled=false）。可在「设置 → 售前助手」里开启。');
  }

  // ── 9. 面板 API（挂在 DSH 自己的 Web 服务下，同源回环）────
  //
  // 两个踩过的坑（dsh-local-kb 的经验），这里照搬处理：
  //   1) 只能用 ctx.get('webServer')；直接写 ctx.webServer 在未 inject 时会抛。
  //   2) 不能假设 apply() 执行时 webServer 已就绪——本插件只依赖 tools，
  //      激活可能早于 webserver 行。所以先试一次，拿不到就轮询等待。
  let webRegistered = false;
  const tryRegisterWeb = () => {
    if (webRegistered) return true;
    try {
      const webServer = ctx.get('webServer');
      if (webServer === undefined || typeof webServer.register !== 'function') return false;
      ctx.effect(
        () => registerWebApi(webServer, {
          settings, activity, poller, identity, llm, conversationData, handlers, discoverer, attachments,
        }, { webPath: '/presale-api', logger }),
        'dsh-presale: web api',
      );
      webRegistered = true;
      logger.info?.('dsh-presale: 面板接口已注册（/presale-api）');
      return true;
    } catch (error) {
      logger.warn?.(`dsh-presale: 面板接口注册失败（其余功能不受影响）：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  if (!tryRegisterWeb()) {
    let attempts = 0;
    const wait = setInterval(() => {
      attempts += 1;
      if (tryRegisterWeb() || attempts >= 60) {
        clearInterval(wait);
        if (!webRegistered) {
          logger.warn?.('dsh-presale: 等待 webServer 超时（30 秒），面板接口未注册；轮询与工具仍可用');
        }
      }
    }, 500);
    if (typeof wait.unref === 'function') wait.unref();
    ctx.effect(() => () => clearInterval(wait), 'dsh-presale: web api wait');
  }

  // ── 10. 工具 ──────────────────────────────────────────────
  try {
    // registerTools 返回 disposer 数组，直接交给 ctx.effect 持有
    ctx.effect(
      () => registerTools(ctx, { settings, poller, identity, activity, discoverer, handlers, sender, llm, attachments }),
      'dsh-presale: tools',
    );
  } catch (error) {
    logger.warn?.(`dsh-presale: 工具注册失败：${error instanceof Error ? error.message : String(error)}`);
  }

  logger.info?.(`dsh-presale: 已加载（设置文件 ${settings.path}）`);
}
