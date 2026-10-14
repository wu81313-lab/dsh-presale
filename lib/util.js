// 通用小工具：文本归一化、时间格式化、安全的 JSON、字段取值。
//
// 「文本归一化」是这个插件里最容易被低估的一环：钉钉消息里的关键词可能是
// 全角、夹空格、大小写混排、或被人从别处复制粘贴带上零宽字符。这些情况都要能匹配上，
// 否则用户会觉得「我明明说了它没反应」。

/** 零宽字符与 BOM —— 复制粘贴的常见污染。 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/gu;

/**
 * 把消息正文归一化成便于关键词匹配的形式。
 *
 * 规则：
 *   1. 去掉零宽字符
 *   2. 全角字母/数字/符号 → 半角
 *   3. 所有空白（含全角空格、换行）折叠成单个空格
 *   4. 转小写（中文不受影响）
 *   5. 默认去掉首尾空白（trim=false 时保留，供「前缀」这种对空格敏感的匹配使用）
 * 保守之处：**不**做简繁转换、**不**做同义词替换——那些会让匹配变得不可预测。
 *
 * @param {unknown} text - 原始正文。
 * @param {{trim?: boolean}} [options] - trim=false 时保留首尾空格（默认 true）。
 * @returns {string} 归一化后的文本（可能为空串）。
 */
export function normalizeText(text, { trim = true } = {}) {
  if (typeof text !== 'string') return '';
  const collapsed = text
    .replace(INVISIBLE, '')
    // 全角字符（U+FF01–U+FF5E）→ 半角，含全角空格 U+3000
    .replace(/[\uFF01-\uFF5E]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/gu, ' ')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
  return trim ? collapsed.trim() : collapsed;
}

/**
 * 归一化「用于构造匹配模式」的片段（关键词 / 前缀）。
 *
 * 与 {@link normalizeText} 相同，但**保留首尾空格**。
 * 这一点是必须的：用户在面板里填「DSH 」（带尾随空格）时，意思是
 * 「必须说 DSH 加空格再加关键词」。若这里 trim 掉，前缀就退化成「DSH」，
 * 拼出来的正则会少一个空格，去匹配「dsh 梳理项目需求」必然失配——
 * 表现为「一填前缀就再也不触发」。
 *
 * @param {unknown} text - 片段。
 * @returns {string} 归一化后保留空格的片段。
 */
export function normalizePatternText(text) {
  return normalizeText(text, { trim: false });
}

/** 当地时间格式化：YYYY-MM-DD HH:mm:ss（与 dws 返回的 createTime 同构，便于比较）。 */
export function formatLocalTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 只要日期部分：YYYY-MM-DD。 */
export function formatLocalDate(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 格式化为 RFC3339（带本地时区偏移），如 `2026-10-14T21:54:41+08:00`。
 *
 * 为什么必须用它：`+search-msg` 的 `--start/--end` **只接受 RFC3339**
 * （实测传 "YYYY-MM-DD HH:mm:ss" 会被拒：「--start 必须是RFC3339时间」）。
 * 而 `+chat-messages` 两者都能吃——命令之间不一致，所以统一用最严格的那个格式。
 *
 * @param {Date} [date] - 时间，默认当前。
 * @returns {string} RFC3339 字符串。
 */
export function formatRfc3339(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

/**
 * 解析 dws 返回的时间字符串为毫秒时间戳。
 *
 * dws 的 `createTime` 是「2026-10-14 18:21:43」（本地时间，无时区后缀），
 * 而 `--start/--end` 接受 RFC3339 或同样的本地格式。这里统一转成毫秒便于比较，
 * 解析不了就返回 null（调用方必须显式处理，不要当成 0 而误判"很旧"）。
 *
 * @param {unknown} value - 时间字符串。
 * @returns {number|null} 毫秒时间戳，或 null 表示无法解析。
 */
export function parseTime(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const text = value.trim();
  // 优先按本地时间解析 "YYYY-MM-DD HH:mm:ss"（避免被当成 UTC）
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/u.exec(text);
  if (m !== null) {
    const d = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]),
    );
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const d = new Date(text);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 安全解析 JSON，永不抛异常。
 *
 * @param {string} text - 原始文本。
 * @returns {{ok: true, value: unknown}|{ok: false, error: string}} 解析结果。
 */
export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 从模型输出里抠出第一个 JSON 对象。
 *
 * 模型经常把 JSON 包在 ```json 代码块里、或在前面先写一句"好的，结果如下"。
 * 这里按以下顺序尝试：整体解析 → 去代码块 → 从第一个 `{` 到最后 `}` 切片。
 * **不做**宽松修复（比如补逗号）：那会把「模型没听话」伪装成成功。
 *
 * @param {unknown} text - 模型输出的原文。
 * @returns {{ok: true, value: object}|{ok: false, error: string}} 解析结果。
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return { ok: false, error: '模型输出不是字符串' };
  const raw = text.trim();
  if (raw.length === 0) return { ok: false, error: '模型输出为空' };

  const attempts = [];
  attempts.push(raw);
  const fence = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw);
  if (fence !== null) attempts.push(fence[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(raw.slice(first, last + 1));

  let lastError = '未找到 JSON 对象';
  for (const attempt of attempts) {
    const parsed = safeJsonParse(attempt);
    if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
      return { ok: true, value: parsed.value };
    }
    if (!parsed.ok) lastError = parsed.error;
  }
  return { ok: false, error: lastError };
}

/** 截断文本到指定长度，超长时带明确标记（不要把截断伪装成完整的）。 */
export function truncate(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…（已截断，原文 ${value.length} 字）`;
}

/** 从对象上安全取字符串字段（不同命令返回同义字段名大小写/拼写会有差异）。 */
export function pickString(source, ...keys) {
  if (typeof source !== 'object' || source === null) return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

/** 去重并保持顺序。 */
export function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 拆掉 dws 的不统一信封，拿到真正的业务负载。
 *
 * **实测发现的坑**：不同 dws 命令的返回结构不一致——
 *   · `+search-msg` 是平铺的：根对象直接有 `messages`
 *   · `+recent-conversations` 是包着的：根对象是 `{ok, outcome, data:{conversations}, meta}`
 * 只按一种写，另一种就会静默取到空数组（表现为「身份解析不出来」或「找不到会话」，
 * 而且不报错，极难排查）。所以统一在这里兼容两种。
 *
 * @param {unknown} payload - dws 返回的已解析 JSON。
 * @returns {object} 业务负载对象（取不到时返回空对象，调用方仍需自己判空）。
 */
export function unwrapDwsPayload(payload) {
  if (typeof payload !== 'object' || payload === null) return {};
  const data = payload.data;
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    // 包着的情况：以 data 为准（同时保住 ok/meta 供需要时查）
    return { ...data, ok: payload.ok, outcome: payload.outcome, meta: payload.meta };
  }
  return payload;
}

/**
 * 从会话条目里取稳定的会话 ID。
 *
 * 不同命令给出的键名不同：`+recent-conversations` 用 `conversationId`，
 * `+my-groups` 用 `conversationId`，而其他命令可能给 `openConversationId`。
 *
 * @param {unknown} item - 会话条目。
 * @returns {string} 会话 ID，取不到返回空串。
 */
export function pickConversationId(item) {
  return pickString(item, 'conversationId', 'openConversationId', 'id');
}
