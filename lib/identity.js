// 身份锚定：确定「哪个 openDingtalkId 是我」。
//
// 为什么这件事必须单独做、且必须零硬编码：
//   插件的核心闸门是「只处理我自己发的消息」。而钉钉的 ID 体系里，
//   `userId`（形如 123456789012345678）和 `openDingtalkId`（形如 D8HS…dD）
//   是两个不同的东西 —— 消息事件和成员表里用的是后者。
//   把 userId 当 openDingtalkId 用会静默地永远匹配不上（不报错，只是没反应），
//   所以这里必须实际解析并交叉校验，而不是想当然。
//
// 三级锚定（任何一级拿到都算成功，但会标注可信度）：
//   ① settings.owner.openDingtalkId 手填 → 直接采信（trusted）
//   ② dws profile list 拿 userName/userId → 在某个群里按姓名查到我的 openDingtalkId
//   ③ 在某个群的历史消息里找我发的消息，取 senderId（众数）
//   ② 与 ③ 都能拿到时比较是否一致：一致为 anchored，不一致为 weak（记告警）。

import { runDws } from './dws.js';
import { pickConversationId, pickString, unwrapDwsPayload } from './util.js';

/** 缓存有效期：身份不会变，但登录账号可能切。 */
const TTL_MS = 30 * 60 * 1000;

/**
 * 建立身份解析器。
 *
 * @param {object} options
 * @param {() => object} options.getSettings - 读取当前设置。
 * @param {{info?: Function, warn?: Function}} [options.logger] - 日志。
 * @returns {{ resolve: Function, invalidate: Function, status: Function }}
 */
export function createIdentity({ getSettings, logger = console } = {}) {
  /** @type {{state: string, myOid: string, aliasIds: string[], myName: string, myUserId: string, myCorp: string, at: number, message: string, evidence: object}} */
  let cache = {
    state: 'unknown',
    myOid: '',
    aliasIds: [],
    myName: '',
    myUserId: '',
    myCorp: '',
    at: 0,
    message: '尚未解析',
    evidence: {},
  };

  /** 取当前登录的 profile（组织+账号）。 */
  async function currentProfile(settings) {
    const args = ['profile', 'list', '-f', 'json'];
    const result = await runDws({
      dwsPath: settings.dwsPath,
      args,
      timeoutMs: 30000,
      logger,
    });
    if (!result.ok) {
      // auth status 能给出更明确的「没登录」判断
      return { ok: false, message: result.message };
    }
    const current = result.data?.currentProfile ?? result.data?.primaryProfile ?? '';
    const list = Array.isArray(result.data?.profiles) ? result.data.profiles : [];
    const hit = list.find(item => item?.profile === current) ?? list.find(item => item?.isCurrent === true) ?? list[0];
    if (hit === undefined || hit === null) {
      return { ok: false, message: 'profile list 里没有可用的账号' };
    }
    return {
      ok: true,
      userId: typeof hit.userId === 'string' ? hit.userId : '',
      userName: typeof hit.userName === 'string' ? hit.userName : '',
      corpName: typeof hit.corpName === 'string' ? hit.corpName : '',
      profile: current,
    };
  }

  /**
   * 取一批「可以拿来当身份取样点」的会话。
   *
   * 两级来源（实测得出）：
   *   ① `+recent-conversations` —— 最近 24 小时有新消息的会话，最快；
   *   ② 为空时退回 `+my-groups` —— 我加入的全部群（本机实测 400+ 个）。
   *
   * 为什么必须有②：如果最近 24 小时恰好没人发言（比如深夜、周末），
   * ① 会返回空，身份就永远锚不上，插件静默失效。这个降级是必要的。
   */
  async function sampleConversations(settings) {
    const recent = await runDws({
      dwsPath: settings.dwsPath,
      args: ['chat', '+recent-conversations', '-f', 'json'],
      timeoutMs: Math.min(settings.poll.commandTimeoutMs, 60000),
      logger,
    });

    const fromRecent = [];
    if (recent.ok) {
      // 注意：+recent-conversations 的结果包在 data 里，与 +search-msg 不同
      const payload = unwrapDwsPayload(recent.data);
      const list = Array.isArray(payload.conversations) ? payload.conversations : [];
      for (const item of list) {
        const id = pickConversationId(item);
        if (id.length === 0) continue;
        fromRecent.push({
          id,
          name: pickString(item, 'name'),
          type: pickString(item, 'type'),
        });
      }
    }

    if (fromRecent.length > 0) {
      return { ok: true, items: fromRecent, source: 'recent-conversations', message: '' };
    }

    // 降级：用我加入的全部群当作取样池
    const groups = await runDws({
      dwsPath: settings.dwsPath,
      args: ['chat', '+my-groups', '--page-all', '-f', 'json'],
      timeoutMs: Math.min(settings.poll.commandTimeoutMs, 120000),
      logger,
    });
    if (!groups.ok) {
      return {
        ok: false,
        items: [],
        source: 'none',
        message: `recent-conversations 为空且 my-groups 失败：${groups.message}`,
      };
    }
    const payload = unwrapDwsPayload(groups.data);
    const list = Array.isArray(payload.groups) ? payload.groups : [];
    const items = list
      .map(item => ({
        id: pickConversationId(item),
        name: pickString(item, 'name'),
        type: pickString(item, 'type'),
      }))
      .filter(item => item.id.length > 0);

    return {
      ok: items.length > 0,
      items,
      source: 'my-groups',
      message: items.length > 0 ? '' : 'my-groups 没有返回任何会话',
    };
  }

  /** ② 在群里按姓名找我的 openDingtalkId。 */
  async function oidFromMembers(settings, conversationId, userName) {
    if (userName.length === 0) return { ok: false, message: '当前登录用户名为空，无法按姓名定位' };
    const result = await runDws({
      dwsPath: settings.dwsPath,
      args: ['chat', '+chat-members-list', '--conversation-id', conversationId, '--member-types', 'user', '-f', 'json'],
      timeoutMs: Math.min(settings.poll.commandTimeoutMs, 60000),
      logger,
    });
    if (!result.ok) return { ok: false, message: result.message };
    const users = Array.isArray(result.data?.users) ? result.data.users : [];
    // 注意字段名是小写 t 的 openDingtalkId —— 写成 openDingTalkId 会静默取到 undefined
    const matches = users.filter(u => pickString(u, 'name') === userName && pickString(u, 'openDingtalkId').length > 0);
    if (matches.length === 0) {
      return { ok: false, message: `在会话 ${conversationId.slice(0, 18)}… 的成员表里没有找到「${userName}」` };
    }
    if (matches.length > 1) {
      return { ok: false, message: `会话里有 ${matches.length} 个「${userName}」，无法唯一确定身份` };
    }
    return { ok: true, oid: pickString(matches[0], 'openDingtalkId'), role: pickString(matches[0], 'role') };
  }

  /**
   * ③ 在群历史里找我发的消息，收集所有出现过的 senderId。
   *
   * **返回数组而不是单值**：实测同一账号在不同会话类型下会有不同的
   * openDingtalkId（群聊一个、与自己单聊另一个），它们是同一人的不同作用域表示，
   * 不是冲突。只取一个会漏掉另一类会话里的消息。
   */
  async function oidsFromMessages(settings, conversationId) {
    const result = await runDws({
      dwsPath: settings.dwsPath,
      args: ['chat', '+chat-messages', '--group', conversationId, '--order', 'desc', '--limit', '50', '-f', 'json'],
      timeoutMs: Math.min(settings.poll.commandTimeoutMs, 60000),
      logger,
    });
    if (!result.ok) return { ok: false, message: result.message };
    const messages = Array.isArray(result.data?.messages) ? result.data.messages : [];
    if (messages.length === 0) return { ok: false, message: '该会话最近没有消息' };

    // 统计出现次数（众数优先），但不丢弃其他 ID——它们可能是另一作用域的别名
    const counts = new Map();
    for (const m of messages) {
      const id = pickString(m, 'senderId');
      if (id.length === 0) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (counts.size === 0) return { ok: false, message: '该会话消息里没有可用的 senderId' };

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [best, bestCount] = sorted[0];
    // 只有在「我明显发过言」时才采信主 ID：出现次数 >= 2，或会话里只有一个人说过话
    if (bestCount < 2 && counts.size > 1) {
      return { ok: false, message: '该会话里我发言次数太少，不足以确定身份' };
    }
    return { ok: true, oids: sorted.map(([id]) => id), primary: best, sampleCount: bestCount, total: messages.length };
  }

  async function resolve({ force = false } = {}) {
    if (!force && cache.myOid.length > 0 && Date.now() - cache.at < TTL_MS) return cache;

    const settings = getSettings();
    const evidence = {};

    // ① 手填优先
    const manual = settings.owner?.openDingtalkId ?? '';
    if (manual.length > 0) {
      cache = {
        state: 'anchored',
        myOid: manual,
        // 手填时可另外补别名（有些账号在单聊里 ID 不同）
        aliasIds: Array.isArray(settings.owner?.aliasIds) ? settings.owner.aliasIds.filter(Boolean) : [],
        myName: settings.owner?.userName ?? '',
        myUserId: settings.owner?.userId ?? '',
        myCorp: '',
        at: Date.now(),
        message: '使用设置里手填的 openDingtalkId',
        evidence: { source: 'settings.owner.openDingtalkId' },
      };
      return cache;
    }

    // 拿登录账号信息
    const profile = await currentProfile(settings);
    if (!profile.ok) {
      cache = {
        state: 'unresolvable',
        myOid: '',
        aliasIds: [],
        myName: '',
        myUserId: '',
        myCorp: '',
        at: Date.now(),
        message: `无法读取 dws 登录账号：${profile.message}`,
        evidence,
      };
      return cache;
    }
    evidence.profile = { userId: profile.userId, userName: profile.userName, corpName: profile.corpName };

    // 取几个会话做取样点
    const conversations = await sampleConversations(settings);
    evidence.conversationSource = conversations.source;
    if (!conversations.ok || conversations.items.length === 0) {
      cache = {
        state: 'unresolvable',
        myOid: '',
        aliasIds: [],
        myName: profile.userName,
        myUserId: profile.userId,
        myCorp: profile.corpName,
        at: Date.now(),
        message: `无法取到任何会话作为取样点（${conversations.message || '为空'}），因此无法解析 openDingtalkId`,
        evidence,
      };
      return cache;
    }
    logger.info?.(`dsh-presale: 身份取样来源=${conversations.source}，共 ${conversations.items.length} 个会话`);

    // 最多试 5 个会话，够用就好（每个会话两次调用，不要打太多）
    const candidates = conversations.items.slice(0, 5);
    /** 成员表给出的我的 ID（多群投票）。 */
    const memberOids = new Map();
    /** 消息发送者给出的我的 ID 及其出现次数。 */
    const messageOids = new Map();
    let memberConversation = '';
    let messageConversation = '';
    /** 消息通道的原始结果（含 sampleCount / total），回退判定要用。 */
    let messageSample = null;

    for (const conv of candidates) {
      if (memberOids.size === 0) {
        const got = await oidFromMembers(settings, conv.id, profile.userName);
        if (got.ok) {
          memberOids.set(got.oid, (memberOids.get(got.oid) ?? 0) + 1);
          memberConversation = conv.name || conv.id;
        }
      }
      if (messageOids.size === 0) {
        const got = await oidsFromMessages(settings, conv.id);
        if (got.ok) {
          for (const id of got.oids) messageOids.set(id, (messageOids.get(id) ?? 0) + 1);
          messageConversation = conv.name || conv.id;
          // 留着原始结果：成员表全失败时，只有「整段会话只有一个人说过话」
          // 这种无歧义情形才允许退到消息推断，那需要 sampleCount / total。
          messageSample = got;
        }
      }
      if (memberOids.size > 0 && messageOids.size > 0) break;
    }

    // ── 判定主 ID ──────────────────────────────────────────────
    //
    // **只用成员表**的结果当主 ID，绝不从消息里推断别名。
    //
    // 早期版本会把「消息里出现过的 senderId」一并收成别名，理由是"同一账号
    // 在不同会话类型下 openDingtalkId 不同"。但 `+chat-messages` 返回的是
    // **整个会话的发送者**，不是只有我——1:1 单聊里必然混进对方的 ID。
    // 由此产生两个后果：
    //
    //   ① 「谁出现最多」取决于谁话多。对方话多的那一次，两路前缀对不上，
    //      判定为「身份弱校验」——这就是"老是提示身份弱、要反复重新校验"的来源。
    //      而且它随取样会话变化，所以时好时坏。
    //   ② 更严重：那个假别名会进 `--senders` 搜索（见 discover.senderIdsOf），
    //      于是**别人发的关键词也会触发插件**，直接违反「只认我本人触发」。
    //
    // 别名只可能来自两处：设置里手填（owner.aliasIds），或下面这个无歧义回退。
    const memberList = [...memberOids.keys()];
    const messageList = [...messageOids.keys()];

    let primary = memberList[0] ?? '';
    /** 主 ID 从哪来：members = 成员表（可信）；messages = 降级推断。 */
    let primarySource = primary.length > 0 ? 'members' : 'none';

    // 降级：成员表一个都没查到（例如我的昵称在成员表里带后缀/表情，
    // 与 dws 返回的 userName 对不上）。只有「这段会话从头到尾只有一个人
    // 说过话」时才敢认定那个人是我——此时不存在"分不清是谁"的问题。
    if (primary.length === 0
        && messageSample !== null
        && messageSample.sampleCount === messageSample.total) {
      primary = messageSample.primary;
      primarySource = 'messages';
    }

    // 别名**永远不从消息里推导**。要补别名请手填设置里的 aliasIds 字段。
    const aliasIds = [];

    evidence.members = memberList.length === 0 ? null : { conversation: memberConversation, oids: memberList };
    evidence.messages = messageList.length === 0 ? null : { conversation: messageConversation, oids: messageList };
    evidence.primarySource = primarySource;

    if (primary.length === 0) {
      cache = {
        state: 'unresolvable',
        myOid: '',
        aliasIds: [],
        myName: profile.userName,
        myUserId: profile.userId,
        myCorp: profile.corpName,
        at: Date.now(),
        message: '无法从群成员表里认出我自己的 openDingtalkId（消息里的发送者分不清哪条是我发的，不予采信）；可在 设置 → 公司名与署名 → 「我的 openDingtalkId」填一次，之后不再自动识别',
        evidence,
      };
      return cache;
    }

    // 状态只有两种：
    //   anchored —— 成员表按姓名精确查到（可信）
    //   weak     —— 成员表没查到，只能靠"整段会话只有一个人发言"降级推断
    // 「两路对比」那套逻辑已经删掉：消息里的发送者本来就分不清是谁，
    // 拿它去质疑成员表的结果，只会制造无意义的告警。
    const state = primarySource === 'members' ? 'anchored' : 'weak';
    const message = primarySource === 'members'
      ? `身份已锚定：${primary}（成员表 ${memberConversation}）`
      : `身份弱校验：${primary}（成员表查不到，仅凭「${messageConversation}」里只有一个人发过言推断；建议在设置里手动确认）`;

    if (state === 'weak') logger.warn?.(`dsh-presale: ${message}`);
    else logger.info?.(`dsh-presale: ${message}`);

    cache = {
      state,
      myOid: primary,
      aliasIds,
      myName: profile.userName,
      myUserId: profile.userId,
      myCorp: profile.corpName,
      at: Date.now(),
      message,
      evidence,
    };
    return cache;
  }

  return {
    resolve,
    invalidate() {
      cache = { ...cache, at: 0 };
    },
    status() {
      return { ...cache };
    },
  };
}
