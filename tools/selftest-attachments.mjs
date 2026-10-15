// 附件链路的实测脚本（真实下载 + 真实提取 + 缓存命中）。
//
// 覆盖三件事，都必须用真实文件才有意义：
//   ① 从钉钉下载文件（dws +messages-resource-download）
//   ② 提取正文（docx/xlsx 手写解析）
//   ③ 第二次调用命中缓存，不再走网络
//
// 需要夹具（见 tools/fixtures.mjs）。没有夹具时本脚本会说明并跳过。
//
// 注意：会把文件下载到 ~/.dsh/presale/attachments/（这是正常缓存位置，
// 不是临时目录）。想清空可跑：node tools/selftest-attachments.mjs --clear
//
// 运行：node tools/selftest-attachments.mjs

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createAttachments } from '../lib/attachments.js';
import { TEST_GROUP, requireFixtures } from './fixtures.mjs';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const logger = { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: () => {} };

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const settingsPath = join(home, 'presale', 'settings.json');
const settings = createSettings({ settingsPath, config: { settingsPath }, logger });
const attachments = createAttachments({
  getSettings: () => settings.get(),
  cacheDir: join(home, 'presale', 'attachments'),
  logger,
});

if (process.argv.includes('--clear')) {
  const result = attachments.clear();
  console.log(`已清空附件缓存：释放 ${(result.freedBytes / 1024).toFixed(1)} KB，删除 ${result.removedFiles} 个文件`);
  process.exit(0);
}

try {
  console.log('== 缓存目录 ==');
  console.log(`  ${attachments.cacheDir}`);
  const before = attachments.stats();
  console.log(`  当前占用 ${(before.totalBytes / 1024).toFixed(1)} KB，${before.entryCount} 个条目`);

  // 纯逻辑部分不需要夹具
  console.log('\n== 缓存统计结构 ==');
  check('stats() 返回必需字段',
    typeof before.totalBytes === 'number' && typeof before.entryCount === 'number' && Array.isArray(before.entries));

  const ready = requireFixtures(['DSH_PRESALE_TEST_GROUP']);
  if (!ready) {
    console.log('\n==== 结构检查通过；真实下载检查已跳过 ====');
    process.exitCode = failures === 0 ? 0 : 1;
  } else {
    console.log(`\n== 从测试群找出真实附件 ==`);
    // 拿该群最近消息，挑出带附件的
    const { createConversationData } = await import('../lib/conversation-data.js');
    const conversationData = createConversationData({ getSettings: () => settings.get(), logger });
    const history = await conversationData.history({ conversationId: TEST_GROUP, count: 200 });
    check('能读到会话历史', history.ok, `${history.messages.length} 条`);

    const refs = [];
    const seen = new Set();
    for (const message of history.messages) {
      for (const ref of message.attachments ?? []) {
        if (seen.has(ref.resourceId)) continue;
        seen.add(ref.resourceId);
        refs.push(ref);
      }
    }
    check('历史里能解析出附件引用', refs.length > 0, `${refs.length} 个`);

    if (refs.length > 0) {
      console.log(`\n== 第一次处理（应真实下载）==`);
      const first = await attachments.collect(refs);
      console.log(`  ${first.summary}`);
      for (const r of first.results) {
        console.log(`    ${r.name}｜${r.status}｜${(r.size / 1024).toFixed(1)}KB｜${r.text.length} 字｜缓存命中=${r.fromCache}${r.note ? `｜${r.note}` : ''}`);
      }
      check('至少有一个附件被成功提取', first.results.some(r => r.status === 'ok'));
      check('内容块格式正确',
        first.block.includes('=== 附件内容开始 ===') && first.block.includes('=== 附件内容结束 ==='));

      console.log(`\n== 第二次处理（应全部命中缓存）==`);
      const second = await attachments.collect(refs);
      const allCached = second.results.every(r => r.fromCache === true);
      check('第二次全部命中缓存，不再下载', allCached,
        second.results.map(r => `${r.name}=${r.fromCache}`).join(' '));
      check('两次提取的文本一致',
        JSON.stringify(second.results.map(r => r.text)) === JSON.stringify(first.results.map(r => r.text)));

      const after = attachments.stats();
      console.log(`\n== 缓存变化 ==`);
      console.log(`  处理前 ${(before.totalBytes / 1024).toFixed(1)} KB → 处理后 ${(after.totalBytes / 1024).toFixed(1)} KB`);
      check('缓存里有条目', after.entryCount > 0, `${after.entryCount} 个`);
      const top = after.entries[0];
      if (top) {
        console.log(`  最新条目：${top.name}｜${(top.bytes / 1024).toFixed(1)}KB｜最后访问 ${top.lastUsedMs > 0 ? new Date(top.lastUsedMs).toLocaleString('zh-CN') : '未知'}`);
      }

      console.log(`\n== 缓存与淘汰接口 ==`);
      // LRU 的**正确性**由单元测试覆盖（lib/test/attachments-cache.test.mjs 造了几 MB 假数据）。
      // 这里只确认接口在真实缓存上能用，以及不超限时确实不动东西。
      // 之前这段想在这里验证淘汰，但 maxCacheBytes 的最小合法值是 1MB 而真实缓存只有几十 KB，
      // 怎么设都触发不到——那种断言是在迁就测试环境，不如交给单元测试。
      const pruned = attachments.prune();
      console.log(`  当前占用 ${(after.totalBytes / 1024).toFixed(1)} KB，上限 ${(settings.get().attachments.maxCacheBytes / 1024 / 1024).toFixed(0)} MB`);
      console.log(`  prune() 返回：淘汰 ${pruned.removed} 个，释放 ${(pruned.freedBytes / 1024).toFixed(1)} KB`);
      check('未超限时 prune 不动任何文件', pruned.removed === 0, `淘汰 ${pruned.removed} 个`);
      check('prune 后缓存仍在', attachments.stats().entryCount > 0);
    }
  }
} catch (error) {
  failures += 1;
  console.log(`\n✖ 抛出异常：${error.stack ?? error.message}`);
}

console.log(`\n==== ${failures === 0 ? '附件链路验证通过' : `验证失败 ${failures} 项`} ====`);
console.log('提示：清空缓存可运行 node tools/selftest-attachments.mjs --clear');
process.exitCode = failures === 0 ? 0 : 1;
