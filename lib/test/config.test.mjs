// 单元测试：只用 node --test 与内置断言，不引入测试框架。
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSettings,
  defaultSettings,
  compileTrigger,
  DEFAULT_TEMPLATE,
} from '../config.js';
import {
  normalizeText,
  parseTime,
  formatLocalDate,
  formatLocalTime,
  safeJsonParse,
  extractJsonObject,
  truncate,
  pickString,
  unique,
} from '../util.js';

// ───────────────────────── config ─────────────────────────

test('config: 空配置得到一份完整可用的默认值', () => {
  const { settings } = normalizeSettings({});
  assert.equal(settings.enabled, false, '默认不自动启动');
  assert.equal(settings.dryRun, true, '默认必须只试运行，不能一装上就真发消息');
  assert.equal(settings.poll.intervalSeconds, 30);
  assert.deepEqual(settings.triggers.provide.keywords, ['提供完整项目需求']);
  assert.deepEqual(settings.triggers.summarize.keywords, ['梳理项目需求']);
  assert.ok(settings.triggers.provide.template.length > 0);
});

test('config: 轮询间隔越界会被回退到安全默认值并告警', () => {
  const tooFast = normalizeSettings({ poll: { intervalSeconds: 1 } });
  assert.equal(tooFast.settings.poll.intervalSeconds, 30, '1 秒轮询会打爆配额，必须回退到默认 30 秒');
  assert.ok(tooFast.warnings.some(w => w.includes('intervalSeconds')), '越界必须有告警，否则用户不知道被改了');

  const tooSlow = normalizeSettings({ poll: { intervalSeconds: 99999 } });
  assert.equal(tooSlow.settings.poll.intervalSeconds, 30, '过大同样回退默认');
  assert.ok(tooSlow.warnings.some(w => w.includes('intervalSeconds')));

  const ok = normalizeSettings({ poll: { intervalSeconds: 15 } });
  assert.equal(ok.settings.poll.intervalSeconds, 15, '15 秒是允许的下界');
  assert.equal(ok.warnings.length, 0, '合法值不应产生告警');
});

test('config: 类型错误回退默认而不抛异常', () => {
  const { settings } = normalizeSettings({
    enabled: 'yes',
    dryRun: 1,
    poll: { intervalSeconds: '很快', jitterSeconds: null },
    triggers: { provide: { keywords: 'not-an-array', cooldownSeconds: 'x' } },
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.dryRun, true);
  assert.equal(settings.poll.intervalSeconds, 30);
  assert.equal(settings.poll.jitterSeconds, 5);
  assert.deepEqual(settings.triggers.provide.keywords, ['提供完整项目需求']);
  assert.equal(settings.triggers.provide.cooldownSeconds, 60);
});

test('config: 未知键被保留（换代不丢用户数据）', () => {
  const { settings } = normalizeSettings({ 未来字段: { a: 1 }, poll: { 未知: true } });
  assert.deepEqual(settings.未来字段, { a: 1 });
  assert.equal(settings.poll.未知, true);
});

test('config: strict 模式下空文案直接拒绝（会发出空白消息）', () => {
  assert.throws(() => {
    normalizeSettings({ triggers: { provide: { template: '   ' } } }, { strict: true });
  }, /不能为空/u);
});

test('config: 非 strict 下空文案回退默认并告警', () => {
  const { settings, warnings } = normalizeSettings({ triggers: { provide: { template: '' } } });
  assert.equal(settings.triggers.provide.template, DEFAULT_TEMPLATE);
  assert.ok(warnings.some(w => w.includes('文案为空')));
});

test('config: 清空关键词会回退内置关键词，并明确告警（避免误以为停用了）', () => {
  const { settings, warnings } = normalizeSettings({
    triggers: { provide: { keywords: [] }, summarize: { keywords: [] } },
  });
  assert.deepEqual(settings.triggers.provide.keywords, ['提供完整项目需求']);
  assert.deepEqual(settings.triggers.summarize.keywords, ['梳理项目需求']);
  assert.ok(warnings.some(w => w.includes('已回退为内置关键词')), '必须告警，否则用户不知道清空没生效');
});

test('config: 置信度取值只接受三档', () => {
  assert.equal(normalizeSettings({ mention: { minConfidence: 'HIGH' } }).settings.mention.minConfidence, 'high');
  assert.equal(normalizeSettings({ mention: { minConfidence: '随便' } }).settings.mention.minConfidence, 'high');
  assert.equal(normalizeSettings({ mention: { minConfidence: 'medium' } }).settings.mention.minConfidence, 'medium');
});

test('config: compileTrigger 生成能匹配归一化文本的正则', () => {
  const re = compileTrigger({ keywords: ['提供完整项目需求'], prefix: '' });
  assert.ok(re !== null);
  assert.ok(re.test(normalizeText('请大家提供完整项目需求，谢谢')));
  assert.ok(re.test(normalizeText('提供完整项目需求')));
  assert.ok(!re.test(normalizeText('提供完整需求')));
});

test('config: compileTrigger 支持前缀，且前缀缺失时不匹配', () => {
  const re = compileTrigger({ keywords: ['梳理项目需求'], prefix: 'DSH ' });
  assert.ok(re !== null);
  assert.ok(re.test(normalizeText('DSH 梳理项目需求')));
  assert.ok(!re.test(normalizeText('梳理项目需求')), '带前缀时裸关键词不应触发');
});

test('config: compileTrigger 对关键词里的正则元字符做转义', () => {
  const re = compileTrigger({ keywords: ['a.b(c)'], prefix: '' });
  assert.ok(re !== null);
  assert.ok(re.test('a.b(c)'));
  assert.ok(!re.test('axb(c)'), '点号必须被转义，不能当通配符');
});

test('config: 关键词为空时 compileTrigger 返回 null', () => {
  assert.equal(compileTrigger({ keywords: [] }), null);
  assert.equal(compileTrigger(undefined), null);
});

// ───────────────────────── util ─────────────────────────

test('util: normalizeText 抹平全角、空白、零宽字符与大小写', () => {
  assert.equal(normalizeText('  提供完整项目需求  '), '提供完整项目需求');
  assert.equal(normalizeText('ＡＢＣ１２３'), 'abc123', '全角字母数字要转半角');
  assert.equal(normalizeText('a\u200Bb'), 'ab', '零宽字符要去掉');
  assert.equal(normalizeText('提供\n完整\t项目  需求'), '提供 完整 项目 需求', '空白折叠为单空格');
  assert.equal(normalizeText('SUMMARY'), 'summary');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(null), '');
});

test('util: parseTime 按本地时间解析 dws 的 createTime', () => {
  const ms = parseTime('2026-10-14 18:21:43');
  assert.ok(ms !== null);
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9); // 10 月
  assert.equal(d.getDate(), 14);
  assert.equal(d.getHours(), 18, '必须按本地时间理解，不能被当成 UTC');
  assert.equal(d.getMinutes(), 21);
});

test('util: parseTime 对无法解析的输入返回 null（不返回 0）', () => {
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('不是时间'), null);
  assert.equal(parseTime(undefined), null);
});

test('util: formatLocalDate / formatLocalTime 形状正确', () => {
  assert.match(formatLocalDate(new Date(2026, 9, 14)), /^2026-10-14$/u);
  assert.match(formatLocalTime(new Date(2026, 9, 14, 18, 21, 43)), /^2026-10-14 18:21:43$/u);
});

test('util: extractJsonObject 能从模型输出里抠出 JSON', () => {
  const plain = extractJsonObject('{"name":"张三","confidence":"high"}');
  assert.equal(plain.ok, true);
  assert.equal(plain.value.name, '张三');

  const fenced = extractJsonObject('好的，结果如下：\n```json\n{"name":"李四","confidence":"low"}\n```\n以上。');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.value.name, '李四');

  const prose = extractJsonObject('我认为是：{"name":"王五","confidence":"medium"} 就这样');
  assert.equal(prose.ok, true);
  assert.equal(prose.value.name, '王五');
});

test('util: extractJsonObject 拒绝自由文本与数组（不把没听话伪装成成功）', () => {
  assert.equal(extractJsonObject('我觉得是张三，他很可能是销售。').ok, false);
  assert.equal(extractJsonObject('["a","b"]').ok, false);
  assert.equal(extractJsonObject('').ok, false);
  assert.equal(extractJsonObject('{不是合法 json}').ok, false);
});

test('util: safeJsonParse 永不抛异常', () => {
  assert.equal(safeJsonParse('{').ok, false);
  assert.equal(safeJsonParse('{"a":1}').ok, true);
});

test('util: truncate 超长时留下明确截断标记', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef');
  const cut = truncate('abcdefghij', 4);
  assert.ok(cut.startsWith('abcd'));
  assert.ok(cut.includes('已截断'), '不能让调用方误以为这是完整内容');
  assert.ok(cut.includes('10'), '要带上原长度');
});

test('util: pickString 兼容同义字段名并跳过空值', () => {
  assert.equal(pickString({ a: '', b: 'x' }, 'a', 'b'), 'x');
  assert.equal(pickString({ openDingTalkId: 'X' }, 'openDingtalkId', 'openDingTalkId'), 'X');
  assert.equal(pickString(null, 'a'), '');
  assert.equal(pickString({ a: '   ' }, 'a'), '');
});

test('util: unique 去重并保持顺序', () => {
  assert.deepEqual(unique(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
});
