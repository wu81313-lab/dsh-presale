// 发送层：把文本发回原会话，并在需要时 @ 到人。
//
// 实测得到的硬契约（必须严格遵守，否则钉钉侧直接报错）：
//   · @ 必须在**正文里写 `<@openDingtalkId>` 占位符**；
//   · 同时传 `--at-open-dingtalk-ids <openDingtalkId>`；
//   · 两者缺一，CLI 返回 validation 错误：
//     「--at-open-dingtalk-ids 中的成员必须在正文中使用对应 <@openDingTalkId> 占位符；缺少: xxx」
//   所以下面把「占位符拼装」和「参数传递」放在同一个函数里，不允许被拆开调用。

import { runDws } from './dws.js';

/** 钉钉客户端把 `<@oid>` 显示成 @姓名，这个占位符格式是必须的。 */
export function mentionPlaceholder(openDingtalkId) {
  const id = typeof openDingtalkId === 'string' ? openDingtalkId.trim() : '';
  if (id.length === 0) return '';
  return `<@${id}>`;
}

/**
 * 发送前的本地校验（纯函数，可单测，不碰网络）。
 *
 * 抽出来单独测的原因：这三条拒绝规则如果失效，后果分别是
 * 「群里出现一条空白消息」「发错会话」「钉钉报一个看不懂的校验错」——
 * 都属于必须在上线前就锁死的行为。
 *
 * @param {object} input
 * @param {string} input.conversationId - 目标会话。
 * @param {string} input.text - 正文。
 * @param {string[]} [input.mentionIds] - 要 @ 的 openDingtalkId。
 * @returns {{ok: true, text: string, ids: string[]}|{ok: false, error: string}}
 */
export function validateSend({ conversationId, text, mentionIds = [] }) {
  const body = typeof text === 'string' ? text : String(text ?? '');
  if (body.trim().length === 0) {
    return { ok: false, error: '拒绝发送空消息（会发出一条空白消息，比不发更糟）' };
  }
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return { ok: false, error: '缺少目标会话 ID' };
  }
  const ids = (Array.isArray(mentionIds) ? mentionIds : [])
    .filter(id => typeof id === 'string' && id.trim().length > 0)
    .map(id => id.trim());
  const missing = ids.filter(id => !body.includes(mentionPlaceholder(id)));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `正文里缺少 @ 占位符：${missing.join(', ')}。钉钉要求 @ 必须在正文中使用 <@openDingtalkId>。`,
    };
  }
  return { ok: true, text: body, ids };
}

/**
 * 建立发送器。
 *
 * @param {object} options
 * @param {() => object} options.getSettings - 当前设置。
 * @param {{info?: Function, warn?: Function}} [options.logger] - 日志。
 * @returns {{ send: Function }}
 */
export function createSender({ getSettings, logger = console } = {}) {
  /**
   * 发送一条消息到指定会话。
   *
   * @param {object} options
   * @param {string} options.conversationId - 目标会话 ID。
   * @param {string} options.text - 正文（**必须已包含 @ 占位符**，若需要 @ 的话）。
   * @param {string[]} [options.mentionIds] - 要 @ 的 openDingtalkId 列表。
   * @param {boolean} [options.preview] - true 时加 --dry-run 做发送前预检（不发真消息）。
   * @returns {Promise<{ok: boolean, sent: boolean, previewed: boolean, error: string, raw: unknown}>}
   */
  async function send({ conversationId, text, mentionIds = [], preview = false }) {
    const settings = getSettings();

    // 复用与单测同一份校验逻辑，避免测试通过而线上行为不同
    const checked = validateSend({ conversationId, text, mentionIds });
    if (!checked.ok) {
      return { ok: false, sent: false, previewed: false, error: checked.error, raw: null };
    }
    const body = checked.text;
    const ids = checked.ids;

    const args = [
      'chat', '+messages-send',
      '--as', 'user',
      '--group', conversationId,
      '--text', body,
    ];
    if (ids.length > 0) args.push('--at-open-dingtalk-ids', ids.join(','));
    if (preview) args.push('--dry-run');
    else args.push('--yes'); // dws 对写操作要求显式确认
    args.push('-f', 'json');
    if (settings.profile.length > 0) args.push('--profile', settings.profile);

    const result = await runDws({
      dwsPath: settings.dwsPath,
      args,
      timeoutMs: settings.poll.commandTimeoutMs,
      logger,
    });

    if (!result.ok) {
      return { ok: false, sent: false, previewed: preview, error: result.message, raw: null };
    }

    if (preview) {
      return { ok: true, sent: false, previewed: true, error: '', raw: result.data };
    }

    // 真实发送后确认底层确实执行了（dws 的 dry-run 计划里 executed=false）
    const executed = result.data?.executed;
    const failed = result.data?.failedCount ?? 0;
    if (executed === false || failed > 0) {
      return {
        ok: false,
        sent: false,
        previewed: false,
        error: `dws 报告未成功发送（executed=${String(executed)}, failedCount=${String(failed)}）`,
        raw: result.data,
      };
    }
    return { ok: true, sent: true, previewed: false, error: '', raw: result.data };
  }

  return { send };
}
