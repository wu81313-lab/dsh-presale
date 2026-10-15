// 诊断：PDF 解析脚本在 Python 侧到底报什么错。
//
// 上一版只看到"Command failed"就没了——因为 execFileSync 的 stderr 没被打印。
// 这里把 Python 脚本原样跑一遍，stdout/stderr 全打出来。
//
// 只读。运行：node tools/diagnose-pdf.mjs <pdf路径> <python路径>

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [, , pdfPath, pythonPath] = process.argv;
if (pdfPath === undefined || pythonPath === undefined) {
  console.log('用法：node tools/diagnose-pdf.mjs <pdf路径> <python路径>');
  process.exit(1);
}
if (!existsSync(pdfPath)) {
  console.log(`PDF 不存在：${pdfPath}`);
  process.exit(1);
}

// 与 lib/attachments.js 里的脚本保持一致（改那边时这里也要同步）
const script = [
  'import sys',
  'path = sys.argv[1]',
  '',
  'def try_pymupdf():',
  '    for name in ("pymupdf", "fitz"):',
  '        try:',
  '            mod = __import__(name)',
  '        except ImportError:',
  '            continue',
  '        doc = mod.open(path)',
  '        parts = [page.get_text() or "" for page in doc]',
  '        doc.close()',
  '        return "\\n".join(parts)',
  '    return None',
  '',
  'def try_pypdf():',
  '    try:',
  '        from pypdf import PdfReader',
  '    except ImportError:',
  '        return None',
  '    reader = PdfReader(path)',
  '    return "\\n".join((p.extract_text() or "") for p in reader.pages)',
  '',
  'engine = None',
  'text = ""',
  'for label, fn in (("pymupdf", try_pymupdf), ("pypdf", try_pypdf)):',
  '    try:',
  '        got = fn()',
  '    except Exception as exc:',
  '        sys.stderr.write(f"__ENGINE_ERROR__{label}:{exc}\\n")',
  '        continue',
  '    if got is not None:',
  '        engine = label',
  '        text = got',
  '        break',
  '',
  'if engine is None:',
  '    sys.stdout.write("__NO_ENGINE__")',
  '    sys.exit(0)',
  'sys.stderr.write(f"__ENGINE__{engine}\\n")',
  'sys.stdout.write(text)',
].join('\n');

console.log('== Python ==');
console.log(`  ${pythonPath}`);

console.log('\n== 直接用 Python 跑这段脚本 ==');
try {
  const out = execFileSync(pythonPath, ['-c', script, pdfPath], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  console.log(`  stdout 长度：${out.length}`);
  console.log(`  前 200 字：${JSON.stringify(out.slice(0, 200))}`);
} catch (error) {
  console.log(`  退出码：${error.status}`);
  console.log(`  stdout：${JSON.stringify(String(error.stdout ?? '').slice(0, 300))}`);
  console.log(`  stderr：${JSON.stringify(String(error.stderr ?? '').slice(0, 800))}`);
}

console.log('\n== 只看 pymupdf 能否读这个文件 ==');
const simple = [
  'import sys',
  'import pymupdf',
  'doc = pymupdf.open(sys.argv[1])',
  'print("页数:", doc.page_count)',
  'for i, page in enumerate(doc):',
  '    t = page.get_text() or ""',
  '    print(f"第 {i+1} 页 {len(t)} 字")',
  'doc.close()',
].join('\n');
try {
  const out = execFileSync(pythonPath, ['-X', 'utf8', '-c', simple, pdfPath], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  console.log(out.trim());
} catch (error) {
  console.log(`  退出码：${error.status}`);
  console.log(`  stderr：${String(error.stderr ?? '').slice(0, 800)}`);
}
