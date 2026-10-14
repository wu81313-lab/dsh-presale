// 探测：DSH 当前注册的 provider / model（确认「DeepSeek-V41-Flash」的准确 id）
//
// 只读，不发起任何推理请求。运行：node tools/probe-models.mjs
//
// 背景：需要把插件的默认 LLM 固定为「DeepSeek-V41-Flash」，
// 但候选 id 有两个（deepseek-flash / deepseek-v4-flash），必须实测确认，
// 写错会导致静默调用失败。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');

/** 从 credentials 里取 api key（只用于列模型，不打印）。 */
function readKey(name) {
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8');
    const m = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'mu').exec(text);
    return m === null ? '' : m[1];
  } catch {
    return '';
  }
}

console.log('== DeepSeek 官方 /models（直连，权威）==');
const key = readKey('DEEPSEEK_API_KEY');
if (key.length === 0) {
  console.log('  未找到 DEEPSEEK_API_KEY，跳过');
} else {
  try {
    const response = await fetch('https://api.deepseek.com/models', {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = await response.json();
    for (const item of body.data ?? []) console.log(`  ${item.id}`);
  } catch (error) {
    console.log(`  查询失败：${error.message}`);
  }
}

console.log('\n== DSH 的 agent 默认模型配置 ==');
try {
  const patch = readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
  const m = /- id: agent-default-model[\s\S]{0,220}/u.exec(patch);
  if (m !== null) {
    for (const line of m[0].split('\n').slice(0, 6)) console.log(`  ${line}`);
  }
} catch (error) {
  console.log(`  读取失败：${error.message}`);
}

console.log('\n== 插件当前设置里的 llm 段 ==');
try {
  const settings = JSON.parse(readFileSync(join(home, 'presale', 'settings.json'), 'utf8'));
  console.log(`  provider = ${JSON.stringify(settings.llm?.provider ?? '')}`);
  console.log(`  model    = ${JSON.stringify(settings.llm?.model ?? '')}`);
} catch (error) {
  console.log(`  读取失败：${error.message}`);
}
