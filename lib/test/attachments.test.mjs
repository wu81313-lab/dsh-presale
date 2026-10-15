// 附件提取的单元测试。
//
// 为什么值得单独测：docx/xlsx 的解析是手写的 zip 读取 + XML 抽取，
// 没有第三方库兜底。一旦正则或 zip 偏移写错，表现是"提取出来一堆乱码"
// 或"提取为空"——都会让模型拿到错误输入，而且不会报错。
//
// 这里用**真实文件**做回归：把采集到的样本放进 lib/test/fixtures/，
// 断言关键内容能出来。没有样本时自动跳过（仓库里不放真实业务文档）。
//
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
  extractDocx, extractPptx, extractXlsx, extractText, extractResourceRefs,
  sanitizeFileName, hashOf, sniffImageMediaType, MAX_FILE_BYTES,
} from '../attachments.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');

/** 手工造一个最小 zip（用于不依赖外部样本的测试）。 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);               // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);                 // deflate
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

test('attachments: 能解析自己造的 docx（含段落与表格单元）', () => {  const zip = buildZip({
    'word/document.xml': [
      '<w:document><w:body>',
      '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>第二段 </w:t></w:r><w:r><w:t>拼接</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '<w:p><w:r><w:t>含 &amp; 实体与 &lt;尖括号&gt;</w:t></w:r></w:p>',
      '</w:body></w:document>',
    ].join(''),
  });
  const text = extractDocx(zip);
  assert.equal(text, '第一段\n第二段 拼接\n表格单元格\n含 & 实体与 <尖括号>');
});

test('attachments: 能解析自己造的 xlsx（共享字符串 + 数字 + 空行跳过）', () => {
  const zip = buildZip({
    'xl/sharedStrings.xml': '<sst><si><t>客户名称</t></si><si><t>示例客户</t></si></sst>',
    'xl/workbook.xml': '<workbook><sheets><sheet name="报价" sheetId="1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': [
      '<worksheet><sheetData>',
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
      '<row r="2"><c r="A2"><v>100</v></c><c r="B2"><v>2000</v></c></row>',
      '<row r="3"></row>',
      '</sheetData></worksheet>',
    ].join(''),
  });
  const text = extractXlsx(zip);
  assert.match(text, /报价 \| 客户名称 \| 示例客户/u);
  assert.match(text, /报价 \| 100 \| 2000/u);
  // 空行必须被跳过，否则会把字数预算吃光
  assert.equal(text.split('\n').length, 2, `实际 ${text.split('\n').length} 行`);
});

test('attachments: docx 缺少 document.xml 时明确报错，不返回空串', () => {
  const zip = buildZip({ 'word/other.xml': '<x/>' });
  assert.throws(() => extractDocx(zip), /不是有效的 docx/u);
});

// ───────────────────────── pptx（售前方案 PPT 常见）─────────────────────────

/** 造一页幻灯片 XML。 */
function slideXml(...paragraphs) {
  return `<p:sld><p:cSld><p:spTree>${paragraphs
    .map(p => `<a:p>${p.split('|').map(t => `<a:r><a:t>${t}</a:t></a:r>`).join('')}</a:p>`)
    .join('')}</p:spTree></p:cSld></p:sld>`;
}

test('attachments: 能解析自己造的 pptx（逐页带页码）', () => {
  const zip = buildZip({
    'ppt/slides/slide1.xml': slideXml('示例项目方案|Data Matrix 打码贴标线'),
    'ppt/slides/slide2.xml': slideXml('设备清单', '合计 286200 元'),
  });
  const text = extractPptx(zip);
  assert.match(text, /【第 1 页】/u);
  assert.match(text, /【第 2 页】/u);
  assert.match(text, /Data Matrix 打码贴标线/u);
  assert.match(text, /合计 286200 元/u);
});

test('attachments: pptx 幻灯片按页码数字排序，而不是按字符串', () => {
  // 字符串排序会得到 slide1, slide10, slide11, slide2 —— 模型看到的顺序就乱了。
  // 这里刻意让 zip 里的条目顺序也是乱序的，确保实现真的按数字排。
  const zip = buildZip({
    'ppt/slides/slide10.xml': slideXml('第十页'),
    'ppt/slides/slide2.xml': slideXml('第二页'),
    'ppt/slides/slide1.xml': slideXml('第一页'),
  });
  const text = extractPptx(zip);
  const order = [...text.matchAll(/【第 (\d+) 页】/gu)].map(m => Number(m[1]));
  assert.deepEqual(order, [1, 2, 10], `实际顺序 ${JSON.stringify(order)}`);
  // 页内容也要跟着页序，不能只有标题对
  assert.ok(text.indexOf('第一页') < text.indexOf('第二页'), '第 1 页内容应在第 2 页之前');
  assert.ok(text.indexOf('第二页') < text.indexOf('第十页'), '第 2 页内容应在第 10 页之前');
});

test('attachments: pptx 带出演讲者备注，并丢掉纯页码占位', () => {
  const zip = buildZip({
    'ppt/slides/slide1.xml': slideXml('方案概览'),
    'ppt/notesSlides/notesSlide1.xml': slideXml('这页重点强调交期|3'),
    'ppt/slides/slide2.xml': slideXml('报价'),
    'ppt/notesSlides/notesSlide2.xml': slideXml('2'),
  });
  const text = extractPptx(zip);
  assert.match(text, /（第 1 页备注）/u);
  assert.match(text, /这页重点强调交期/u);
  // 只有页码数字的备注没有信息量，不该出现
  assert.ok(!text.includes('（第 2 页备注）'), '纯页码备注应被丢弃');
});

test('attachments: pptx 里 <a:br/> 要还原成换行，否则整页挤成一行', () => {
  const zip = buildZip({
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>第一行</a:t></a:r><a:br/><a:r><a:t>第二行</a:t></a:r></a:p></p:sld>',
  });
  const text = extractPptx(zip);
  assert.match(text, /第一行\n第二行/u, `实际：${JSON.stringify(text)}`);
});

test('attachments: pptx 全是图片没有文字时明确说明，不返回空串', () => {
  const zip = buildZip({ 'ppt/slides/slide1.xml': '<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>' });
  assert.throws(() => extractPptx(zip), /没有可提取的文字/u);
});

test('attachments: pptx 无 slides 时明确报错', () => {
  const zip = buildZip({ 'ppt/presentation.xml': '<p:presentation/>' });
  assert.throws(() => extractPptx(zip), /不是有效的 pptx/u);
});

test('attachments: pptx 走 extractText 分派，状态为 ok', () => {
  const zip = buildZip({ 'ppt/slides/slide1.xml': slideXml('方案要点') });
  const result = extractText(zip, '售前方案.pptx');
  assert.equal(result.status, 'ok');
  assert.match(result.text, /方案要点/u);
});

test('attachments: 旧版 .ppt 给出可行的补救建议', () => {
  const result = extractText(Buffer.from('x'), 'old.ppt');
  assert.equal(result.status, 'unsupported');
  assert.match(result.note, /旧版 Office/u);
  assert.match(result.note, /另存为 pptx/u, `实际：${result.note}`);
});

test('attachments: 纯文本按 UTF-8 读，含中文', () => {
  const text = extractText(Buffer.from('产品信息：码中台对接\n数量：3 条产线', 'utf8'), 'notes.txt');
  assert.equal(text.status, 'ok');
  assert.match(text.text, /码中台对接/u);
});

test('attachments: 不支持的格式给出明确说明（而不是静默当作没内容）', () => {
  // 注意：图片**不再**属于这一类——它会走 handleImage 下载并注册给多模态模型。
  // pptx 也已支持（见上面的 pptx 用例）。这里只覆盖真正无法处理的格式。
  const cases = [
    // 旧版 Office 二进制：文案要给出可行的补救办法，而不是只说"不支持"
    ['a.doc', /旧版 Office 二进制格式.*另存为 docx/u],
    ['a.xls', /旧版 Office 二进制格式.*另存为 xlsx/u],
    ['a.ppt', /旧版 Office 二进制格式.*另存为 pptx/u],
    ['archive.zip', /暂不支持/u],
    ['noext', /暂不支持/u],
    ['clip.mp4', /暂不支持/u],
  ];
  for (const [name, pattern] of cases) {
    const r = extractText(Buffer.from('x'), name);
    assert.equal(r.status, 'unsupported', name);
    assert.match(r.note, pattern, `${name} → ${r.note}`);
  }
});

test('attachments: 视频与语音明确标注（模型输入只有文本与图像）', async () => {
  const { createAttachments } = await import('../attachments.js');
  const attachments = createAttachments({
    getSettings: () => ({
      attachments: {
        enabled: true, maxFilesPerRun: 5, maxFileBytes: 1024, maxCharsPerFile: 100,
        maxTotalChars: 1000, cacheTtlDays: 30, maxCacheBytes: 1048576, pythonPath: '',
      },
      dwsPath: 'dws',
      poll: { commandTimeoutMs: 1000 },
    }),
    cacheDir: join(tmpdir(), `dsh-presale-media-${Date.now()}`),
    saveImage: async () => ({ attachmentId: 'x' }),
    logger: { info() {}, warn() {} },
  });
  const video = await attachments.ensureText({
    resourceId: 'video-1', kind: 'mediaId', name: '', contentType: 'video', messageId: 'm', downloadArgs: null,
  });
  assert.equal(video.status, 'unsupported');
  assert.match(video.note, /视频/u);
  assert.match(video.note, /不含视频/u);
});

test('attachments: 拿不到附件服务时，图片明确说明"未交给模型"，不假装看过', async () => {
  const { createAttachments } = await import('../attachments.js');
  const attachments = createAttachments({
    getSettings: () => ({
      attachments: {
        enabled: true, maxFilesPerRun: 5, maxFileBytes: 1024, maxCharsPerFile: 100,
        maxTotalChars: 1000, cacheTtlDays: 30, maxCacheBytes: 1048576, pythonPath: '',
      },
      dwsPath: 'dws',
      poll: { commandTimeoutMs: 1000 },
    }),
    cacheDir: join(tmpdir(), `dsh-presale-imgno-${Date.now()}`),
    saveImage: null, // 模拟 DSH 附件服务不可用
    logger: { info() {}, warn() {} },
  });
  const image = await attachments.ensureText({
    resourceId: 'img-1', kind: 'mediaId', name: 'photo.png', contentType: 'image', messageId: 'm', downloadArgs: null,
  });
  assert.equal(image.status, 'unsupported');
  assert.match(image.note, /附件服务不可用/u);
  assert.match(image.note, /未交给模型/u);
});

test('attachments: 按文件头识别图片格式（元数据不可信）', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
  const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(12)]);

  assert.equal(sniffImageMediaType(png), 'image/png');
  assert.equal(sniffImageMediaType(jpeg), 'image/jpeg');
  assert.equal(sniffImageMediaType(gif), 'image/gif');
  assert.equal(sniffImageMediaType(webp), 'image/webp');
  assert.equal(sniffImageMediaType(bmp), 'image/bmp');

  // 非图片必须返回空串，不能瞎认
  assert.equal(sniffImageMediaType(Buffer.from('PK\u0003\u0004rest-of-zip')), '', 'zip 不该被当图片');
  assert.equal(sniffImageMediaType(Buffer.from('just some plain text here')), '');
  assert.equal(sniffImageMediaType(Buffer.alloc(3)), '', '太短无法判定');
});

test('attachments: 缺 contentType 的 .bin 其实是图片时，走图片路径而不是报"不支持"', async () => {
  // 复现真实场景：钉钉对同一张图给两个 resourceId，其中一个没有 contentType、
  // 也没有文件名，落盘成 .bin。按扩展名判就会被拒掉——但字节是 PNG，
  // 所以必须走图片路径。（实测踩到过：同一张图一条路读到了、另一条报不支持。）
  const { createAttachments, sniffImageMediaType } = await import('../attachments.js');
  const cacheDir = join(tmpdir(), `dsh-presale-sniff-${Date.now()}`);
  mkdirSync(join(cacheDir, 'extract'), { recursive: true });

  let saved = 0;
  const attachments = createAttachments({
    getSettings: () => ({
      attachments: {
        enabled: true, maxFilesPerRun: 5, maxFileBytes: 1024, maxCharsPerFile: 100,
        maxTotalChars: 1000, cacheTtlDays: 30, maxCacheBytes: 1048576, pythonPath: '',
      },
      dwsPath: 'dws',
      poll: { commandTimeoutMs: 1000 },
    }),
    cacheDir,
    saveImage: async () => { saved += 1; return { attachmentId: 'sha256:fake', mediaType: 'image/png', width: 10, height: 10, bytes: 100 }; },
    logger: { info() {}, warn() {} },
  });

  // 预置"已下载成 .bin 的 PNG"缓存，让 ensureText 命中缓存字节而不去联网
  const resourceId = 'bin-that-is-actually-png';
  const hash = hashOf(resourceId);
  mkdirSync(join(cacheDir, hash), { recursive: true });
  writeFileSync(join(cacheDir, hash, `${hash}.bin`),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120)]));
  writeFileSync(join(cacheDir, hash, 'meta.json'), JSON.stringify({
    resourceId, fileName: `${hash}.bin`, originalName: '', size: 128,
  }), 'utf8');

  const ref = { resourceId, kind: 'mediaId', name: '', contentType: '', messageId: 'm', downloadArgs: null };
  const result = await attachments.ensureText(ref);

  assert.equal(result.status, 'image', `应识别为图片，实际 ${result.status}｜${result.note}`);
  assert.match(result.note, /已交给模型查看/u);
  assert.equal(saved, 1, '应调用一次 saveImage');
});

test('attachments: 无 Python 时 PDF 明确标注原因', () => {
  const r = extractText(Buffer.from('%PDF-1.4'), 'spec.pdf', { pythonPath: '' });
  assert.equal(r.status, 'unsupported');
  assert.match(r.note, /未配置 Python/u);
});

test('attachments: 从消息与其引用消息里都能取到文件引用', () => {
  const raw = {
    messageId: 'msgA',
    text: '@张三 张工，可以提供下这个图纸吗',
    quotedMessage: {
      messageId: 'msgB',
      resourceRefs: [
        { resourceId: 'id-1', resourceIdType: 'fileId', name: 'main requirement.docx', contentType: 'file' },
        { resourceId: 'id-2', resourceIdType: 'fileId', name: '报价.xlsx', contentType: 'file' },
      ],
    },
  };
  const refs = extractResourceRefs(raw);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].name, 'main requirement.docx');
  assert.equal(refs[0].messageId, 'msgB', '来自引用消息时应记住它自己的 messageId');
});

test('attachments: 同一资源出现多次只返回一次', () => {
  const raw = {
    messageId: 'msgA',
    resourceRefs: [{ resourceId: 'dup', name: 'a.docx' }],
    quotedMessage: { messageId: 'msgB', resourceRefs: [{ resourceId: 'dup', name: 'a.docx' }] },
  };
  assert.equal(extractResourceRefs(raw).length, 1);
});

test('attachments: 没有附件时返回空数组', () => {
  assert.deepEqual(extractResourceRefs({ messageId: 'x', text: '普通消息' }), []);
  assert.deepEqual(extractResourceRefs(null), []);
});

test('attachments: 文件名消毒挡住路径穿越', () => {
  assert.equal(sanitizeFileName('../../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\Windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(sanitizeFileName('..\\..\\boot.ini'), 'boot.ini');
  assert.equal(sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(sanitizeFileName('...hidden.docx'), 'hidden.docx');
  assert.equal(sanitizeFileName(''), 'unnamed');
  assert.equal(sanitizeFileName(null), 'unnamed');
});

test('attachments: 超长文件名截断后保留扩展名', () => {
  const long = `${'x'.repeat(300)}.docx`;
  const safe = sanitizeFileName(long);
  assert.ok(safe.length <= 180, `长度 ${safe.length}`);
  assert.ok(safe.endsWith('.docx'), safe.slice(-10));
});

test('attachments: 同一 resourceId 的哈希稳定，不同 id 不同', () => {
  assert.equal(hashOf('abc'), hashOf('abc'));
  assert.notEqual(hashOf('abc'), hashOf('abd'));
  assert.equal(hashOf('abc').length, 12);
});

test('attachments: 体积上限是 10MB', () => {
  assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
});

// ── 真实样本回归（有样本才跑）─────────────────────────────────
const DOCX_SAMPLE = join(FIXTURES, 'sample.docx');
const XLSX_SAMPLE = join(FIXTURES, 'sample.xlsx');

test('attachments: 真实 docx 样本能提取出中文正文', { skip: !existsSync(DOCX_SAMPLE) }, () => {
  const buffer = readFileSync(DOCX_SAMPLE);
  const text = extractDocx(buffer);
  assert.ok(text.length > 500, `提取到 ${text.length} 字，偏少`);
  assert.ok(/[\u4e00-\u9fff]/u.test(text), '应当含中文');
  assert.ok(!text.includes('<w:'), '不应残留 XML 标签');
});

test('attachments: 真实 xlsx 样本能提取出表格行', { skip: !existsSync(XLSX_SAMPLE) }, () => {
  const buffer = readFileSync(XLSX_SAMPLE);
  const text = extractXlsx(buffer);
  assert.ok(text.length > 0, '不应为空');
  assert.ok(!text.includes('<c '), '不应残留 XML 标签');
});
