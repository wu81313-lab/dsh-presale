// 单元测试：水位去重、发送前校验、设置读写、活动日志、渲染与 @ 组装。
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWatermark } from '../watermark.js';
import { validateSend, mentionPlaceholder } from '../send.js';
import { createActivity } from '../activity.js';
import { createSettings } from '../settings.js';
import { renderTemplate, extractKeyword } from '../render.js';
import { renderHistoryForModel } from '../conversation-data.js';
import { DEFAULT_TEMPLATE } from '../config.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-presale-test-'));
}

// ───────────────────────── watermark ─────────────────────────

test('watermark: 同一 messageId 第二次判为旧（防重复触发）', () => {
  const dir = tempDir();
  try {
    const wm = createWatermark({ watermarkPath: join(dir, 'wm.json'), logger: { warn() {} } });
    const msg = { messageId: 'msg-1', createTimeMs: 1000 };
    assert.equal(wm.isNew(msg), true, '第一次是新消息');
    wm.mark(msg);
    assert.equal(wm.isNew(msg), false, '同一条消息不能重复触发');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watermark: 重叠窗口内已处理的消息不会被再次触发', () => {
  const dir = tempDir();
  try {
    const wm = createWatermark({ watermarkPath: join(dir, 'wm.json'), logger: { warn() {} } });
    // 模拟第一轮处理了一条
    const first = { messageId: 'msg-a', createTimeMs: 10_000 };
    wm.mark(first);

    // 第二轮窗口刻意往回重叠（这正是漏消息防护），同一个 messageId 又出现在结果里
    assert.equal(wm.isNew(first), false, '重叠窗口里的旧消息必须被拦住');

    // 但同一窗口里的新消息要放行
    const second = { messageId: 'msg-b', createTimeMs: 20_000 };
    assert.equal(wm.isNew(second), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watermark: seed 之后历史消息不再触发（防装上就刷屏）', () => {
  const dir = tempDir();
  try {
    const wm = createWatermark({ watermarkPath: join(dir, 'wm.json'), logger: { warn() {} } });
    const now = Date.now();
    wm.seed(now);

    const old = { messageId: 'msg-old', createTimeMs: now - 60_000 };
    assert.equal(wm.isNew(old), false, '种子之前的历史消息不能被重放');

    const fresh = { messageId: 'msg-new', createTimeMs: now + 1_000 };
    assert.equal(wm.isNew(fresh), true, '种子之后的新消息要能被发现');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watermark: 落盘后重新加载仍然记得已处理的消息', () => {
  const dir = tempDir();
  const path = join(dir, 'wm.json');
  try {
    const a = createWatermark({ watermarkPath: path, logger: { warn() {} } });
    const msg = { messageId: 'msg-persist', createTimeMs: 5_000 };
    a.mark(msg);
    a.save();

    // 模拟 DSH 重启
    const b = createWatermark({ watermarkPath: path, logger: { warn() {} } });
    assert.equal(b.isNew(msg), false, '重启后不能把同一条消息再执行一遍');
    assert.ok(b.snapshot().lastSeenMs >= 5_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watermark: messageId 缺失时不丢消息（只靠时间判断）', () => {
  const dir = tempDir();
  try {
    const wm = createWatermark({ watermarkPath: join(dir, 'wm.json'), logger: { warn() {} } });
    wm.mark({ messageId: '', createTimeMs: 1_000 });
    // 没有 ID 的消息不应被 ID 判重逻辑挡住——宁可能重复，不可漏触发
    assert.equal(wm.isNew({ messageId: '', createTimeMs: 2_000 }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── send 校验 ─────────────────────────

test('send: 拒绝空消息与纯空白', () => {
  assert.equal(validateSend({ conversationId: 'cidX', text: '' }).ok, false);
  assert.equal(validateSend({ conversationId: 'cidX', text: '   \n  ' }).ok, false);
});

test('send: 缺少会话 ID 时拒绝', () => {
  assert.equal(validateSend({ conversationId: '', text: 'hi' }).ok, false);
});

test('send: 要 @ 人但正文没有占位符 → 拒绝（这是钉钉的硬要求）', () => {
  const result = validateSend({
    conversationId: 'cidX',
    text: '请补充需求',
    mentionIds: ['D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001'],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /占位符/u);
});

test('send: 正文带占位符时通过，并保留 @ 列表', () => {
  const oid = 'D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001';
  const result = validateSend({
    conversationId: 'cidX',
    text: `${mentionPlaceholder(oid)} 请补充需求`,
    mentionIds: [oid],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ids, [oid]);
  assert.ok(result.text.startsWith('<@'));
});

test('send: 空字符串的 @ 目标被忽略，不会误判为缺少占位符', () => {
  const result = validateSend({ conversationId: 'cidX', text: '普通消息', mentionIds: ['', '  '] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ids, []);
});

test('send: mentionPlaceholder 对空值返回空串（不产生 <@> 这种畸形占位符）', () => {
  assert.equal(mentionPlaceholder(''), '');
  assert.equal(mentionPlaceholder(undefined), '');
  assert.equal(mentionPlaceholder('  '), '');
});

// ───────────────────────── settings ─────────────────────────

test('settings: 首次读取会落盘播种内容，之后可热改写', () => {
  const dir = tempDir();
  const path = join(dir, 'settings.json');
  try {
    const s = createSettings({ settingsPath: path, config: { dryRun: false }, logger: { warn() {} } });
    const first = s.get();
    assert.equal(first.dryRun, false, 'cordis config 应作为初值播种');
    assert.ok(s.exists(), '首次读取应写出文件，方便用户直接编辑');

    const updated = s.update({ triggers: { provide: { keywords: ['自定义关键词'] } } });
    assert.deepEqual(updated.triggers.provide.keywords, ['自定义关键词']);
    assert.equal(updated.dryRun, false, '未触及的字段不应被丢掉');

    // 磁盘上确实写进去了
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(onDisk.triggers.provide.keywords, ['自定义关键词']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: mtime 变化后热读到新值（面板改完立刻生效）', async () => {
  const dir = tempDir();
  const path = join(dir, 'settings.json');
  try {
    const s = createSettings({ settingsPath: path, logger: { warn() {} } });
    assert.equal(s.get().dryRun, true);

    // 模拟外部（或面板）直接改文件
    await new Promise(resolve => setTimeout(resolve, 20));
    writeFileSync(path, JSON.stringify({ dryRun: false, enabled: true }), 'utf8');

    const reloaded = s.get();
    assert.equal(reloaded.dryRun, false, '必须按 mtime 感知外部改动');
    assert.equal(reloaded.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: 文件损坏时不覆盖用户文件，退回默认并给出告警', () => {
  const dir = tempDir();
  const path = join(dir, 'settings.json');
  try {
    writeFileSync(path, '{ 这不是合法 json', 'utf8');
    const s = createSettings({ settingsPath: path, logger: { warn() {} } });
    const loaded = s.get();
    assert.equal(loaded.dryRun, true, '坏文件应退回默认值而不是让插件崩掉');
    assert.ok(s.warnings().some(w => w.includes('无法解析')), '必须告警，否则用户不知道为什么设置没生效');
    // 原文件保留原样（用户可能只是编辑到一半）
    assert.equal(readFileSync(path, 'utf8'), '{ 这不是合法 json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: 保存时 strict 校验会拒绝空文案', () => {
  const dir = tempDir();
  const path = join(dir, 'settings.json');
  try {
    const s = createSettings({ settingsPath: path, logger: { warn() {} } });
    assert.throws(() => {
      s.update({ triggers: { provide: { template: '  ' } } }, { strict: true });
    }, /不能为空/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── activity ─────────────────────────

test('activity: 追加后可读回，且新的在前', () => {
  const dir = tempDir();
  try {
    const log = createActivity({ activityPath: join(dir, 'a.ndjson'), logger: { warn() {} } });
    log.append({ action: 'provide', decision: 'dry-run', text: '第一条' });
    log.append({ action: 'summarize', decision: 'sent', text: '第二条' });

    const recent = log.recent(10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].text, '第二条', '最近的在最前');
    assert.ok(Number.isFinite(recent[0].ts), 'ts 应自动补上');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: 重新加载后能读回历史记录', () => {
  const dir = tempDir();
  const path = join(dir, 'a.ndjson');
  try {
    const a = createActivity({ activityPath: path, logger: { warn() {} } });
    a.append({ action: 'provide', decision: 'sent', text: '历史一条' });

    const b = createActivity({ activityPath: path, logger: { warn() {} } });
    const recent = b.recent(5);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].text, '历史一条');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: 清空后不再返回旧记录', () => {
  const dir = tempDir();
  const path = join(dir, 'a.ndjson');
  try {
    const log = createActivity({ activityPath: path, logger: { warn() {} } });
    log.append({ action: 'x' });
    log.clear();
    assert.equal(log.recent(5).length, 0);
    assert.equal(readFileSync(path, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── render ─────────────────────────

test('render: 占位符被替换，未知的保留并回报', () => {
  const result = renderTemplate('发给{senderName}在{groupName}：{未知键}', {
    senderName: '吴瑞铎',
    groupName: '示例工作群',
  });
  assert.match(result.text, /吴瑞铎/u);
  assert.match(result.text, /示例工作群/u);
  assert.ok(result.text.includes('{未知键}'), '未知占位符要原样保留，不能静默吃掉');
  assert.deepEqual(result.unknown, ['未知键']);
});

test('render: 默认文案里的占位符全部可识别（占位符表与默认文案不脱节）', () => {
  // 默认文案本身不含占位符，但要确保它不会意外带出未识别项
  const result = renderTemplate(DEFAULT_TEMPLATE, { senderName: 'x', groupName: 'y' });
  assert.deepEqual(result.unknown, []);
  assert.ok(result.text.length > 0);
});

test('render: 值为 undefined / null 时替换为空串而不是字符串 "undefined"', () => {
  const result = renderTemplate('A{一}B{二}C', { 一: undefined, 二: null });
  assert.equal(result.text, 'ABC');
  assert.deepEqual(result.unknown, []);
});

test('render: extractKeyword 命中配置里的原始写法', () => {
  assert.equal(extractKeyword('请大家提供完整项目需求，谢谢', { keywords: ['提供完整项目需求'] }), '提供完整项目需求');
  assert.equal(extractKeyword('梳理项目需求', { keywords: ['提供完整项目需求', '梳理项目需求'] }), '梳理项目需求');
});

test('render: extractKeyword 按配置顺序返回第一个命中项', () => {
  const text = '提供完整项目需求 梳理项目需求';
  assert.equal(extractKeyword(text, { keywords: ['提供完整项目需求', '梳理项目需求'] }), '提供完整项目需求');
});

// ───────────────────────── 历史渲染（判销售/总结的输入）─────────────────────────

test('history: 我自己的发言被标注为「我·非销售」', () => {
  const messages = [
    { createTime: '2026-10-14 10:00:00', sender: '吴瑞铎', senderId: 'ME', text: '提供完整项目需求', quotedSender: '', quotedText: '' },
    { createTime: '2026-10-14 10:01:00', sender: '张三', senderId: 'OTHER', text: '客户要上追溯', quotedSender: '', quotedText: '' },
  ];
  const { text } = renderHistoryForModel(messages, { myOid: 'ME' });
  assert.match(text, /吴瑞铎（我·非销售）/u, '必须把自己标出来，否则模型可能把自己当销售');
  assert.match(text, /张三/u);
  assert.ok(!text.includes('张三（我·非销售）'));
});

test('history: 超长时从最老的开始丢弃并显式声明', () => {
  const messages = [];
  for (let i = 0; i < 50; i += 1) {
    messages.push({
      createTime: `2026-10-14 10:00:${String(i).padStart(2, '0')}`,
      sender: `人${i}`,
      senderId: `id-${i}`,
      text: 'x'.repeat(200),
      quotedSender: '',
      quotedText: '',
    });
  }
  const { text, dropped } = renderHistoryForModel(messages, { myOid: '' }, 1500);
  assert.ok(dropped > 0, '应该发生截断');
  assert.match(text, /未包含/u, '截断必须显式告知模型，否则会把部分当全量');
  assert.ok(text.includes('人49'), '最新的消息要保留');
  assert.ok(!text.includes('人0:'), '最老的应被丢弃');
});

test('history: 引用内容会被带上（需求常在引用里）', () => {
  const messages = [{
    createTime: '2026-10-14 10:00:00',
    sender: '张三',
    senderId: 'OTHER',
    text: '好的',
    quotedSender: '客户',
    quotedText: '产线要 4 条',
  }];
  const { text } = renderHistoryForModel(messages, { myOid: 'ME' });
  assert.match(text, /引用/u);
  assert.match(text, /产线要 4 条/u);
});
