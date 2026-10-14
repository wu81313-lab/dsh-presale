// 探测：插件调用 LLM 时为什么返回空内容？
//
// 现象：真实触发里 mention.reason = 「LLM 返回了空内容」，
// 说明 llm.complete() 拿到了空字符串（而不是抛错——否则会是"LLM 调用失败：…"）。
//
// 这里独立复现一次调用，把 chunk 类型分布打出来，看是：
//   · 只有 reasoning-delta（思维链）没有 text-delta；
//   · 或者 provider/model 路由不对；
//   · 或者 maxTokens 太小被推理吃光。
//
// 只读（只是发一次很短的模型请求），不发任何钉钉消息。
// 运行：node tools/probe-llm-call.mjs

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(home, 'profiles', 'desktop');
// DSH 全局安装位置从环境推导，不写死本机路径
const dshRoot = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');

/** 解析 DSH 内部包。 */
function resolvePkg(spec) {
  const bases = [
    `file:///${join(dshRoot, '..', '..', '..').replace(/\\/gu, '/')}/`,
    `file:///${profileDir.replace(/\\/gu, '/')}/`,
  ];
  for (const base of bases) {
    try {
      return createRequire(base).resolve(spec);
    } catch { /* 下一个 */ }
  }
  return null;
}

const cordisPath = resolvePkg('@deepseek-ai/cordis');
if (cordisPath === null) {
  console.log('无法解析 cordis，探测终止');
  process.exit(0);
}
const { Context } = await import(pathToFileURL(cordisPath).href);

// 逐个试适配器，找到能真出 provider 的那个
const adapters = [
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-deepseek-account-platform',
];

for (const spec of adapters) {
  const resolved = resolvePkg(spec);
  if (resolved === null) {
    console.log(`\n== ${spec} ==\n  未安装，跳过`);
    continue;
  }
  console.log(`\n== ${spec} ==`);
  let ctx = null;
  try {
    ctx = new Context();
    const mod = await import(pathToFileURL(resolved).href);
    await ctx.plugin(mod.default ?? mod);
    await new Promise(r => setTimeout(r, 400));

    const llm = ctx.get('llm');
    if (llm === undefined) {
      console.log('  ctx.llm 未就绪（缺少宿主其它服务），跳过');
      continue;
    }
    const providers = llm.listProviders();
    console.log(`  provider：${providers.map(p => p.id).join(', ') || '(无)'}`);

    for (const p of providers) {
      const models = await llm.listModels(p.id).catch(() => []);
      console.log(`  ${p.id} 的模型：${models.map(m => `${m.id}(${m.name})`).join(', ') || '(无)'}`);
    }

    // 试一次真实调用，把 chunk 分布打出来
    const target = providers[0];
    if (target === undefined) continue;
    const modelId = 'deepseek-flash';
    console.log(`\n  → 试探调用 ${target.id} / ${modelId}`);
    const counts = {};
    let text = '';
    let reasoning = '';
    try {
      const stream = llm.stream({
        provider: target.id,
        model: modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
        maxTokens: 64,
      });
      for await (const chunk of stream) {
        counts[chunk?.type ?? 'unknown'] = (counts[chunk?.type ?? 'unknown'] ?? 0) + 1;
        if (typeof chunk?.text === 'string') {
          if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
          else if (chunk.type === 'text-delta') text += chunk.text;
        }
      }
      console.log(`  chunk 分布：${JSON.stringify(counts)}`);
      console.log(`  正文（${text.length} 字）：${JSON.stringify(text.slice(0, 120))}`);
      console.log(`  思维链（${reasoning.length} 字）：${JSON.stringify(reasoning.slice(0, 120))}`);
      if (text.length === 0) {
        console.log('  ✖ 正文为空 —— 这就是插件看到「LLM 返回了空内容」的原因');
        if (reasoning.length > 0) console.log('  → 模型把 token 全用在思维链上了，maxTokens 需要调大或换模型');
      } else {
        console.log('  ✔ 能拿到正文');
      }
    } catch (error) {
      console.log(`  ✖ 调用抛错：${error.message}`);
    }
  } catch (error) {
    console.log(`  加载失败：${error.message}`);
  } finally {
    try { await ctx?.stop?.(); } catch { /* ignore */ }
  }
}
