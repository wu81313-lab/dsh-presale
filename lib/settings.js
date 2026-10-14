// 运行时设置的读写：~/.dsh/presale/settings.json
//
// 为什么要独立于 cordis config：
//   cordis 配置改完要重启 DSH 才生效；而这个插件的文案、关键词、开关必须能
//   「一边用一边改」。所以运行时以这个 JSON 文件为准，cordis config 只提供初值。
//
// 两个实现要点（都是从 dsh-local-kb 踩出来的）：
//   1. 写入必须原子（先写 .tmp 再 rename），否则面板保存时 DSH 崩溃会留下半截文件。
//   2. 读取要按 mtime 缓存，否则每轮轮询都解析一次磁盘文件（30 秒一次也很浪费）。

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeSettings, defaultSettings } from './config.js';

/**
 * 建立设置读写句柄。
 *
 * @param {object} options
 * @param {string} options.settingsPath - settings.json 的绝对路径。
 * @param {object} [options.config] - cordis config 提供的初值（仅用于播种）。
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger] - 日志。
 * @returns {{
 *   get: () => object,
 *   raw: () => object,
 *   warnings: () => string[],
 *   update: (patch: object, opts?: {strict?: boolean}) => object,
 *   reset: (keys?: string[]) => object,
 *   path: string,
 *   exists: () => boolean,
 * }} 设置句柄。
 */
export function createSettings({ settingsPath, config = {}, logger = console } = {}) {
  let cachedMtime = null;
  let cachedNormalized = null;
  let cachedRaw = null;
  let cachedWarnings = [];

  /** 首次播种内容：cordis config 里的同名键覆盖默认值。 */
  function seed() {
    const { settings } = normalizeSettings(config);
    return settings;
  }

  /** 读磁盘 + 归一化；按 mtime 缓存。文件不存在时用播种内容并落盘。 */
  function load() {
    if (typeof settingsPath !== 'string' || settingsPath.length === 0) {
      // 没有路径就没法持久化：退化成内存态，仍然可用
      if (cachedNormalized === null) {
        const { settings, warnings } = normalizeSettings(seed());
        cachedNormalized = settings;
        cachedRaw = settings;
        cachedWarnings = warnings;
      }
      return;
    }

    let mtime = null;
    try {
      mtime = statSync(settingsPath).mtimeMs;
    } catch {
      mtime = null; // 不存在
    }

    if (mtime !== null && mtime === cachedMtime && cachedNormalized !== null) return;

    if (mtime === null) {
      // 第一次运行：把播种内容写到磁盘，让用户有个能直接编辑的文件
      const initial = seed();
      writeAtomic(initial);
      cachedRaw = initial;
      cachedNormalized = initial;
      cachedWarnings = [];
      try {
        cachedMtime = statSync(settingsPath).mtimeMs;
      } catch {
        cachedMtime = null;
      }
      return;
    }

    try {
      const text = readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(text);
      const { settings, warnings } = normalizeSettings(parsed);
      cachedRaw = parsed;
      cachedNormalized = settings;
      cachedWarnings = warnings;
      cachedMtime = mtime;
    } catch (error) {
      // 文件坏了：不要用默认值覆盖用户的文件（可能是手工编辑到一半），
      // 先在内存里退回默认值并告警，等用户自己修好或通过面板保存。
      logger.warn?.(`dsh-presale: 读取设置失败（${settingsPath}）：${error instanceof Error ? error.message : String(error)}`);
      const { settings, warnings } = normalizeSettings(config);
      cachedRaw = {};
      cachedNormalized = settings;
      cachedWarnings = ['设置文件无法解析，已临时使用默认值；保存面板设置会覆盖该文件', ...warnings];
      cachedMtime = mtime;
    }
  }

  /** 原子写：先写 .tmp 再 rename（同目录 rename 在 Windows 上也是原子的）。 */
  function writeAtomic(value) {
    if (typeof settingsPath !== 'string' || settingsPath.length === 0) return;
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, settingsPath);
  }

  return {
    /** 归一化后的设置（热读，按 mtime 缓存）。 */
    get() {
      load();
      return cachedNormalized ?? defaultSettings();
    },

    /** 磁盘上的原始对象（含未知键），只读。 */
    raw() {
      load();
      return cachedRaw ?? {};
    },

    /** 最近一次归一化产生的告警（面板上显示，让用户知道哪项被回退了）。 */
    warnings() {
      load();
      return cachedWarnings.slice();
    },

    /**
     * 深合并式更新并落盘。
     *
     * strict=true 时做保存前校验（例如空模板直接拒绝），抛出的 Error 会由
     * web 层转成 400，面板上显示原因；strict=false 走回退逻辑。
     */
    update(patch, { strict = false } = {}) {
      load();
      const base = cachedRaw ?? {};
      const merged = deepMerge(base, patch ?? {});
      const { settings, warnings } = normalizeSettings(merged, { strict });
      writeAtomic(settings);
      cachedRaw = settings;
      cachedNormalized = settings;
      cachedWarnings = warnings;
      try {
        cachedMtime = statSync(settingsPath).mtimeMs;
      } catch {
        cachedMtime = null;
      }
      return settings;
    },

    /** 把指定键（或全部）恢复默认。 */
    reset(keys) {
      load();
      const base = { ...(cachedRaw ?? {}) };
      const defaults = defaultSettings();
      if (!Array.isArray(keys) || keys.length === 0) {
        return this.update(defaults);
      }
      const patch = {};
      for (const key of keys) {
        if (key in defaults) patch[key] = defaults[key];
      }
      return this.update(patch);
    },

    /** 设置文件当前是否存在。 */
    exists() {
      try {
        statSync(settingsPath);
        return true;
      } catch {
        return false;
      }
    },

    path: settingsPath,
  };
}

/** 深合并对象（数组整体替换，不做逐项合并）。 */
function deepMerge(base, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const out = { ...(typeof base === 'object' && base !== null && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
