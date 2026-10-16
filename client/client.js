// dsh-presale 客户端半边：设置对话框里的「售前助手」一级导航页。
//
// 装载契约（与已装第三方插件一致，实测得来）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
//   · React 由宿主共享提供，必须 require('react')，不能自带第二份（否则 hooks 失效）；
//   · 模块导出 { apply, inject }，inject 写「服务名」，这里是 ['slots']；
//   · 注册设置一级导航用的是 **settings.section** 插槽
//     （该插槽只投影 id / order / label，第三方拿不到图标，一律用外壳的齿轮）；
//   · 客户端到宿主没有通用 RPC，一律走同源 fetch 打 /presale-api/*。
//
// 刻意不引入任何打包器：整份代码是普通 JS + React.createElement，
// 出问题能直接在浏览器里读栈、改一行刷新即可。

window.__ModuleLoader__.load({
  id: 'dsh-presale',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const API = '/presale-api';

    const PANEL_ID = 'presale';

    // ─────────────────────────── 工具 ───────────────────────────

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        method: options?.method ?? 'GET',
        headers: { accept: 'application/json', 'x-dsh-presale-client': 'web' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text.length === 0 ? null : JSON.parse(text);
      } catch {
        throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok) throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
      return payload;
    }

    function humanTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '从未';
      try {
        return new Date(ms).toLocaleString('zh-CN');
      } catch {
        return String(ms);
      }
    }

    function relative(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const diff = Date.now() - ms;
      if (diff < 0) return '';
      if (diff < 60000) return `${Math.round(diff / 1000)} 秒前`;
      if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
      if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
      return `${Math.round(diff / 86400000)} 天前`;
    }

    /** 判断某个 patch 相对当前值是否真的变了（避免无谓保存）。 */
    function changed(a, b) {
      return JSON.stringify(a) !== JSON.stringify(b);
    }

    // ─────────────────────────── 样式 ───────────────────────────
    //
    // 只用 DSH 的设计令牌，因此深浅主题自动跟随；令牌缺失时每条规则都有中性兜底值。

    const CSS = `
.dsp-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; }
.dsp-card { border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.24)); border-radius: 12px; padding: 16px; background: var(--dsw-alias-bg-layer, transparent); }
.dsp-card-title { font-size: 14px; font-weight: 600; margin: 0 0 4px; color: var(--dsw-alias-text-1, inherit); }
.dsp-card-hint { font-size: 12px; line-height: 1.6; margin: 0 0 12px; color: var(--dsw-alias-text-3, rgba(128,128,128,.9)); }
/* 折叠箭头：收起朝下、展开朝上。做成按钮以便键盘可达。 */
.dsp-caret { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: 0 0; cursor: pointer; font: inherit; font-size: 13px; line-height: 1; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); transition: transform .16s, background .16s; }
.dsp-caret:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); }
.dsp-caret:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0f1115); outline-offset: -1px; }
.dsp-caret-open { transform: rotate(180deg); }
.dsp-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsp-row + .dsp-row { margin-top: 10px; }
.dsp-label { font-size: 13px; color: var(--dsw-alias-text-2, inherit); min-width: 128px; }
.dsp-input, .dsp-textarea, .dsp-select { flex: 1 1 240px; min-width: 0; font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-base, transparent); color: inherit; box-sizing: border-box; }
.dsp-textarea { min-height: 132px; resize: vertical; line-height: 1.6; font-family: inherit; }
.dsp-input:focus, .dsp-textarea:focus, .dsp-select:focus { outline: 2px solid var(--dsw-alias-brand, #4b7bec); outline-offset: -1px; }
.dsp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.dsp-btn { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-base, transparent); color: inherit; cursor: pointer; }
.dsp-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.12)); }
.dsp-btn:disabled { opacity: .5; cursor: not-allowed; }
.dsp-btn-primary { background: var(--dsw-alias-brand, #4b7bec); border-color: var(--dsw-alias-brand, #4b7bec); color: #fff; }
.dsp-btn-danger { color: var(--dsw-alias-danger, #d64545); border-color: var(--dsw-alias-danger, #d64545); }
.dsp-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.3)); }
.dsp-badge-ok { color: var(--dsw-alias-success, #2f9e44); border-color: currentColor; }
.dsp-badge-warn { color: var(--dsw-alias-warning, #c98a00); border-color: currentColor; }
.dsp-badge-err { color: var(--dsw-alias-danger, #d64545); border-color: currentColor; }
.dsp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px 20px; font-size: 13px; }
.dsp-kv { display: flex; flex-direction: column; gap: 2px; }
.dsp-kv-k { font-size: 12px; color: var(--dsw-alias-text-3, rgba(128,128,128,.9)); }
.dsp-kv-v { font-size: 13px; word-break: break-all; }
.dsp-note { font-size: 12px; line-height: 1.7; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); color: var(--dsw-alias-text-2, inherit); }
.dsp-note-warn { border-left: 3px solid var(--dsw-alias-warning, #c98a00); }
.dsp-note-err { border-left: 3px solid var(--dsw-alias-danger, #d64545); }
.dsp-log { font-size: 12px; line-height: 1.7; max-height: 300px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); padding: 10px 12px; }
.dsp-log-item + .dsp-log-item { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border, rgba(128,128,128,.2)); }
.dsp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.dsp-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.dsp-spacer { flex: 1; }
/* 卡片内的分节标题：把并入同一张卡的一组设置分开
   （例如「动作一」里的「@ 销售人员」）。
   上边留白 + 一道细分隔线，视觉上从属于卡片标题。 */
.dsp-subhead { margin-top: 20px; padding-top: 14px;
  border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.16));
  font-size: 13px; font-weight: 600; color: var(--dsw-alias-text-1, inherit); }

/* ── 折叠组（「高级设置」）─────────────────────────────────
   把不常用的几张卡收在一起，主屏只留日常要动的那几张。
   用原生 details：开合由浏览器处理，不需要 JS 也不需要状态。 */
.dsp-group { border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.24));
  border-radius: 12px; background: var(--dsw-alias-bg-layer, transparent); }
.dsp-group > summary { display: flex; align-items: center; gap: 8px;
  padding: 14px 16px; cursor: pointer; list-style: none; font-size: 14px;
  font-weight: 600; color: var(--dsw-alias-text-1, inherit); border-radius: 12px; }
.dsp-group > summary:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.06)); }
.dsp-group > summary::-webkit-details-marker { display: none; }
.dsp-group > summary::before { content: '▸'; flex: none; font-size: 10px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dsp-group[open] > summary::before { content: '▾'; }
.dsp-group[open] > summary { border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.16));
  border-radius: 12px 12px 0 0; }
.dsp-group-label { flex: 1; min-width: 0; }
/* 收起时也能看到里面配成了什么（例如当前模型），不必为了确认而展开 */
.dsp-group-sum { flex: none; font-size: 12px; font-weight: 400;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
/* 组内卡片去掉各自的边框，只靠间距区分——避免"框里套框" */
.dsp-group-body { display: flex; flex-direction: column; gap: 18px; padding: 18px; }
.dsp-group-body > .dsp-card { border: 0; border-radius: 0; padding: 0; background: 0 0; }
.dsp-group-body > .dsp-card + .dsp-card { border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.16)); padding-top: 18px; }

/* ── 状态开关（监听启停用）──────────────────────────────────
   把「开始监听 / 停止监听」两个按钮合成一个开关：
     · 两个按钮同时摆着，用户得先读文字才知道当前是开还是关；
     · 开关的**位置**本身就表达状态（左关右开），一眼可读。
   配色刻意区分：
     · 开 = 绿（state-success-primary）
     · 关 = **红**（state-error-primary）——不是灰。
       监听停着等于功能没在工作，用中性的灰容易被当成"没设置"。
   滑块上的 On/Off 与右侧文字都由 React 渲染（不用 ::after 生成内容，
   否则那份文字读屏软件拿不到）。 */
.dsp-switch { display: inline-flex; align-items: center; gap: 9px; flex: none; cursor: pointer; user-select: none; }
.dsp-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.dsp-switch-track { position: relative; flex: none; width: 44px; height: 24px; border-radius: 999px;
  background: var(--dsw-alias-state-error-primary, #d64545); transition: background .18s; }
.dsp-switch.on .dsp-switch-track { background: var(--dsw-alias-state-success-primary, #2f9e44); }
.dsp-switch-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .18s; }
.dsp-switch.on .dsp-switch-thumb { transform: translateX(20px); }
/* On/Off 文字压在滑块上：关时靠右、开时靠左，是这类开关的惯例 */
.dsp-switch-text { position: absolute; top: 50%; transform: translateY(-50%);
  font-size: 10px; font-weight: 700; letter-spacing: .02em; color: #fff; }
.dsp-switch:not(.on) .dsp-switch-text { right: 7px; }
.dsp-switch.on .dsp-switch-text { left: 7px; }
.dsp-switch-caption { font-size: 13px; color: var(--dsw-alias-text-2, inherit); white-space: nowrap; }
.dsp-switch.busy { opacity: .6; cursor: default; }
.dsp-switch:not(.busy):hover .dsp-switch-caption { color: var(--dsw-alias-text-1, inherit); }
.dsp-switch input:focus-visible + .dsp-switch-track { outline: 2px solid var(--dsw-alias-brand, #4b7bec); outline-offset: 2px; }
.dsp-pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; line-height: 1.7; margin: 0; }
/* 维护折叠区：默认收起，只占一行。
   三个维护动作（立即检查 / 重置水位 / 重新识别身份）都是排查用的，
   平铺在按钮行里会把日常操作挤在一起，所以折起来。 */
.dsp-maintain { margin-top: 12px; }
.dsp-maintain > summary { font-size: 12px; color: var(--dsw-alias-text-3, rgba(128,128,128,.9));
  cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.dsp-maintain > summary:hover { color: var(--dsw-alias-text-2, inherit); }
.dsp-maintain > summary::-webkit-details-marker { display: none; }
.dsp-maintain > summary::before { content: '▸'; font-size: 10px; }
.dsp-maintain[open] > summary::before { content: '▾'; }

/* ── 悬停提示 ──────────────────────────────────────────────
   为什么要自己写、且必须用 position:fixed：
     · 客户端没有暴露 primitives 服务，拿不到宿主自带的 Tooltip；
     · 卡片是 overflow:hidden，纯 CSS 的 ::after 气泡会被裁掉。
   所以用 JS 量出触发区的位置，把气泡挂到 fixed 层上，再按视口夹紧。

   触发区是**内容本身**（卡片标题、字段标签），没有额外的 ? 圆点。
   用虚线内下划线暗示"这里有说明可看"——比一个问号图标含蓄，
   也不会被误认成可点击的按钮。 */
/* 悬停提示的触发区（卡片标题、字段标签）。
   不加下划线也不加图标：文字本身就是触发区，鼠标移上去即可。
   cursor:help 是唯一的暗示——不改变排版，也不会被误认成可点的按钮。 */
.dsp-tiptrigger { cursor: help; }
.dsp-tiptrigger > .dsp-tip { text-decoration: none; }
.dsp-tip { position: fixed; z-index: 9999; width: 300px; max-width: calc(100vw - 24px);
  padding: 9px 11px; border-radius: 8px; font-size: 12px; line-height: 1.65;
  text-decoration: none; text-align: left; font-weight: 400;
  background: var(--dsw-alias-bg-layer, #fff);
  color: var(--dsw-alias-text-1, #0f1115);
  border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.3));
  box-shadow: 0 6px 24px rgba(0,0,0,.14); pointer-events: none; }
.dsp-tip-above { transform: translateY(-100%); }
`;

    let styleElement = null;
    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-presale';
      tag.textContent = CSS;
      document.head.appendChild(tag);
      styleElement = tag;
      return () => {
        tag.remove();
        if (styleElement === tag) styleElement = null;
      };
    }

    // ─────────────────────────── 小组件 ───────────────────────────

    /**
     * 悬停/聚焦提示气泡。
     *
     * 触发区就是**被包裹的内容本身**（卡片标题、字段标签），不再另加 ? 圆点：
     * 多一个圆点等于多一个要认的元素，而"悬停标题看说明"是通用习惯。
     *
     * 为什么自己写而不是用组件库：客户端把 primitives 服务收在内部，
     * 第三方插件通过 ctx 拿不到（可用服务只有 layout / locale / sessions /
     * slots / theme / timer / uiWorkspace / workspaces）。
     *
     * 为什么用 position:fixed 而不是 CSS 的 ::after：
     *   · 卡片是 overflow:hidden，气泡会被裁掉；
     *   · fixed 相对视口定位，不受任何祖先的溢出影响。
     * 代价是要在打开时量一次触发点的位置，并做视口夹紧。
     *
     * 交互：移入/聚焦显示（延迟 260ms，避免鼠标划过就弹），
     * 移出/失焦/Esc 关闭；由于标题不可聚焦，额外支持点击切换。
     */
    function Tooltip(props) {
      const [pos, setPos] = React.useState(null);
      const ref = React.useRef(null);
      const timer = React.useRef(null);

      const show = () => {
        const node = ref.current;
        if (node === null) return;
        const r = node.getBoundingClientRect();
        const W = 300;
        // 水平居中于触发区，再夹进视口（左右各留 12px）
        const center = r.left + r.width / 2;
        const left = Math.max(12 + W / 2, Math.min(center, window.innerWidth - 12 - W / 2));
        // 下方放不下就翻到上方
        const above = r.bottom + 8 + 130 > window.innerHeight && r.top > 150;
        setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
      };
      const cancel = () => {
        if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
      };
      const schedule = () => { cancel(); timer.current = setTimeout(show, 260); };
      const hide = () => { cancel(); setPos(null); };

      // 卸载时清掉待触发的定时器，避免在已移除的节点上定位
      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current);
      }, []);

      React.useEffect(() => {
        if (pos === null) return undefined;
        const onKey = event => { if (event.key === 'Escape') setPos(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [pos]);

      return h('span', {
        ref,
        className: 'dsp-tiptrigger',
        // 注意：**不要**在这里加 title 属性。
        // title 会让浏览器同时弹出它自己的原生气泡，于是悬停一次出现两个提示
        // （原生的那个还是方角灰底，跟界面风格也不一致）。
        // 读屏改用 aria-label 提供同样一段文字。
        'aria-label': props.text,
        onMouseEnter: schedule,
        onMouseLeave: hide,
        onClick: event => { event.preventDefault(); cancel(); (pos === null ? show() : setPos(null)); },
      },
        props.children,
        pos === null ? null : h('div', {
          className: `dsp-tip${pos.above ? ' dsp-tip-above' : ''}`,
          role: 'tooltip',
          style: { left: pos.left, top: pos.top },
        }, props.text),
      );
    }

    /**
     * 表单字段：左标签 + 右控件。
     *
     * `hint` 默认挂在**标签**上做成悬停提示（与卡片标题一致），
     * 不再在字段下方摊一行说明——几十个字段各摊一行，页面会被撑得很长。
     * 需要常驻显示时传 hintMode="inline"。
     *
     * 注意：这里用的是 Field 默认的 `hint` 属性，不是 Card 的。
     */
    function Field(props) {
      const asTip = props.hintMode !== 'inline';
      return h('div', { className: 'dsp-row' },
        h('div', { className: 'dsp-label' },
          asTip && props.hint ? h(Tooltip, { text: props.hint }, props.label) : props.label,
        ),
        props.children,
        props.hint && !asTip
          ? h('div', { className: 'dsp-card-hint', style: { flex: '1 1 100%', margin: '2px 0 0 0' } }, props.hint)
          : null,
      );
    }

    /**
     * 折叠开关：一个可点的小箭头。
     *
     * 用在「运行状态」上——那 8 项指标平时不用盯着看，默认收起能让整页短很多；
     * 但异常时又要能一眼展开，所以箭头常驻、不做成"藏起来的交互"。
     */
    function Caret(props) {
      const open = props.open === true;
      return h('button', {
        type: 'button',
        className: `dsp-caret${open ? ' dsp-caret-open' : ''}`,
        title: open ? '收起详情' : '展开详情',
        'aria-expanded': open,
        'aria-label': open ? '收起详情' : '展开详情',
        onClick: props.onClick,
      }, '▾');
    }

    function Kv(props) {
      return h('div', { className: 'dsp-kv' },
        h('div', { className: 'dsp-kv-k' }, props.k),
        h('div', { className: 'dsp-kv-v' }, props.v),
      );
    }

    /**
     * 区块卡片。
     *
     * `hint` 默认渲染成**标题右侧的 `?` 悬停提示**，而不是占一整行的说明段。
     * 理由：卡片说明都是"这块是干什么的"的描述性文字，读完一次就不再看，
     * 摊在卡片头里却要一直占两行——十几张卡叠起来，页面被撑得很长。
     * 个别确实需要常驻的（比如出错时要一眼看到），传 hintMode="inline"。
     */
    function Card(props) {
      const asTip = props.hintMode !== 'inline';
      return h('section', { className: 'dsp-card' },
        h('h3', { className: 'dsp-card-title' },
          // Tooltip 自带包裹 span，标题文字直接作为子节点，不再多套一层
          asTip && props.hint ? h(Tooltip, { text: props.hint }, props.title) : props.title,
        ),
        props.hint && !asTip ? h('p', { className: 'dsp-card-hint' }, props.hint) : null,
        props.children,
      );
    }

    /**
     * 折叠组：把若干张不常用的卡收在一起。
     *
     * 用原生 details —— 开合交给浏览器，不需要 JS、不需要状态，
     * 也不会像受控组件那样在重渲染时把用户的展开状态重置掉。
     *
     * `summary` 右侧显示一行摘要（例如当前用的模型），
     * 这样收起时也能一眼看出里面配成了什么，不用为了确认而展开。
     */
    function Group(props) {
      return h('details', { className: 'dsp-group' },
        h('summary', null,
          h('span', { className: 'dsp-group-label' }, props.label),
          props.summary ? h('span', { className: 'dsp-group-sum' }, props.summary) : null,
        ),
        h('div', { className: 'dsp-group-body' }, props.children),
      );
    }

    // ─────────────────────────── 主面板 ───────────────────────────

    function Panel() {
      const [status, setStatus] = React.useState(null);
      const [settings, setSettings] = React.useState(null);
      const [activity, setActivity] = React.useState([]);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [saved, setSaved] = React.useState('');
      const [attachmentStats, setAttachmentStats] = React.useState(null);
      /**
       * 「运行状态」的指标详情是否展开。
       *
       * 默认收起：那 8 项指标（周期数、水位、轮询间隔…）平时不用盯着看，
       * 展开会把整页拉得很长。徽标行（监听中 / 身份已锚定）常驻可见，
       * 所以收起状态下依然一眼能看出"它在不在工作"。
       */
      const [showDetails, setShowDetails] = React.useState(false);
      const dirtyRef = React.useRef(false);

      const refresh = React.useCallback(async () => {
        try {
          const [s, st, act] = await Promise.all([
            api('/settings'),
            api('/status'),
            api('/activity?limit=30'),
          ]);
          // 用户正在编辑时不要把草稿覆盖掉
          if (!dirtyRef.current) setSettings(s.settings);
          setStatus(st);
          setActivity(act.entries ?? []);
          setError('');
        } catch (err) {
          setError(err.message);
        }
      }, []);

      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 5000);
        return () => clearInterval(timer);
      }, [refresh]);

      /** 局部更新草稿（不改磁盘）。 */
      function edit(path, value) {
        dirtyRef.current = true;
        setSettings(prev => {
          const next = JSON.parse(JSON.stringify(prev ?? {}));
          const keys = path.split('.');
          let cursor = next;
          for (let i = 0; i < keys.length - 1; i += 1) {
            if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) cursor[keys[i]] = {};
            cursor = cursor[keys[i]];
          }
          cursor[keys[keys.length - 1]] = value;
          return next;
        });
        setSaved('');
      }

      async function save(patch) {
        setBusy('save');
        try {
          const result = await api('/settings', { method: 'POST', body: { patch, strict: true } });
          dirtyRef.current = false;
          setSettings(result.settings);
          setSaved(`已保存（${new Date().toLocaleTimeString('zh-CN')}）`);
          setError('');
          await refresh();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy('');
        }
      }

      async function act(name, path, body) {
        setBusy(name);
        try {
          await api(path, { method: 'POST', body });
          setError('');
          await refresh();
          // 清空缓存后顺手刷新用量，让用户立刻看到结果
          if (path === '/attachments/clear') await loadAttachments();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy('');
        }
      }

      /** 拉取附件缓存用量（面板展示，不轮询——缓存变化不频繁，手动刷新即可）。 */
      async function loadAttachments() {
        try {
          setAttachmentStats(await api('/attachments'));
          setError('');
        } catch (err) {
          setError(`读取附件缓存失败：${err.message}`);
        }
      }

      if (settings === null || status === null) {
        return h('div', { className: 'dsp-root' },
          h(Card, { title: '售前助手' },
            h('p', { className: 'dsp-card-hint' }, error.length > 0 ? `加载失败：${error}` : '正在读取插件状态…'),
            h('div', { className: 'dsp-actions' }, h('button', { className: 'dsp-btn', onClick: () => void refresh() }, '重试')),
          ),
        );
      }

      const poller = status.poller ?? {};
      const id = status.identity ?? {};
      const llmInfo = status.llm ?? {};
      const t = settings.triggers ?? { provide: {}, summarize: {} };
      // 监听是否在跑。
      // 读自 poller 的**实际运行状态**，不是 settings.enabled 那个草稿——
      // 否则用户改了勾选框还没保存时，开关会显示成与实际不符的状态。
      const listening = poller.running === true;

      /**
       * 「高级设置」折叠组右侧的摘要。
       *
       * 为什么要有：把 6 张卡收起来之后，用户想确认"模型配的是哪个"
       * 就得先展开再找。摘要让收起状态下也能一眼看到关键配置。
       * 只列真正影响行为的几项，不堆参数——堆多了摘要自己就成了噪音。
       */
      function groupSummary() {
        const parts = [];
        const route = llmInfo.route ?? {};
        if (route.model) parts.push(route.model);
        // 轮询间隔：写"自动"更诚实——连续无命中时插件会自己拉长间隔，
        // 这里显示的是基准值而不是当前实际值（实际值在「运行状态」里）
        const interval = settings.poll?.intervalSeconds;
        if (interval) parts.push(`轮询 ${interval}s`);
        parts.push(settings.attachments?.enabled ? '读附件' : '不读附件');
        const n = activity.length;
        parts.push(n > 0 ? `日志 ${n} 条` : '暂无日志');
        return parts.join(' · ');
      }

      // 状态灯：把「为什么没工作」一次说清
      const badges = [];
      if (poller.enabled !== true) badges.push(['warn', '未启用']);
      else if (poller.running) badges.push(['ok', '监听中']);
      else badges.push(['warn', '已启用但未运行']);
      if (poller.dryRun) badges.push(['warn', '试运行：不发消息']);
      if (poller.authOk === false) badges.push(['err', 'dws 未登录']);
      if (id.state === 'anchored') badges.push(['ok', `身份已锚定：${id.myName || id.myOid}`]);
      else if (id.state === 'weak') badges.push(['warn', `身份弱校验：${id.myName || id.myOid}`]);
      else badges.push(['err', `身份未锚定${id.myName ? `（${id.myName}）` : ''}`]);
      if (llmInfo.available !== true) badges.push(['err', 'LLM 不可用']);

      return h('div', { className: 'dsp-root' },

        // ── 状态 ──────────────────────────────────────────────
        h(Card, {
          title: '运行状态',
        },
          h('div', { className: 'dsp-row' },
            ...badges.map(([kind, text], i) => h('span', { key: i, className: `dsp-badge dsp-badge-${kind}` }, text)),
            h(Caret, { open: showDetails, onClick: () => setShowDetails(v => !v) }),
          ),
          showDetails ? h('div', null,
            // 这段规则说明也放进详情：收起时只留一行徽标，整页短很多
            h('p', { className: 'dsp-card-hint', style: { marginTop: 12 } },
              '「只认我本人触发」是硬规则：只有你（上面的登录账号）发出的关键词才会被执行，其他人的同类消息会被跳过。'),
            h('div', { className: 'dsp-grid' },
              h(Kv, { k: '上次检查', v: `${humanTime(poller.lastSearchAt)}${relative(poller.lastSearchAt) ? `（${relative(poller.lastSearchAt)}）` : ''}` }),
              h(Kv, { k: '上次命中', v: humanTime(poller.lastHitAt) }),
              h(Kv, { k: '已完成周期', v: `${poller.cycles ?? 0} 次 / 命中 ${poller.hits ?? 0} 次` }),
              h(Kv, { k: '当前轮询间隔', v: poller.currentIntervalSeconds > 0 ? `${poller.currentIntervalSeconds} 秒` : '尚未计算' }),
              h(Kv, { k: '连续无命中', v: `${poller.consecutiveEmpty ?? 0} 轮（会自动拉长间隔省配额）` }),
              h(Kv, { k: '消息水位', v: poller.watermark?.lastSeenText ?? '未初始化' }),
              h(Kv, { k: '我的 openDingtalkId', v: h('span', { className: 'dsp-mono' }, id.myOid || '（未解析）') }),
              h(Kv, { k: 'LLM 路由', v: llmInfo.route?.provider ? `${llmInfo.route.provider} / ${llmInfo.route.model}（${llmInfo.route.source}）` : '不可用' }),
            ),
            id.message ? h('div', { className: 'dsp-note', style: { marginTop: 12 } }, `身份说明：${id.message}`) : null,
          ) : null,
          // 出错与告警**不受折叠影响**：有问题必须直接看见，不能藏在详情里
          poller.lastError ? h('div', { className: 'dsp-note dsp-note-warn', style: { marginTop: 10 } }, `最近错误：${poller.lastError}`) : null,
          (status.settingsWarnings ?? []).length > 0
            ? h('div', { className: 'dsp-note dsp-note-warn', style: { marginTop: 10 } },
                '配置告警：', h('ul', { style: { margin: '6px 0 0 18px' } }, (status.settingsWarnings ?? []).map((w, i) => h('li', { key: i }, w))))
            : null,
        ),

        // ── 开关 ──────────────────────────────────────────────
        h(Card, {
          title: '总开关',
          hint: '建议先用「试运行」把文案和 @ 判定调准，确认无误后再关掉试运行让它真发消息。',
        },
          h(Field, { label: '启用监听' },
            h('label', { className: 'dsp-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.enabled === true,
                onChange: e => edit('enabled', e.target.checked),
              }),
              settings.enabled ? '开启' : '关闭',
            ),
          ),
          h(Field, {
            label: '试运行 dryRun',
            hint: '开启时一切照常执行（读消息、判销售、组装文案），但只在活动日志里记录「本该发什么」，不会真的发到群里。',
          },
            h('label', { className: 'dsp-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.dryRun === true,
                onChange: e => edit('dryRun', e.target.checked),
              }),
              settings.dryRun ? '只记录，不发送' : '真实发送到群',
            ),
          ),
          h('div', { className: 'dsp-actions', style: { marginTop: 14 } },
            h('button', { className: 'dsp-btn dsp-btn-primary', disabled: busy === 'save', onClick: () => void save({ enabled: settings.enabled, dryRun: settings.dryRun }) }, '保存开关'),
            // 监听启停：一个状态开关，而不是「开始 / 停止」两个按钮。
            //
            // 原来两个按钮并排摆着，用户得先读文字才知道当前是开还是关，
            // 而且"停止监听"在已经停止时仍然可点，容易误以为出问题。
            // 开关的**位置**本身就表达状态（左关右开），一眼可读。
            //
            // 状态读自 poller（实际运行状态），不是读 settings 草稿——
            // 否则改了勾选框还没保存时，开关会显示成另一个状态，跟实际不符。
            h('label', {
              className: `dsp-switch${listening ? ' on' : ''}${busy !== '' ? ' busy' : ''}`,
              title: listening ? '点击停止监听' : '点击开始监听',
            },
              h('input', {
                type: 'checkbox',
                checked: listening,
                disabled: busy !== '',
                onChange: () => void act(listening ? 'stop' : 'start', listening ? '/stop' : '/start'),
              }),
              h('span', { className: 'dsp-switch-track' },
                // On/Off 由 React 渲染在滑块上（不用 ::after 生成内容，
                // 否则读屏软件拿不到这两个字）。忙碌时用省略号代替，
                // 避免"点了没反应"的错觉。
                h('span', { className: 'dsp-switch-text' },
                  busy === 'start' || busy === 'stop' ? '…' : (listening ? 'On' : 'Off')),
                h('span', { className: 'dsp-switch-thumb' }),
              ),
              h('span', { className: 'dsp-switch-caption' },
                busy === 'start' ? '启动中…'
                  : busy === 'stop' ? '停止中…'
                  : (listening ? '监听中' : '已停止')),
            ),
            h('div', { className: 'dsp-spacer' }),
          ),
          // 维护动作收进折叠区。
          //
          // 这三个都是排查用的：日常监听不需要动它们，但删掉会真的丢掉能力
          // （尤其「立即检查」——退避期最长 5 分钟，想验证配置时得靠它）。
          // 平铺在按钮行里会把上面三个日常按钮挤在一起，所以折起来。
          h('details', { className: 'dsp-maintain' },
            h('summary', null, '维护（排查用，平时不需要动）'),
            h('div', { className: 'dsp-actions', style: { marginTop: 10 } },
              h('button', {
                className: 'dsp-btn',
                disabled: busy !== '',
                title: '不等下一个轮询周期，立刻跑一轮搜索',
                onClick: () => void act('check', '/check-now'),
              }, busy === 'check' ? '检查中…' : '立即检查一次'),
              h('button', {
                className: 'dsp-btn',
                disabled: busy !== '',
                title: '把搜索起点推到此刻，之前的历史消息一律不再处理',
                onClick: () => void act('seed', '/seed-now'),
              }, '把水位重置为现在'),
              h('button', {
                className: 'dsp-btn',
                disabled: busy !== '',
                onClick: () => void act('id', '/reidentify'),
              }, '重新识别身份'),
            ),
          ),
        ),

        // ── 动作一 ────────────────────────────────────────────
        h(Card, {
          title: '动作一 · 提供完整项目需求',
          hint: '你在任意群里说触发关键词时，插件会在该群发下面这段文案，并尝试 @ AI 判别出的销售人员。',
        },
          h(Field, { label: '触发关键词', hint: '多个关键词用英文逗号分隔。匹配时会自动忽略前后空格、全角/半角差异与大小写。' },
            h('input', {
              className: 'dsp-input',
              value: (t.provide.keywords ?? []).join(','),
              onChange: e => edit('triggers.provide.keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean)),
            }),
          ),
          h(Field, { label: '触发前缀（可选）', hint: '留空表示直接说关键词就触发。若担心闲聊时顺口提到会误触发，可填一个前缀（例如「DSH 」），之后必须说「DSH 提供完整项目需求」才会触发。' },
            h('input', {
              className: 'dsp-input',
              value: t.provide.prefix ?? '',
              placeholder: '（留空 = 不需要前缀）',
              onChange: e => edit('triggers.provide.prefix', e.target.value),
            }),
          ),
          h(Field, { label: '冷却秒数', hint: '同一会话内两次触发的最小间隔，防止连打刷屏。' },
            h('input', {
              className: 'dsp-input',
              type: 'number',
              min: 0,
              value: t.provide.cooldownSeconds ?? 60,
              onChange: e => edit('triggers.provide.cooldownSeconds', Number(e.target.value)),
            }),
          ),
          h(Field, {
            label: '文案内容',
            hint: '可用占位符：{senderName} 触发人、{groupName} 群名、{keyword} 命中的关键词、{date} 日期、{time} 时间、{salesName} 判出的销售姓名。未识别的占位符会原样保留并在日志里提示。',
          },
            h('textarea', {
              className: 'dsp-textarea',
              value: t.provide.template ?? '',
              onChange: e => edit('triggers.provide.template', e.target.value),
            }),
          ),
          // ── @ 销售人员 ────────────────────────────────────
          //
          // 这块原先是**独立一张卡**，但它只服务于动作一（动作一才 @ 人，
          // 动作二的总结不 @ 任何人是设计如此）。单独成卡会让人以为它是
          // 全局设置，进而怀疑"动作二是不是也会 @ 人"。归到动作一里。
          //
          // 再往下细分两层：
          //   常显   「启用 @」——决定要不要 @ 人，是开关级别的决定；
          //   折叠   置信度门槛 / 降级策略 / 判别提示词——都是"怎么 @ 更准"
          //          的细化调参，调好一次基本不再动。
          // 之前这几项平铺着，一屏全是 @ 的细节，把动作一本身淹没了。
          h('div', { className: 'dsp-subhead' }, '@ 销售人员'),
          h(Field, { label: '启用 @' },
            h('label', { className: 'dsp-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.mention.enabled === true,
                onChange: e => edit('mention.enabled', e.target.checked),
              }),
              settings.mention.enabled ? '开启' : '关闭（只发文案，不 @ 人）',
            ),
          ),
          h('details', { className: 'dsp-maintain' },
            h('summary', null, `@ 判定策略（当前：置信度 ${settings.mention.minConfidence ?? 'high'}）`),
            h('div', { style: { marginTop: 4 } },
              h(Field, {
                label: '最低置信度',
                hint: '只有达到这个置信度才会真正 @ 人。达不到时：medium 会在正文里写成纯文本「@姓名」（不触发提醒），low 直接不 @。群里 @ 错人比不 @ 更尴尬，所以默认要求 high。',
              },
                h('select', {
                  className: 'dsp-select',
                  value: settings.mention.minConfidence ?? 'high',
                  onChange: e => edit('mention.minConfidence', e.target.value),
                },
                  h('option', { value: 'high' }, 'high（最保守，推荐）'),
                  h('option', { value: 'medium' }, 'medium（判出就 @）'),
                  h('option', { value: 'low' }, 'low（几乎总会 @）'),
                ),
              ),
              h(Field, { label: '中等置信度降级为文本提及' },
                h('label', { className: 'dsp-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: settings.mention.textualMentionWhenMedium === true,
                    onChange: e => edit('mention.textualMentionWhenMedium', e.target.checked),
                  }),
                  settings.mention.textualMentionWhenMedium ? '开启：正文写「@姓名」但不提醒' : '关闭：干脆不 @',
                ),
              ),
              h(Field, { label: '判不出时 @ 你自己' },
                h('label', { className: 'dsp-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: settings.mention.fallbackToTriggerWhenUnknown === true,
                    onChange: e => edit('mention.fallbackToTriggerWhenUnknown', e.target.checked),
                  }),
                  settings.mention.fallbackToTriggerWhenUnknown ? '开启' : '关闭（推荐）',
                ),
              ),
              h(Field, {
                label: '判别提示词',
                hint: '交给模型判断"谁在把需求和项目信息带进这个群"的提示词。通常是提出需求描述的那个人；模型必须排除你自己（你是在发指令，不是需求提出方）。',
              },
                h('textarea', {
                  className: 'dsp-textarea',
                  value: t.provide.salesPrompt ?? '',
                  onChange: e => edit('triggers.provide.salesPrompt', e.target.value),
                }),
              ),
            ),
          ),
          // 一个按钮保存整块动作一：触发设置 + @ 策略。
          // 原来分成「保存动作一」和「保存 @ 设置」两个按钮，用户得记住
          // 改了哪半边该点哪个；这里是同一件事，合成一个。
          h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
            h('button', {
              className: 'dsp-btn dsp-btn-primary',
              disabled: busy === 'save',
              onClick: () => void save({
                mention: settings.mention,
                triggers: { provide: {
                  keywords: t.provide.keywords,
                  prefix: t.provide.prefix,
                  cooldownSeconds: t.provide.cooldownSeconds,
                  template: t.provide.template,
                  salesPrompt: t.provide.salesPrompt,
                  salesLookbackMessages: t.provide.salesLookbackMessages,
                } },
              }),
            }, '保存动作一'),
          ),
        ),

        // ── 动作二 ────────────────────────────────────────────
        //
        // 原来这里是两张卡：「动作二 · 梳理项目需求」只有标题和说明（**空壳**），
        // 真正的字段全在下面那张「动作二设置」里。同一件事拆成两张卡，
        // 既显得重复，也让人以为"上面那张还没加载完"。合成一张。
        h(Card, {
          title: '动作二 · 梳理项目需求',
          hint: '插件会读取该群近期消息，交给 DSH 的模型分析，然后把需求总结发回该群（默认不 @ 任何人）。下方提示词可自定义：改这里就能调整总结的口径、结构与详略。',
        },
          h(Field, { label: '触发关键词', hint: '多个用英文逗号分隔。' },
            h('input', {
              className: 'dsp-input',
              value: (t.summarize.keywords ?? []).join(','),
              onChange: e => edit('triggers.summarize.keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean)),
            }),
          ),
          h(Field, { label: '读取消息条数', hint: '越多越全面，但消耗的模型 token 也越多。默认 200。' },
            h('input', {
              className: 'dsp-input',
              type: 'number',
              min: 10,
              max: 1000,
              value: t.summarize.historyCount ?? 200,
              onChange: e => edit('triggers.summarize.historyCount', Number(e.target.value)),
            }),
          ),
          h(Field, { label: '冷却秒数' },
            h('input', {
              className: 'dsp-input',
              type: 'number',
              min: 0,
              value: t.summarize.cooldownSeconds ?? 120,
              onChange: e => edit('triggers.summarize.cooldownSeconds', Number(e.target.value)),
            }),
          ),
          h(Field, { label: '标题前缀', hint: '拼在总结最前面，例如「【项目需求梳理】」。留空则不加。' },
            h('input', {
              className: 'dsp-input',
              value: t.summarize.title ?? '',
              onChange: e => edit('triggers.summarize.title', e.target.value),
            }),
          ),
          h(Field, { label: '总结提示词' },
            h('textarea', {
              className: 'dsp-textarea',
              value: t.summarize.prompt ?? '',
              onChange: e => edit('triggers.summarize.prompt', e.target.value),
            }),
          ),
          h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
            h('button', {
              className: 'dsp-btn dsp-btn-primary',
              disabled: busy === 'save',
              onClick: () => void save({
                triggers: { summarize: {
                  keywords: t.summarize.keywords,
                  cooldownSeconds: t.summarize.cooldownSeconds,
                  historyCount: t.summarize.historyCount,
                  title: t.summarize.title,
                  prompt: t.summarize.prompt,
                } },
              }),
            }, '保存动作二'),
          ),
        ),


        // ── 轮询 ──────────────────────────────────────────────
        h(Group, {
          label: '高级设置',
          summary: groupSummary(),
        },
          h(Card, {
            title: '轮询与性能',
            hint: '插件用「全局搜索我的消息」来发现触发（一次调用覆盖所有群，不逐群扫）。实测单次约 1 秒；连续无命中时会自动拉长间隔省配额，有命中立刻恢复。',
          },
            h(Field, { label: '轮询间隔（秒）', hint: '允许 15–300 秒。低于 15 会被自动纠正，避免把钉钉接口配额打爆。默认 30 秒。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 15,
                max: 300,
                value: settings.poll.intervalSeconds,
                onChange: e => edit('poll.intervalSeconds', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '时间窗重叠（秒）', hint: '搜索时向前多取一段时间，防止服务端索引延迟导致漏消息。默认 120 秒。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 10,
                max: 3600,
                value: settings.poll.windowOverlapSeconds,
                onChange: e => edit('poll.windowOverlapSeconds', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '无命中退避上限（秒）', hint: '一直没命中时，间隔最多拉长到这个值。默认 300 秒。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 60,
                max: 3600,
                value: settings.poll.backoffMaxSeconds,
                onChange: e => edit('poll.backoffMaxSeconds', Number(e.target.value)),
              }),
            ),
            h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
              h('button', {
                className: 'dsp-btn dsp-btn-primary',
                disabled: busy === 'save',
                onClick: () => void save({ poll: settings.poll }),
              }, '保存轮询设置'),
            ),
          ),

          // ── 公司名 / 使用者名 ──────────────────────────────────
          h(Card, {
            title: '公司名与署名',
            hint: '提示词里可以用 {company} 和 {owner} 两个占位符，发送前会被替换成下面的值。',
          },
            h(Field, { label: '公司名（提示词里的 {company}）', hint: '让模型以你的公司口吻说话。留空则显示为「我们公司」。' },
              h('input', {
                className: 'dsp-input',
                value: settings.company ?? '',
                placeholder: '例如：示例智能科技',
                onChange: e => edit('company', e.target.value),
              }),
            ),
            h(Field, {
              label: '使用者名（提示词里的 {owner}）',
              hint: '默认提示词末尾的署名「本消息由{owner}AI售前助理发出」会用它替换。留空则把整行署名去掉——不发读不通的半句。',
            },
              h('input', {
                className: 'dsp-input',
                value: settings.ownerName ?? '',
                placeholder: '例如：张三',
                onChange: e => edit('ownerName', e.target.value),
              }),
            ),
            // 这张卡原先**没有保存按钮**——`edit()` 只写本地草稿，
            // 用户改完这两格如果没去点别的卡的保存，刷新后改动就没了。
            // 补齐，与其他卡一致。
            h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
              h('button', {
                className: 'dsp-btn dsp-btn-primary',
                disabled: busy === 'save',
                onClick: () => void save({ company: settings.company, ownerName: settings.ownerName }),
              }, '保存署名'),
            ),
          ),

          // ── 模型 ──────────────────────────────────────────────
          h(Card, {
            title: '模型',
            hint: '默认 DeepSeek-V4.1-Flash（deepseek-account / deepseek-flash）。上方「运行状态」里的 LLM 路由会显示实际用的是哪个；若来源标为 auto，说明默认 provider 未注册、已自动换用别的模型，建议在这里显式指定。',
          },
            h(Field, { label: 'provider' },
              h('input', {
                className: 'dsp-input',
                value: settings.llm.provider ?? '',
                placeholder: 'deepseek-account',
                onChange: e => edit('llm.provider', e.target.value),
              }),
            ),
            h(Field, { label: 'model' },
              h('input', {
                className: 'dsp-input',
                value: settings.llm.model ?? '',
                placeholder: 'deepseek-flash',
                onChange: e => edit('llm.model', e.target.value),
              }),
            ),
            h(Field, { label: '最长等待（毫秒）', hint: '需求梳理可能比较慢，超时会记失败而不是返回半截结果。默认 60000。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 5000,
                max: 600000,
                value: settings.llm.timeoutMs,
                onChange: e => edit('llm.timeoutMs', Number(e.target.value)),
              }),
            ),
            h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
              h('button', {
                className: 'dsp-btn dsp-btn-primary',
                disabled: busy === 'save',
                onClick: () => void save({ llm: settings.llm }),
              }, '保存模型设置'),
            ),
          ),

          // ── 附件读取 ──────────────────────────────────────────
          h(Card, {
            title: '附件读取',
            hint: '钉钉服务端没有「在线读文件正文」的接口，文件必须先下载到本地才能解析。开启后，「梳理项目需求」会把群里的 docx / xlsx / txt 下载并提取正文交给模型——很多人只在群里丢一个需求文档就完事，不读附件等于漏掉核心需求。',
          },
            h(Field, { label: '读取群文件', hint: '关闭则只依据聊天文字，文件仅记录不解析。' },
              h('input', {
                type: 'checkbox',
                checked: settings.attachments.enabled,
                onChange: e => edit('attachments.enabled', e.target.checked),
              }),
            ),
            h(Field, { label: '单轮文件数上限', hint: '防止一个群刷了几十个附件的极端情况。默认 5。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 1,
                max: 50,
                value: settings.attachments.maxFilesPerRun,
                onChange: e => edit('attachments.maxFilesPerRun', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '单文件大小上限（字节）', hint: '超过就跳过并记明原因。默认 10MB。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 1024,
                value: settings.attachments.maxFileBytes,
                onChange: e => edit('attachments.maxFileBytes', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '单文件注入字数上限', hint: '默认 12000 字。表格类文件往往很长，适当限制可避免挤掉聊天记录。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 500,
                value: settings.attachments.maxCharsPerFile,
                onChange: e => edit('attachments.maxCharsPerFile', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '全部附件总字数上限', hint: '默认 30000 字。超出会按顺序截断，并在提示词里显式告知模型。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 1000,
                value: settings.attachments.maxTotalChars,
                onChange: e => edit('attachments.maxTotalChars', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '缓存有效期（天）', hint: '超期会重新下载，避免群里文件被替换后仍读旧内容。默认 30 天，填 0 表示永不过期。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 0,
                max: 3650,
                value: settings.attachments.cacheTtlDays,
                onChange: e => edit('attachments.cacheTtlDays', Number(e.target.value)),
              }),
            ),
            h(Field, { label: 'Python 路径（可选）', hint: '只用于解析 PDF。留空则不尝试解析 PDF——找不到解析器时会明确标注「未提取」，不会假装读过。' },
              h('input', {
                className: 'dsp-input',
                value: settings.attachments.pythonPath ?? '',
                placeholder: '留空 = 不解析 PDF',
                onChange: e => edit('attachments.pythonPath', e.target.value),
              }),
            ),
          ),

          // ── 附件缓存 ──────────────────────────────────────────
          h(Card, {
            title: '附件缓存',
            hint: '下载的文件与提取出的文本都缓存在这里，同一个文件第二次遇到会直接命中缓存、不再走网络。',
          },
            h('div', { className: 'dsp-actions', style: { marginBottom: 10 } },
              h('button', { className: 'dsp-btn', onClick: () => void loadAttachments() }, '刷新用量'),
              h('button', { className: 'dsp-btn dsp-btn-danger', disabled: busy !== '', onClick: () => void act('attachclear', '/attachments/clear') }, '清空缓存'),
            ),
            attachmentStats === null
              ? h('div', { className: 'dsp-note' }, '点「刷新用量」查看缓存占用。')
              : h('div', null,
                  h('div', { className: 'dsp-card-hint', style: { margin: '0 0 6px 0' } },
                    `占用 ${(attachmentStats.totalBytes / 1024 / 1024).toFixed(2)} MB｜${attachmentStats.entryCount} 个条目｜${attachmentStats.fileCount} 个文件`),
                  h('div', { className: 'dsp-mono', style: { marginBottom: 8 } }, attachmentStats.cacheDir || '（未启用）'),
                  attachmentStats.entries.length === 0
                    ? h('div', { className: 'dsp-card-hint', style: { margin: 0 } }, '缓存为空。')
                    : h('div', null,
                        ...attachmentStats.entries.slice(0, 20).map((entry, i) => h('div', {
                          key: entry.hash ?? i,
                          className: 'dsp-card-hint',
                          style: { margin: '2px 0 0 0' },
                        }, `${entry.name}｜${(entry.bytes / 1024).toFixed(1)}KB｜最后访问 ${entry.lastUsedText}`)),
                      ),
                ),
          ),

          // ── 活动记录 ──────────────────────────────────────────
          h(Card, {
            title: '活动记录',
            hint: '每轮「发现 → 判定 → 发送/跳过」都记一条。试运行模式下这里是唯一的观察窗口。',
          },
            h('div', { className: 'dsp-actions', style: { marginBottom: 10 } },
              h('button', { className: 'dsp-btn', onClick: () => void refresh() }, '刷新'),
              h('button', { className: 'dsp-btn dsp-btn-danger', disabled: busy !== '', onClick: () => void act('clear', '/activity/clear') }, '清空记录'),
              h('div', { className: 'dsp-spacer' }),
              h('span', { className: 'dsp-card-hint', style: { margin: 0 } }, `共 ${activity.length} 条`),
            ),
            activity.length === 0
              ? h('div', { className: 'dsp-note' }, '暂无记录。若你刚在群里发过关键词，可点上面的「立即检查一次」。')
              : h('div', { className: 'dsp-log' },
                  activity.map((e, i) => h('div', { key: e.ts ?? i, className: 'dsp-log-item' },
                    h('div', null,
                      h('span', { className: 'dsp-badge' }, `${e.action ?? '?'} / ${e.decision ?? '?'}`),
                      ' ',
                      h('span', { className: 'dsp-card-hint', style: { margin: 0 } }, humanTime(e.ts)),
                      e.conversationName ? `  ${e.conversationName}` : '',
                    ),
                    e.conversationId
                      ? h('div', { className: 'dsp-mono', style: { marginTop: 2 } }, e.conversationId)
                      : null,
                    e.triggerText ? h('div', { style: { marginTop: 2 } }, `触发：${e.triggerText}`) : null,
                    e.mention && e.mention.mode && e.mention.mode !== 'none'
                      ? h('div', { style: { marginTop: 2 } }, `@：${e.mention.name || '?'}（${e.mention.mode}${e.mention.confidence ? ` / ${e.mention.confidence}` : ''}）— ${e.mention.reason ?? ''}`)
                      : null,
                    // 附件处理结果：排查「模型为什么没读到某个文件」时这是唯一线索
                    Array.isArray(e.attachments) && e.attachments.length > 0
                      ? h('div', { style: { marginTop: 4 } },
                          h('div', { className: 'dsp-card-hint', style: { margin: 0 } }, `附件（${e.attachmentSummary || ''}）：`),
                          ...e.attachments.map((a, ai) => {
                            // 三种结果要看得出来：读到正文 / 图片交给模型看 / 没读到
                            const icon = a.status === 'ok' ? '✔' : a.status === 'image' ? '🖼' : a.status === 'error' ? '✖' : 'ℹ';
                            const what = a.status === 'ok'
                              ? `提取 ${a.chars} 字`
                              : a.status === 'image'
                                ? '图片已交给模型查看'
                                : '未提取内容';
                            return h('div', {
                              key: ai,
                              className: 'dsp-card-hint',
                              style: { margin: '2px 0 0 12px' },
                            }, `${icon} ${a.name}｜${(a.size / 1024).toFixed(1)}KB｜${what}${a.fromCache ? '｜缓存命中' : ''}${a.note ? `｜${a.note}` : ''}`);
                          }),
                        )
                      : null,
                    e.error ? h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-danger, #d64545)' } }, `错误：${e.error}`) : null,
                    e.note ? h('div', { className: 'dsp-card-hint', style: { margin: '2px 0 0 0' } }, e.note) : null,
                    e.text ? h('pre', { className: 'dsp-pre', style: { marginTop: 6, opacity: .85 } }, e.text.slice(0, 500)) : null,
                  )),
                ),
          ),
        ),

        // ── 保存提示 / 错误 ───────────────────────────────────
        (error.length > 0 || saved.length > 0)
          ? h('div', { className: `dsp-note ${error.length > 0 ? 'dsp-note-err' : ''}` },
              error.length > 0 ? `错误：${error}` : saved)
          : null,
      );
    }

    // ─────────────────────────── 装配 ───────────────────────────

    const inject = ['slots'];

    function apply(ctx) {
      const slots = ctx.slots;
      if (slots === undefined) return;

      ctx.effect(() => injectStyles(), 'dsh-presale: styles');

      // 注册设置左侧一级导航入口。
      // settings.section 只投影 id / order / label，第三方拿不到图标（一律是齿轮）。
      ctx.effect(() => slots.inject('settings.section', () => {
        try {
          return slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            // 排在「备份与迁移」之后，正好落在截图里空出来的那一行
            order: 60,
            label: () => '售前助手',
            // 不用 locale：直接写中文标签，避免依赖宿主字典文件
          }, Panel);
        } catch (error) {
          console.error('[dsh-presale] 注册设置入口失败：' + (error && error.message ? error.message : error));
          return () => {};
        }
      }), 'dsh-presale: settings section');
    }

    module.exports = { apply, inject, Panel };
    return module.exports;
  },
});
