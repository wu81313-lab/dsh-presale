// 单元测试：LLM 空返回的自动重试。
//
// 背景：这个模型带推理，而**思维链也算输出 token**。上限给小了会稳定出现
// 「只有思维链、正文为空」——真实触发里就踩到过（销售判别给 512 必然为空）。
// 修法是：只在「空返回且产出了思维链」这一种情况下把上限加倍重试一次。
//
// 要同时锁住两件事：
//   1. 该重试时必须重试（否则用户永远拿不到 @ 判别与需求梳理）；
//   2. **不该重试时不能重试**（超时、路由不对、未登录重试只是浪费配额与时间）。
//
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLlm } from '../llm.js';
import { defaultSettings } from '../config.js';

/**
 * 造一个假的 LLM 服务。
 *
 * @param {Array<{text?: string, reasoning?: string, finish?: string, code?: string}>} replies
 *   每次调用的"剧本"：给出思维链/正文/结束原因。
 * @param {Array<object>} calls - 收集每次调用实际用的 maxTokens。
 */
function fakeLlm(replies, calls) {
  let index = 0;
  return {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    stream: options => {
      calls.push({ maxTokens: options.maxTokens, model: options.model, provider: options.provider });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return (async function* generate() {
        if (typeof reply.reasoning === 'string' && reply.reasoning.length > 0) {
          yield { type: 'reasoning-delta', index: 0, text: reply.reasoning };
        }
        if (typeof reply.text === 'string' && reply.text.length > 0) {
          yield { type: 'text-delta', index: 1, text: reply.text };
        }
        yield {
          type: 'finish',
          index: 2,
          reason: reply.finish === 'error'
            ? { kind: 'error', failure: { code: reply.code ?? 'X', message: 'err' } }
            : { kind: reply.finish ?? 'stop' },
        };
      })();
    },
  };
}

function mkLlm(fake, overrides = {}) {
  const base = defaultSettings();
  return createLlm({
    getLlm: () => fake,
    getSettings: () => ({ ...base, llm: { ...base.llm, ...overrides } }),
    logger: { warn() {}, info() {} },
  });
}

test('llm: 正常返回时不重试', async () => {
  const calls = [];
  const llm = mkLlm(fakeLlm([{ text: '收到' }], calls));
  const result = await llm.complete({ system: 's', user: 'u' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '收到');
  assert.equal(calls.length, 1, '一次就成功，不该有第二次调用');
});

test('llm: 只有思维链、正文为空时自动加倍上限重试', async () => {
  const calls = [];
  // 第一次：只出思维链；第二次：出正文
  const llm = mkLlm(fakeLlm([
    { reasoning: '想……想……想……' },
    { text: '{"name":"","confidence":"low"}' },
  ], calls), { maxTokens: 512 });

  const result = await llm.complete({ system: 's', user: 'u', maxTokens: 512 });
  assert.equal(result.ok, true, '重试后应当成功');
  assert.equal(result.text, '{"name":"","confidence":"low"}');
  assert.equal(calls.length, 2, '应当重试一次');
  assert.equal(calls[0].maxTokens, 512, '第一次用原上限');
  assert.equal(calls[1].maxTokens, 1024, '第二次上限加倍');
});

test('llm: 重试仍然空返回时如实失败，并说清是思维链吃光了上限', async () => {
  const calls = [];
  const llm = mkLlm(fakeLlm([{ reasoning: '一直想' }], calls), { maxTokens: 512 });
  const result = await llm.complete({ system: 's', user: 'u', maxTokens: 512 });
  assert.equal(result.ok, false);
  assert.match(result.error, /思维链/u, '错误信息必须点明成因');
  assert.match(result.error, /被推理吃光/u);
  assert.equal(calls.length, 2, '最多重试一次，不无限打');
});

test('llm: 完全没有 chunk（路由/登录问题）不重试', async () => {
  const calls = [];
  // 只有 finish、没有正文也没有思维链 → 不是 token 问题，重试无意义
  const llm = mkLlm(fakeLlm([{ }], calls));
  const result = await llm.complete({ system: 's', user: 'u' });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, '这种失败重试只是浪费配额');
  assert.match(result.error, /路由不对|未登录/u);
});

test('llm: 结束原因 error 时不重试', async () => {
  const calls = [];
  const llm = mkLlm(fakeLlm([{ reasoning: '想了', finish: 'error', code: 'RATE_LIMIT' }], calls));
  const result = await llm.complete({ system: 's', user: 'u' });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, '报错型失败不重试');
  assert.match(result.error, /RATE_LIMIT/u);
});

test('llm: 达到 max-tokens 而空返回时也会提示', async () => {
  const calls = [];
  const llm = mkLlm(fakeLlm([{ reasoning: 'x'.repeat(50), finish: 'max-tokens' }], calls));
  const result = await llm.complete({ system: 's', user: 'u', maxTokens: 64 });
  assert.equal(result.ok, false);
  assert.match(result.error, /maxTokens|思维链/u);
});

test('llm: 路由不可用时明确报不可用，不假装重试', async () => {
  const base = defaultSettings();
  const llm = createLlm({
    getLlm: () => ({ listProviders: () => [], stream: async function* stream() { yield { type: 'finish', reason: { kind: 'stop' } }; } }),
    getSettings: () => base,
    logger: { warn() {}, info() {} },
  });
  const result = await llm.complete({ system: 's', user: 'u' });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有可用的 LLM 路由|未就绪/u);
});

test('llm: 服务未就绪时返回可读错误', async () => {
  const base = defaultSettings();
  const llm = createLlm({
    getLlm: () => null,
    getSettings: () => base,
    logger: { warn() {}, info() {} },
  });
  const result = await llm.complete({ system: 's', user: 'u' });
  assert.equal(result.ok, false);
  assert.match(result.error, /未就绪/u);
});

test('llm: lastCallStats 记录最近一次调用的细节（供诊断工具使用）', async () => {
  const calls = [];
  const llm = mkLlm(fakeLlm([{ reasoning: '想了很久', text: '答案' }], calls));
  await llm.complete({ system: 's', user: 'u' });
  const stats = llm.lastCallStats();
  assert.ok(stats !== null, '应当记录统计');
  assert.equal(stats.reasoningChars, 4);
  assert.equal(stats.textChars, 2);
  assert.equal(stats.chunkCount, 3, 'reasoning + text + finish');
  assert.equal(stats.finishReason, 'stop');
  assert.equal(stats.provider, 'deepseek-account');
});
