// 诊断：为什么「不支持的结论」写进了缓存，第二次仍报 fromCache=false？
//
// 只查这两条图片引用，连跑两次 ensureText，把中间值打出来。
// 只读 + 会写缓存（这是正常行为）。运行：node tools/diagnose-image-cache.mjs

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createAttachments, hashOf } from '../lib/attachments.js';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const settingsPath = join(home, 'presale', 'settings.json');
const cacheDir = join(home, 'presale', 'attachments');
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const settings = createSettings({ settingsPath, config: { settingsPath }, logger });
const attachments = createAttachments({ getSettings: () => settings.get(), cacheDir, logger });

// 这两条来自测试群的真实消息（图片）。
const REFS = [
  {
    resourceId: '$iwEcAqNwbmcDAQTRAiAF0QGkBrBjZy_9Lo6lzQqhQjnANqIAB9IJfJ4XCAAJomltCgAL0gAAyGA',
    kind: 'mediaId',
    name: '',
    contentType: '',
    messageId: 'msgl0w2yMNPVV6cReGEKGLbtw==',
    downloadArgs: null,
  },
  {
    resourceId: '@lQLPJxitMuJtnznNAaTNAiCwY2cv_S6Opc0KoUI5wDaiAA',
    kind: 'mediaId',
    name: '',
    contentType: 'image',
    messageId: 'msgl0w2yMNPVV6cReGEKGLbtw==',
    downloadArgs: null,
  },
];

for (const ref of REFS) {
  const hash = hashOf(ref.resourceId);
  const extractPath = join(cacheDir, 'extract', `${hash}.txt`);
  console.log('=== 引用 ===');
  console.log(`  resourceId 前缀 : ${ref.resourceId.slice(0, 24)}…`);
  console.log(`  contentType     : ${JSON.stringify(ref.contentType)}`);
  console.log(`  hash            : ${hash}`);
  console.log(`  提取缓存路径    : ${extractPath}`);
  console.log(`  缓存文件已存在  : ${existsSync(extractPath)}`);

  const first = await attachments.ensureText(ref);
  console.log(`  第 1 次：status=${first.status} fromCache=${first.fromCache} note=${first.note}`);
  console.log(`  写完后缓存存在  : ${existsSync(extractPath)}`);

  const second = await attachments.ensureText(ref);
  console.log(`  第 2 次：status=${second.status} fromCache=${second.fromCache} note=${second.note}`);
  console.log();
}
