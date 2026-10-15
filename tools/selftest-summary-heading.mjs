// 验证总结的标题拼接与去重（不需要真 LLM：注入一个假 stream 即可）。
//
// 为什么要有这个测试：标题重复是**实测踩到**的真问题——
//   【项目需求梳理】
//   片仔癀口腔护理产品纯平台需求梳理     ← 模型又写了一遍
// 两处都在造标题，叠在一起就重复了。这里把拼接逻辑钉死，防止回归。
//
// 运行：node tools/selftest-summary-heading.mjs

import { createLlm, stripLeadingHeading } from '../lib/llm.js';
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
    candidates: ['【项目需求梳理】', '片仔癀口腔护理产品纯平台'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '模型自造「会话名+需求梳理」→ 删',
    body: '片仔癀口腔护理产品纯平台需求梳理\n一、客户与场景\n正文…',
    candidates: ['【项目需求梳理】', '片仔癀口腔护理产品纯平台'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '标题行与自造行同时出现 → 两行都删',
    body: '【项目需求梳理】\n片仔癀口腔护理产品纯平台需求梳理\n一、客户与场景\n正文…',
    candidates: ['【项目需求梳理】', '片仔癀口腔护理产品纯平台'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '正常正文 → 一个字都不动',
    body: '一、客户与场景\n客户：漳州片仔癀…\n正文…',
    candidates: ['【项目需求梳理】', '片仔癀口腔护理产品纯平台'],
    expectFirst: '一、客户与场景',
  },
  {
    label: '正文首行提到客户名但是完整句子 → 保留',
    body: '片仔癀口腔护理产品纯平台这个项目目前用的是伟迪捷追溯，查询常出问题。\n下一段…',
    candidates: ['【项目需求梳理】', '片仔癀口腔护理产品纯平台'],
    expectFirst: '片仔癀口腔护理产品纯平台这个项目目前用的是伟迪捷追溯，查询常出问题。',
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

const conversation = '片仔癀口腔护理产品纯平台';
const body = '片仔癀口腔护理产品纯平台需求梳理\n一、客户与场景\n客户：某公司。\n二、明确的需求\n1. 追溯。';

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
check('标注了会话', text.includes(`会话：${conversation}`));
check('正文完整保留', text.includes('一、客户与场景') && text.includes('1. 追溯。'));
check('没有连续两行标题', !/\n\s*\n\s*[^\n]*需求梳理[^\n]*\n[^\n]*\n/u.test(text.split('会话：')[1] ?? ''));

console.log(`\n==== ${failures === 0 ? '标题拼接验证通过' : `验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
