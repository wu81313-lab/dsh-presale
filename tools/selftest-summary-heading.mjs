// 验证总结的标题拼接与去重（不需要真 LLM：注入一个假 stream 即可）。
//
// 为什么要有这个测试：标题重复是**实测踩到**的真问题——
//   【项目需求梳理】
//   某某项目需求梳理     ← 模型又写了一遍
// 两处都在造标题，叠在一起就重复了。这里把拼接逻辑钉死，防止回归。
//
// 运行：node tools/selftest-summary-heading.mjs

import { createLlm, stripLeadingHeading, stripSourceCitations } from '../lib/llm.js';
import { defaultSettings } from '../lib/config.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('== 纯函数：stripLeadingHeading ==');
const headingCases = [
  {
    label: '模型照抄了配置里的标题 → 删',
    body: '【项目需求梳理】\n一、客户与场景\n正文…',
    candidates: ['【项目需求梳理】', '某某项目群'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '模型自造「会话名+需求梳理」→ 删',
    body: '某某项目需求梳理\n一、客户与场景\n正文…',
    candidates: ['【项目需求梳理】', '某某项目群'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '标题行与自造行同时出现 → 两行都删',
    body: '【项目需求梳理】\n某某项目需求梳理\n一、客户与场景\n正文…',
    candidates: ['【项目需求梳理】', '某某项目群'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '正常正文 → 一个字都不动',
    body: '一、客户与场景\n客户：漳州某客户…\n正文…',
    candidates: ['【项目需求梳理】', '某某项目群'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '正文首行提到客户名但是完整句子 → 保留',
    body: '某某项目群这个项目目前用的是某供应商追溯，查询常出问题。\n下一段…',
    candidates: ['【项目需求梳理】', '某某项目群'],
    expectFirst: '某某项目群这个项目目前用的是某供应商追溯，查询常出问题。',
  },
];
for (const c of headingCases) {
  const out = stripLeadingHeading(c.body, c.candidates);
  check(c.label, out.split('\n')[0] === c.expectFirst, `首行 ${JSON.stringify(out.split('\n')[0])}`);
}

console.log('\n== 端到端：注入假 LLM 看最终拼出来的文本 ==');

/** 构造一个只回固定正文的假 llm 服务。 */
function fakeLlm(replyText) {
  return {
    listProviders: () => [{ id: 'fake', models: [{ id: 'fake-model', name: 'Fake' }] }],
    stream: () => (async function* gen() {
      yield { type: 'text-delta', text: replyText };
      yield { type: 'finish', reason: 'stop' };
    }()),
  };
}

const settings = defaultSettings();
settings.llm.provider = 'fake';
settings.llm.model = 'fake-model';
settings.company = '示例公司';

const conversation = '某某项目群';
const body = '某某项目需求梳理\n一、客户与场景\n客户：某公司。\n二、明确的需求\n1. 追溯。';

const llm = createLlm({
  getLlm: () => fakeLlm(body),
  getSettings: () => settings,
  logger: { info: () => {}, warn: () => {} },
});

const result = await llm.summarizeRequirements({
  prompt: settings.triggers.summarize.prompt,
  title: settings.triggers.summarize.title,
  historyText: '张三: 梳理一下',
  conversationName: conversation,
});
check('调用成功', result.ok, result.error ?? '');
const text = result.text ?? '';
console.log('\n  最终文本：');
for (const line of text.split('\n')) console.log(`    ${line}`);

console.log('\n== 断言 ==');
const titleCount = (text.match(/需求梳理/gu) ?? []).length;
check('标题只出现一次（不再重复）', titleCount === 1, `「需求梳理」出现 ${titleCount} 次`);
check('保留了配置里的标题', text.includes('【项目需求梳理】'));
check('不再输出「会话：xxx」行（用户要求去掉）', !text.includes('会话：'), JSON.stringify(text.split('\n')[1] ?? ''));
check('正文完整保留', text.includes('客户与场景') && text.includes('明确的需求') && text.includes('追溯。'),
  JSON.stringify(text.slice(0, 60)));
check('正文紧跟在标题之后', text.split('\n')[1] === '一、客户与场景', JSON.stringify(text.split('\n')[1] ?? ''));

console.log('\n== 引用依据必须被清掉 ==');
const withCitations = [
  '【项目需求梳理】',
  '1. 重构追溯平台（需求docx）。',
  '2. 报价总计113000元（报价.xlsx）。',
  '据《某需求.docx》',
  '来源：群聊记录',
  '6. 核心依据：《某需求.docx》《某报价.xlsx》。',
  '3. 正常条目（预算5万）。',
].join('\n');
const cleaned = stripSourceCitations(withCitations);
console.log('  清理后：');
for (const line of cleaned.split('\n')) console.log(`    ${line}`);
check('不存在句末括号引用', !/[（(][^）)]*(docx|xlsx|pptx)[^）)]*[)）]/iu.test(cleaned));
check('不存在「据《》」整行', !/^据\s*[《【]/mu.test(cleaned));
check('不存在「来源：」整行', !/^(来源|依据|出处)\s*[:：]/mu.test(cleaned));
check('不留被掏空的残句（如「6. 核心。」）', !/\d+[.、)]\s*\S{0,4}\s*$/mu.test(cleaned), cleaned);
check('正常条目未被误删', cleaned.includes('正常条目（预算5万）'));

console.log(`\n==== ${failures === 0 ? '标题拼接与引用清理验证通过' : `验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
