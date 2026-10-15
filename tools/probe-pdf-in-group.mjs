// 从真实会话里找一个 PDF 附件，走完整链路（下载 → 解析）看能不能读到正文。
//
// 为什么不用自己造的 PDF：真实 PDF 由别人用各种工具生成，字体嵌入方式、编码、
// 是否扫描件都不一样。自己造的只能证明"逻辑对"，证明不了"真文件能读"。
//
// 需要夹具。只读（会下载到附件缓存，这是正常缓存位置）。
// 运行：node tools/probe-pdf-in-group.mjs <会话ID>

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createAttachments } from '../lib/attachments.js';
import { createConversationData } from '../lib/conversation-data.js';
import { TEST_GROUP, requireFixtures } from './fixtures.mjs';

const conversationId = process.argv[2] ?? TEST_GROUP ?? '';
if (conversationId.length === 0) {
  if (!requireFixtures(['DSH_PRESALE_TEST_GROUP'])) {
    console.log('用法：node tools/probe-pdf-in-group.mjs <会话ID>');
    process.exit(0);
  }
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const settingsPath = join(home, 'presale', 'settings.json');
const logger = { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: () => {} };
const settings = createSettings({ settingsPath, config: { settingsPath }, logger });
const conversationData = createConversationData({ getSettings: () => settings.get(), logger });
const attachments = createAttachments({
  getSettings: () => settings.get(),
  cacheDir: join(home, 'presale', 'attachments'),
  logger,
});

const current = settings.get();
console.log('== 当前附件设置 ==');
console.log(`  读取群文件 : ${current.attachments.enabled}`);
console.log(`  pythonPath : ${current.attachments.pythonPath || '（未配置）'}`);
console.log(`  存在性     : ${current.attachments.pythonPath ? existsSync(current.attachments.pythonPath) : '—'}`);
console.log();

const history = await conversationData.history({ conversationId, count: 300 });
console.log(`== 会话历史 ==`);
console.log(`  消息 ${history.messages.length} 条`);

// 收集所有附件，挑出 PDF
const refs = [];
const seen = new Set();
for (const message of history.messages) {
  for (const ref of message.attachments ?? []) {
    if (seen.has(ref.resourceId)) continue;
    seen.add(ref.resourceId);
    refs.push(ref);
  }
}
const pdfs = refs.filter(r => /\.pdf$/iu.test(r.name ?? ''));
console.log(`  附件 ${refs.length} 个，其中 PDF ${pdfs.length} 个`);
for (const ref of refs) {
  console.log(`    · ${ref.name || '（无文件名）'}  kind=${ref.kind}  contentType=${ref.contentType || '—'}`);
}

if (pdfs.length === 0) {
  console.log('\n这个会话里没有 PDF。换一个发过 PDF 的群，或先把 PDF 发到该群再跑。');
  process.exit(0);
}

console.log('\n== 逐个解析 PDF ==');
for (const ref of pdfs) {
  console.log(`\n【${ref.name}】`);
  const result = await attachments.ensureText(ref);
  console.log(`  状态   : ${result.status}`);
  console.log(`  大小   : ${result.size} 字节`);
  console.log(`  提取   : ${result.text.length} 字`);
  console.log(`  缓存   : ${result.fromCache}`);
  if (result.note) console.log(`  说明   : ${result.note}`);
  if (result.status === 'ok' && result.text.length > 0) {
    console.log('  预览   :');
    for (const line of result.text.split('\n').filter(l => l.trim().length > 0).slice(0, 6)) {
      console.log(`      ${line.trim().slice(0, 76)}`);
    }
  }
}
