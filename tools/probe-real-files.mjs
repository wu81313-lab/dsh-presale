// 拿真实群文件验证解析器（docx/xlsx/pptx）。
//
// 为什么要这个：单测里的 office 文件是我手搓的 zip，只能证明"逻辑对"。
// 群里真实的方案书/报价表由 Word/WPS/PowerPoint 生成，结构复杂得多
// （母版、样式、嵌入对象、多级编号）。这里走完整链路：真实下载 → 真实解析。
//
// 只读（会写入附件缓存，这是正常位置）。
// 运行：node tools/probe-real-files.mjs <会话ID>

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createAttachments } from '../lib/attachments.js';
import { createConversationData } from '../lib/conversation-data.js';
import { TEST_GROUP, requireFixtures } from './fixtures.mjs';

const conversationId = process.argv[2] ?? TEST_GROUP ?? '';
if (conversationId.length === 0 && !requireFixtures(['DSH_PRESALE_TEST_GROUP'])) {
  console.log('用法：node tools/probe-real-files.mjs <会话ID>');
  process.exit(0);
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const settingsPath = join(home, 'presale', 'settings.json');
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const settings = createSettings({ settingsPath, config: { settingsPath }, logger });
const conversationData = createConversationData({ getSettings: () => settings.get(), logger });
const attachments = createAttachments({
  getSettings: () => settings.get(),
  cacheDir: join(home, 'presale', 'attachments'),
  // 图片要用；这里给个替身，好让图片也走通（真实通道另由插件工具验证）
  saveImage: async ({ data, mediaType }) => ({ attachmentId: `probe:${mediaType}`, mediaType, bytes: data.length, width: 0, height: 0 }),
  logger,
});

const history = await conversationData.history({ conversationId, count: 300 });
const refs = [];
const seen = new Set();
for (const message of history.messages) {
  for (const ref of message.attachments ?? []) {
    if (seen.has(ref.resourceId)) continue;
    seen.add(ref.resourceId);
    refs.push(ref);
  }
}

const named = refs.filter(r => typeof r.name === 'string' && r.name.length > 0);
console.log(`消息 ${history.messages.length} 条，附件 ${refs.length} 个，其中有文件名的 ${named.length} 个\n`);

const interesting = named.filter(r => /\.(docx|xlsx|pptx|pdf)$/iu.test(r.name));
if (interesting.length === 0) {
  console.log('没有 docx/xlsx/pptx/pdf 附件。');
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const ref of interesting) {
  const result = await attachments.ensureText(ref);
  const mark = result.status === 'ok' ? '✔' : result.status === 'image' ? '🖼' : '✖';
  if (result.status === 'ok') ok += 1; else if (result.status !== 'image') failed += 1;
  console.log(`${mark} ${ref.name}`);
  console.log(`    ${result.status}｜${(result.size / 1024).toFixed(1)}KB｜${result.text.length} 字｜缓存=${result.fromCache}`);
  if (result.note) console.log(`    ${result.note}`);
  if (result.text.length > 0) {
    const preview = result.text.split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 4);
    for (const line of preview) console.log(`      ${line.slice(0, 78)}`);
  }
  console.log();
}

console.log(`==== 成功 ${ok} 个，失败 ${failed} 个 ====`);
process.exitCode = failed === 0 ? 0 : 1;
