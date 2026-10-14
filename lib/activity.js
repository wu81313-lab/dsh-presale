// 活动日志：~/.dsh/presale/activity.ndjson
//
// 每一轮「发现消息 → 判定 → 发送/跳过」都记一条。它的作用不是给人看流水账，
// 而是回答三个必须能回答的问题：
//   1. 我的触发消息被识别到了吗？
//   2. 为什么这次没发/@？（是没匹配、被冷却挡了、还是 AI 判不出销售）
//   3. 到底发出去了什么？
// 所以在 dryRun 模式下 activity 是唯一的观察窗口。

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 内存里保留的条数（面板展示用）。 */
const KEEP = 300;

/** 磁盘文件超过这个大小就轮转一次，避免无限增长。 */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * 建立活动日志句柄。
 *
 * @param {object} options
 * @param {string} options.activityPath - ndjson 文件路径。
 * @param {{warn?: Function}} [options.logger] - 日志。
 * @returns {{ append: Function, recent: Function, clear: Function, path: string }}
 */
export function createActivity({ activityPath, logger = console } = {}) {
  /** @type {object[]} 环形缓冲：最后 KEEP 条。 */
  let buffer = [];
  let loaded = false;

  /** 首次使用时把磁盘上已有的记录读进内存（只读尾部，避免大文件拖慢启动）。 */
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (typeof activityPath !== 'string' || activityPath.length === 0) return;
    try {
      const stat = statSync(activityPath);
      if (stat.size === 0) return;
      // 大于 512KB 时只读尾部，够填满 buffer 就行
      const readFrom = Math.max(0, stat.size - 512 * 1024);
      const text = readFileSync(activityPath, 'utf8');
      const slice = readFrom > 0 ? text.slice(text.length - (stat.size - readFrom)) : text;
      for (const line of slice.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          buffer.push(JSON.parse(line));
        } catch {
          // 半截行（进程被杀时可能出现）：跳过
        }
      }
      if (buffer.length > KEEP) buffer = buffer.slice(buffer.length - KEEP);
    } catch {
      // 文件不存在/不可读：从空开始
    }
  }

  function rotateIfNeeded() {
    if (typeof activityPath !== 'string' || activityPath.length === 0) return;
    try {
      const stat = statSync(activityPath);
      if (stat.size < MAX_BYTES) return;
      const backup = `${activityPath}.1`;
      renameSync(activityPath, backup);
      writeFileSync(activityPath, '', 'utf8');
      logger.warn?.(`dsh-presale: 活动日志超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，已轮转为 ${backup}`);
    } catch {
      // 轮转失败不影响主流程
    }
  }

  return {
    /**
     * 追加一条记录。
     *
     * @param {object} entry - 记录内容；`ts` 缺失时自动补当前时间。
     * @returns {object} 实际写入的记录（已补 ts）。
     */
    append(entry) {
      ensureLoaded();
      const record = { ts: Date.now(), ...entry };
      buffer.push(record);
      if (buffer.length > KEEP) buffer = buffer.slice(buffer.length - KEEP);

      if (typeof activityPath !== 'string' || activityPath.length === 0) return record;
      try {
        mkdirSync(dirname(activityPath), { recursive: true });
        rotateIfNeeded();
        appendFileSync(activityPath, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (error) {
        logger.warn?.(`dsh-presale: 写活动日志失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return record;
    },

    /**
     * 最近 n 条（新的在前）。
     *
     * @param {number} [n] - 条数，默认 50，上限 300。
     * @returns {object[]} 记录数组。
     */
    recent(n = 50) {
      ensureLoaded();
      const limit = Math.max(1, Math.min(KEEP, Math.round(Number(n) || 50)));
      return buffer.slice(-limit).reverse();
    },

    /** 清空（内存与磁盘）。 */
    clear() {
      buffer = [];
      loaded = true;
      if (typeof activityPath !== 'string' || activityPath.length === 0) return;
      try {
        mkdirSync(dirname(activityPath), { recursive: true });
        writeFileSync(activityPath, '', 'utf8');
      } catch (error) {
        logger.warn?.(`dsh-presale: 清空活动日志失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },

    path: activityPath,
  };
}
