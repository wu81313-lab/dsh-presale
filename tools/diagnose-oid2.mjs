// 诊断 2：查清另一个 openDingtalkId 的作用域。
//
// 已知：
//   · 成员表（多个群）给我的 ID 都是 D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001
//   · 全局搜索返回过我发的消息，senderId 是 D8HS2VhbIeHFm6jlxdxQByiiiiLYXZXx0002
// 需要判定：后者是「会话作用域 ID」还是「另一种会话类型（如单聊）」的 ID。
//
// 做法：用 --senders 分别搜两个 ID，看命中的会话是不是同一批、以及会话类型。
// 只读。运行：node tools/diagnose-oid2.mjs

import { runDws } from '../lib/dws.js';
import { pickString } from '../lib/util.js';

const logger = { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: () => {} };
const run = (args, timeoutMs = 60000) => runDws({ dwsPath: 'dws', args, timeoutMs, logger });

const OID_A = 'D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001';
const OID_B = 'D8HS2VhbIeHFm6jlxdxQByiiiiLYXZXx0002';

async function probe(label, oid) {
  const result = await run(['chat', '+search-msg', '--senders', oid, '--days', '30', '--no-enrich', '--page-all', '--limit', '100', '-f', 'json'], 120000);
  if (!result.ok) {
    console.log(`  ${label}: 失败 — ${result.message}`);
    return { ok: false, count: 0, conversations: [] };
  }
  const messages = Array.isArray(result.data?.messages) ? result.data.messages : [];
  const conversations = [...new Set(messages.map(m => pickString(m, 'conversationId')))];
  const times = messages.map(m => pickString(m, 'createTime')).filter(Boolean).sort();
  console.log(`  ${label}: ${messages.length} 条消息，覆盖 ${conversations.length} 个会话`);
  if (times.length > 0) console.log(`      时间范围：${times[0]} ~ ${times[times.length - 1]}`);
  return { ok: true, count: messages.length, conversations, messages };
}

(async () => {
  console.log('== 分别用两个 ID 搜索（30 天）==');
  const a = await probe('ID-A …HZXXdD', OID_A);
  const b = await probe('ID-B …XZXxEY5', OID_B);

  console.log('\n== 会话集合对比 ==');
  const setA = new Set(a.conversations);
  const setB = new Set(b.conversations);
  const onlyA = [...setA].filter(x => !setB.has(x));
  const onlyB = [...setB].filter(x => !setA.has(x));
  const both = [...setA].filter(x => setB.has(x));
  console.log(`  仅 ID-A 命中：${onlyA.length} 个`);
  console.log(`  仅 ID-B 命中：${onlyB.length} 个`);
  console.log(`  两者都命中：${both.length} 个`);

  // 抽查几个会话的名称与类型，看是否集中在某类会话
  const sample = (onlyB.length > 0 ? onlyB : onlyA).slice(0, 5);
  if (sample.length > 0) {
    console.log('\n== 抽查独有会话的类型 ==');
    const recent = await run(['chat', '+recent-conversations', '-f', 'json']);
    const names = new Map();
    if (recent.ok) {
      const list = Array.isArray(recent.data?.data?.conversations) ? recent.data.data.conversations
        : Array.isArray(recent.data?.conversations) ? recent.data.conversations : [];
      for (const item of list) names.set(pickString(item, 'conversationId'), `${pickString(item, 'name')} [${pickString(item, 'type')}]`);
    }
    for (const cid of sample) {
      console.log(`  ${cid}  ->  ${names.get(cid) ?? '(不在最近会话列表里)'}`);
    }
  }

  console.log('\n== 结论 ==');
  if (onlyB.length > 0 && onlyA.length === 0) {
    console.log('  ID-B 是另一类会话的作用域 ID（ID-A 覆盖其子集）');
  } else if (onlyA.length > 0 && onlyB.length === 0) {
    console.log('  ID-A 是更全的那个（ID-B 覆盖其子集）');
  } else if (onlyA.length === 0 && onlyB.length === 0) {
    console.log('  两个 ID 命中的会话完全相同 —— 同一人的两种表示，任选其一即可');
  } else {
    console.log('  两个 ID 各覆盖一部分会话 —— 需要同时用两个 ID 才不漏消息');
  }
})();
