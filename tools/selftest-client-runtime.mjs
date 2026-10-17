#!/usr/bin/env node
/**
 * 把 client/client.js 真正**执行 + 渲染**一遍，抓运行时错误。
 *
 * 为什么需要：`node --check` 只查语法，白屏这类问题几乎都是运行时报错
 * （引用不存在的变量、Hooks 用法错误、组件被当普通函数调用……），
 * 语法检查一律放过。这个脚本用假 React / ctx / fetch 把 factory 跑起来，
 * **喂进真实形状的数据并触发重渲染**，把真正的面板渲染出来。
 *
 * 关键点：必须驱动 useState，否则 settings 一直是 null，
 * 只会渲染骨架态——而白屏恰恰发生在有数据之后。
 *
 * 只读。用法：node tools/selftest-client-runtime.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8');

const problems = [];

/**
 * 极简 React 桩：useState/useRef/useCallback/useEffect/useMemo，
 * 且同一组件实例的状态在多次渲染间**保持**，重渲染时用最新值。
 */
function makeReact() {
  const instances = new Map(); // key -> { states, refs, cursor }
  let cursorKey = null;

  const React = {
    createElement(type, props, ...children) {
      if (type === undefined || type === null) {
        problems.push('createElement 收到空 type —— 可能有组件被当普通函数调用了');
      }
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const inst = instances.get(cursorKey);
      if (!inst) throw new Error('useState 在组件外被调用');
      const i = inst.cursor++;
      if (!(i in inst.states)) {
        inst.states[i] = typeof initial === 'function' ? initial() : initial;
      }
      return [inst.states[i], v => {
        inst.states[i] = typeof v === 'function' ? v(inst.states[i]) : v;
        inst.dirty = true;
      }];
    },
    useRef(initial) {
      const inst = instances.get(cursorKey);
      if (!inst) throw new Error('useRef 在组件外被调用');
      const i = inst.cursor++;
      if (!(i in inst.refs)) inst.refs[i] = { current: initial };
      return inst.refs[i];
    },
    useCallback(fn) { const inst = instances.get(cursorKey); if (inst) inst.cursor++; return fn; },
    useMemo(fn) { const inst = instances.get(cursorKey); if (inst) inst.cursor++; return fn(); },
    // effect 必须真的执行：面板的数据加载（fetch /status、/settings）就在
    // useEffect 里。只登记不执行的话，settings 永远是 null，
    // 只能渲染骨架态——那样根本测不出白屏。
    useEffect(fn, deps) {
      const inst = instances.get(cursorKey);
      if (inst) inst.cursor++;
      pendingEffects.push({ fn, deps, key: cursorKey });
    },
  };

  const pendingEffects = [];

  /** 执行本轮登记的 effects（忽略依赖数组的比较，测试里多跑几次无害）。 */
  function runEffects() {
    const list = pendingEffects.splice(0, pendingEffects.length);
    for (const { fn } of list) {
      try {
        fn();
      } catch (error) {
        problems.push(`useEffect 回调抛错：${error && error.message}`);
      }
    }
    return list.length;
  }

  /** 渲染一个元素树，返回 { type, props, children } 形状的树（组件已展开）。 */
  function renderTree(element, depth = 0) {
    if (depth > 80) return null;
    if (element === null || element === undefined || typeof element !== 'object') return element;
    const { type, props, children } = element;
    if (typeof type === 'function') {
      const name = type.name || 'anonymous';
      const key = `${name}#${depth}`;
      if (!instances.has(key)) instances.set(key, { states: {}, refs: {}, cursor: 0, dirty: false });
      const inst = instances.get(key);
      inst.cursor = 0;
      const prev = cursorKey;
      cursorKey = key;
      let out;
      try {
        out = type({ ...props, children });
      } catch (error) {
        problems.push(`渲染 <${name}> 抛错：${error && error.message}`);
        out = null;
      } finally {
        cursorKey = prev;
      }
      return renderTree(out, depth + 1);
    }
    return { type, props, children: (children ?? []).map(c => renderTree(c, depth + 1)) };
  }

  /** 反复渲染 + 执行 effects 直到都没有新动作（最多 12 轮）。 */
  function renderUntilStable(element) {
    let tree = null;
    for (let round = 0; round < 12; round += 1) {
      for (const inst of instances.values()) inst.dirty = false;
      tree = renderTree(element);
      const ran = runEffects();
      if (![...instances.values()].some(i => i.dirty) && ran === 0) break;
    }
    return tree;
  }

  return { React, renderUntilStable, runEffects };
}

/** 收集渲染树里出现的所有文本，便于断言"面板真的渲染了内容"。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach(n => collectText(n, out)); return out; }
  if (typeof node === 'object') {
    collectText(node.children, out);
    if (node.props) {
      for (const key of ['title', 'placeholder', 'value']) {
        if (typeof node.props[key] === 'string') out.push(node.props[key]);
      }
    }
  }
  return out;
}

// ── 造一份真实形状的后端数据 ──────────────────────────────
const statusPayload = {
  settingsPath: 'C:\\Users\\x\\.dsh\\presale\\settings.json',
  settingsWarnings: [],
  identity: {
    state: 'anchored', myOid: 'D8HS2VhbIeHGbHEUVCofiSaQpBPqHZXXdD', myName: '测试账号',
    loginId: 'test', aliases: ['a', 'b'], message: '身份已锚定',
  },
  poller: {
    running: true, lastSearchAt: Date.now(), lastHitAt: 0, cycles: 19, hits: 0,
    currentIntervalSeconds: 123, consecutiveEmpty: 19,
    watermark: { lastSeenText: '2026/10/15 23:50:12' }, lastError: '',
  },
  llm: { available: true, route: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'default' } },
  activity: [],
};

const settingsPayload = {
  enabled: true,
  dryRun: true,
  ownerName: '测试账号',
  company: '',
  mention: { enabled: true, minConfidence: 0.6 },
  poll: { intervalSeconds: 60, maxIntervalSeconds: 300 },
  llm: { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 16384, timeoutMs: 120000 },
  attachments: { enabled: true, maxFileBytes: 52428800, pythonPath: 'C:\\Python314\\python.exe' },
  triggers: {
    provide: { keywords: ['提供完整项目需求'], prefix: '', cooldownSeconds: 60, template: '你好 {senderName}' },
    summarize: { keywords: ['梳理项目需求'], cooldownSeconds: 120, historyCount: 200, title: '【项目需求梳理】', prompt: '你是售前技术支持' },
  },
};

// 注意形状：/settings 返回 **{ settings: {...} }**（不是裸对象），
// /status 返回 { ok, status: {...} }。形状搞错的话会测出假故障。
const fetchCalls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  fetchCalls.push(u);
  const body = u.includes('/settings') ? { ok: true, settings: settingsPayload }
    : u.includes('/status') ? { ok: true, status: statusPayload }
      : u.includes('/activity') ? { ok: true, items: [] }
        : u.includes('/attachments') ? { ok: true, stats: { count: 0, bytes: 0 } }
          : { ok: true };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

globalThis.window = {
  __ModuleLoader__: { load(d) { globalThis.__loaded = d; } },
  addEventListener() {}, removeEventListener() {},
  innerWidth: 1440, innerHeight: 900,
};
globalThis.document = {
  head: { appendChild() {} },
  createElement() { return { dataset: {}, textContent: '', remove() {} }; },
  addEventListener() {}, removeEventListener() {},
};

const { React, renderUntilStable } = makeReact();
const requireStub = id => {
  if (id === 'react') return React;
  throw new Error(`未知模块：${id}`);
};

// ── 加载 ──────────────────────────────────────────────────
try {
  new Function('window', 'document', 'fetch', 'React', source)(
    globalThis.window, globalThis.document, globalThis.fetch, React);
} catch (error) {
  console.log('✖ 加载 client.js 抛错：\n' + (error && error.stack));
  process.exit(1);
}
const def = globalThis.__loaded;
if (!def) { console.log('✖ 没有调用 __ModuleLoader__.load —— 插件注册不上（白屏）'); process.exit(1); }
console.log(`✔ 注册模块 id=${def.id}`);

let mod;
try { mod = def.factory(requireStub); } catch (error) {
  console.log('✖ factory 抛错：\n' + (error && error.stack)); process.exit(1);
}
console.log(`✔ factory 返回：${Object.keys(mod ?? {}).join(', ')}`);

// ── 注册 ──────────────────────────────────────────────────
const slotCalls = [];
const ctx = {
  slots: {
    register(...args) { slotCalls.push(args); return () => {}; },
    inject(_k, cb) { cb(); return () => {}; },
  },
  effect(fn) { fn(); return () => {}; },
  get() { return undefined; },
  on() { return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};
try { mod.apply(ctx); } catch (error) {
  console.log('✖ apply(ctx) 抛错：\n' + (error && error.stack)); process.exit(1);
}
if (slotCalls.length === 0) { console.log('✖ 没有 slots.register'); process.exit(1); }

// 面板本体挂在 main 插槽（整块设置模块已迁过去）。
// slotCalls[0] 现在是侧边栏入口，只画一个图标，不能拿它当面板来渲染。
const mainEntry = slotCalls.find(([o]) => o?.name === 'main');
if (mainEntry === undefined) { console.log('✖ 没有注册 main 插槽'); process.exit(1); }
const [options, component] = mainEntry;
console.log(`✔ main 插槽 key=${options.key}，组件是第 2 参数：${typeof component === 'function' ? '是' : '否（会白屏）'}`);
if (typeof component !== 'function') process.exit(1);

// ── 渲染（关键：驱动到有数据的状态）──────────────────────
// 先渲染一次骨架；async 的 fetch 在微任务里完成，用 await 让它们落地，
// 再渲染几轮直到状态稳定。
let tree = renderUntilStable(React.createElement(component));
console.log(`✔ 第 1 轮渲染（骨架态），fetch 调用 ${fetchCalls.length} 次`);

for (let i = 0; i < 6; i += 1) {
  await new Promise(r => setImmediate(r));
  tree = renderUntilStable(React.createElement(component));
}

const texts = collectText(tree);
const joined = texts.join(' | ');
console.log(`✔ 稳定后渲染出 ${texts.length} 段文本`);
console.log(`  fetch 端点：${[...new Set(fetchCalls.map(u => u.replace(/^.*presale-api/, '').split('?')[0]))].join(', ')}`);

// 面板应当渲染出这些关键文案
const mustHave = ['运行状态', '总开关', '功能一', '功能二', '保存功能一', '保存功能二'];
for (const key of mustHave) {
  if (!joined.includes(key)) problems.push(`渲染结果里找不到「${key}」——面板可能没渲染完整`);
}

// ── 回归断言 ────────────────────────────────────────────────
// ① @ 销售人员必须并入「功能一」，不能再是独立卡片。
//    判断依据：它出现在「功能一」标题与「功能二」标题之间，且不再有独立的
//    卡片标题结构。这里用渲染树里的顺序做检查。
const iAction1 = joined.indexOf('功能一');
const iMention = joined.indexOf('@ 销售人员');
const iAction2 = joined.indexOf('功能二');
if (iMention < 0) {
  problems.push('找不到「@ 销售人员」——它应当并入功能一卡片内');
} else if (!(iAction1 < iMention && iMention < iAction2)) {
  problems.push('「@ 销售人员」不在「功能一」与「功能二」之间——可能又变回独立卡片了');
}
if (joined.includes('保存 @ 设置')) {
  problems.push('还存在独立的「保存 @ 设置」按钮——@ 策略应当与功能一合并保存');
}

// ② 悬停提示不能同时挂原生 title 属性，否则浏览器会弹出第二个气泡。
const tipTriggers = [];
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (node.props && typeof node.props.className === 'string'
      && node.props.className.includes('dsp-tiptrigger')) {
    tipTriggers.push(node.props);
  }
  walk(node.children);
})(tree);
console.log(`  dsp-tiptrigger 节点：${tipTriggers.length} 个`);
for (const p of tipTriggers) {
  if ('title' in p && p.title !== undefined) {
    problems.push('提示触发区上挂了原生 title 属性——会和自定义气泡同时弹出（悬停出现两个提示）');
    break;
  }
  if (!p['aria-label']) {
    problems.push('提示触发区缺少 aria-label——读屏用户拿不到说明文字');
    break;
  }
}

// ③ 两个挂载点，配套使用。
//
// sidebar.panellist = 顶部入口（只画图标，文字由外壳渲染）
// main             = 该入口对应的中央页面（完整设置模块）
//
// 注册失败时页面一切正常、只有点开才白屏——必须在这里提前抓住。
// 另外断言 settings.section **没有**被注册：设置是模态窗口，会锁死主页面，
// 模块已整体迁到 main 面板；若哪天它又被加回来，这里会直接失败。
const slotNames = slotCalls.map(([o]) => o?.name);
console.log(`  已注册插槽：${slotNames.join(', ')}`);
for (const need of ['sidebar.panellist', 'main']) {
  if (!slotNames.includes(need)) problems.push(`缺少插槽注册：${need}`);
}
if (slotNames.includes('settings.section')) {
  problems.push('又注册了 settings.section——设置是模态窗口，会锁死主页面，模块已迁至 main');
}

const mainCall = slotCalls.find(([o]) => o?.name === 'main');
const footCall = slotCalls.find(([o]) => o?.name === 'sidebar.panellist');
if (mainCall !== undefined) {
  // main 是 keyed 插槽，key 必须与侧边栏条目的 id 一致，否则点了切不过去
  const footId = footCall?.[0]?.id;
  if (mainCall[0].key !== footId) {
    problems.push(`main 的 key(${mainCall[0].key}) 与侧边栏条目 id(${footId}) 不一致——点击后切不到面板`);
  }
}

// 渲染主面板：这里一旦抛错，用户点侧边栏就是白屏
if (mainCall !== undefined && typeof mainCall[1] === 'function') {
  try {
    let mainTree = renderUntilStable(React.createElement(mainCall[1]));
    for (let i = 0; i < 6; i += 1) {
      await new Promise(r => setImmediate(r));
      mainTree = renderUntilStable(React.createElement(mainCall[1]));
    }
    const mainTexts = collectText(mainTree);
    const mainJoined = mainTexts.join(' | ');
    console.log(`✔ 主面板渲染出 ${mainTexts.length} 段文本`);
    // 主面板放的是**完整**设置模块：配置项和运维项都必须在
    for (const key of ['运行状态', '总开关', '功能一', '功能二', '总结提示词', '触发关键词']) {
      if (!mainJoined.includes(key)) problems.push(`主面板里找不到「${key}」——模块没完整迁移过来`);
    }
  } catch (error) {
    problems.push('渲染主面板时抛错（点侧边栏会白屏）：' + (error && error.message ? error.message : error));
  }
}

// 渲染侧边栏入口：只应有图标，不该再画一遍「售前助手」文字
// （外壳会按 label 渲染，两边都画就是用户看到的「售前助手 售前助手」）
if (footCall !== undefined && typeof footCall[1] === 'function') {
  try {
    const footTree = renderUntilStable(React.createElement(footCall[1], { usePanelInfo: undefined }));
    // 只看**真正渲染出来的文字节点**。不能用 collectText——它为了覆盖属性文案
    // 会把 title / aria-label 也收进来，而按钮的 title 本来就是「售前助手」。
    const childTexts = [];
    (function walkChildren(node) {
      if (node === null || node === undefined || node === false) return;
      if (typeof node === 'string' || typeof node === 'number') { childTexts.push(String(node)); return; }
      if (Array.isArray(node)) { node.forEach(walkChildren); return; }
      if (typeof node === 'object') walkChildren(node.children);
    })(footTree);
    const footJoined = childTexts.join('');
    if (footJoined.includes('售前助手')) {
      problems.push('侧边栏入口组件自己画了「售前助手」文字——会和外壳的 label 重复成「售前助手 售前助手」');
    } else {
      console.log(`✔ 侧边栏入口只画图标（文字节点：${JSON.stringify(footJoined)}），文字交给外壳`);
    }

    // 图标必须是 SVG，不能是文字符号。
    // 之前用的是「◈」这个字符——和旁边那排线性图标摆在一起非常扎眼，
    // 用户直接反馈"图标太丑"。这里锁住"必须是 svg 元素"，且规格与内置一致。
    const svgNodes = [];
    (function walkSvg(node) {
      if (node === null || node === undefined || node === false) return;
      if (Array.isArray(node)) { node.forEach(walkSvg); return; }
      if (typeof node === 'object') {
        if (node.type === 'svg') svgNodes.push(node.props ?? {});
        walkSvg(node.children);
      }
    })(footTree);
    if (svgNodes.length === 0) {
      problems.push('侧边栏入口没有渲染出 SVG 图标——不要用文字符号当图标');
    } else {
      const p = svgNodes[0];
      const okBox = p.viewBox === '0 0 24 24';
      const okStroke = p.stroke === 'currentColor';
      const okWidth = p.width === 16 && p.height === 16;
      if (!okBox) problems.push(`图标 viewBox 不是 24×24（实际 ${p.viewBox}）——与内置图标规格不一致`);
      if (!okStroke) problems.push('图标描边不是 currentColor——深浅主题不会跟随');
      if (!okWidth) problems.push(`图标尺寸不是 16×16（实际 ${p.width}×${p.height}）`);
      if (okBox && okStroke && okWidth) console.log('✔ 图标是 SVG（24×24 viewBox / currentColor / 16px）');
    }
  } catch (error) {
    problems.push('渲染侧边栏入口时抛错：' + (error && error.message ? error.message : error));
  }
}

if (problems.length > 0) {
  console.log('\n发现的问题：');
  for (const p of problems) console.log('  ✖ ' + p);
  process.exit(1);
}
console.log('\n==== 客户端运行时自检通过 ====');
// 显式退出：组件里会登记真正的定时器（Tooltip 的 260ms 延迟），
// 不退出的话 Node 会一直等事件循环空下来，脚本看着像"卡住"。
process.exit(0);
