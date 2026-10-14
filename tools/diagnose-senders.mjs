// 诊断 3：--senders 传多个 ID 时是否真的还在过滤？
//
// 背景：把多个别名 ID 用逗号拼给 --senders 后，搜索结果里出现了**其他人**的
// senderId。如果服务端因此忽略过滤条件，插件就会对着别人的消息触发——
// 这直接违反「只认我本人」，必须查清是「多值」的问题还是「逗号语法」的问题。
//
// 只读。运行：node tools/diagnose-senders.mjs

import { runDws } from '../lib/dws.js';
import { pickString } from '../lib/util.js';

const logger = { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: () => {} };
const run = (args, timeoutMs = 90000) => runDws({ dwsPath: 'dws', args, timeoutMs, logger });

const A = 'D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001'; // 主 ID（群作用域）
const B = 'D8HS2VhbIeHFm6jlxdxQByiiiiLYXZXx0002'; // 别名（单聊作用域）

async function probe(label, args) {
  const result = await run(['chat', '+search-msg', ...args, '--days', '2', '--no-enrich', '--limit', '100', '-f', 'json']);
  if (!result.ok) {
    console.log(`  ${label}\n    → 失败：${result.message.split('\n')[0]}`);
    return null;
  }
  const messages = Array.isArray(result.data?.messages) ? result.data.messages : [];
  const senders = [...new Set(messages.map(m => pickString(m, 'senderId')))];
  const foreign = senders.filter(s => s !== A && s !== B);
  console.log(`  ${label}`);
  console.log(`    → ${messages.length} 条消息，${senders.length} 种 senderId，其中非我的：${foreign.length} 种`);
  if (foreign.length > 0) console.log(`    → 外来 ID 示例：${foreign.slice(0, 3).join(', ')}`);
  return { count: messages.length, senders, foreign: foreign.length };
}

(async () => {
  console.log('== 对照实验（近 2 天）==\n');

  const single = await probe('① 单值 --senders <A>', ['--senders', A]);
  console.log('');

  const comma = await probe('② 逗号多值 --senders "<A>,<B>"', ['--senders', `${A},${B}`]);
  console.log('');

  const repeated = await probe('③ 重复 flag --senders <A> --senders <B>', ['--senders', A, '--senders', B]);
  console.log('');

  const singleB = await probe('④ 单值 --senders <B>（别名）', ['--senders', B]);
  console.log('');

  console.log('== 结论 ==');
  if (comma !== null && comma.foreign > 0 && single !== null && single.foreign === 0) {
    console.log('  ✖ 逗号多值会让服务端忽略发送者过滤 → 必须改用「重复 flag」或「逐个 ID 分别搜索后本地合并」');
  } else if (comma !== null && comma.foreign === 0) {
    console.log('  ✔ 逗号多值正常工作（此前看到的"外来 ID"另有原因）');
  } else if (single !== null && single.foreign > 0) {
    console.log('  ✖ 连单值都不过滤 → 发送者过滤整体不可信，必须本地按 senderId 严格过滤');
  }
  if (repeated !== null) {
    console.log(`  重复 flag 形式：外来 ${repeated.foreign} 种 → ${repeated.foreign === 0 ? '可用' : '也不过滤'}`);
  }
  if (singleB !== null) {
    console.log(`  别名单独搜索：${singleB.count} 条（${singleB.count > 0 ? '有效' : '无结果'}）`);
  }
})();
