// 文案渲染：模板占位符替换 + 反查命中的关键词。
//
// 独立成模块是为了可单测——这是唯一一段「用户可见输出的拼装逻辑」，
// 它出错的表现是「群里发出去的文案缺东西或带了花括号」，必须锁死。

import { normalizeText } from './util.js';

/**
 * 渲染模板占位符。
 *
 * 关键行为：**未识别的占位符原样保留**并回报给调用方。
 * 不静默替换成空串——那样用户写了错的占位符只会看到文案少一句话，
 * 不知道是自己写错了。
 *
 * 占位符名允许中日韩等 Unicode 字母（`{senderName}` 与 `{销售姓名}` 都认）——
 * 配置界面是中文的，只认 ASCII 会让用户写出「看起来对但不生效」的占位符。
 *
 * @param {unknown} template - 模板文本。
 * @param {Record<string, unknown>} vars - 可用变量。
 * @returns {{text: string, unknown: string[]}} 渲染结果与未识别的占位符名。
 */
export function renderTemplate(template, vars) {
  const unknown = new Set();
  const source = typeof template === 'string' ? template : String(template ?? '');
  const table = typeof vars === 'object' && vars !== null ? vars : {};

  const text = source.replace(/\{([\p{L}_][\p{L}\p{N}_]*)\}/gu, (whole, key) => {
    // 只要这个键在变量表里（哪怕值是 null/undefined），就算「已识别」，
    // 替换为空串；只有变量表里根本没有这个名字，才算未知并原样保留。
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      const value = table[key];
      return value === undefined || value === null ? '' : String(value);
    }
    unknown.add(key);
    return whole;
  });

  return { text, unknown: [...unknown] };
}

/**
 * 从归一化文本里反查命中的是哪个关键词。
 *
 * 用途有两个：填充 `{keyword}` 占位符、在日志里说明「是哪句话触发的」。
 * 按配置顺序返回第一个命中项（配置顺序即优先级）。
 *
 * @param {string} textNorm - normalizeText 处理过的正文。
 * @param {{keywords?: unknown}} triggerCfg - 触发配置。
 * @returns {string} 命中的关键词，未命中返回第一个关键词或空串。
 */
export function extractKeyword(textNorm, triggerCfg) {
  const keywords = Array.isArray(triggerCfg?.keywords) ? triggerCfg.keywords : [];
  const haystack = typeof textNorm === 'string' ? textNorm : '';
  for (const keyword of keywords) {
    if (typeof keyword !== 'string' || keyword.length === 0) continue;
    // 与消息正文、与 compileTrigger 用同一套归一化，避免三处规则不一致
    const needle = normalizeText(keyword);
    if (needle.length > 0 && haystack.includes(needle)) return keyword;
  }
  return typeof keywords[0] === 'string' ? keywords[0] : '';
}
