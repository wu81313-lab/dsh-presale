// 诊断：附件提取缓存的落盘情况。
//
// 背景：图片附件在第二轮仍然显示「缓存命中=false」，怀疑"不支持的结论"
// 没有真正写入提取缓存。这里直接把 extract 目录列出来核对。
//
// 只读。运行：node tools/diagnose-attachment-cache.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createAttachments, hashOf, sanitizeFileName } from '../lib/attachments.js';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const cacheDir = join(home, 'presale', 'attachments');
const extractDir = join(cacheDir, 'extract');
const settingsPath = join(home, 'presale', 'settings.json');
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const settings = createSettings({ settingsPath, config: { settingsPath }, logger });
const attachments = createAttachments({ getSettings: () => settings.get(), cacheDir, logger });

console.log('== 缓存根目录 ==');
console.log(`  ${cacheDir}`);

console.log('\n== 原件目录 ==');
try {
  for (const name of readdirSync(cacheDir)) {
    if (name === 'extract') continue;
    const dir = join(cacheDir, name);
    const files = readdirSync(dir).map(f => ({ f, size: statSync(join(dir, f)).size }));
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    } catch { /* 没有 meta */ }
    console.log(`  ${name}  ${meta === null ? '（无 meta）' : `原始名=${meta.originalName || '（无）'} kind=${meta.kind}`}`);
    for (const file of files) console.log(`      ${file.f}  ${file.size} 字节`);
  }
} catch (error) {
  console.log(`  读取失败：${error.message}`);
}

console.log('\n== 提取结果缓存 ==');
try {
  const files = readdirSync(extractDir);
  if (files.length === 0) console.log('  （空）');
  for (const f of files) {
    const p = join(extractDir, f);
    let summary = '解析失败';
    try {
      const record = JSON.parse(readFileSync(p, 'utf8'));
      summary = `status=${record.status}  正文=${(record.text ?? '').length} 字  note=${record.note || '（无）'}`;
    } catch { /* 保持 */ }
    console.log(`  ${f}  ${statSync(p).size} 字节  ${summary}`);
  }
} catch (error) {
  console.log(`  读取失败：${error.message}`);
}

console.log('\n== 与设置里上限的对照 ==');
const snapshot = attachments.stats();
const limit = settings.get().attachments.maxCacheBytes;
console.log(`  当前占用 ${(snapshot.totalBytes / 1024).toFixed(1)} KB，上限 ${(limit / 1024 / 1024).toFixed(1)} MB`);
console.log(`  是否会触发淘汰：${snapshot.totalBytes > limit ? '是' : '否'}`);
console.log(`  ⚠ maxCacheBytes 的最小合法值是 1MB——填更小的值会被归一化拒绝并回退默认值。`);
console.log(`    所以想测试淘汰，上限必须 ≥1MB 且小于当前占用（即缓存需超过 1MB）。`);

console.log('\n== 文件名消毒抽查（图片资源名缺失时的兜底）==');
console.log(`  hashOf 示例：${hashOf('abc')}`);
console.log(`  空名兜底：${sanitizeFileName('')}`);
