// 用真实 PDF 验证解析链路（样本由 tools/make-fixture-pdf.py 现场生成）。
//
// 为什么要真文件：单测里只有 "%PDF-1.4" 这种假字节，只能证明"缺库时报错正确"，
// 证明不了"真 PDF 的文字能读出来"。
//
// 本脚本会依次尝试本机所有 Python，找出真正能解析 PDF 的那个——
// 实测两个解释器能力不同（系统 Python 有 PyMuPDF，DSH runtime 一个都没有），
// 所以"该配哪个"必须实测，不能猜。
//
// 运行：node tools/selftest-pdf-real.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractText } from '../lib/attachments.js';

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');

/** 候选解释器：DSH runtime 的、系统装的，都试。 */
const CANDIDATES = [
  join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  'C:\\Python314\\python.exe',
  'python',
];

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 探测某个解释器能不能解析 PDF（用它自己的库列表判断）。 */
function probeEngine(python) {
  const script = [
    'import importlib',
    'found = []',
    'for n in ("pymupdf", "fitz", "pypdf"):',
    '    try:',
    '        importlib.import_module(n); found.append(n)',
    '    except Exception:',
    '        pass',
    'import sys',
    'sys.stdout.buffer.write(",".join(found).encode("utf-8"))',
  ].join('\n');
  try {
    // 注意把 stderr 也丢掉：`import fitz` 会打印弃用告警，
    // 混进 stdout 会污染结果（踩过一次，探测结果里混进一整行 warning）
    const out = execFileSync(python, ['-X', 'utf8', '-c', script], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null; // 解释器本身不可用
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-pdf-'));
const pdfPath = join(dir, 'fixture.pdf');
const script = new URL('./make-fixture-pdf.py', import.meta.url).pathname.replace(/^\//u, '');

try {
  console.log('== 探测本机 Python 与 PDF 库 ==');
  const usable = [];
  for (const python of CANDIDATES) {
    const engines = probeEngine(python);
    if (engines === null) {
      console.log(`  ${python}  →  不可用`);
      continue;
    }
    console.log(`  ${python}  →  ${engines.length > 0 ? engines : '（无 PDF 库）'}`);
    if (engines.length > 0) usable.push({ python, engines });
  }

  if (usable.length === 0) {
    console.log('\n本机没有任何能解析 PDF 的 Python。');
    console.log('安装方法（任选其一）：');
    console.log('  <某 Python> -m pip install pymupdf');
    console.log('然后在插件设置的「附件读取 → Python 路径」里填该解释器的完整路径。');
    process.exitCode = 1;
  } else {
    const chosen = usable[0];
    console.log(`\n选用：${chosen.python}（${chosen.engines}）`);

    console.log('\n== 生成真实 PDF ==');
    execFileSync(chosen.python, ['-X', 'utf8', script, pdfPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    check('样本已生成', existsSync(pdfPath));
    const bytes = readFileSync(pdfPath);
    console.log(`  文件大小：${(bytes.length / 1024).toFixed(1)} KB`);

    console.log('\n== 用插件的解析代码读取 ==');
    const result = extractText(bytes, '技术任务书.pdf', { pythonPath: chosen.python, filePath: pdfPath });
    console.log(`  状态：${result.status}${result.note ? `｜${result.note}` : ''}`);
    console.log(`  提取 ${result.text?.length ?? 0} 字`);

    console.log('\n== 断言 ==');
    check('状态为 ok', result.status === 'ok', result.note || '');
    check('读到第 1 页正文', /半自动打码贴标线技术任务书|Data Matrix/u.test(result.text ?? ''));
    check('读到第 2 页分条列项', /输送线体|Equipment list/u.test(result.text ?? ''));
    check('多行内容没有挤成一行', (result.text ?? '').includes('\n'));

    if (result.text && result.text.length > 0) {
      console.log('\n  提取内容预览：');
      for (const line of result.text.split('\n').slice(0, 6)) {
        if (line.trim().length > 0) console.log(`    ${line.trim().slice(0, 70)}`);
      }
    }

    console.log('\n== 同一解释器的两种写法都应能用 ==');
    // 绝对路径与 PATH 命令名都要支持——用户很自然会填 "python"
    for (const alias of [chosen.python, 'python']) {
      const viaAlias = extractText(bytes, '技术方案.pdf', { pythonPath: alias, filePath: pdfPath });
      check(`pythonPath="${alias}" 可用`, viaAlias.status === 'ok', `状态 ${viaAlias.status}${viaAlias.note ? `｜${viaAlias.note}` : ''}`);
    }

    console.log('\n== 缺库的解释器要给出可执行的安装命令 ==');
    const noLib = CANDIDATES.map(p => ({ p, engines: probeEngine(p) }))
      .find(c => c.engines !== null && c.engines.length === 0);
    if (noLib === undefined) {
      console.log('  （本机所有 Python 都有 PDF 库，跳过）');
    } else {
      const r = extractText(bytes, '技术方案.pdf', { pythonPath: noLib.p, filePath: pdfPath });
      check('状态为 unsupported（不假装成功）', r.status === 'unsupported');
      check('提示里给出了 pip 安装命令', /pip install pymupdf/u.test(r.note ?? ''), r.note ?? '');
    }
  }
} catch (error) {
  failures += 1;
  console.log(`\n✖ 抛出异常：${error.stack ?? error.message}`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* Windows 有时锁住文件 */ }
}

console.log(`\n==== ${failures === 0 ? '真实 PDF 解析验证通过' : `验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
