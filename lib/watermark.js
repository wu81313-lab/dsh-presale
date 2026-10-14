// 水位：记住「已经处理到哪条消息」，保证重启不重放、重叠窗口不重复触发。
//
// 为什么需要它，而不是简单按时间比较：
//   · 时间戳精度只到秒，同一秒里可能有多条消息（尤其是我连发两条指令）；
//   · 轮询窗口刻意带 2 分钟重叠（防搜索索引延迟漏消息），重叠部分必然重复命中；
//   · DSH 重启后不能把「最近 30 分钟我说过的话」再执行一遍。
// 所以用「时间水位」+「已处理 messageId 集合」两个条件共同判定：两个都新才算新。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 记住多少个已处理的 messageId（够覆盖重叠窗口即可）。 */
const SEEN_CAP = 400;

/**
 * 建立水位句柄。
 *
 * @param {object} options
 * @param {string} options.watermarkPath - 持久化路径。
 * @param {{warn?: Function}} [options.logger] - 日志。
 * @returns {{ isNew: Function, mark: Function, snapshot: Function, seed: Function, setLastSeenMs: Function, save: Function }}
 */
export function createWatermark({ watermarkPath, logger = console } = {}) {
  /** 已处理过的消息时间上界（毫秒）。 */
  let lastSeenMs = 0;
  /** 已处理的 messageId 顺序表（新的在后）。 */
  let seen = [];
  let seenSet = new Set();
  let dirty = false;
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (typeof watermarkPath !== 'string' || watermarkPath.length === 0) return;
    try {
      const parsed = JSON.parse(readFileSync(watermarkPath, 'utf8'));
      if (Number.isFinite(parsed?.lastSeenMs) && parsed.lastSeenMs > 0) lastSeenMs = parsed.lastSeenMs;
      if (Array.isArray(parsed?.seenIds)) {
        seen = parsed.seenIds.filter(id => typeof id === 'string' && id.length > 0).slice(-SEEN_CAP);
        seenSet = new Set(seen);
      }
    } catch {
      // 文件不存在或损坏：从零开始。这不危险——首启种子逻辑会挡住历史重放。
    }
  }

  function persist() {
    if (!dirty) return;
    if (typeof watermarkPath !== 'string' || watermarkPath.length === 0) {
      dirty = false;
      return;
    }
    try {
      mkdirSync(dirname(watermarkPath), { recursive: true });
      const payload = { version: 1, lastSeenMs, seenIds: seen.slice(-SEEN_CAP) };
      const tmp = `${watermarkPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
      renameSync(tmp, watermarkPath);
      dirty = false;
    } catch (error) {
      logger.warn?.(`dsh-presale: 写水位文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    /**
     * 判断一条消息是否「新的、需要处理」。
     *
     * @param {{messageId?: string, createTimeMs?: number|null}} message - 消息。
     * @returns {boolean} true 表示尚未处理过。
     */
    isNew(message) {
      load();
      const id = typeof message?.messageId === 'string' ? message.messageId : '';
      if (id.length > 0 && seenSet.has(id)) return false;
      const ms = Number.isFinite(message?.createTimeMs) ? message.createTimeMs : null;
      // 时间解析不出来的消息：只靠 messageId 去重（并在下面 mark 时进集合）。
      // 不因为"时间不可解析"就丢弃——那会漏触发。
      if (ms !== null && ms < lastSeenMs) return false;
      return true;
    },

    /**
     * 标记一条消息已处理。
     *
     * @param {{messageId?: string, createTimeMs?: number|null}} message - 消息。
     */
    mark(message) {
      load();
      const id = typeof message?.messageId === 'string' ? message.messageId : '';
      if (id.length > 0 && !seenSet.has(id)) {
        seen.push(id);
        seenSet.add(id);
        if (seen.length > SEEN_CAP) {
          const dropped = seen.splice(0, seen.length - SEEN_CAP);
          for (const d of dropped) seenSet.delete(d);
        }
        dirty = true;
      }
      const ms = Number.isFinite(message?.createTimeMs) ? message.createTimeMs : null;
      if (ms !== null && ms > lastSeenMs) {
        lastSeenMs = ms;
        dirty = true;
      }
    },

    /**
     * 首启种子：把一个时间点当作水位，且不记录任何 messageId。
     *
     * 这是「装上插件后不要立刻把最近半小时我说过的话执行一遍」的闸门。
     *
     * @param {number} ms - 毫秒时间戳。
     */
    seed(ms) {
      load();
      if (!Number.isFinite(ms)) return;
      if (ms > lastSeenMs) {
        lastSeenMs = ms;
        dirty = true;
      }
    },

    /** 直接设水位（用于搜索不完整时回退）。 */
    setLastSeenMs(ms) {
      load();
      if (!Number.isFinite(ms)) return;
      lastSeenMs = ms;
      dirty = true;
    },

    /** 当前状态快照（面板展示）。 */
    snapshot() {
      load();
      return { lastSeenMs, seenCount: seen.length };
    },

    save: persist,
  };
}
