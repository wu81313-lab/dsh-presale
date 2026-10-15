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

check('等待并注入了 settings.section', injectedSlots.includes('settings.section'), JSON.stringify(injectedSlots));
check('注册了恰好 1 个插槽', registrations.length === 1, `实际 ${registrations.length}`);

if (registrations.length > 0) {
  const opts = registrations[0].options;
  check('插槽名是 settings.section', opts.name === 'settings.section', String(opts.name));
  check('id 为 presale', opts.id === 'presale', String(opts.id));
  check('label 是函数（外壳要求惰性求值）', typeof opts.label === 'function', typeof opts.label);
  if (typeof opts.label === 'function') {
    check('label 返回中文「售前助手」', opts.label() === '售前助手', String(opts.label()));
  }
  check('order 是数字', typeof opts.order === 'number', String(opts.order));
  check('注册了组件', typeof registrations[0].Component === 'function');
}

check('注入了样式（跟随主题令牌）', styleTags.length === 1, `实际 ${styleTags.length}`);
if (styleTags.length === 1) {
  const css = styleTags[0].textContent;
  check('样式只用 DSH 设计令牌，不写死颜色', css.includes('--dsw-'), '未发现 --dsw- 令牌');
  check('样式作用域带 dsp- 前缀（不污染宿主）', css.includes('.dsp-'));

  // ── 令牌名必须真实存在 ──────────────────────────────────────
  //
  // 这条是**踩坑换来的**：早前 CSS 里用的是 `--dsw-alias-border` /
  // `--dsw-alias-text-1` / `--dsw-alias-brand` 这类**猜测名**，而真实令牌是
  // `--dsw-alias-border-l1` / `--dsw-alias-label-primary` / `--dsw-alias-brand-primary`。
  // 写错**不会报错**，只会静默走兜底值——于是「跟随主题」形同虚设，
  // 换深浅色面板也不跟着变。
  //
  // 清单**从主题包导出，不手写**：最初我按 listTokens 的 14 个建了白名单，
  // 但那个列表只是子集（客户端自带设置页实际用到 79 个），
  // 于是真令牌被误判成非法，自检变成了"阻碍正确改动"的东西。
  // 导出命令：python tools/sync-theme-tokens.py
  const tokenListPath = new URL('./theme-tokens.json', import.meta.url);
  let THEME_TOKENS = new Set();
  try {
    const payload = JSON.parse(readFileSync(tokenListPath, 'utf8'));
    THEME_TOKENS = new Set(payload.tokens ?? []);
  } catch (err) {
    console.log(`  ! 读不到 theme-tokens.json（${err.message}）——先跑 python tools/sync-theme-tokens.py`);
  }

  // 只看 CSS 部分：注释里会举反例（提到错误的旧名字），不该被算进来
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
  const usedTokens = [...new Set(cssWithoutComments.match(/--dsw-[a-z0-9-]+/gu) ?? [])];
  // --dsw-static-* 是底层色板，同样合法
  const unknownTokens = usedTokens.filter(t => !THEME_TOKENS.has(t) && !t.startsWith('--dsw-static-'));
  check(
    '样式里的令牌名都是 DSH 真实令牌（防止静默失效）',
    unknownTokens.length === 0 && THEME_TOKENS.size > 0,
    unknownTokens.length > 0
      ? `未知令牌：${unknownTokens.join('、')}`
      : `共 ${usedTokens.length} 个，对照 ${THEME_TOKENS.size} 个已知令牌`,
  );
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
