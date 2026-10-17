// 客户端半边自检：在 Node 里模拟浏览器的 __ModuleLoader__ 与 require，
// 把 client/client.js 真跑一遍，断言它注册的插槽契约正确。
//
// 为什么值得单独验：客户端半边出错的表现是「设置里根本没有这一项」，
// 而且错误只出现在浏览器控制台里，从 DSH 日志看不到。
//
// 运行：node tools/selftest-client.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client', 'client.js');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 模拟浏览器环境 ────────────────────────────────────────────
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded.push({ id, factory });
    },
  },
};

// 极简 React 替身：只要能被调用、能持有 hooks 即可（不做真实渲染）
let hookState = [];
let hookCursor = 0;
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => {
    const index = hookCursor;
    hookCursor += 1;
    if (hookState.length <= index) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [hookState[index], value => { hookState[index] = value; }];
  },
  useCallback: fn => fn,
  useEffect: () => {},
  useRef: initial => ({ current: initial }),
  useMemo: fn => fn(),
  useReducer: (reducer, initial) => [initial, () => {}],
};

const requireStub = name => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return {};
  throw new Error(`客户端代码 require 了未预期的模块：${name}`);
};

// ── 执行客户端 bundle ─────────────────────────────────────────
const source = readFileSync(clientPath, 'utf8');
console.log('== 执行客户端 bundle ==');
try {
  // 用 Function 执行，模拟浏览器把脚本当普通脚本跑
  // eslint-disable-next-line no-new-func
  new Function(source)();
  check('脚本执行无异常', true);
} catch (error) {
  check('脚本执行无异常', false, error.message);
}

check('调用了 __ModuleLoader__.load', loaded.length === 1, `实际 ${loaded.length} 次`);
if (loaded.length === 1) {
  check('模块 id 与包名一致', loaded[0].id === 'dsh-presale', String(loaded[0].id));
}

// ── 取出模块导出 ──────────────────────────────────────────────
console.log('\n== 模块导出 ==');
let mod = null;
try {
  mod = loaded[0].factory(requireStub);
  check('factory 返回导出对象', typeof mod === 'object' && mod !== null);
} catch (error) {
  check('factory 返回导出对象', false, error.message);
}

if (mod !== null) {
  check('导出 apply 函数', typeof mod.apply === 'function');
  check('导出 inject 数组', Array.isArray(mod.inject), JSON.stringify(mod.inject));
  check('inject 包含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject));
}

// ── 运行 apply(ctx) 并断言插槽注册 ────────────────────────────
console.log('\n== 插槽注册 ==');
const registrations = [];
const injectedSlots = [];
const effects = [];
const headerChildren = [];
const styleTags = [];

globalThis.document = {
  head: {
    appendChild(node) { styleTags.push(node); },
  },
  createElement(tag) {
    return { tag, dataset: {}, textContent: '', remove() {}, setAttribute() {}, removeAttribute() {} };
  },
  querySelectorAll() { return []; },
  body: {},
};

const slots = {
  register(options, Component) {
    registrations.push({ options, Component });
    return () => {};
  },
  inject(name, callback) {
    injectedSlots.push(name);
    return callback();
  },
};

const ctx = {
  slots,
  effect(factory, label) {
    effects.push(label);
    const result = typeof factory === 'function' ? factory() : undefined;
    return typeof result === 'function' ? result : () => {};
  },
  logger: { info() {}, warn() {}, error() {} },
};

if (mod !== null && typeof mod.apply === 'function') {
  try {
    mod.apply(ctx);
    check('apply() 无异常', true);
  } catch (error) {
    check('apply() 无异常', false, error.message);
  }
}

// 两个挂载点，配套使用：
//   sidebar.panellist  顶部全局导航组的入口（只画图标，文字由外壳渲染）
//   main               该入口对应的中央页面（完整设置模块）
//
// 不再注册 settings.section —— 那是模态窗口，打开就锁死主页面，
// 整块已迁到 main 面板。所以这里也断言它**没有**被注册。
const EXPECTED_SLOTS = ['sidebar.panellist', 'main'];
const registeredNames = registrations.map(r => r.options?.name);
check('注册了 2 个插槽', registrations.length === 2, `实际 ${registrations.length}: ${registeredNames.join(', ')}`);
for (const need of EXPECTED_SLOTS) {
  check(`注册了 ${need}`, registeredNames.includes(need), registeredNames.join(', '));
}
check('不再注册 settings.section（模态窗口已弃用）', !registeredNames.includes('settings.section'), registeredNames.join(', '));

const footReg = registrations.find(r => r.options?.name === 'sidebar.panellist');
const mainReg = registrations.find(r => r.options?.name === 'main');

if (footReg !== undefined) {
  const opts = footReg.options;
  check('侧边栏条目 id 为 presale', opts.id === 'presale', String(opts.id));
  check('label 是函数（外壳要求惰性求值）', typeof opts.label === 'function', typeof opts.label);
  if (typeof opts.label === 'function') {
    check('label 返回中文「售前助手」', opts.label() === '售前助手', String(opts.label()));
  }
  check('order 是数字', typeof opts.order === 'number', String(opts.order));
  check('侧边栏条目注册了组件', typeof footReg.Component === 'function');
}

if (mainReg !== undefined) {
  // main 是 keyed 插槽：key 必须等于侧边栏条目 id，否则点了切不过去
  check('主面板 key 与侧边栏 id 一致', mainReg.options.key === footReg?.options?.id,
    `${mainReg.options.key} vs ${footReg?.options?.id}`);
  check('主面板注册了组件', typeof mainReg.Component === 'function');
}

check('注入了样式（跟随主题令牌）', styleTags.length === 1, `实际 ${styleTags.length}`);
if (styleTags.length === 1) {
  check('样式只用 DSH 设计令牌，不写死颜色', styleTags[0].textContent.includes('--dsw-'), '未发现 --dsw- 令牌');
  check('样式作用域带 dsp- 前缀（不污染宿主）', styleTags[0].textContent.includes('.dsp-'));

  // 滚动：main 插槽只给定高容器，**不会**替面板加滚动条。
  // 原来挂在设置弹窗时由弹窗外壳滚动，迁到 main 后必须自己撑滚动区，
  // 否则 11 张卡的下半截永远看不到（用户实测报告过「无法上下滑动」）。
  const rootRule = (styleTags[0].textContent.match(/\.dsp-root\s*\{[^}]*\}/) ?? [''])[0];
  check('面板根容器自己可滚动（overflow-y: auto）', rootRule.includes('overflow-y: auto'), rootRule.slice(0, 120));
  check('面板根容器撑满高度（height: 100%）', rootRule.includes('height: 100%'), rootRule.slice(0, 120));
  check('面板根容器的 padding 不会被撑破（box-sizing: border-box）', rootRule.includes('box-sizing: border-box'), rootRule.slice(0, 120));
}

// ── 渲染一次面板（不装 React，只验证组件能被调用不抛错）───────
console.log('\n== 组件可调用性 ==');
if (registrations.length > 0 && typeof registrations[0].Component === 'function') {
  // 组件是函数组件，首次渲染时 settings 为 null 会走「加载中」分支
  hookState = [];
  hookCursor = 0;
  try {
    const element = registrations[0].Component({});
    check('组件首次渲染不抛错', element !== undefined && element !== null);
  } catch (error) {
    check('组件首次渲染不抛错', false, error.message);
  }
}

console.log(`\n==== ${failures === 0 ? '客户端自检全部通过' : `客户端自检失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
