// 附件处理：把钉钉消息里的文件取到本地并提取出文本，供模型阅读。
//
// ── 为什么需要这一层 ───────────────────────────────────────────
//
// 钉钉服务端**没有「在线读文件正文」的接口**：文件是不透明的附件，
// 只能先取到本地字节，再解析。dws 提供了 `+messages-resource-download`，
// 而消息里本来就带着下载句柄（resourceRefs）。
//
// 之前的实现在消息归一化时把 resourceRefs 整个丢掉了，结果模型只看到
// `[文件] main requirement.docx fileId: xxx` 这一行字——文件名有了，
// 内容一个字都没进去，于是总结只能写「文件无法读取，请重新上传」。
//
// ── 落点 ──────────────────────────────────────────────────────
//
// dws 的 --output 只接受**工作目录内的相对路径**，所以落点由 cwd 决定。
// 这里把 cwd 显式设成 staging 子目录，落点因此完全可预测：
//
//   <cacheDir>/<hash12>/<原文件名>     原件
//   <cacheDir>/<hash12>/meta.json      元信息
//   <cacheDir>/extract/<hash12>.txt    提取出的正文
//
// <hash12> 是 resourceId 的哈希前缀。用哈希而不是原文件名做目录名，
// 既避免同名文件互相覆盖，也避免文件名里的 `..` 造成路径穿越。
//
// ── 缓存 ──────────────────────────────────────────────────────
//
// 同一个 fileId 反复出现时，第二轮起直接命中本地缓存，不再走网络。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { runDws } from './dws.js';
import { truncate } from './util.js';

/** 判断是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 单文件体积上限（字节）。超过就跳过——防某个大文件拖死一轮梳理。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 单轮最多处理的文件数。防止一个群刷了几十个附件的极端情况。 */
export const MAX_FILES_PER_RUN = 5;
/** 注入给模型的总字数上限。超出会按文件顺序截断，并**显式告知**。 */
export const MAX_TOTAL_CHARS = 30000;
/** 缓存有效期（毫秒）：超期重新下载，防群里文件被替换后仍读旧内容。 */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 缓存总量上限（字节）：超出按最久未访问淘汰。 */
export const MAX_CACHE_BYTES = 200 * 1024 * 1024;

/** 可直接按纯文本读取的扩展名。 */
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml', '.ini']);
/** 图片扩展名：只登记不解析（当前 LLM 通道是纯文本）。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.heic']);

/** 取小写扩展名（含点）。 */
function extOf(name) {
  const m = /\.[A-Za-z0-9]+$/u.exec(name ?? '');
  return m === null ? '' : m[0].toLowerCase();
}

/**
 * 推断图片的 MIME 类型。
 *
 * 优先看文件头（magic bytes）而不是扩展名：钉钉图片经常没有文件名
 * （mediaId 资源就是），而且扩展名不可信。DSH 只接受
 * image/png、image/jpeg、image/webp、image/gif 四种。
 *
 * @param {string} fileName - 文件名（可能为空）。
 * @param {Buffer} buffer - 图片字节。
 * @returns {string} MIME 类型。
 */
function guessImageMediaType(fileName, buffer) {
  if (buffer.length >= 8) {
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
    // WEBP: RIFF....WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  }
  const ext = extOf(fileName);
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp' || ext === '.heic') {
    // DSH 不接受这两种；交给它自己报错，好过我们悄悄换一个格式骗过去
    return ext === '.bmp' ? 'image/bmp' : 'image/heic';
  }
  return 'image/png';
}

/** resourceId → 稳定的目录名。 */
export function hashOf(resourceId) {
  return createHash('sha1').update(String(resourceId)).digest('hex').slice(0, 12);
}

/**
 * 把文件名消毒成可安全落盘的形式。
 *
 * 只保留基名并剔除路径分隔符与 Windows 非法字符。文件名来自群消息，
 * 属于不可信输入，不该把"能否穿越目录"的赌注押在 dws 自己也会拒绝上。
 *
 * @param {string} name - 原始文件名。
 * @returns {string} 可安全使用的文件名。
 */
export function sanitizeFileName(name) {
  const base = String(name ?? '')
    .split(/[\\/]/u).pop()
    .replace(/[\u0000-\u001f<>:"|?*]/gu, '_')
    .replace(/^\.+/u, '')
    .trim();
  const safe = base.length > 0 ? base : 'unnamed';
  // 给扩展名留空间，避免截断把后缀切掉导致类型判断失效
  return safe.length > 180 ? `${safe.slice(0, 170)}${extOf(safe)}` : safe;
}

/**
 * 从一条原始 dws 消息里提取资源引用。
 *
 * 必须**同时**看消息本身与它引用的消息：需求文档常常是被引用的那一条。
 * 本次踩到的正是这种情况——正文只有「@张三 张工，可以提供下这个图纸吗」，
 * 真正的需求文档在 quotedMessage 里。
 *
 * 钉钉把两类资源混在同一个 resourceRefs 里，形状不同：
 *   · 文件：{type:'fileId', name:'x.docx', download.arguments:{resource-id, type:'fileId'}}
 *   · 图片：{type:'mediaId', contentType:'image', download.arguments:{message-id,
 *            open-conversation-id, resource-id, type:'mediaId'}}   ← 没有 name
 *
 * 所以这里**直接保留 download.arguments**：那是钉钉给的权威参数，
 * 自己按字段拼容易漏（曾经就漏了 mediaId 必需的 message-id，导致图片下载报错）。
 *
 * @param {object} raw - dws 返回的原始消息对象。
 * @returns {Array<{resourceId: string, kind: string, name: string, contentType: string,
 *   messageId: string, downloadArgs: object|null}>}
 */
export function extractResourceRefs(raw) {
  const out = [];
  const seen = new Set();

  const collect = (holder, fallbackMessageId) => {
    if (!isPlainObject(holder)) return;
    const refs = holder.resourceRefs;
    if (!Array.isArray(refs)) return;
    for (const ref of refs) {
      if (!isPlainObject(ref)) continue;
      const resourceId = typeof ref.resourceId === 'string' ? ref.resourceId.trim() : '';
      if (resourceId.length === 0 || seen.has(resourceId)) continue;
      seen.add(resourceId);

      const messageId = typeof holder.messageId === 'string' && holder.messageId.length > 0
        ? holder.messageId
        : (typeof fallbackMessageId === 'string' ? fallbackMessageId : '');
      const downloadArgs = isPlainObject(ref.download?.arguments) ? ref.download.arguments : null;
      // type 可能出现在顶层，也可能只在 download.arguments 里
      const kind = typeof ref.type === 'string' && ref.type.length > 0
        ? ref.type
        : (typeof downloadArgs?.type === 'string' && downloadArgs.type.length > 0 ? downloadArgs.type : 'fileId');

      out.push({
        resourceId,
        kind,
        name: typeof ref.name === 'string' ? ref.name : '',
        contentType: typeof ref.contentType === 'string' ? ref.contentType : '',
        messageId,
        downloadArgs,
      });
    }
  };

  collect(raw, '');
  collect(raw?.quotedMessage, '');
  return out;
}

// ───────────────────────── zip 读取（docx/xlsx 的底座）─────────────────────────

/** 找到中央目录结束记录的位置。 */
function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** 遍历中央目录，返回每个条目的名字与本地数据起点。 */
function* zipEntries(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  if (end === -1) return;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count && offset + 46 <= buffer.length; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    if (localOffset + 30 <= buffer.length) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      yield { name, method, compressedSize, dataStart };
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
}

/** 读取一个 zip 条目的文本内容；不存在返回 null。 */
function readZipEntry(buffer, entryName) {
  for (const entry of zipEntries(buffer)) {
    if (entry.name !== entryName) continue;
    const raw = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    // store(0) 原样；deflate(8) 解压。office 文档只用这两种。
    const bytes = entry.method === 0 ? raw : inflateRawSync(raw);
    return bytes.toString('utf8');
  }
  return null;
}

/** 按正则列出 zip 内的条目名。 */
function listZipEntryNames(buffer) {
  const names = [];
  for (const entry of zipEntries(buffer)) names.push(entry.name);
  return names;
}

// ───────────────────────── 文本提取 ─────────────────────────

/** 解开 XML 里最常见的实体（&amp; 必须最后处理，否则会二次解码）。 */
function decodeXml(text) {
  return String(text)
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gu, '&');
}

/** 从一组 `<w:t>` / `<t>` 片段里拼出纯文本。 */
function joinXmlTexts(chunk, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gu');
  const parts = chunk.match(re) ?? [];
  return parts
    .map(p => p.replace(new RegExp(`^<${tag}(?:\\s[^>]*)?>`, 'u'), '').replace(new RegExp(`</${tag}>$`, 'u'), ''))
    .map(decodeXml)
    .join('');
}

/**
 * 从 docx 提取正文。
 *
 * docx 就是一个 zip，正文在 word/document.xml。零依赖即可解析——
 * 插件的依赖越少，别人的安装越不容易出问题。表格单元格也是 <w:p>，
 * 会被自然纳入。
 *
 * @param {Buffer} buffer - 文件字节。
 * @returns {string} 纯文本正文。
 */
export function extractDocx(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (xml === null) throw new Error('不是有效的 docx（缺少 word/document.xml）');
  return xml
    .split('</w:p>')
    .map(chunk => joinXmlTexts(chunk, 'w:t').trim())
    .filter(line => line.length > 0)
    .join('\n');
}

/**
 * 从 xlsx 提取单元格文本。
 *
 * 输出成 `Sheet1 | A | B | C` 这种近似 CSV 的行，模型读起来最顺。
 * 字符串存于 sharedStrings，单元格里只放下标；数字与布尔值直接写在 <v>。
 *
 * @param {Buffer} buffer - 文件字节。
 * @returns {string} 表格文本。
 */
export function extractXlsx(buffer) {
  const sharedXml = readZipEntry(buffer, 'xl/sharedStrings.xml');
  const shared = [];
  if (sharedXml !== null) {
    for (const si of sharedXml.match(/<si>([\s\S]*?)<\/si>/gu) ?? []) {
      shared.push(joinXmlTexts(si, 't'));
    }
  }

  const workbook = readZipEntry(buffer, 'xl/workbook.xml');
  const sheetNames = workbook === null
    ? []
    : (workbook.match(/<sheet\b[^>]*>/gu) ?? [])
      .map(tag => decodeXml(/name="([^"]*)"/u.exec(tag)?.[1] ?? ''));

  const lines = [];
  const sheetFiles = listZipEntryNames(buffer)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/u.test(n))
    .sort((a, b) => Number(/(\d+)/u.exec(a)?.[1] ?? 0) - Number(/(\d+)/u.exec(b)?.[1] ?? 0));

  sheetFiles.forEach((file, index) => {
    const sheetName = sheetNames[index] ?? `Sheet${index + 1}`;
    const xml = readZipEntry(buffer, file);
    if (xml === null) return;
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/gu) ?? []) {
      const cells = [];
      for (const cell of row.match(/<c\b[\s\S]*?<\/c>/gu) ?? []) {
        const attrs = /^<c\b([^>]*)/u.exec(cell)?.[1] ?? '';
        const type = /t="([^"]*)"/u.exec(attrs)?.[1] ?? '';
        const valueTag = /<v>([\s\S]*?)<\/v>/u.exec(cell);
        let value = valueTag === null ? '' : decodeXml(valueTag[1]);
        if (type === 's') {
          const idx = Number(value);
          value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
        } else if (type === 'inlineStr') {
          value = joinXmlTexts(cell, 't');
        }
        cells.push(value);
      }
      const line = cells.join(' | ').trim();
      // 跳过空行：xlsx 里大量空行会把字数预算吃光
      if (line.replace(/[|\s]/gu, '').length > 0) lines.push(`${sheetName} | ${line}`);
    }
  });
  return lines.join('\n');
}

/** 解码纯文本（UTF-8 优先，出现替换字符则退回 GBK）。 */
function decodePlainText(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/**
 * 尝试用 Python 提取 PDF 文本。
 *
 * Python 做成**可选**而不是硬依赖：找不到就明确标注「未能提取（缺解析器）」，
 * 绝不假装读过——把"没读到"伪装成"读到了但没内容"会直接误导判断。
 *
 * @param {string} filePath - PDF 路径。
 * @param {string} pythonPath - Python 可执行文件（可为空）。
 * @returns {{ok: true, text: string}|{ok: false, reason: string}}
 */
function extractPdfViaPython(filePath, pythonPath) {
  if (typeof pythonPath !== 'string' || pythonPath.length === 0 || !existsSync(pythonPath)) {
    return { ok: false, reason: '本机未配置 Python 路径，无法解析 PDF' };
  }
  const script = [
    'import sys',
    'try:',
    '    from pypdf import PdfReader',
    'except ImportError:',
    '    print("__NO_PYPDF__"); sys.exit(0)',
    'r = PdfReader(sys.argv[1])',
    'print("\\n".join((p.extract_text() or "") for p in r.pages))',
  ].join('\n');
  try {
    const out = execFileSync(pythonPath, ['-c', script, filePath], {
      encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    });
    if (out.includes('__NO_PYPDF__')) return { ok: false, reason: 'Python 里没有 pypdf 模块，无法解析 PDF' };
    const text = out.trim();
    if (text.length === 0) return { ok: false, reason: 'PDF 里没有可提取的文字（可能是扫描件）' };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: `PDF 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 按扩展名提取文本。
 *
 * @param {Buffer} buffer - 文件字节。
 * @param {string} fileName - 原始文件名。
 * @param {{pythonPath?: string, filePath?: string}} [options] - PDF 需要真实路径。
 * @returns {{status: 'ok'|'unsupported'|'empty', text: string, note: string}}
 */
export function extractText(buffer, fileName, options = {}) {
  const ext = extOf(fileName);
  try {
    if (ext === '.docx') {
      const text = extractDocx(buffer);
      return { status: text.length > 0 ? 'ok' : 'empty', text, note: text.length > 0 ? '' : 'docx 里没有文字' };
    }
    if (ext === '.xlsx') {
      const text = extractXlsx(buffer);
      return { status: text.length > 0 ? 'ok' : 'empty', text, note: text.length > 0 ? '' : '表格里没有内容' };
    }
    if (TEXT_EXTS.has(ext)) {
      const text = decodePlainText(buffer);
      return { status: text.trim().length > 0 ? 'ok' : 'empty', text, note: '' };
    }
    if (IMAGE_EXTS.has(ext)) {
      return {
        status: 'unsupported',
        text: '',
        note: '图片内容未解析（阅读图片需要多模态通道，当前模型调用是纯文本）',
      };
    }
    if (ext === '.pdf') {
      const result = extractPdfViaPython(options.filePath ?? '', options.pythonPath);
      return result.ok
        ? { status: 'ok', text: result.text, note: '' }
        : { status: 'unsupported', text: '', note: result.reason };
    }
    if (ext === '.doc' || ext === '.xls' || ext === '.ppt' || ext === '.pptx') {
      return { status: 'unsupported', text: '', note: `未支持的 Office 格式（${ext}），请另存为 docx/xlsx` };
    }
    return { status: 'unsupported', text: '', note: `暂不支持的文件类型（${ext || '无扩展名'}）` };
  } catch (error) {
    return { status: 'unsupported', text: '', note: `解析出错：${error instanceof Error ? error.message : String(error)}` };
  }
}

// ───────────────────────── 缓存与下载 ─────────────────────────

/**
 * 建立附件处理器。
 *
 * @param {object} options
 * @param {() => object} options.getSettings - 当前设置。
 * @param {string} options.cacheDir - 缓存根目录（绝对路径）。
 * @param {Function|null} [options.saveImage] - DSH 附件服务的 saveImage，用来把图片
 *   注册成模型可读的附件引用。没有它就只能登记"有图片"而无法让模型看到。
 * @param {{info?: Function, warn?: Function}} [options.logger] - 日志。
 * @returns {{collect: Function, ensureText: Function, download: Function, stats: Function, prune: Function, clear: Function, cacheDir: string}}
 */
export function createAttachments({ getSettings, cacheDir, saveImage = null, logger = console } = {}) {
  const extractDir = join(cacheDir, 'extract');

  /** 确保缓存目录存在。 */
  function ensureDirs() {
    for (const dir of [cacheDir, extractDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  /** 读某个资源已缓存的原件路径（不存在或超期返回 null）。 */
  function cachedOriginal(resourceId, ttlMs) {
    const dir = join(cacheDir, hashOf(resourceId));
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const filePath = join(dir, meta.fileName);
      if (!existsSync(filePath)) return null;
      const stat = statSync(filePath);
      // 超期 → 视为未命中，重新下载（群里文件可能被替换）
      if (ttlMs > 0 && Date.now() - stat.mtimeMs > ttlMs) return null;
      return { dir, filePath, meta, size: stat.size };
    } catch {
      return null;
    }
  }

  /** 记录一次访问时间，供 LRU 淘汰使用。 */
  function touch(dir) {
    try {
      const now = Date.now();
      writeFileSync(join(dir, '.used'), String(now), 'utf8');
      // 同时把 mtime 拉新，便于用系统工具排查
      const utimes = now / 1000;
      // eslint-disable-next-line no-undef
      require('node:fs').utimesSync(join(dir, '.used'), utimes, utimes);
    } catch {
      /* 记录访问时间失败不影响功能 */
    }
  }

  /** 取目录的最后访问时间（没有记就退回 mtime）。 */
  function lastUsedMs(dir) {
    try {
      const usedPath = join(dir, '.used');
      if (existsSync(usedPath)) return Number(readFileSync(usedPath, 'utf8')) || 0;
      return statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 下载一个资源到缓存目录。
   *
   * @param {object} ref - extractResourceRefs 产出的引用。
   * @returns {Promise<{ok: true, filePath: string, fromCache: boolean, size: number, fileName: string}
   *   | {ok: false, reason: string}>}
   */
  async function download(ref) {
    const settings = getSettings();
    const ttl = Number(settings?.attachments?.cacheTtlDays ?? 30) * 24 * 60 * 60 * 1000;
    const cached = cachedOriginal(ref.resourceId, ttl);
    if (cached !== null) {
      touch(cached.dir);
      return { ok: true, filePath: cached.filePath, fromCache: true, size: cached.size, fileName: cached.meta.fileName };
    }

    ensureDirs();
    const hash = hashOf(ref.resourceId);
    const dir = join(cacheDir, hash);
    const fileName = sanitizeFileName(ref.name.length > 0 ? ref.name : `${hash}.bin`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // 参数以钉钉给的 download.arguments 为准（那份是权威的，含 mediaId 必需的
    // message-id / open-conversation-id）；没有就退化成文件下载。
    const args = ['chat', '+messages-resource-download'];
    const da = isPlainObject(ref.downloadArgs) ? ref.downloadArgs : null;
    if (da !== null && typeof da.type === 'string' && da.type.length > 0) {
      args.push('--type', da.type);
      for (const key of ['resource-id', 'message-id', 'open-conversation-id']) {
        const value = da[key];
        if (typeof value === 'string' && value.length > 0) args.push(`--${key}`, value);
      }
    } else {
      args.push('--type', ref.kind === 'mediaId' ? 'mediaId' : 'fileId', '--resource-id', ref.resourceId);
      if (ref.kind === 'mediaId') {
        if (ref.messageId.length > 0) args.push('--message-id', ref.messageId);
        // 会话 ID 在扫描阶段由调用方补；缺了 dws 会报错，这里如实回报
      }
    }
    // --output 只接受工作目录内的相对路径，所以 cwd 必须设成缓存根目录
    args.push('--output', `./${hash}/${fileName}`, '-f', 'json');

    const result = await runDws({
      dwsPath: settings?.dwsPath ?? 'dws',
      args,
      timeoutMs: settings?.poll?.commandTimeoutMs ?? 60000,
      cwd: cacheDir,
      logger,
    });

    if (!result.ok) return { ok: false, reason: `下载失败：${result.message}` };

    let filePath = join(dir, fileName);
    if (!existsSync(filePath)) {
      // dws 有时会把文件放在 --output 指定的目录下并用它自己的名字命名
      const landed = findFileIn(dir);
      if (landed === null) return { ok: false, reason: '下载命令成功但没找到落地文件' };
      filePath = landed;
    }
    const size = statSync(filePath).size;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      resourceId: ref.resourceId,
      kind: ref.kind,
      fileName,
      originalName: ref.name,
      size,
      downloadedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    touch(dir);
    return { ok: true, filePath, fromCache: false, size, fileName };
  }

  /** 在目录里找一个非 meta 文件（应对 dws 自己命名的情况）。 */
  function findFileIn(dir) {
    try {
      for (const name of readdirSync(dir)) {
        if (name === 'meta.json' || name === '.used') continue;
        const p = join(dir, name);
        if (statSync(p).isFile()) return p;
      }
    } catch {
      /* 目录读不到就当没找到 */
    }
    return null;
  }

  /**
   * 处理一张图片：下载 → 注册成 DSH 附件 → 供模型直接查看。
   *
   * 为什么要走 DSH 的 attachments 服务而不是直接把字节塞给 stream：
   * 图片要先经它做校验与归一化（尺寸、像素、体积、把 webp/gif 之类统一处理），
   * 然后以 `{type:'image', attachment}` 内容块的形式交给适配器，
   * 适配器再决定是内联还是走文件 ID。绕过它就得自己实现这些，容易出错。
   *
   * 附件引用会连图片原始字节一起缓存在本地，因此第二轮不再下载、也不再重复注册。
   *
   * @param {object} ref - 资源引用。
   * @param {object} ctxIn - {displayName, extractPath, settings}。
   * @returns {Promise<object>} 与其他附件同形状的结果，额外带 image 字段。
   */
  async function handleImage(ref, { displayName, extractPath, settings }) {
    // 缓存里已有可用引用 → 直接复用（连下载都省了）
    if (existsSync(extractPath)) {
      try {
        const cached = JSON.parse(readFileSync(extractPath, 'utf8'));
        if (cached.status === 'image' && cached.image !== null && cached.image !== undefined) {
          return { ...cached, name: displayName, fromCache: true };
        }
      } catch {
        /* 缓存坏了就重算 */
      }
    }

    if (saveImage === null || typeof saveImage !== 'function') {
      const note = '图片已登记但未交给模型：DSH 附件服务不可用（无法注册图片引用）';
      return { name: displayName, status: 'unsupported', text: '', note, size: 0, fromCache: false, error: '' };
    }

    const downloaded = await download(ref);
    if (!downloaded.ok) {
      return { name: displayName, status: 'error', text: '', note: downloaded.reason, size: 0, fromCache: false, error: downloaded.reason };
    }

    let buffer;
    try {
      buffer = readFileSync(downloaded.filePath);
    } catch (error) {
      return {
        name: displayName, status: 'error', text: '',
        note: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        size: downloaded.size, fromCache: downloaded.fromCache, error: 'E_READ',
      };
    }

    const mediaType = guessImageMediaType(downloaded.fileName, buffer);
    try {
      const imageRef = await saveImage({ data: buffer, mediaType, name: downloaded.fileName });
      const record = {
        status: 'image',
        text: '',
        note: `已交给模型查看（${mediaType}，${(downloaded.size / 1024).toFixed(1)}KB）`,
        size: downloaded.size,
        image: imageRef,
        extractedAt: new Date().toISOString(),
      };
      try {
        ensureDirs();
        writeFileSync(extractPath, JSON.stringify(record), 'utf8');
      } catch {
        /* 写缓存失败不影响本次使用 */
      }
      return { ...record, name: displayName, fromCache: downloaded.fromCache, error: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 把失败原因如实回报：可能是尺寸超限、格式不被接受等
      return {
        name: displayName, status: 'unsupported', text: '',
        note: `图片未能注册给模型：${message}`,
        size: downloaded.size, fromCache: downloaded.fromCache, error: '',
      };
    }
  }

  /**
   * 确保某个附件已有可读文本。
   *
   * 流程（**顺序很关键**）：
   *   ① 读提取缓存 → 命中直接返回
   *   ② 媒体类型（图片/视频/语音）短路，不下载
   *   ③ 下载 → 提取 → 缓存结论
   *
   * 为什么①必须在②之前：图片短路**也要写缓存**，但如果先短路再读缓存，
   * 每次都直接 return，永远读不到刚写下的结论，表现为每轮都重新评估一遍、
   * `fromCache` 永远为 false。（这个顺序 bug 已实测踩到过。）
   *
   * @param {object} ref - 资源引用。
   * @returns {Promise<{name: string, status: string, text: string, note: string,
   *   size: number, fromCache: boolean, error: string}>}
   */
  async function ensureText(ref) {
    const displayName = ref.name.length > 0
      ? ref.name
      : (ref.contentType.length > 0 ? `（${ref.contentType}，无文件名）` : `（无文件名资源 ${hashOf(ref.resourceId)}）`);
    const settings = getSettings();
    const extractPath = join(extractDir, `${hashOf(ref.resourceId)}.txt`);

    // ① 提取结果永久缓存：文本很小，而重新下载+解析的代价大得多。
    //    不支持的结论也要缓存——否则每轮梳理都会把同样的图片重新评估/下载一遍。
    if (existsSync(extractPath)) {
      try {
        const cached = JSON.parse(readFileSync(extractPath, 'utf8'));
        return { ...cached, name: displayName, fromCache: true };
      } catch {
        /* 缓存坏了就重算 */
      }
    }

    // ② 图片：**要下载**，但目的不是提取文字，而是交给多模态模型直接看。
    //    deepseek-v4.1-flash 的模型目录声明了 inputModalities: ['text','image']，
    //    DSH 也有 attachments 服务把字节日志化。所以这里是"登记成模型可读的附件"，
    //    而不是"读不出文字就放弃"。（先前误判为不支持，是只看了适配器里拒绝图片的
    //    那几行，漏了它同时也有完整的图片通道。）
    const isImage = ref.contentType === 'image' || IMAGE_EXTS.has(extOf(ref.name));
    if (isImage) {
      return await handleImage(ref, { displayName, extractPath, settings });
    }

    // 视频/语音无法用当前通道处理：模型是文本+图像输入，不含视频与音频
    if (ref.contentType === 'video' || ref.contentType === 'audio') {
      const label = ref.contentType === 'video' ? '视频' : '语音';
      const note = `${label}内容未解析（当前模型只支持文本与图像输入，不含${label}）`;
      try {
        ensureDirs();
        writeFileSync(extractPath, JSON.stringify({
          status: 'unsupported', text: '', note, size: 0, extractedAt: new Date().toISOString(),
        }), 'utf8');
      } catch {
        /* 写缓存失败不影响本次结果 */
      }
      return { name: displayName, status: 'unsupported', text: '', note, size: 0, fromCache: false, error: '' };
    }

    const maxBytes = Number(settings?.attachments?.maxFileBytes ?? MAX_FILE_BYTES);
    const downloaded = await download(ref);
    if (!downloaded.ok) {
      return { name: displayName, status: 'error', text: '', note: downloaded.reason, size: 0, fromCache: false, error: downloaded.reason };
    }
    if (downloaded.size > maxBytes) {
      const reason = `文件 ${(downloaded.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB，已跳过`;
      return { name: displayName, status: 'skipped', text: '', note: reason, size: downloaded.size, fromCache: downloaded.fromCache, error: '' };
    }

    let buffer;
    try {
      buffer = readFileSync(downloaded.filePath);
    } catch (error) {
      return {
        name: displayName, status: 'error', text: '',
        note: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        size: downloaded.size, fromCache: downloaded.fromCache, error: 'E_READ',
      };
    }

    const extracted = extractText(buffer, downloaded.fileName, {
      pythonPath: settings?.attachments?.pythonPath ?? '',
      filePath: downloaded.filePath,
    });

    const record = {
      status: extracted.status,
      text: truncate(extracted.text, Number(settings?.attachments?.maxCharsPerFile ?? 12000)),
      note: extracted.note,
      size: downloaded.size,
      extractedAt: new Date().toISOString(),
    };
    try {
      ensureDirs();
      writeFileSync(extractPath, JSON.stringify(record), 'utf8');
    } catch {
      /* 写缓存失败不影响本次使用 */
    }
    return { ...record, name: displayName, fromCache: downloaded.fromCache, error: '' };
  }

  /**
   * 批量取附件文本，并给出可直接拼进提示词的内容块。
   *
   * @param {Array<object>} refs - 资源引用数组。
   * @returns {Promise<{results: object[], block: string, summary: string}>}
   */
  async function collect(refs) {
    const settings = getSettings();
    const list = Array.isArray(refs) ? refs : [];
    const maxFiles = Number(settings?.attachments?.maxFilesPerRun ?? MAX_FILES_PER_RUN);
    const chosen = list.slice(0, Math.max(0, maxFiles));
    const skippedForCount = list.length - chosen.length;

    const results = [];
    for (const ref of chosen) {
      // 串行处理：并发下载容易触发限流，而且文件本身不多
      // eslint-disable-next-line no-await-in-loop
      results.push(await ensureText(ref));
    }

    // 组装给模型的内容块（带字数预算）
    const budget = Number(settings?.attachments?.maxTotalChars ?? MAX_TOTAL_CHARS);
    const lines = ['=== 附件内容开始 ==='];
    const images = [];
    let truncatedCount = 0;

    // 字数预算的分配方式：**按需均分**，而不是顺序吃。
    //
    // 顺序吃有个隐蔽后果：前面那份文档把预算用完后，后面所有文件都只能写
    // 「未附正文」——于是"后面那些文件里写了什么"成了盲区，而用户完全不知道
    // 漏了哪些重点。均分能保证每份都露个头；富余的额度再按需补给还没放完的文件。
    //
    // （这个思路来自 dsh-project 的做法，对比时发现它比我的更公平。）
    const textItems = results.filter(r => r.status === 'ok' && r.text.length > 0);
    const totalWanted = textItems.reduce((sum, r) => sum + r.text.length, 0);
    const share = textItems.length === 0
      ? 0
      : Math.max(200, Math.floor(Math.min(budget, totalWanted) / textItems.length));

    /** 每个文件实际能放多少字。 */
    const allowance = new Map();
    for (const item of textItems) allowance.set(item, Math.min(item.text.length, share));
    // 把用不完的额度（短文件剩下的）再分给还能用的长文件，反复几轮直到收敛
    for (let round = 0; round < 4; round += 1) {
      const spare = budget - [...allowance.values()].reduce((a, b) => a + b, 0);
      const hungry = textItems.filter(r => allowance.get(r) < r.text.length);
      if (spare <= 0 || hungry.length === 0) break;
      const extra = Math.floor(spare / hungry.length);
      if (extra <= 0) break;
      for (const item of hungry) {
        const before = allowance.get(item);
        const after = Math.min(item.text.length, before + extra);
        allowance.set(item, after);
        if (after === before) break; // 已到顶，下一轮会把它排除
      }
    }

    for (const item of results) {
      if (item.status === 'image' && item.image !== null && item.image !== undefined) {
        // 图片不是"内容块文本"，而是单独作为多模态内容交给模型
        images.push({ name: item.name, attachment: item.image });
        lines.push(`\n【${item.name}】图片，已随消息直接提供给模型查看`);
        continue;
      }
      if (item.status === 'ok' && item.text.length > 0) {
        const allowed = allowance.get(item) ?? 0;
        const piece = item.text.slice(0, allowed);
        if (piece.length < item.text.length) truncatedCount += 1;
        lines.push(`\n【${item.name}】（${item.size} 字节${piece.length < item.text.length ? `，原文 ${item.text.length} 字，此处截断到 ${piece.length} 字` : ''}）`);
        lines.push(piece);
      } else {
        // 读不到的文件也要写出来——让模型知道"有这个东西但它没读到"，
        // 而不是干脆不出现（那样总结会把文件漏掉，反而更误导）
        lines.push(`\n【${item.name}】${item.status === 'error' ? '读取失败' : '未提取内容'}：${item.note || '无说明'}`);
      }
    }

    if (skippedForCount > 0) lines.push(`\n（另有 ${skippedForCount} 个文件因单轮数量上限未处理）`);
    if (truncatedCount > 0) lines.push(`（有 ${truncatedCount} 个文件的正文被截断或未附，因总字数上限）`);
    lines.push('=== 附件内容结束 ===');

    const readable = results.filter(r => r.status === 'ok').length;
    const imageCount = images.length;
    const parts = [`${results.length} 个附件`];
    if (readable > 0) parts.push(`提取正文 ${readable} 个`);
    if (imageCount > 0) parts.push(`图片 ${imageCount} 张交给模型查看`);
    const summary = results.length === 0 ? '本轮没有附件' : parts.join('，');

    return { results, block: lines.join('\n'), images, summary };
  }

  /** 缓存统计（面板展示用）。 */
  function stats() {
    ensureDirs();
    let totalBytes = 0;
    let fileCount = 0;
    const entries = [];
    try {
      for (const name of readdirSync(cacheDir)) {
        if (name === 'extract') continue;
        const dir = join(cacheDir, name);
        let dirBytes = 0;
        let dirFiles = 0;
        try {
          for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (!statSync(p).isFile()) continue;
            dirBytes += statSync(p).size;
            dirFiles += 1;
          }
        } catch {
          /* 单个子目录读不到就跳过 */
        }
        let displayName = name;
        try {
          const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
          if (typeof meta.originalName === 'string' && meta.originalName.length > 0) displayName = meta.originalName;
        } catch {
          /* 没 meta 就用目录名 */
        }
        totalBytes += dirBytes;
        fileCount += dirFiles;
        entries.push({ hash: name, name: displayName, bytes: dirBytes, files: dirFiles, lastUsedMs: lastUsedMs(dir) });
      }
    } catch {
      /* 缓存目录不存在时返回空统计 */
    }
    entries.sort((a, b) => b.lastUsedMs - a.lastUsedMs);
    return { cacheDir, totalBytes, fileCount, entryCount: entries.length, entries };
  }

  /** 按 LRU 淘汰，把总量压到上限内。 */
  function prune() {
    const limit = Number(getSettings()?.attachments?.maxCacheBytes ?? MAX_CACHE_BYTES);
    const snapshot = stats();
    if (snapshot.totalBytes <= limit) return { removed: 0, freedBytes: 0 };

    // entries 已按最久未访问在前排序（越靠前越旧）。
    //
    // 算法刻意分两步：**先选出要删的条目，再执行删除**。
    // 理由是直接边算边删时，"已释放多少"只能靠估算（目录项、meta.json、.used
    // 这些开销不在 entry.bytes 里），估算偏小就会多删一个——实测踩到过
    // （3×1MB + 2MB 上限时删了 2 个而不是 1 个）。先选中再删可以顺带回报
    // 精确的释放量，统计与账目就对得上了。
    const ordered = [...snapshot.entries].reverse();
    const doomed = [];
    let projected = snapshot.totalBytes;
    for (const entry of ordered) {
      if (projected <= limit) break;
      doomed.push(entry);
      projected -= entry.bytes;
    }

    let removed = 0;
    let freed = 0;
    for (const entry of doomed) {
      try {
        rmSync(join(cacheDir, entry.hash), { recursive: true, force: true });
      } catch {
        /* 删不掉就跳过（统计按实际结果重算，不虚报） */
        continue;
      }
      try {
        const extractPath = join(extractDir, `${entry.hash}.txt`);
        if (existsSync(extractPath)) freed += statSync(extractPath).size;
        unlinkSync(extractPath);
      } catch {
        /* 提取缓存可能不存在 */
      }
      freed += entry.bytes;
      removed += 1;
    }
    return { removed, freedBytes: freed };
  }

  /** 清空全部缓存。 */
  function clear() {
    const before = stats();
    try {
      rmSync(cacheDir, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, freedBytes: 0, error: error instanceof Error ? error.message : String(error) };
    }
    ensureDirs();
    return { ok: true, freedBytes: before.totalBytes, removedFiles: before.fileCount };
  }

  return { collect, ensureText, download, stats, prune, clear, cacheDir };
}
