// 附件缓存的单元测试：LRU 淘汰、统计、清空。
//
// 为什么单独测 LRU：真实附件往往只有几十 KB，而 maxCacheBytes 的最小合法值是
// 1MB——用真实文件根本触发不到淘汰。所以这里造一个临时缓存目录，
// 塞几个 MB 的假文件，才能验证「超限真的会清」以及「清到限内就停」。
//
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAttachments, hashOf, CACHE_VERSION } from '../attachments.js';
import { defaultSettings } from '../config.js';

/**
 * 提取缓存的文件名：`<hash>.v<版本>.txt`。
 *
 * 版本号是刻意编进文件名的——改了提取行为就把版本 +1，让旧结论自动失效
 * （不这样做的话，功能改好了却仍命中旧结论，实测踩到过）。
 * 测试里必须用同一个命名，否则预置的缓存根本不会被命中。
 */
const extractFileName = resourceId => `${hashOf(resourceId)}.v${CACHE_VERSION}.txt`;

/**
 * 造一个带附件的临时缓存目录。
 *
 * @param {Array<{id: string, bytes: number, name?: string, usedAgoMs?: number}>} entries
 * @param {object} [overrides] - 覆盖 attachments 设置。
 */
function setup(entries, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-presale-cache-'));
  const cacheDir = join(root, 'attachments');
  mkdirSync(join(cacheDir, 'extract'), { recursive: true });

  for (const entry of entries) {
    const dir = join(cacheDir, hashOf(entry.id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, entry.name ?? `${hashOf(entry.id)}.docx`), Buffer.alloc(entry.bytes, 1));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      resourceId: entry.id, fileName: entry.name ?? `${hashOf(entry.id)}.docx`, originalName: entry.name ?? '', size: entry.bytes,
    }), 'utf8');
    // lastUsedMs 越小越旧；测试里用固定值以便断言淘汰顺序
    const usedAt = Date.now() - (entry.usedAgoMs ?? 0);
    writeFileSync(join(dir, '.used'), String(usedAt), 'utf8');
  }

  const settings = () => ({
    ...defaultSettings(),
    attachments: { ...defaultSettings().attachments, ...overrides },
  });

  return {
    root,
    cacheDir,
    attachments: createAttachments({ getSettings: settings, cacheDir, logger: { info() {}, warn() {} } }),
  };
}

test('attachments: stats 统计总字节、条目数与文件名', () => {
  const { root, attachments } = setup([
    { id: 'a', bytes: 1000, name: '需求文档.docx' },
    { id: 'b', bytes: 2000, name: '报价表.xlsx' },
  ]);
  try {
    const stats = attachments.stats();
    assert.equal(stats.entryCount, 2);
    assert.ok(stats.totalBytes >= 3000, `实际 ${stats.totalBytes}`);
    const names = stats.entries.map(e => e.name).sort();
    assert.deepEqual(names, ['报价表.xlsx', '需求文档.docx'].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachments: 未超限时 prune 不动任何东西', () => {
  const { root, attachments } = setup([{ id: 'a', bytes: 1000 }], { maxCacheBytes: 10 * 1024 * 1024 });
  try {
    const result = attachments.prune();
    assert.equal(result.removed, 0);
    assert.equal(result.freedBytes, 0);
    assert.equal(attachments.stats().entryCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachments: 超限时按最久未访问淘汰，且够用就停', () => {
  // 数据刻意**不等大**，避免卡在临界点上——等大的条目加上目录开销后
  // 「删一个够不够」会变得依赖字节级细节，那种测试是在迁就脆弱的设计。
  // 这里：旧 1MB / 中 1MB / 新 0.1MB，上限 1.5MB。
  // 删掉最旧的 1MB 后剩 ~1.1MB < 1.5MB，所以**只需删一个**。
  const MB = 1024 * 1024;
  const { root, attachments } = setup([
    { id: 'old', bytes: MB, name: '最旧.docx', usedAgoMs: 3_000_000 },
    { id: 'mid', bytes: MB, name: '中间.docx', usedAgoMs: 2_000_000 },
    { id: 'new', bytes: Math.floor(0.1 * MB), name: '最新.docx', usedAgoMs: 1_000_000 },
  ], { maxCacheBytes: Math.floor(1.5 * MB) });

  try {
    const before = attachments.stats();
    assert.ok(before.totalBytes > 1.5 * MB, `造的数据应超过上限，实际 ${before.totalBytes}`);

    const result = attachments.prune();
    const after = attachments.stats();

    assert.equal(result.removed, 1, `够用就应停手，实际淘汰 ${result.removed} 个`);
    assert.ok(result.freedBytes >= MB, `释放量应覆盖那 1MB，实际 ${result.freedBytes}`);
    assert.ok(after.totalBytes <= 1.5 * MB, `清完应在上限内，实际 ${after.totalBytes}`);

    // LRU 语义：最旧的被删，其余保留
    const remaining = after.entries.map(e => e.name).sort();
    assert.deepEqual(remaining, ['中间.docx', '最新.docx'].sort(), JSON.stringify(remaining));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachments: 上限极小时会全部淘汰（不残留）', () => {
  const { root, attachments } = setup([
    { id: 'a', bytes: 2 * 1024 * 1024 },
    { id: 'b', bytes: 2 * 1024 * 1024 },
  ], { maxCacheBytes: 1024 * 1024 });

  try {
    const result = attachments.prune();
    assert.equal(result.removed, 2, `应全部淘汰，实际 ${result.removed}`);
    assert.equal(attachments.stats().entryCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachments: clear 释放全部并清空目录', () => {
  const { root, cacheDir, attachments } = setup([{ id: 'a', bytes: 5000 }]);
  try {
    const result = attachments.clear();
    assert.equal(result.ok, true);
    assert.ok(result.freedBytes >= 5000, `实际 ${result.freedBytes}`);
    assert.equal(attachments.stats().entryCount, 0);
    assert.equal(attachments.stats().totalBytes, 0);
    // 清空后目录应重新建好（下次能直接用）
    assert.ok(readdirSync(cacheDir).length >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachments: 缓存目录不存在时 stats 不抛异常', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-presale-none-'));
  const settings = () => ({ ...defaultSettings(), attachments: defaultSettings().attachments });
  const attachments = createAttachments({
    getSettings: settings,
    cacheDir: join(root, 'does-not-exist', 'attachments'),
    logger: { info() {}, warn() {} },
  });
  try {
    const stats = attachments.stats();
    assert.equal(stats.entryCount, 0);
    assert.equal(stats.totalBytes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 字数预算的分配（对比 dsh-project 时发现它做得更公平，这里是回归锁）──────

/** 直接测 collect 的分配逻辑：造两个"已提取"的附件，喂进 collect。 */
function budgetHarness({ totalChars, files }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-presale-budget-'));
  const cacheDir = join(root, 'attachments');
  mkdirSync(join(cacheDir, 'extract'), { recursive: true });

  // 预置提取缓存，让 ensureText 直接命中，避免真的去下载
  for (const file of files) {
    writeFileSync(join(cacheDir, 'extract', extractFileName(file.id)), JSON.stringify({
      status: 'ok', text: 'x'.repeat(file.chars), note: '', size: file.chars, extractedAt: new Date().toISOString(),
    }), 'utf8');
  }

  const settings = () => ({
    ...defaultSettings(),
    attachments: { ...defaultSettings().attachments, maxTotalChars: totalChars, maxFilesPerRun: files.length },
  });
  const attachments = createAttachments({ getSettings: settings, cacheDir, logger: { info() {}, warn() {} } });
  const refs = files.map(f => ({
    resourceId: f.id, kind: 'fileId', name: `${f.id}.txt`, contentType: 'file', messageId: '', downloadArgs: null,
  }));
  return { root, collect: () => attachments.collect(refs) };
}

test('attachments: 预算不够时**均分**给各文件，而不是前面的吃光', async () => {
  // 两份各 1000 字，总预算 800：顺序吃会让第一份占 800、第二份 0；
  // 均分应各得约 400。
  const h = budgetHarness({ totalChars: 800, files: [{ id: 'a.txt', chars: 1000 }, { id: 'b.txt', chars: 1000 }] });
  try {
    const { block } = await h.collect();
    const aPos = block.indexOf('【a.txt.txt】');
    const bPos = block.indexOf('【b.txt.txt】');
    assert.ok(aPos > -1 && bPos > -1, '两份都应出现');
    // 抽掉标记行后数各自的正文长度
    const between = block.slice(aPos, bPos);
    const afterB = block.slice(bPos);
    const aBody = (between.match(/x/gu) ?? []).length;
    const bBody = (afterB.match(/x/gu) ?? []).length;
    assert.ok(aBody > 100, `第一份正文太少：${aBody}`);
    assert.ok(bBody > 100, `第二份正文太少（被前面的吃光了）：${bBody}`);
    assert.ok(Math.abs(aBody - bBody) < 200, `两份应大致均分：${aBody} vs ${bBody}`);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('attachments: 短文件用不完的额度会补给长文件', async () => {
  // 一份 100 字、一份 5000 字，预算 1000：
  // 短文件只用掉 100，剩下的额度应该补给长文件，而不是浪费。
  const h = budgetHarness({ totalChars: 1000, files: [{ id: 'short.txt', chars: 100 }, { id: 'long.txt', chars: 5000 }] });
  try {
    const { block } = await h.collect();
    const longPos = block.indexOf('【long.txt.txt】');
    assert.ok(longPos > -1, '长文件应出现');
    const longBody = (block.slice(longPos).match(/x/gu) ?? []).length;
    assert.ok(longBody > 700, `长文件应拿到短文件省下的额度，实际 ${longBody}`);
    assert.ok(longBody <= 1000, `但不得超过总预算，实际 ${longBody}`);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('attachments: 预算充裕时不截断任何文件', async () => {
  const h = budgetHarness({ totalChars: 5000, files: [{ id: 'a.txt', chars: 100 }, { id: 'b.txt', chars: 200 }] });
  try {
    const { block, results } = await h.collect();
    assert.ok(block.includes('x'.repeat(100)), '第一份应完整');
    assert.ok(block.includes('x'.repeat(200)), '第二份应完整');
    assert.ok(!block.includes('截断'), `不该出现截断说明：${block.slice(0, 200)}`);
    assert.equal(results.filter(r => r.status === 'ok').length, 2);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
