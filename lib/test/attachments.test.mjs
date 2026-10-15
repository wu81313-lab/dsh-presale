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
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
  extractDocx, extractXlsx, extractText, extractResourceRefs,
  sanitizeFileName, hashOf, MAX_FILE_BYTES,
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

test('attachments: 能解析自己造的 docx（含段落与表格单元）', () => {
  const zip = buildZip({
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
    'xl/sharedStrings.xml': '<sst><si><t>客户名称</t></si><si><t>普瑞玛</t></si></sst>',
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
  assert.match(text, /报价 \| 客户名称 \| 普瑞玛/u);
  assert.match(text, /报价 \| 100 \| 2000/u);
  // 空行必须被跳过，否则会把字数预算吃光
  assert.equal(text.split('\n').length, 2, `实际 ${text.split('\n').length} 行`);
});

test('attachments: docx 缺少 document.xml 时明确报错，不返回空串', () => {
  const zip = buildZip({ 'word/other.xml': '<x/>' });
  assert.throws(() => extractDocx(zip), /不是有效的 docx/u);
});

test('attachments: 纯文本按 UTF-8 读，含中文', () => {
  const text = extractText(Buffer.from('产品信息：码中台对接\n数量：3 条产线', 'utf8'), 'notes.txt');
  assert.equal(text.status, 'ok');
  assert.match(text.text, /码中台对接/u);
});

test('attachments: 不支持的格式给出明确说明（而不是静默当作没内容）', () => {
  // 注意：图片**不再**属于这一类——它会走 handleImage 下载并注册给多模态模型。
  // 这里只覆盖真正无法处理的格式。
  const cases = [
    ['a.doc', /未支持的 Office 格式/u],
    ['a.pptx', /未支持的 Office 格式/u],
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
