// 诊断：stripSourceCitations 为什么没删掉空壳行。
//
// 上一轮调试是在 PowerShell 里拼正则，$ 被转义成了字面美元符，
// 导致"不匹配"是假的。这里直接 import 真实实现来测。
//
// 只读。运行：node tools/diagnose-citation-strip.mjs

import { stripSourceCitations } from '../lib/llm.js';

const cases = [
  ['6. 核心依据：《某需求.docx》《某报价.xlsx》。', '空壳：应删'],
  ['核心依据：《某需求.docx》', '空壳：应删'],
  ['依据：群聊记录', '整行引用：应删'],
  ['来源：群聊记录', '整行引用：应删'],
  ['1. 追溯。', '合法短条目：应留'],
  ['1. 重构追溯平台（需求docx）。', '去引用后保留'],
  ['预算5万。', '正常：应留'],
  ['1. 重构追溯平台，对接生产采集数据，获取支-盒-箱-托关联关系（需求docx）。', '长条目：去引用后保留'],
];

let bad = 0;
for (const [input, note] of cases) {
  const out = stripSourceCitations(input);
  const kept = out.trim().length > 0;
  const expectKeep = note.includes('应留') || note.includes('保留');
  const ok = kept === expectKeep;
  if (!ok) bad += 1;
  console.log(`${ok ? '✔' : '✖'} ${note}`);
  console.log(`    输入 ${JSON.stringify(input)}`);
  console.log(`    输出 ${JSON.stringify(out)}`);
}

console.log();
console.log(bad === 0 ? '==== 全部符合预期 ====' : `==== ${bad} 项不符合预期 ====`);
process.exitCode = bad === 0 ? 0 : 1;
