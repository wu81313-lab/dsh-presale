// 发现层：找出「我本人刚发的、命中关键词的消息」。
//
// 主通道：全局搜索
//   dws chat +search-msg --senders <我的openDingtalkId> --start … --no-enrich --page-all
//   一次调用就能拿到我在所有群/单聊里发过的消息，不需要逐群轮询（444 个群不可能逐群扫）。
//
// 备用通道：最近活跃会话补查
//   dws chat +recent-conversations → 只对「本周期有新消息」的会话补读一次历史。
//   存在的理由是：搜索依赖服务端索引，索引延迟会造成**静默漏报**——
//   表现为「我明明发了它没反应」，这是最难排查的故障，所以用第二条独立路径兜底。
//
// 两条通道的结果按 messageId 合并去重，任何一条命中都算命中。

import { runDws } from './dws.js';
import {
  formatRfc3339,
  normalizeText,
  parseTime,
  pickConversationId,
  pickString,
  truncate,
  unwrapDwsPayload,
} from './util.js';
import { compileTrigger } from './config.js';

/**
 * dws 在「窗口内没有任何结果」时返回的是一段**错误**，而不是空集合：
 *   {"error":{"category":"api","code":1,"message":"下游缺少明确的集合字段，无法判定结果为空"}}
 *
 * 这一条极其重要：空转（最近几分钟我没说话）是这个插件**绝大多数轮次**的正常状态。
 * 若把它当失败处理，就会变成：水位永远推不动 → 每轮重扫同样的窗口 → 间隔退避到上限
 * → 插件事实上瘫掉。所以必须把它识别成「结果为空」。
 */
const EMPTY_RESULT_HINT = /无法判定结果为空|缺少明确的集合字段/u;

/** 判定一个失败的 dws 结果是否其实代表「结果为空」。 */
function isEmptyResult(result) {
  if (result.ok) return false;
  return EMPTY_RESULT_HINT.test(result.message);
}

/** 单条消息归一化：把不同命令返回的同义字段统一成一个形状。 */
function normalizeMessage(raw) {
  const text = typeof raw?.text === 'string'
    ? raw.text
    : typeof raw?.content === 'string'
      ? raw.content
      : '';
  const createTime = typeof raw?.createTime === 'string'
    ? raw.createTime
    : typeof raw?.time === 'string'
      ? raw.time
      : '';
  return {
    messageId: typeof raw?.messageId === 'string' ? raw.messageId : '',
    conversationId: typeof raw?.conversationId === 'string' ? raw.conversationId : '',
    createTime,
    createTimeMs: parseTime(createTime),
    sender: typeof raw?.sender === 'string' ? raw.sender : '',
    senderId: typeof raw?.senderId === 'string' ? raw.senderId : '',
    text,
    textNorm: normalizeText(text),
    aiSendFlag: typeof raw?.messageAiSendFlag === 'string' ? raw.messageAiSendFlag : '',
    quoted: raw?.quotedMessage ?? null,
  };
}

/**
 * 建立发现器。
 *
 * @param {object} options
 * @param {() => object} options.getSettings - 当前设置。
 * @param {() => {myOid: string}} options.getIdentity - 当前身份。
 * @param {{info?: Function, warn?: Function}} [options.logger] - 日志。
 * @returns {{ searchMine: Function, supplementConversations: Function, matchTriggers: Function, conversationNames: Function }}
 */
export function createDiscoverer({ getSettings, getIdentity, logger = console } = {}) {
  /** 会话名缓存：conversationId → {name, type, at}。 */
  const nameCache = new Map();
  const NAME_TTL_MS = 60 * 60 * 1000;

  /**
   * 取「我」的全部稳定 ID。
   *
   * 为什么是复数：实测同一账号在不同会话类型下会有不同的 openDingtalkId
   * （群聊里是一个，与自己单聊里是另一个）。只用一个 ID 会漏掉另一类会话，
   * 表现为「在单聊里发关键词没反应」这种很难查的问题。
   *
   * @param {object} identity - identity.status() 的快照。
   * @returns {string[]} 去重后的 ID 列表（主 ID 在前）。
   */
  function senderIdsOf(identity) {
    const out = [];
    const push = value => {
      if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value);
    };
    push(identity?.myOid);
    if (Array.isArray(identity?.aliasIds)) for (const id of identity.aliasIds) push(id);
    return out;
  }

  /**
   * 主通道：全局搜索我发出的消息。
   *
   * 用 `--senders` 一次带上**所有别名 ID**（group 作用域 + direct 作用域）——
   * 实测同一账号在不同会话类型下会有不同的 openDingtalkId，
   * 只用一个会漏掉另一类会话里的消息。
   *
   * @param {object} options
   * @param {number} options.startMs - 搜索起点（含）。
   * @param {number} [options.endMs] - 搜索终点（不含），默认当前。
   * @returns {Promise<{ok: boolean, messages: object[], complete: boolean, message: string, ms: number}>}
   */
  async function searchMine({ startMs, endMs }) {
    const settings = getSettings();
    const identity = getIdentity();
    const ids = senderIdsOf(identity);
    if (ids.length === 0) {
      return { ok: false, messages: [], complete: false, message: '身份未锚定，无法按发送者搜索', ms: 0 };
    }
    const idSet = new Set(ids);

    const args = [
      'chat', '+search-msg',
      '--senders', ids.join(','),
      // 必须是 RFC3339：+search-msg 只认这个格式（+chat-messages 才接受空格分隔）
      '--start', formatRfc3339(new Date(startMs)),
      '--no-enrich',
      '--page-all',
      '--page-limit', String(Math.max(1, Math.min(40, settings.poll.maxPagesPerCycle))),
      '--limit', String(Math.max(1, Math.min(100, settings.poll.pageLimit))),
      '-f', 'json',
    ];
    if (typeof endMs === 'number' && Number.isFinite(endMs)) {
      args.push('--end', formatRfc3339(new Date(endMs)));
    }
    if (settings.profile.length > 0) args.push('--profile', settings.profile);

    const result = await runDws({
      dwsPath: settings.dwsPath,
      args,
      timeoutMs: settings.poll.commandTimeoutMs,
      logger,
    });
    if (!result.ok) {
      // 「结果为空」不是失败：它是空转时的常态，必须走正常路径（否则水位推不动）
      if (isEmptyResult(result)) {
        return {
          ok: true,
          messages: [],
          complete: true,
          hasMore: false,
          message: '',
          ms: result.ms,
          empty: true,
        };
      }
      return { ok: false, messages: [], complete: false, message: result.message, ms: result.ms, code: result.code };
    }

    const list = Array.isArray(result.data?.messages) ? result.data.messages : [];
    // 只保留确实由我发出的（服务端过滤过一次，这里再核一次，防底层忽略过滤条件）
    const mine = list
      .map(normalizeMessage)
      .filter(m => idSet.has(m.senderId) || m.senderId === '');

    // 完整性：complete=true 且 failedCount=0 才敢说「本窗口没有触发」
    const complete = result.data?.complete === true && (result.data?.failedCount ?? 0) === 0;

    return {
      ok: true,
      messages: mine,
      complete,
      hasMore: result.data?.hasMore === true,
      message: complete ? '' : `搜索未读全（complete=${String(result.data?.complete)}, failed=${String(result.data?.failedCount)}）`,
      ms: result.ms,
    };
  }

  /**
   * 备用通道：挑出「最近有新消息」的会话，逐个小范围补查我在里面说了什么。
   *
   * @param {object} options
   * @param {number} options.maxConversations - 本次最多补查几个会话（控制成本）。
   * @returns {Promise<{ok: boolean, messages: object[], checked: number, message: string}>}
   */
  async function supplementConversations({ maxConversations = 8 } = {}) {
    const settings = getSettings();
    const identity = getIdentity();
    const ids = senderIdsOf(identity);
    if (ids.length === 0) {
      return { ok: false, messages: [], checked: 0, message: '身份未锚定' };
    }
    const idSet = new Set(ids);

    const recent = await runDws({
      dwsPath: settings.dwsPath,
      args: ['chat', '+recent-conversations', '-f', 'json'],
      timeoutMs: Math.min(settings.poll.commandTimeoutMs, 60000),
      logger,
    });
    if (!recent.ok) {
      return { ok: false, messages: [], checked: 0, message: recent.message };
    }

    // 注意信封差异：+recent-conversations 的结果包在 data 里
    const payload = unwrapDwsPayload(recent.data);
    const rawList = Array.isArray(payload.conversations) ? payload.conversations : [];

    const candidates = rawList
      .map(item => ({
        id: pickConversationId(item),
        name: pickString(item, 'name'),
        latest: parseTime(pickString(item, 'latestMessageTime', 'lastMessageTime', 'time')),
      }))
      .filter(item => item.id.length > 0)
      // 只补查受管范围的会话
      .filter(item => inScope(item.id))
      // 有最新消息时间的排前面；没有的排后面
      .sort((a, b) => (b.latest ?? 0) - (a.latest ?? 0))
      .slice(0, maxConversations);

    const found = [];
    let checked = 0;
    for (const conv of candidates) {
      if (conv.name.length > 0) {
        nameCache.set(conv.id, { name: conv.name, type: '', at: Date.now() });
      }
      const result = await runDws({
        dwsPath: settings.dwsPath,
        args: ['chat', '+chat-messages', '--group', conv.id, '--order', 'desc', '--limit', String(Math.max(5, settings.poll.pageLimit)), '-f', 'json'],
        timeoutMs: Math.min(settings.poll.commandTimeoutMs, 60000),
        logger,
      });
      checked += 1;
      if (!result.ok) continue;
      const messages = Array.isArray(result.data?.messages) ? result.data.messages : [];
      for (const raw of messages) {
        const m = normalizeMessage(raw);
        if (m.senderId.length === 0) continue;
        if (!idSet.has(m.senderId)) continue; // 只看我说的（含所有别名）
        found.push(m);
      }
    }

    return { ok: true, messages: found, checked, message: '' };
  }

  /** 会话是否在受管范围内。 */
  function inScope(conversationId) {
    const settings = getSettings();
    const scope = settings.scope ?? {};
    const excluded = Array.isArray(scope.excludeConversationIds) ? scope.excludeConversationIds : [];
    if (excluded.includes(conversationId)) return false;
    return true; // allConversations=true 时其余全收
  }

  /**
   * 把消息列表按两个动作的关键词分类。
   *
   * @param {object[]} messages - 归一化后的消息。
   * @returns {{provide: object[], summarize: object[]}} 按动作分组的命中消息（各按时间升序）。
   */
  function matchTriggers(messages) {
    const settings = getSettings();
    const provideRe = compileTrigger(settings.triggers?.provide);
    const summarizeRe = compileTrigger(settings.triggers?.summarize);
    const out = { provide: [], summarize: [] };

    for (const message of messages) {
      if (message.textNorm.length === 0) continue; // 纯图片/文件：没有正文，不参与匹配
      if (!inScope(message.conversationId)) continue;
      // 两种都命中时只算一个：优先 provide（更具体），避免一次消息发两次
      if (provideRe !== null && provideRe.test(message.textNorm)) {
        out.provide.push(message);
        continue;
      }
      if (summarizeRe !== null && summarizeRe.test(message.textNorm)) {
        out.summarize.push(message);
      }
    }

    const byTime = (a, b) => (a.createTimeMs ?? 0) - (b.createTimeMs ?? 0);
    out.provide.sort(byTime);
    out.summarize.sort(byTime);
    return out;
  }

  /**
   * 用最近活跃会话补全会话名（供面板展示与提示词使用）。
   *
   * @returns {Promise<Map<string, string>>} conversationId → name。
   */
  async function conversationNames() {
    const settings = getSettings();
    const result = await runDws({
      dwsPath: settings.dwsPath,
      args: ['chat', '+recent-conversations', '-f', 'json'],
      timeoutMs: Math.min(settings.poll.commandTimeoutMs, 60000),
      logger,
    });
    if (result.ok) {
      const payload = unwrapDwsPayload(result.data);
      const list = Array.isArray(payload.conversations) ? payload.conversations : [];
      for (const item of list) {
        const id = pickConversationId(item);
        const name = pickString(item, 'name');
        if (id.length > 0 && name.length > 0) {
          nameCache.set(id, { name, type: pickString(item, 'type'), at: Date.now() });
        }
      }
    }
    const out = new Map();
    for (const [id, entry] of nameCache) {
      if (Date.now() - entry.at < NAME_TTL_MS) out.set(id, entry.name);
    }
    return out;
  }

  /** 从缓存里取会话名（没有就返回空串，不要编造）。 */
  function cachedName(conversationId) {
    const entry = nameCache.get(conversationId);
    if (entry === undefined) return '';
    if (Date.now() - entry.at >= NAME_TTL_MS) return '';
    return entry.name;
  }

  return {
    searchMine,
    supplementConversations,
    matchTriggers,
    conversationNames,
    cachedName,
    /** 给面板用的诊断摘要。 */
    describe(message) {
      return `[${message.conversationId.slice(0, 20)}…] ${truncate(message.text, 60)}`;
    },
  };
}
