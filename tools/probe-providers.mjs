// 探测：当前环境里确实注册了哪些 LLM provider，以及 deepseek-account 的模型目录。
//
// 为什么必须验：插件的默认 LLM 路由写的是 deepseek-account / deepseek-flash。
// 如果这个 provider 在当前环境没注册，默认值就会静默失效、退回自动探测
// （面板上会显示 source=auto）——那就偏离了「默认 DeepSeek-V4.1-Flash」的要求。
//
// 做法：用真实的 Cordis 加载 llm-deepseek 插件，再读 ctx.llm。
// 只读，不发起任何推理请求。
//
// 运行：node tools/probe-providers.mjs
//   （需要 DSH 内部包可解析；脚本会自动从 profile 的 node_modules 找）

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(home, 'profiles', 'desktop');
const requireFrom = createRequire(`file:///${profileDir.replace(/\\/gu, '/')}/index.js`);

/** 尝试从若干候选位置解析一个包。 */
function tryResolve(spec) {
  const bases = [
    `file:///${profileDir.replace(/\\/gu, '/')}/package.json`,
    `file:///${join(home, 'plugins').replace(/\\/gu, '/')}/`,
  ];
  for (const base of bases) {
    try {
      return createRequire(base).resolve(spec);
    } catch {
      // 继续试下一个
    }
  }
  return null;
}

const cordisPath = tryResolve('@deepseek-ai/cordis');
console.log('== 解析 DSH 内部包 ==');
console.log('  @deepseek-ai/cordis :', cordisPath ?? '未找到');
if (cordisPath === null) {
  console.log('\n  无法从 profile 解析 cordis，跳过运行时探测。');
  console.log('  （这不影响插件工作；默认路由有「回退到自动探测」的兜底，只是面板会显示 source=auto）');
  process.exit(0);
}

const { Context } = await import(pathToFileURL(cordisPath).href);

const candidates = [
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-deepseek-api-key',
  '@deepseek-ai/dsh-llm-pi-ai',
];

console.log('\n== 加载 LLM 适配器并列出 provider ==');
for (const spec of candidates) {
  const resolved = tryResolve(spec);
  if (resolved === null) {
    console.log(`  ${spec}: 未安装（跳过）`);
    continue;
  }
  try {
    const mod = await import(pathToFileURL(resolved).href);
    const ctx = new Context();
    // 有些适配器需要凭证服务；这里只求 listProviders 可用，缺依赖就报错跳过
    await ctx.plugin(mod.default ?? mod);
    await new Promise(resolve => setTimeout(resolve, 300));

    const llm = ctx.get('llm');
    if (llm === undefined) {
      console.log(`  ${spec}: 加载成功但 ctx.llm 未就绪（需要宿主其他服务）`);
    } else {
      const providers = llm.listProviders();
      console.log(`  ${spec}:`);
      for (const p of providers) console.log(`    provider: ${p.id}   (${p.name})`);
      for (const p of providers) {
        try {
          const models = await llm.listModels(p.id);
          if (models.length > 0) {
            console.log(`      ${p.id} 的模型：${models.map(m => m.id).join(', ')}`);
          }
        } catch (error) {
          console.log(`      ${p.id} 列模型失败：${error.message}`);
        }
      }
    }
    await ctx.stop?.();
  } catch (error) {
    console.log(`  ${spec}: 加载失败 — ${error.message}`);
  }
}

console.log('\n== 结论 ==');
console.log('  若上面列出了 deepseek-account，则插件的默认路由有效。');
console.log('  若没有，插件会回退自动探测并在面板把来源标为 auto。');
