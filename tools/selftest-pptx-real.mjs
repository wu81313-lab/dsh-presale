// 用真实 pptx 验证手写解析器（结构真实的文件由 tools/make-fixture-pptx.py 生成）。
//
// 为什么需要这一步：单元测试里的 pptx 是我手搓的 XML，只能证明"逻辑对"，
// 证明不了"真实 PowerPoint 文件也能读"。真实文件里有母版、占位符、表格、
// 多文本框、备注页，结构比手搓的复杂得多。
//
// 不提交真实 PPT：里面常含客户名与报价。所以本脚本自己生成一份无关痛痒的，
// 验完即删。
//
// 运行：node tools/selftest-pptx-real.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { extractPptx, extractText } from '../lib/attachments.js';

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const python = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

if (!existsSync(python)) {
  console.log(`找不到 Python：${python}`);
  console.log('本项检查需要 python-pptx 来生成真实样本，已跳过。');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-pptx-'));
const pptxPath = join(dir, 'fixture.pptx');
const script = new URL('./make-fixture-pptx.py', import.meta.url).pathname.replace(/^\//u, '');

try {
  console.log('== 生成真实 pptx ==');
  execFileSync(python, ['-X', 'utf8', script, pptxPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  check('样本已生成', existsSync(pptxPath));
  const bytes = readFileSync(pptxPath);
  console.log(`  文件大小：${(bytes.length / 1024).toFixed(1)} KB`);

  console.log('\n== 解析 ==');
  const text = extractPptx(bytes);
  const pages = [...text.matchAll(/【第 (\d+) 页】/gu)].map(m => Number(m[1]));
  console.log(`  提取到 ${pages.length} 页，共 ${text.length} 字`);
  console.log('  页序：', JSON.stringify(pages));

  console.log('\n== 断言 ==');
  check('页序是 1..N 升序（按数字排，不是按字符串）',
    JSON.stringify(pages) === JSON.stringify(pages.slice().sort((a, b) => a - b)),
    JSON.stringify(pages));
  check('读到标题页文字', text.includes('半自动打码贴标线技术方案'));
  check('读到多级项目符号', text.includes('入口段 / 工艺段 / 出口段'));
  check('读到表格文字（表格在真实 PPT 里是独立结构）',
    text.includes('热转印 300dpi') && text.includes('工业相机'), '');
  check('读到占位符之外的独立文本框', text.includes('换行测试第一行') && text.includes('换行测试第二行'));
  check('多段落被分行而不是挤成一行',
    /换行测试第一行[\s\S]{0,4}换行测试第二行/u.test(text));
  check('带出有信息量的备注', text.includes('本页重点是产能与节拍'));
  check('丢掉纯页码备注', !text.includes('（第 3 页备注）'));

  console.log('\n== 走 extractText 分派 ==');
  const dispatched = extractText(bytes, '技术方案.pptx');
  check('状态为 ok', dispatched.status === 'ok', dispatched.note || '');
  check('正文与直接解析一致', dispatched.text === text);

  console.log('\n== 只给文件名（真实场景里钉钉会给中文名）==');
  const renamed = extractText(bytes, '普瑞玛技术方案V2.pptx');
  check('中文名不影响解析', renamed.status === 'ok');
} catch (error) {
  failures += 1;
  console.log(`\n✖ 抛出异常：${error.stack ?? error.message}`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* Windows 有时锁住文件，留给系统清理 */ }
}

console.log(`\n==== ${failures === 0 ? '真实 pptx 解析验证通过' : `验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
