// 会话数据获取：群成员表（用于 @ 到人）与历史消息（用于判销售 / 梳理需求）。
//
// 一个必须记牢的坑：成员表里的键是 **`openDingtalkId`（小写 t）**。
// 写成 `openDingTalkId` 不会报错，只会永远取到 undefined，然后表现为
// 「@ 不出来人」——很难排查。所以这里用一个函数集中取值，并对两种拼写都做兼容。

import { runDws } from './dws.js';
import { pickString, truncate } from './util.js';

/** 成员表缓存：避免同一会话每轮都拉一次（成员很少变）。 */
const ROSTER_TTL_MS = 30 * 60 * 1000;

/**
 * 建立会话数据访问器。
 *
 * @param {object} options
 * @param {() => object} options.getSettings - 当前设置。
 * @param {{info?: Function, warn?: Function}} [options.logger] - 日志。
 * @returns {{ roster: Function, history: Function, invalidateRoster: Function }}
 */
export function createConversationData({ getSettings, logger = console } = {}) {
  /** @type {Map<string, {at: number, members: object[], error: string}>} */
  const rosterCache = new Map();

  /**
   * 取群成员表。
   *
   * 单聊会拿不到成员表（不是群），此时返回空数组而不是报错——
   * 调用方据此走「单聊不 @」的降级路径。
   *
   * @param {string} conversationId - 会话 ID。
   * @param {{force?: boolean}} [opts] - force 绕过缓存。
   * @returns {Promise<{ok: boolean, members: object[], error: string, fromCache: boolean}>}
   */
  async function roster(conversationId, { force = false } = {}) {
    const cached = rosterCache.get(conversationId);
    if (!force && cached !== undefined && Date.now() - cached.at < ROSTER_TTL_MS) {
      return { ok: cached.error.length === 0, members: cached.members, error: cached.error, fromCache: true };
    }

    const settings = getSettings();
    const result = await runDws({
      dwsPath: settings.dwsPath,
      args: ['chat', '+chat-members-list', '--conversation-id', conversationId, '--member-types', 'user', '-f', 'json'],
      timeoutMs: Math.min(settings.poll.commandTimeoutMs, 60000),
      logger,
    });

    if (!result.ok) {
      // 单聊/非群会话取不到成员是正常情况，不当错误刷日志
      const isNotGroup = /群|group|conversation/i.test(result.message) && /不存在|不支持|invalid/i.test(result.message);
      if (!isNotGroup) logger.warn?.(`dsh-presale: 取成员表失败（${conversationId.slice(0, 18)}…）：${result.message}`);
      rosterCache.set(conversationId, { at: Date.now(), members: [], error: result.message });
      return { ok: false, members: [], error: result.message, fromCache: false };
    }

    const users = Array.isArray(result.data?.users) ? result.data.users : [];
    const members = users.map(user => ({
      name: pickString(user, 'name', 'nick', 'memberNick', 'memberEmpName'),
      // 两种拼写都试：真机返回的是小写 t
      openDingtalkId: pickString(user, 'openDingtalkId', 'openDingTalkId'),
      role: pickString(user, 'role', 'memberRoleDesc'),
    })).filter(m => m.name.length > 0);

    const missingIds = members.filter(m => m.openDingtalkId.length === 0).length;
    if (members.length > 0 && missingIds === members.length) {
      // 全体都没有 ID：说明字段名又变了，必须显式告警（否则表现为"@ 不出来人"且无人知道为什么）
      logger.warn?.('dsh-presale: 成员表里所有成员都没有 openDingtalkId，字段名可能已变更；@ 功能会降级为纯文本提及');
    }

    rosterCache.set(conversationId, { at: Date.now(), members, error: '' });
    return { ok: true, members, error: '', fromCache: false };
  }

  /**
   * 取会话历史消息（时间升序，便于喂给模型）。
   *
   * @param {object} options
   * @param {string} options.conversationId - 会话 ID。
   * @param {number} options.count - 最多取多少条。
   * @returns {Promise<{ok: boolean, messages: object[], complete: boolean, hasMore: boolean, error: string}>}
   */
  async function history({ conversationId, count = 60 }) {
    const settings = getSettings();
    const limit = Math.max(1, Math.min(100, settings.poll.pageLimit));
    const pages = Math.max(1, Math.min(40, Math.ceil(count / limit)));

    const result = await runDws({
      dwsPath: settings.dwsPath,
      args: [
        'chat', '+chat-messages',
        '--group', conversationId,
        '--order', 'desc',
        '--page-all',
        '--page-limit', String(pages),
        '--limit', String(limit),
        '--no-reactions',
        '-f', 'json',
      ],
      timeoutMs: settings.poll.commandTimeoutMs,
      logger,
    });

    if (!result.ok) {
      return { ok: false, messages: [], complete: false, hasMore: false, error: result.message };
    }

    const raw = Array.isArray(result.data?.messages) ? result.data.messages : [];
    const messages = raw
      .map(m => ({
        messageId: pickString(m, 'messageId'),
        sender: pickString(m, 'sender'),
        senderId: pickString(m, 'senderId'),
        createTime: pickString(m, 'createTime', 'time'),
        text: typeof m?.text === 'string' ? m.text : '',
        quotedSender: pickString(m?.quotedMessage ?? {}, 'sender'),
        quotedText: typeof m?.quotedMessage?.text === 'string' ? m.quotedMessage.text : '',
      }))
      .filter(m => m.text.length > 0 || m.quotedText.length > 0);

    // dws 返回的是 desc（新→旧），喂给模型要升序
    messages.reverse();

    // 只保留最近 count 条（去掉最老的）
    const trimmed = messages.length > count ? messages.slice(messages.length - count) : messages;

    const complete = result.data?.complete === true && (result.data?.failedCount ?? 0) === 0;

    return {
      ok: true,
      messages: trimmed,
      complete,
      hasMore: result.data?.hasMore === true,
      // 截断必须显式告知调用方（提示词里要写明），不能把部分当全量
      truncated: messages.length > trimmed.length,
      error: complete ? '' : `历史未读全（complete=${String(result.data?.complete)}, failed=${String(result.data?.failedCount)}）`,
    };
  }

  /** 丢弃某个会话的成员表缓存（成员变动时可用）。 */
  function invalidateRoster(conversationId) {
    if (typeof conversationId === 'string') rosterCache.delete(conversationId);
    else rosterCache.clear();
  }

  return { roster, history, invalidateRoster, rosterCacheSize: () => rosterCache.size };
}

/**
 * 把历史消息渲染成给模型看的多行文本。
 *
 * 我自己的发言会被标注为「（我）」——这是判销售时最重要的排除线索。
 *
 * @param {object[]} messages - history() 返回的消息。
 * @param {{myOid: string}} identity - 当前身份（用于标注哪条是我）。
 * @param {number} [maxChars] - 总字符上限，超出时从最老的一端丢弃。
 * @returns {{text: string, dropped: number}} 渲染结果与被丢弃条数。
 */
export function renderHistoryForModel(messages, identity, maxChars = 12000) {
  const myOid = typeof identity?.myOid === 'string' ? identity.myOid : '';
  const lines = [];
  let dropped = 0;

  for (const m of messages) {
    const who = m.sender.length > 0 ? m.sender : '（未知发送人）';
    const isMe = myOid.length > 0 && m.senderId === myOid;
    const label = isMe ? `${who}（我·非销售）` : who;
    let line = `[${m.createTime}] ${label}: ${truncate(m.text, 400)}`;
    if (m.quotedText.length > 0) {
      line += `\n    └ 引用 ${m.quotedSender || '（未知）'}: ${truncate(m.quotedText, 200)}`;
    }
    lines.push(line);
  }

  // 从最老的开始丢，直到不超过上限
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  let start = 0;
  while (total > maxChars && start < lines.length) {
    total -= lines[start].length + 1;
    start += 1;
    dropped += 1;
  }

  const body = lines.slice(start).join('\n');
  const note = dropped > 0 ? `\n（说明：更早的 ${dropped} 条消息因长度限制未包含）` : '';
  return { text: body + note, dropped };
}
