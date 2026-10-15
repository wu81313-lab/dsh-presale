// 对照实验：为什么 dsh-project 判定「群文件（fileId）下载不通」，而我这边通？
//
// 事实基础：
//   · dsh-project lib/fileops.js 走的是 `chat +messages-resource-download --type fileId`，
//     但会**额外带上 --message-id 与 --open-conversation-id**（它把所有预解析字段
//     一律转发），随后报「缺少必要信息 spaceId」，补 --space-id 重试仍失败 → 判定通道受限。
//   · 本插件只用 `--type fileId --resource-id <id> --output` 就成功下载了
//     37,797 字节的 docx 与 11,657 字节的 xlsx。
//
// 所以怀疑点是：**给 fileId 多传 message-id / open-conversation-id 会让 dws 走媒体分支**
// （媒体分支需要 spaceId），而不传时它走的是纯 fileId 分支（直接可用）。
//
// 本脚本做四组对照，定位到具体是哪个参数造成的差异。
//
// 只读（dry-run 不行，下载命令没有 dry-run），会写入临时目录并在结束时清理。
// 运行：node tools/diagnose-fileid-args.mjs

import { existsSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDws } from '../lib/dws.js';
import { TEST_GROUP, requireFixtures } from './fixtures.mjs';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

if (!requireFixtures(['DSH_PRESALE_TEST_GROUP'])) {
  console.log('需要 DSH_PRESALE_TEST_GROUP 才能取到真实的 fileId，跳过。');
  process.exit(0);
}

// 从测试群里找一个真实的文件类附件（fileId）
const { createSettings } = await import('../lib/settings.js');
const { createConversationData } = await import('../lib/conversation-data.js');
const { homedir } = await import('node:os');
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const settingsPath = join(home, 'presale', 'settings.json');
const settings = createSettings({ settingsPath, config: { settingsPath }, logger });
const conversationData = createConversationData({ getSettings: () => settings.get(), logger });

const history = await conversationData.history({ conversationId: TEST_GROUP, count: 200 });
const files = [];
const seen = new Set();
for (const message of history.messages) {
  for (const ref of message.attachments ?? []) {
    if (seen.has(ref.resourceId)) continue;
    seen.add(ref.resourceId);
    if (ref.kind === 'fileId' && ref.name.length > 0) files.push({ ref, messageId: ref.messageId });
  }
}

if (files.length === 0) {
  console.log('测试群里没有 fileId 类附件，换个群再试。');
  process.exit(0);
}

const target = files[0];
console.log('== 待测文件 ==');
console.log(`  名称：${target.ref.name}`);
console.log(`  fileId：${target.ref.resourceId}`);
console.log(`  来源消息：${target.messageId}`);
console.log(`  群：${TEST_GROUP}`);
console.log();

/** 跑一组参数，看是否能下到文件。 */
async function probe(label, extraArgs, note) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-fid-'));
  const fileName = target.ref.name.replace(/[^\w.\u4e00-\u9fff-]/gu, '_');
  const args = [
    'chat', '+messages-resource-download',
    '--type', 'fileId',
    '--resource-id', target.ref.resourceId,
    '--output', `./${fileName}`,
    ...extraArgs,
    '-f', 'json',
  ];
  const result = await runDws({ dwsPath: 'dws', args, timeoutMs: 60000, cwd: dir, logger });

  let landed = null;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isFile()) landed = { name: f, size: statSync(p).size };
    }
  } catch { /* 空目录 */ }

  console.log(`== ${label} ==`);
  console.log(`  ${note}`);
  console.log(`  结果：${result.ok ? '✔ 成功' : '✖ 失败'}  落地文件：${landed === null ? '（无）' : `${landed.name} ${landed.size} 字节`}`);
  if (!result.ok) {
    const msg = result.message.replace(/\s+/gu, ' ').slice(0, 160);
    console.log(`  错误：${msg}`);
  }
  console.log();
  // dws 有时还握着文件句柄，删不掉不算测试失败——留给系统清理
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    console.log(`  （临时目录未能删除，可忽略：${dir}）`);
    console.log();
  }
  return result.ok;
}

console.log('== 四组对照（只差在附加参数上）==');
await probe(
  'A. 只给 resource-id（我用的形态）',
  [],
  '不传 message-id / open-conversation-id —— 本插件当前的做法',
);

await probe(
  'B. 加 open-conversation-id',
  ['--open-conversation-id', TEST_GROUP],
  '带上会话 ID，看是否反而触发媒体分支',
);

await probe(
  'C. 加 message-id',
  ['--message-id', target.messageId],
  '带上消息 ID（dsh-project 会这么传）',
);

await probe(
  'D. 同时加 message-id 与 open-conversation-id（dsh-project 的形态）',
  ['--message-id', target.messageId, '--open-conversation-id', TEST_GROUP],
  '完整复现 dsh-project 的参数',
);

console.log('== 结论 ==');
console.log('  若只有 A 成功 → 说明差异就出在"多传了 message-id / open-conversation-id"，');
console.log('  那两个参数会把 fileId 请求推到需要 spaceId 的媒体分支上。');
