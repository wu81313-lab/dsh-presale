// 单元测试：轮询器的错误状态管理。
//
// 专门测「错误会不会粘住」——这类问题很隐蔽：插件其实在正常工作，
// 但面板上一直挂着一条旧报错，用户会以为它坏了。
// 之前的实现就有这个 bug：无命中分支提前 return，跳过了清错逻辑。
//
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPoller } from '../poller.js';
import { defaultSettings } from '../config.js';

/** 造一个最小可用的轮询器依赖集。 */
function harness({ identity = { state: 'anchored', myOid: 'OID', aliasIds: [] }, searchResults = [] } = {}) {
  const settings = () => ({
    ...defaultSettings(),
    enabled: true,
    dryRun: true,
    poll: { ...defaultSettings().poll, intervalSeconds: 30 },
  });

  let searchCalls = 0;
  const discoverer = {
    async searchMine() {
      const next = searchResults[Math.min(searchCalls, searchResults.length - 1)];
      searchCalls += 1;
      return next;
    },
    async supplementConversations() {
      return { ok: true, messages: [], checked: 0, message: '' };
    },
    async conversationNames() {
      return new Map();
    },
    matchTriggers() {
      return { provide: [], summarize: [] };
    },
    cachedName() {
      return '';
    },
  };

  // 水位：第一次 tick 会 seed，第二次才开始搜索
  let lastSeenMs = 0;
  const watermark = {
    snapshot: () => ({ lastSeenMs, seenCount: 0 }),
    seed: ms => { lastSeenMs = ms; },
    setLastSeenMs: ms => { lastSeenMs = ms; },
    mark: () => {},
    save: () => {},
    isNew: () => true,
  };

  const poller = createPoller({
    getSettings: settings,
    getIdentity: () => identity,
    discoverer,
    watermark,
    handlers: { runProvide: async () => ({}), runSummarize: async () => ({}) },
    activity: { append: () => {}, recent: () => [] },
    authCheck: null,
    logger: { info() {}, warn() {} },
  });

  return { poller, getSearchCalls: () => searchCalls };
}

test('poller: 首启先落种子，不重放历史', async () => {
  const { poller } = harness();
  await poller.tick();
  const wm = poller.status().watermark;
  assert.ok(wm.lastSeenMs > 0, '第一次 tick 应把水位设到当前时间');
});

test('poller: 搜索失败时记下错误', async () => {
  const { poller } = harness({
    searchResults: [{ ok: false, messages: [], complete: false, message: '搜索炸了', ms: 1 }],
  });
  await poller.tick(); // seed
  await poller.tick(); // search → 失败
  assert.match(poller.status().lastError, /搜索炸了/u);
});

test('poller: 身份未锚定时报错可读，且锚定后自动清除', async () => {
  const identity = { state: 'unresolvable', myOid: '', aliasIds: [] };
  const { poller } = harness({ identity });
  await poller.tick();
  assert.match(poller.status().lastError, /身份尚未锚定/u, '必须给出可操作的原因');

  // 身份修好后，下个周期必须把那条报错清掉（否则会一直挂在面板上）
  identity.state = 'anchored';
  identity.myOid = 'OID';
  await poller.tick();
  assert.equal(poller.status().lastError, '', '身份可用后旧报错必须消失');
});

test('poller: 搜索成功后，无命中也不留旧错误（回归：错误粘住）', async () => {
  // 第一轮失败 → 记错；第二轮成功但零命中 → 错误必须被清掉。
  // 无命中是最常见的状态，而它在实现里是提前 return 的，
  // 曾经因为没在这里清错，导致面板永远挂着「搜索未读全」之类的旧信息。
  const { poller } = harness({
    searchResults: [
      { ok: true, messages: [], complete: false, message: '搜索未读全（complete=false, failed=1）', ms: 1 },
      { ok: true, messages: [], complete: true, hasMore: false, message: '', ms: 1 },
    ],
  });
  await poller.tick(); // seed
  await poller.tick(); // 未读全 → 记错
  assert.notEqual(poller.status().lastError, '', '未读全应被记录');

  await poller.tick(); // 完整且零命中
  assert.equal(poller.status().lastError, '', '搜索恢复完整后错误必须清掉');
});

test('poller: 连续无命中会累积计数（用于自动退避）', async () => {
  const { poller } = harness({
    searchResults: [{ ok: true, messages: [], complete: true, hasMore: false, message: '', ms: 1 }],
  });
  await poller.tick(); // seed
  await poller.tick();
  await poller.tick();
  const status = poller.status();
  assert.ok(status.consecutiveEmpty >= 2, `实际 ${status.consecutiveEmpty}`);
  assert.equal(status.lastError, '', '正常空转不该产生错误');
});

test('poller: enabled=false 时不做任何事', async () => {
  const settings = () => ({ ...defaultSettings(), enabled: false });
  const poller = createPoller({
    getSettings: settings,
    getIdentity: () => ({ myOid: 'OID', aliasIds: [] }),
    discoverer: { searchMine: async () => { throw new Error('不该被调用'); } },
    watermark: { snapshot: () => ({ lastSeenMs: 1, seenCount: 0 }), seed() {}, setLastSeenMs() {}, mark() {}, save() {} },
    handlers: {},
    activity: { append: () => {} },
    logger: { info() {}, warn() {} },
  });
  await poller.tick();
  assert.equal(poller.status().cycles, 0, '关闭时不应推进周期计数');
});
