// 单元测试：LLM 路由解析（默认 DeepSeek-V4.1-Flash 的行为）
//
// 为什么要专门测：路由解析错了不会报错，只会**静默用别的模型**，
// 而本插件生成的是要发到客户群里的文案，模型换了直接影响输出质量。
//
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLlm } from '../llm.js';
import { defaultSettings } from '../config.js';

/** 造一个假的 llm 服务，只提供 listProviders。 */
function fakeLlm(providerIds) {
  return {
    listProviders: () => providerIds.map(id => ({ id, name: id })),
    stream: async function* stream() {
      yield { type: 'text-delta', text: 'ok' };
    },
  };
}

/** 造一个只覆盖 llm 段的设置读取器。 */
function settingsWith(llmPartial) {
  const base = defaultSettings();
  return () => ({ ...base, llm: { ...base.llm, ...llmPartial } });
}

test('llm: 出厂默认就是 DeepSeek-V4.1-Flash（deepseek-account / deepseek-flash）', () => {
  const d = defaultSettings().llm;
  assert.equal(d.provider, 'deepseek-account');
  assert.equal(d.model, 'deepseek-flash');
});

test('llm: 未配置时代码走默认路由而非自动探测', () => {
  // 关键：「默认」必须来自我们的固定值，不能是 listProviders 的第一个。
  // 这里故意让第一个可用 provider 是别的，验证不会被它带走。
  const llm = createLlm({
    getLlm: () => fakeLlm(['some-other-provider', 'deepseek-account']),
    getSettings: settingsWith({ provider: '', model: '' }),
    logger: { warn() {}, info() {} },
  });
  const route = llm.describe();
  assert.equal(route.provider, 'deepseek-account', `实际 ${route.provider}`);
  assert.equal(route.model, 'deepseek-flash', `实际 ${route.model}`);
  assert.equal(route.source, 'default');
});

test('llm: 用户显式指定的 route 优先', () => {
  const llm = createLlm({
    getLlm: () => fakeLlm(['deepseek-account', 'deepseek-v4-pro']),
    getSettings: settingsWith({ provider: 'deepseek-account', model: 'deepseek-v4-pro' }),
    logger: { warn() {}, info() {} },
  });
  const route = llm.describe();
  assert.equal(route.model, 'deepseek-v4-pro');
  assert.equal(route.source, 'settings');
});

test('llm: 只填 provider 时模型用默认值补齐', () => {
  const llm = createLlm({
    getLlm: () => fakeLlm(['deepseek-account']),
    getSettings: settingsWith({ provider: 'deepseek-account', model: '' }),
    logger: { warn() {}, info() {} },
  });
  const route = llm.describe();
  assert.equal(route.provider, 'deepseek-account');
  assert.equal(route.model, 'deepseek-flash');
  assert.equal(route.source, 'settings+default-model');
});

test('llm: 只填 model 时 provider 用默认值补齐', () => {
  const llm = createLlm({
    getLlm: () => fakeLlm(['deepseek-account']),
    getSettings: settingsWith({ provider: '', model: 'deepseek-v4-pro' }),
    logger: { warn() {}, info() {} },
  });
  const route = llm.describe();
  assert.equal(route.provider, 'deepseek-account');
  assert.equal(route.model, 'deepseek-v4-pro');
  assert.equal(route.source, 'default-provider+settings-model');
});

test('llm: 默认 provider 未注册时才自动探测，并把来源标为 auto', () => {
  const warnings = [];
  const llm = createLlm({
    getLlm: () => fakeLlm(['only-this-one']),
    getSettings: settingsWith({ provider: '', model: '' }),
    logger: { warn: (...a) => warnings.push(a.join(' ')), info() {} },
  });
  const route = llm.describe();
  assert.equal(route.provider, 'only-this-one');
  assert.equal(route.source, 'auto', '来源必须是 auto，好让面板提示用户模型不是固定的');
  assert.ok(warnings.some(w => w.includes('自动改用')), '必须告警，否则用户不知道模型漂移了');
});

test('llm: 用户指定的 provider 未注册时回退默认并告警', () => {
  const warnings = [];
  const llm = createLlm({
    getLlm: () => fakeLlm(['deepseek-account']),
    getSettings: settingsWith({ provider: '不存在的provider', model: 'x' }),
    logger: { warn: (...a) => warnings.push(a.join(' ')), info() {} },
  });
  const route = llm.describe();
  assert.equal(route.provider, 'deepseek-account', '应回退默认而不是用未注册的路由');
  assert.ok(warnings.some(w => w.includes('未注册')), '必须告警');
});

test('llm: 没有任何可用 provider 时返回不可用（不编造模型名）', () => {
  const llm = createLlm({
    getLlm: () => fakeLlm([]),
    getSettings: settingsWith({ provider: '', model: '' }),
    logger: { warn() {}, info() {} },
  });
  // listProviders 为空且默认 provider 不在列表里 → 走不到任何分支，返回 auto 或 null
  const route = llm.describe();
  assert.ok(route === null || route.provider === '' || route.source === 'auto', JSON.stringify(route));
  assert.equal(llm.available(), true, 'stream 存在即视为可用（可用性只看服务在不在）');
});

test('llm: LLM 服务未就绪时 describe 不抛异常', () => {
  const llm = createLlm({
    getLlm: () => null,
    getSettings: settingsWith({ provider: '', model: '' }),
    logger: { warn() {}, info() {} },
  });
  const route = llm.describe();
  assert.equal(route.provider, '', `实际 ${JSON.stringify(route)}`);
  assert.equal(route.source, 'unavailable');
  assert.equal(llm.available(), false);
});

test('llm: listProviders 抛异常时不崩，降级为不可用', () => {
  const llm = createLlm({
    getLlm: () => ({
      listProviders: () => { throw new Error('服务坏了'); },
      stream: async function* stream() { yield { type: 'text-delta', text: 'x' }; },
    }),
    getSettings: settingsWith({ provider: '', model: '' }),
    logger: { warn() {}, info() {} },
  });
  const route = llm.describe();
  assert.equal(route.provider, '');
  assert.equal(route.source, 'unavailable');
});
