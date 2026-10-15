// 验证字节嗅探对真实数据的判定。
//
// 背景：钉钉对同一张图给两个 resourceId，其中一个没有 contentType、也没有文件名，
// 落盘成 .bin。按扩展名判就会被当成"不支持的格式"拒掉。
// 这里拿真实下载下来的 .bin 字节，确认嗅探能识别出它是图片。
//
// 只读。运行：node tools/diagnose-sniff.mjs <文件路径>

import { readFileSync } from 'node:fs';

import { sniffImageMediaType } from '../lib/attachments.js';

const path = process.argv[2];
if (path === undefined || path.length === 0) {
  console.log('用法：node tools/diagnose-sniff.mjs <文件路径>');
  process.exit(1);
}

const buffer = readFileSync(path);
const detected = sniffImageMediaType(buffer);

console.log('文件      :', path);
console.log('大小      :', buffer.length, '字节');
console.log('前 8 字节 :', [...buffer.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' '));
console.log('嗅探结果  :', detected.length > 0 ? detected : '（不是图片）');
console.log();
if (detected.length > 0) {
  console.log('✔ 会被正确识别为图片并交给多模态模型');
} else {
  console.log('✖ 仍会被误判为不支持');
}
