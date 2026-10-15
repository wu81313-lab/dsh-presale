// dsh-presale 客户端半边：设置对话框里的「售前助手」一级导航页。
//
// 装载契约（与已装第三方插件一致，实测得来）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
//   · React 由宿主共享提供，必须 require('react')，不能自带第二份（否则 hooks 失效）；
//   · 模块导出 { apply, inject }，inject 写服务名，这里是 ['slots']；
//   · 注册设置一级导航用 **settings.section** 插槽，签名是
//     **slots.register(options, component)** —— 组件走**第二个参数**
//     （渲染器读 entry.component，由第二个参数填进来；塞进 options 里是无效的）；
//   · 该插槽只投影 id / order / label，第三方拿不到图标（一律齿轮），
//     label 必须是函数（外壳惰性求值）；
//   · 客户端到宿主没有通用 RPC，一律走同源 fetch 打 /presale-api/*。
//
// 刻意不引入打包器：整份代码是普通 JS + React.createElement，
// 出问题能直接在浏览器里读栈、改一行刷新即可。
//
// ── 界面设计要点（全部对着客户端自带设置页抄的，踩过的坑都记在这）──────
//
// ① **CSS 变量名必须是 DSH 的真 token**。早前用的是
//    `--dsw-alias-border` / `--dsw-alias-text-1` / `--dsw-alias-brand` 这类
//    **猜测名**，真实名是 `--dsw-alias-border-l1` / `--dsw-alias-label-primary` /
//    `--dsw-alias-brand-primary`。写错不报错，只会静默走兜底值——
//    于是"跟随主题"形同虚设。查真实 token：
//      cordis_inspect_query(client / Theme / listTokens)
//      或 tools/extract-theme-tokens.py（连两套主题的色值一起导出）
//
// ② **尺寸参数全部对齐客户端原生设置页**（来源：自带设置页的 CSS module）：
//      内容列 max-width 720px；卡片 .5px 边框 + 16px 圆角；
//      卡片头 padding 14px 16px；卡片名 15px/600；卡片说明 13px；
//      字段 padding 12px 0 + gap 6px，相邻字段间 .5px 分隔线；
//      字段名 13px/500；字段提示 12px；
//      **短输入框 height 34px**；按钮 height 36px + radius 18px（胶囊）；
//      主按钮黑白反转（浅色 #0f1115 底白字、深色 #f9fafb 底黑字）。
//
// ③ **输入框必须限高**。踩过一个坑：给 input 和 textarea 套同一个类，
//    而 textarea 有 min-height，结果短文本框（冷却秒数、条数）被撑成大块。
//    现在 .dsp-input 固定 height:34px，只有 .dsp-textarea 才有高度。
//
// ④ **保存按钮挂在每张卡自己脚下**，不做全局底栏。这是客户端原生插件的做法
//    （见自带插件页的 card footer）。且**只在真有未保存改动时才出现**，
//    否则满屏都是按钮很吵。
//
// ⑤ 开关（启用监听 / 试运行）**即时生效**，不进草稿——从状态卡看到"未启用"时，
//    不该还要滚到底部去保存。

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

    /** 字节数转可读体积（附件缓存用量用）。 */
    function humanSize(bytes) {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return '0 KB';
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    // ─────────────────────────── 样式 ───────────────────────────
    //
    // 只用 DSH 真实设计令牌（见文件头 ①），深浅主题自动跟随。
    // 兜底值只是保险，正常情况下不会用到。

    const CSS = `
.dsp-root { display: flex; flex-direction: column; gap: 12px; max-width: 720px; font-size: 14px; line-height: 22px; }

/* ── 页头 ─────────────────────────────────────────────── */
.dsp-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; color: var(--dsw-alias-label-primary, inherit); }
.dsp-intro { margin: 6px 0 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }

/* ── 卡片 ─────────────────────────────────────────────── */
.dsp-card { border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-3, transparent); border-radius: 16px; overflow: hidden; transition: border-color .16s, background .16s; }
.dsp-card:hover { border-color: var(--dsw-alias-label-dimmed, rgba(128,128,128,.35)); }
.dsp-card-open { background: var(--dsw-alias-bg-layer-2, transparent); }
.dsp-card-head { width: 100%; font: inherit; color: inherit; text-align: left; background: 0 0; border: 0; display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.dsp-card-head-btn { cursor: pointer; }
.dsp-card-head-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0f1115); outline-offset: -2px; }
.dsp-card-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.dsp-card-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary, inherit); }
.dsp-card-desc { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dsp-caret { flex: none; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); font-size: 10px; transition: transform .16s; }
.dsp-caret-open { transform: rotate(180deg); }
.dsp-card-body { border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); margin: 0 16px; padding-bottom: 4px; }
.dsp-card-foot { border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); margin: 0 16px; display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 12px 0 4px; }
.dsp-foot-msg { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dsp-foot-msg-dirty { color: var(--dsw-alias-state-warn-label, #dd8629); }
.dsp-foot-msg-ok { color: var(--dsw-alias-state-success-primary, #22c55e); }

/* ── 徽标 ─────────────────────────────────────────────── */
.dsp-tag { border: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3)); color: var(--dsw-alias-label-secondary, inherit); border-radius: 4px; flex: none; padding: 1px 6px; font-size: 11px; line-height: 16px; white-space: nowrap; }
.dsp-tag-ok { color: var(--dsw-alias-state-success-primary, #22c55e); border-color: currentColor; }
.dsp-tag-warn { color: var(--dsw-alias-state-warn-label, #dd8629); border-color: currentColor; }
.dsp-tag-err { color: var(--dsw-alias-state-error-primary, #ec1313); border-color: currentColor; }
.dsp-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--dsw-alias-state-success-primary, #22c55e); }
.dsp-dot-warn { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsp-dot-err { background: var(--dsw-alias-state-error-primary, #ec1313); }

/* ── 字段 ─────────────────────────────────────────────── */
.dsp-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dsp-field + .dsp-field { border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); }
.dsp-field-label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary, inherit); }
.dsp-field-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }

/* 短输入框：**固定高度，不许被拉伸**（踩过坑：和 textarea 共用一个类，
   结果 textarea 的 min-height 把短文本框撑成大块） */
.dsp-input { height: 34px; width: 100%; font: inherit; font-size: 13px; line-height: 1.5; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary, inherit); border-radius: 8px; flex: none; }
.dsp-select { height: 34px; width: 100%; font: inherit; font-size: 13px; line-height: 1.5; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary, inherit); border-radius: 8px; flex: none; }
/* 多行框：只有它才有高度 */
.dsp-textarea { width: 100%; font: inherit; font-size: 13px; line-height: 1.6; padding: 9px 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary, inherit); border-radius: 8px; min-height: 84px; resize: vertical; display: block; flex: none; }
.dsp-textarea-tall { min-height: 150px; }
.dsp-input:focus-visible, .dsp-select:focus-visible, .dsp-textarea:focus-visible { border-color: var(--dsw-alias-brand-primary, #0f1115); outline: none; }
.dsp-input::placeholder, .dsp-textarea::placeholder { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.55)); }
.dsp-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
@media (max-width: 520px) { .dsp-two { grid-template-columns: minmax(0, 1fr); } }

/* ── 开关行（照原生 toggleRow：说明在左、开关在右）────────── */
.dsp-toggle { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, inherit); padding: 12px 0; }
.dsp-toggle + .dsp-toggle { border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); }
.dsp-toggle-text { flex: 1; min-width: 0; }
.dsp-switch { position: relative; width: 34px; height: 20px; border-radius: 99px; flex: none; margin-top: 1px; cursor: pointer; transition: background .16s; background: var(--dsw-alias-border-l4, rgba(128,128,128,.4)); }
.dsp-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .16s; }
.dsp-switch-on { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dsp-switch-on::after { transform: translateX(14px); }
.dsp-switch-busy { opacity: .5; cursor: default; }

/* ── 按钮（高 36、胶囊）────────────────────────────────── */
.dsp-btn { height: 36px; font: inherit; font-size: 13px; line-height: 1.5; padding: 0 14px; border: 1px solid transparent; border-radius: 18px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; background: 0 0; }
.dsp-btn-primary { background: var(--dsw-alias-label-primary, #0f1115); color: var(--dsw-alias-bg-layer-3, #fff); }
.dsp-btn-primary:hover:not(:disabled) { opacity: .88; }
.dsp-btn-secondary { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.25)); color: var(--dsw-alias-label-secondary, inherit); }
.dsp-btn-secondary:hover:not(:disabled) { color: var(--dsw-alias-label-primary, inherit); border-color: var(--dsw-alias-label-dimmed, rgba(128,128,128,.4)); }
.dsp-btn:disabled { opacity: .4; cursor: default; }
.dsp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 0 4px; }
.dsp-grow { flex: 1; }

/* ── 运行状态的键值网格 ────────────────────────────────── */
.dsp-kv { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
@media (max-width: 480px) { .dsp-kv { grid-template-columns: minmax(0, 1fr); } }
.dsp-kv-k { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dsp-kv-v { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, inherit); word-break: break-word; }
.dsp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; word-break: break-all; }

/* ── 提示条 ───────────────────────────────────────────── */
.dsp-note { font-size: 12px; line-height: 1.7; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08)); color: var(--dsw-alias-label-secondary, inherit); }
.dsp-note ul { margin: 4px 0 0 16px; padding: 0; }
.dsp-note-warn { border-left: 2px solid var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsp-note-err { border-left: 2px solid var(--dsw-alias-state-error-primary, #ec1313); }
.dsp-note-ok { border-left: 2px solid var(--dsw-alias-state-success-primary, #22c55e); }

/* ── 列表（活动记录 / 附件缓存）────────────────────────── */
.dsp-list { margin: 0; padding: 0; list-style: none; }
.dsp-li { padding: 12px 0; font-size: 12.5px; }
.dsp-li + .dsp-li { border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); }
.dsp-li-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsp-li-time { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dsp-li-name { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dsp-li-line { margin-top: 3px; color: var(--dsw-alias-label-secondary, inherit); }
.dsp-li-sub { margin-top: 2px; padding-left: 10px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dsp-pre { margin: 6px 0 0; font-family: inherit; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, inherit); max-height: 96px; overflow: hidden; }
.dsp-scroll { max-height: 300px; overflow-y: auto; }
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

    /** 表单字段：标签在上、控件在中、说明在下（对齐原生字段排版）。 */
    function Field(props) {
      return h('div', { className: 'dsp-field' },
        props.label ? h('span', { className: 'dsp-field-label' }, props.label) : null,
        props.children,
        props.hint ? h('p', { className: 'dsp-field-hint' }, props.hint) : null,
      );
    }

    function Kv(props) {
      return h('div', null,
        h('div', { className: 'dsp-kv-k' }, props.k),
        h('div', { className: `dsp-kv-v${props.mono ? ' dsp-mono' : ''}` }, props.v),
      );
    }

    function Tag(props) {
      const kind = props.kind ? ` dsp-tag-${props.kind}` : '';
      return h('span', { className: `dsp-tag${kind}` }, props.children);
    }

    /** 开关行：说明在左、开关在右。即时生效，不进草稿。 */
    function ToggleRow(props) {
      return h('div', { className: 'dsp-toggle' },
        h('span', { className: 'dsp-toggle-text' },
          props.label,
          props.hint ? h('p', { className: 'dsp-field-hint', style: { marginTop: 3 } }, props.hint) : null,
        ),
        h('span', {
          className: `dsp-switch${props.on ? ' dsp-switch-on' : ''}${props.disabled ? ' dsp-switch-busy' : ''}`,
          role: 'switch',
          'aria-checked': props.on === true,
          tabIndex: props.disabled ? -1 : 0,
          onClick: props.disabled ? undefined : props.onToggle,
          onKeyDown: props.disabled ? undefined : event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              props.onToggle();
            }
          },
        }),
      );
    }

    /**
     * 卡片。
     *
     * 折叠与保存都做成可选：`open`/`onToggle` 控制折叠，
     * `dirty`/`onSave`/`onDiscard` 控制脚部的保存行。
     *
     * 保存行**只在真的有未保存改动时**才渲染——否则满屏都是按钮。
     * 这是客户端原生插件的做法（每张卡自己带 footer），不做全局底栏。
     */
    function Card(props) {
      const collapsible = typeof props.open === 'boolean';
      const open = collapsible ? props.open : true;
      const showFoot = props.dirty === true || (props.footNote !== undefined);
      const headClass = `dsp-card-head${collapsible ? ' dsp-card-head-btn' : ''}`;
      const headProps = { className: headClass };
      if (collapsible) {
        headProps.onClick = props.onToggle;
        headProps.onKeyDown = event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onToggle?.();
          }
        };
        headProps.role = 'button';
        headProps.tabIndex = 0;
      }
      return h('div', { className: `dsp-card${open ? ' dsp-card-open' : ''}` },
        h('div', headProps,
          props.badge ?? null,
          h('span', { className: 'dsp-card-text' },
            h('span', { className: 'dsp-card-name' }, props.title),
            props.subtitle ? h('span', { className: 'dsp-card-desc' }, props.subtitle) : null,
          ),
          props.tag ?? null,
          collapsible ? h('span', { className: `dsp-caret${open ? ' dsp-caret-open' : ''}` }, '▼') : null,
        ),
        open ? h('div', { className: 'dsp-card-body' }, props.children) : null,
        open && showFoot
          ? h('div', { className: 'dsp-card-foot' },
              h('span', { className: `dsp-foot-msg${props.dirty ? ' dsp-foot-msg-dirty' : props.saved ? ' dsp-foot-msg-ok' : ''}` },
                props.dirty ? '● 有未保存的改动' : (props.footNote ?? '')),
              props.dirty
                ? [
                    h('button', { key: 'd', className: 'dsp-btn dsp-btn-secondary', onClick: props.onDiscard }, '放弃'),
                    h('button', { key: 's', className: 'dsp-btn dsp-btn-primary', onClick: props.onSave }, '保存'),
                  ]
                : (props.footAction ?? null),
            )
          : null,
      );
    }

    // ─────────────────────────── 主面板 ───────────────────────────

    /**
     * 一份「可编辑草稿」的状态机。
     *
     * 每张可编辑的卡各持一份：改字段进草稿，点保存才落盘，点放弃回滚。
     * 这样"改动作一"和"改动作二"互不干扰，也不会因为一处没保存而丢另一处。
     */
    function useDraft(serverValue, onSaved, setError) {
      const [draft, setDraft] = React.useState(serverValue);
      const [dirty, setDirty] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const serverRef = React.useRef(serverValue);

      // 服务端值变化时同步（但我们自己脏了就別覆盖用户的输入）
      React.useEffect(() => {
        serverRef.current = serverValue;
        if (!dirty) setDraft(serverValue);
      }, [serverValue, dirty]);

      // 把最新草稿同时存一份到 ref。
      // 为什么：commit 要提交"当前"草稿，而调用方传进来的 patch 是**渲染时
      // 闭包捕获**的值——用户改完立刻点保存时，闭包可能还指向上一次渲染的对象，
      // 于是保存的是旧值（改了等于没改）。用 ref 读最新值避开这个坑。
      const draftRef = React.useRef(serverValue);
      draftRef.current = draft;

      return {
        draft,
        dirty,
        saved,
        set(path, value) {
          setDraft(prev => {
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
          setDirty(true);
          setSaved(false);
        },
        /**
         * 提交。
         *
         * @param {Function} buildPatch - 收到**最新**草稿，返回要提交的 patch。
         */
        async commit(buildPatch) {
          try {
            await onSaved(buildPatch(draftRef.current));
            setDirty(false);
            setSaved(true);
          } catch (err) {
            setError(err.message);
          }
        },
        rollback() {
          setDraft(serverRef.current);
          setDirty(false);
          setSaved(false);
        },
      };
    }

    function Panel() {
      const [status, setStatus] = React.useState(null);
      const [settings, setSettings] = React.useState(null);
      const [activity, setActivity] = React.useState([]);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [testResult, setTestResult] = React.useState(null);
      const [testConversation, setTestConversation] = React.useState('');
      const [attachmentStats, setAttachmentStats] = React.useState(null);
      const [open, setOpen] = React.useState({ state: true });
      const toggle = key => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

      const refresh = React.useCallback(async () => {
        try {
          const [s, st, act] = await Promise.all([
            api('/settings'),
            api('/status'),
            api('/activity?limit=30'),
          ]);
          setSettings(s.settings);
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

      /** 提交部分设置。返回 Promise 让草稿状态机知道成功与否。 */
      async function patch(patchObject) {
        setBusy('save');
        try {
          const result = await api('/settings', { method: 'POST', body: { patch: patchObject, strict: true } });
          setSettings(result.settings);
          setError('');
          return result;
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
          if (path === '/attachments/clear') await loadAttachments();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy('');
        }
      }

      async function loadAttachments() {
        try {
          setAttachmentStats(await api('/attachments'));
          setError('');
        } catch (err) {
          setError(`读取附件缓存失败：${err.message}`);
        }
      }

      async function runTest(kind) {
        const conversationId = testConversation.trim();
        if (conversationId.length === 0) {
          setTestResult({ error: '请先填一个会话 ID（openConversationId，以 cid 开头）。可从下面的活动记录里复制。' });
          return;
        }
        setBusy(`test-${kind}`);
        setTestResult(null);
        try {
          setTestResult(await api('/test', { method: 'POST', body: { kind, conversationId } }));
          setError('');
        } catch (err) {
          setTestResult({ error: err.message });
        } finally {
          setBusy('');
        }
      }

      // 草稿：每张可编辑的卡一份。hooks 必须在 return 之前无条件调用。
      const triggerDraft = useDraft(settings?.triggers ?? null, patch, setError);
      const mentionDraft = useDraft(settings?.mention ?? null, patch, setError);
      const pollDraft = useDraft(settings?.poll ?? null, patch, setError);
      const llmDraft = useDraft(
        settings === null ? null : { llm: settings.llm, company: settings.company, ownerName: settings.ownerName },
        patch,
        setError,
      );
      const attachDraft = useDraft(settings?.attachments ?? null, patch, setError);

      if (settings === null || status === null) {
        return h('div', { className: 'dsp-root' },
          h('h2', { className: 'dsp-title' }, '售前助手'),
          h('p', { className: 'dsp-intro' }, error.length > 0 ? `加载失败：${error}` : '正在读取插件状态…'),
          error.length > 0
            ? h('div', { className: 'dsp-actions' },
                h('button', { className: 'dsp-btn dsp-btn-secondary', onClick: () => void refresh() }, '重试'))
            : null,
        );
      }

      const poller = status.poller ?? {};
      const id = status.identity ?? {};
      const llmInfo = status.llm ?? {};
      const trigger = triggerDraft.draft ?? { provide: {}, summarize: {} };
      const mention = mentionDraft.draft ?? {};
      const pollCfg = pollDraft.draft ?? {};
      const llmCfg = llmDraft.draft ?? { llm: {}, company: '', ownerName: '' };
      const attach = attachDraft.draft ?? {};

      // ── 状态判定：给出一句话结论，而不是让用户去读一堆指标 ──
      const problems = [];
      if (poller.enabled !== true) problems.push('未启用监听');
      else if (!poller.running) problems.push('已启用但未运行');
      if (poller.authOk === false) problems.push('dws 未登录');
      if (id.state !== 'anchored') problems.push(id.state === 'weak' ? '身份弱校验' : '身份未锚定');
      if (llmInfo.available !== true) problems.push('LLM 不可用');

      const healthy = problems.length === 0;
      const headline = healthy
        ? (poller.dryRun ? '运行正常（试运行中，不会真的发消息）' : '运行正常')
        : problems.join(' · ');
      const subtitle = healthy
        ? `身份已锚定 · ${id.myName || id.myOid}　|　${llmInfo.route?.provider ? `${llmInfo.route.provider} / ${llmInfo.route.model}` : 'LLM 不可用'}`
        : '展开下面的「运行状态」查看细节';

      const dirtyAny = triggerDraft.dirty || mentionDraft.dirty || pollDraft.dirty || llmDraft.dirty || attachDraft.dirty;

      return h('div', { className: 'dsp-root' },

        // ── 页头 ────────────────────────────────────────────
        h('div', null,
          h('h2', { className: 'dsp-title' }, '售前助手'),
          h('p', { className: 'dsp-intro' }, '在钉钉群里说关键词即可触发。只认你本人发的消息。'),
        ),

        // ── 总开关（即时生效）────────────────────────────────
        h(Card, { title: '开关', subtitle: '改动立即生效，无需保存' },
          h(ToggleRow, {
            label: '启用监听',
            hint: '关闭后不再轮询钉钉，任何关键词都不会触发',
            on: settings.enabled === true,
            disabled: busy === 'save',
            onToggle: () => void patch({ enabled: !(settings.enabled === true) }),
          }),
          h(ToggleRow, {
            label: '试运行（只记录不发送）',
            hint: '建议先开着把文案和 @ 判定调准，确认无误再关掉',
            on: settings.dryRun === true,
            disabled: busy === 'save',
            onToggle: () => void patch({ dryRun: !(settings.dryRun === true) }),
          }),
        ),

        // ── 运行状态 ────────────────────────────────────────
        h(Card, {
          open: open.state === true,
          onToggle: () => toggle('state'),
          badge: h('span', { className: `dsp-dot${healthy ? '' : ' dsp-dot-warn'}` }),
          title: headline,
          subtitle,
          tag: poller.dryRun ? h(Tag, { kind: 'warn' }, '试运行') : null,
        },
          h('div', { className: 'dsp-kv' },
            h(Kv, { k: '上次检查', v: `${humanTime(poller.lastSearchAt)}${relative(poller.lastSearchAt) ? `（${relative(poller.lastSearchAt)}）` : ''}` }),
            h(Kv, { k: '上次命中', v: humanTime(poller.lastHitAt) }),
            h(Kv, { k: '已完成周期', v: `${poller.cycles ?? 0} 次 / 命中 ${poller.hits ?? 0} 次` }),
            h(Kv, { k: '当前轮询间隔', v: poller.currentIntervalSeconds > 0 ? `${poller.currentIntervalSeconds} 秒` : '尚未计算' }),
            h(Kv, { k: '连续无命中', v: `${poller.consecutiveEmpty ?? 0} 轮（自动拉长间隔省配额）` }),
            h(Kv, { k: '消息水位', v: poller.watermark?.lastSeenText ?? '未初始化' }),
            h(Kv, { k: '我的 openDingtalkId', v: id.myOid || '（未解析）', mono: true }),
            h(Kv, { k: 'LLM 路由', v: llmInfo.route?.provider ? `${llmInfo.route.provider} / ${llmInfo.route.model}（${llmInfo.route.source}）` : '不可用' }),
          ),
          id.message ? h('div', { className: 'dsp-note', style: { marginTop: 12 } }, `身份说明：${id.message}`) : null,
          poller.lastError ? h('div', { className: 'dsp-note dsp-note-warn', style: { marginTop: 12 } }, `最近错误：${poller.lastError}`) : null,
          (status.settingsWarnings ?? []).length > 0
            ? h('div', { className: 'dsp-note dsp-note-warn', style: { marginTop: 12 } },
                '配置告警：', h('ul', null, (status.settingsWarnings ?? []).map((w, i) => h('li', { key: i }, w))))
            : null,
          h('div', { className: 'dsp-actions' },
            h('button', { className: 'dsp-btn dsp-btn-secondary', disabled: busy !== '', onClick: () => void act('check', '/check-now') }, busy === 'check' ? '检查中…' : '立即检查一次'),
            h('button', { className: 'dsp-btn dsp-btn-secondary', disabled: busy !== '', onClick: () => void act('seed', '/seed-now') }, '水位重置为现在'),
            h('button', { className: 'dsp-btn dsp-btn-secondary', disabled: busy !== '', onClick: () => void act('id', '/reidentify') }, '重新识别身份'),
            h('span', { className: 'dsp-grow' }),
            h('button', { className: 'dsp-btn dsp-btn-secondary', disabled: busy !== '' || poller.running === true, onClick: () => void act('start', '/start') }, '开始'),
            h('button', { className: 'dsp-btn dsp-btn-secondary', disabled: busy !== '' || poller.running !== true, onClick: () => void act('stop', '/stop') }, '停止'),
          ),
        ),

        // ── 动作一 ──────────────────────────────────────────
        h(Card, {
          open: open.a1 === true,
          onToggle: () => toggle('a1'),
          title: '动作一 · 提供完整项目需求',
          subtitle: '你说触发词时，插件发这段文案并尝试 @ 判出的销售人员',
          dirty: triggerDraft.dirty,
          onSave: () => void triggerDraft.commit(d => ({ triggers: { provide: d.provide } })),
          onDiscard: triggerDraft.rollback,
        },
          h(Field, { label: '触发关键词', hint: '多个用英文逗号分隔。匹配时忽略空格、全角半角与大小写差异。' },
            h('input', {
              className: 'dsp-input',
              value: (trigger.provide?.keywords ?? []).join(','),
              onChange: e => triggerDraft.set('provide.keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean)),
            }),
          ),
          h('div', { className: 'dsp-two' },
            h(Field, { label: '冷却秒数', hint: '同一会话两次触发的最小间隔。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 0,
                value: trigger.provide?.cooldownSeconds ?? 60,
                onChange: e => triggerDraft.set('provide.cooldownSeconds', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '触发前缀（可选）', hint: '留空则直接说关键词就触发。' },
              h('input', {
                className: 'dsp-input',
                value: trigger.provide?.prefix ?? '',
                placeholder: '例如「DSH 」',
                onChange: e => triggerDraft.set('provide.prefix', e.target.value),
              }),
            ),
          ),
          h(Field, { label: '文案内容', hint: '可用占位符：{senderName} {groupName} {keyword} {date} {time} {salesName}' },
            h('textarea', {
              className: 'dsp-textarea',
              value: trigger.provide?.template ?? '',
              onChange: e => triggerDraft.set('provide.template', e.target.value),
            }),
          ),
        ),

        // ── 动作二 ──────────────────────────────────────────
        h(Card, {
          open: open.a2 === true,
          onToggle: () => toggle('a2'),
          title: '动作二 · 梳理项目需求',
          subtitle: '读取该群近期消息（含群文件与图片），交给模型总结后发回该群',
          tag: h(Tag, null, `读 ${trigger.summarize?.historyCount ?? 200} 条`),
          dirty: triggerDraft.dirty,
          onSave: () => void triggerDraft.commit(d => ({ triggers: { summarize: d.summarize } })),
          onDiscard: triggerDraft.rollback,
        },
          h('div', { className: 'dsp-two' },
            h(Field, { label: '触发关键词', hint: '多个用英文逗号分隔。' },
              h('input', {
                className: 'dsp-input',
                value: (trigger.summarize?.keywords ?? []).join(','),
                onChange: e => triggerDraft.set('summarize.keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean)),
              }),
            ),
            h(Field, { label: '冷却秒数' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 0,
                value: trigger.summarize?.cooldownSeconds ?? 120,
                onChange: e => triggerDraft.set('summarize.cooldownSeconds', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '读取消息条数', hint: '越多越全面，token 消耗也越多。' },
              h('input', {
                className: 'dsp-input',
                type: 'number',
                min: 10,
                max: 1000,
                value: trigger.summarize?.historyCount ?? 200,
                onChange: e => triggerDraft.set('summarize.historyCount', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '标题前缀', hint: '拼在总结最前面，留空则不加。' },
              h('input', {
                className: 'dsp-input',
                value: trigger.summarize?.title ?? '',
                onChange: e => triggerDraft.set('summarize.title', e.target.value),
              }),
            ),
          ),
          h(Field, { label: '总结提示词', hint: '改这里就能调整总结的口径、结构与详略。可用 {company} 与 {owner}。' },
            h('textarea', {
              className: 'dsp-textarea dsp-textarea-tall',
              value: trigger.summarize?.prompt ?? '',
              onChange: e => triggerDraft.set('summarize.prompt', e.target.value),
            }),
          ),
        ),

        // ── @ 销售人员 ──────────────────────────────────────
        h(Card, {
          open: open.mention === true,
          onToggle: () => toggle('mention'),
          title: '@ 销售人员',
          subtitle: '让模型判断谁在把需求和项目信息带进这个群（会自动排除你自己）',
          tag: mention.enabled === true ? h(Tag, { kind: 'ok' }, `已开启 · ${mention.minConfidence ?? 'high'}`) : h(Tag, null, '已关闭'),
          dirty: mentionDraft.dirty,
          onSave: () => void mentionDraft.commit(d => ({ mention: d })),
          onDiscard: mentionDraft.rollback,
        },
          h(ToggleRow, {
            label: '启用 @',
            hint: '关闭后只发文案，不 @ 任何人',
            on: mention.enabled === true,
            onToggle: () => mentionDraft.set('enabled', !(mention.enabled === true)),
          }),
          h(Field, {
            label: '最低置信度',
            hint: '只有达到这个置信度才会真正 @ 人。达不到时：medium 会写成纯文本「@姓名」（不触发提醒），low 直接不 @。群里 @ 错人比不 @ 更尴尬，所以默认 high。',
          },
            h('select', {
              className: 'dsp-select',
              value: mention.minConfidence ?? 'high',
              onChange: e => mentionDraft.set('minConfidence', e.target.value),
            },
              h('option', { value: 'high' }, 'high（最保守，推荐）'),
              h('option', { value: 'medium' }, 'medium（判出就 @）'),
              h('option', { value: 'low' }, 'low（几乎总会 @）'),
            ),
          ),
          h(ToggleRow, {
            label: '中等置信度降级为文本提及',
            hint: '开启后正文写「@姓名」但不触发提醒；关闭则干脆不 @',
            on: mention.textualMentionWhenMedium === true,
            onToggle: () => mentionDraft.set('textualMentionWhenMedium', !(mention.textualMentionWhenMedium === true)),
          }),
          h(ToggleRow, {
            label: '判不出时 @ 你自己',
            hint: '默认关闭——判不出就不 @，比 @ 错人好',
            on: mention.fallbackToTriggerWhenUnknown === true,
            onToggle: () => mentionDraft.set('fallbackToTriggerWhenUnknown', !(mention.fallbackToTriggerWhenUnknown === true)),
          }),
          h(Field, { label: '判别提示词', hint: '告诉模型「谁是销售人员」的判定标准。' },
            h('textarea', {
              className: 'dsp-textarea',
              value: trigger.provide?.salesPrompt ?? '',
              onChange: e => triggerDraft.set('provide.salesPrompt', e.target.value),
            }),
          ),
        ),

        // ── 附件读取 ────────────────────────────────────────
        h(Card, {
          open: open.attach === true,
          onToggle: () => toggle('attach'),
          title: '附件读取',
          subtitle: '支持 docx / xlsx / pptx / pdf / 文本，图片直接交给多模态模型看',
          tag: attach.enabled ? h(Tag, { kind: 'ok' }, '已开启') : h(Tag, null, '已关闭'),
          dirty: attachDraft.dirty,
          onSave: () => void attachDraft.commit(d => ({ attachments: d })),
          onDiscard: attachDraft.rollback,
        },
          h(ToggleRow, {
            label: '读取群文件',
            hint: '关闭则只依据聊天文字，文件仅记录不解析。钉钉服务端没有「在线读正文」的接口，文件必须先下载到本地再解析。',
            on: attach.enabled === true,
            onToggle: () => attachDraft.set('enabled', !(attach.enabled === true)),
          }),
          h('div', { className: 'dsp-two' },
            h(Field, { label: '单轮文件数上限', hint: '默认 5。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 1, max: 50,
                value: attach.maxFilesPerRun,
                onChange: e => attachDraft.set('maxFilesPerRun', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '单文件大小上限（MB）', hint: '默认 50MB——方案 PPT 常有 12MB 以上。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 1, max: 200,
                value: Math.round((attach.maxFileBytes ?? 0) / 1024 / 1024),
                onChange: e => attachDraft.set('maxFileBytes', Math.max(1, Number(e.target.value)) * 1024 * 1024),
              }),
            ),
            h(Field, { label: '单文件字数上限', hint: '默认 12000 字。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 500,
                value: attach.maxCharsPerFile,
                onChange: e => attachDraft.set('maxCharsPerFile', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '总字数上限', hint: '默认 30000 字，超出时按份均分。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 1000,
                value: attach.maxTotalChars,
                onChange: e => attachDraft.set('maxTotalChars', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '缓存有效期（天）', hint: '填 0 表示永不过期。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 0, max: 3650,
                value: attach.cacheTtlDays,
                onChange: e => attachDraft.set('cacheTtlDays', Number(e.target.value)),
              }),
            ),
            h(Field, { label: 'Python 路径（解析 PDF 用）', hint: '需该 Python 装了 PyMuPDF 或 pypdf。留空则不解析 PDF。' },
              h('input', {
                className: 'dsp-input dsp-mono',
                value: attach.pythonPath ?? '',
                placeholder: '留空 = 不解析 PDF',
                onChange: e => attachDraft.set('pythonPath', e.target.value),
              }),
            ),
          ),

          // 缓存用量
          h('div', { className: 'dsp-note', style: { marginTop: 12 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
              h('strong', { style: { flex: 1, fontSize: 12 } }, '附件缓存'),
              h('button', { className: 'dsp-btn dsp-btn-secondary', style: { height: 30, fontSize: 12 }, onClick: () => void loadAttachments() }, '刷新用量'),
              h('button', { className: 'dsp-btn dsp-btn-secondary', style: { height: 30, fontSize: 12 }, disabled: busy !== '', onClick: () => void act('attachclear', '/attachments/clear') }, '清空缓存'),
            ),
            attachmentStats === null
              ? h('p', { className: 'dsp-field-hint', style: { margin: 0 } }, '点「刷新用量」查看缓存占用。同一个文件第二次遇到会直接命中缓存、不再走网络。')
              : h('div', null,
                  h('p', { className: 'dsp-field-hint', style: { margin: '0 0 6px' } },
                    `占用 ${humanSize(attachmentStats.totalBytes)}｜${attachmentStats.entryCount} 个条目｜${attachmentStats.fileCount} 个文件`),
                  h('div', { className: 'dsp-mono', style: { marginBottom: 8, opacity: .8 } }, attachmentStats.cacheDir || '（未启用）'),
                  attachmentStats.entries.length === 0
                    ? h('p', { className: 'dsp-field-hint', style: { margin: 0 } }, '缓存为空。')
                    : h('div', { className: 'dsp-scroll' },
                        ...attachmentStats.entries.slice(0, 20).map((entry, i) => h('div', {
                          key: entry.hash ?? i, className: 'dsp-field-hint',
                        }, `${entry.name}｜${humanSize(entry.bytes)}｜最后访问 ${entry.lastUsedText}`)),
                      ),
                ),
          ),
        ),

        // ── 轮询与性能 ──────────────────────────────────────
        h(Card, {
          open: open.poll === true,
          onToggle: () => toggle('poll'),
          title: '轮询与性能',
          subtitle: '插件用「全局搜索我的消息」发现触发，一次调用覆盖所有群，不逐群扫',
          tag: h(Tag, null, `间隔 ${pollCfg.intervalSeconds ?? 30} 秒`),
          dirty: pollDraft.dirty,
          onSave: () => void pollDraft.commit(d => ({ poll: d })),
          onDiscard: pollDraft.rollback,
        },
          h('div', { className: 'dsp-two' },
            h(Field, { label: '轮询间隔（秒）', hint: '允许 15–300。低于 15 会被自动纠正。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 15, max: 300,
                value: pollCfg.intervalSeconds,
                onChange: e => pollDraft.set('intervalSeconds', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '时间窗重叠（秒）', hint: '向前多取一段，防止索引延迟漏消息。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 10, max: 3600,
                value: pollCfg.windowOverlapSeconds,
                onChange: e => pollDraft.set('windowOverlapSeconds', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '无命中退避上限（秒）', hint: '一直没命中时间隔最多拉长到该值。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 60, max: 3600,
                value: pollCfg.backoffMaxSeconds,
                onChange: e => pollDraft.set('backoffMaxSeconds', Number(e.target.value)),
              }),
            ),
          ),
        ),

        // ── 模型与署名 ──────────────────────────────────────
        h(Card, {
          open: open.llm === true,
          onToggle: () => toggle('llm'),
          title: '模型与署名',
          subtitle: '默认 DeepSeek-V4.1-Flash。上面「运行状态」里的 LLM 路由会显示实际用的是哪个',
          tag: llmCfg.llm?.model ? h(Tag, null, llmCfg.llm.model) : null,
          dirty: llmDraft.dirty,
          onSave: () => void llmDraft.commit(d => ({ llm: d.llm, company: d.company, ownerName: d.ownerName })),
          onDiscard: llmDraft.rollback,
        },
          h('div', { className: 'dsp-two' },
            h(Field, { label: 'provider', hint: '默认 deepseek-account。' },
              h('input', {
                className: 'dsp-input dsp-mono',
                value: llmCfg.llm?.provider ?? '',
                placeholder: 'deepseek-account',
                onChange: e => llmDraft.set('llm.provider', e.target.value),
              }),
            ),
            h(Field, { label: 'model', hint: '默认 deepseek-flash。' },
              h('input', {
                className: 'dsp-input dsp-mono',
                value: llmCfg.llm?.model ?? '',
                placeholder: 'deepseek-flash',
                onChange: e => llmDraft.set('llm.model', e.target.value),
              }),
            ),
            h(Field, { label: '最长等待（毫秒）', hint: '需求梳理较慢，超时会记失败而不是返回半截结果。' },
              h('input', {
                className: 'dsp-input', type: 'number', min: 5000, max: 600000,
                value: llmCfg.llm?.timeoutMs ?? 120000,
                onChange: e => llmDraft.set('llm.timeoutMs', Number(e.target.value)),
              }),
            ),
            h(Field, { label: '公司名（提示词里的 {company}）', hint: '留空则显示为「我们公司」。' },
              h('input', {
                className: 'dsp-input',
                value: llmCfg.company ?? '',
                placeholder: '例如：示例智能科技',
                onChange: e => llmDraft.set('company', e.target.value),
              }),
            ),
            h(Field, { label: '使用者名（提示词里的 {owner}）', hint: '用于结尾署名。留空则整行署名不发。' },
              h('input', {
                className: 'dsp-input',
                value: llmCfg.ownerName ?? '',
                placeholder: '例如：张三',
                onChange: e => llmDraft.set('ownerName', e.target.value),
              }),
            ),
          ),
        ),

        // ── 试跑 ────────────────────────────────────────────
        h(Card, {
          open: open.test === true,
          onToggle: () => toggle('test'),
          title: '试跑（不会发送）',
          subtitle: '用真实会话数据走完整链路，只显示结果，绝不发消息',
        },
          h(Field, { label: '会话 ID', hint: '从下面的活动记录里复制一个 cid 开头的 ID。' },
            h('input', {
              className: 'dsp-input dsp-mono',
              value: testConversation,
              placeholder: 'cid…',
              onChange: e => setTestConversation(e.target.value),
            }),
          ),
          h('div', { className: 'dsp-actions' },
            h('button', { className: 'dsp-btn dsp-btn-primary', disabled: busy !== '', onClick: () => void runTest('provide') }, busy === 'test-provide' ? '生成中…' : '试跑动作一'),
            h('button', { className: 'dsp-btn dsp-btn-primary', disabled: busy !== '', onClick: () => void runTest('summarize') }, busy === 'test-summarize' ? '分析中…' : '试跑动作二'),
          ),
          testResult === null ? null : h('div', { className: `dsp-note ${testResult.error ? 'dsp-note-err' : 'dsp-note-ok'}`, style: { marginTop: 12 } },
            testResult.error
              ? `失败：${testResult.error}`
              : h('div', null,
                  h('div', { style: { marginBottom: 8 } },
                    h('strong', null, '@ 判定：'),
                    testResult.mention?.mode === 'at'
                      ? `会真 @ ${testResult.mention.name}（置信度 ${testResult.mention.confidence}）— ${testResult.mention.reason}`
                      : testResult.mention?.mode === 'textual'
                        ? `仅文本提及 ${testResult.mention.name}（置信度 ${testResult.mention.confidence}）— ${testResult.mention.reason}`
                        : `不 @（${testResult.mention?.reason ?? '无原因'}）`,
                  ),
                  (testResult.mention?.evidence ?? []).length > 0
                    ? h('div', { style: { marginBottom: 8 } }, h('strong', null, '依据：'),
                        h('ul', null, (testResult.mention.evidence).map((ev, i) => h('li', { key: i }, ev))))
                    : null,
                  (testResult.warnings ?? []).length > 0
                    ? h('div', { style: { marginBottom: 8 } }, h('strong', null, '提醒：'),
                        h('ul', null, (testResult.warnings).map((w, i) => h('li', { key: i }, w))))
                    : null,
                  h('div', { style: { marginBottom: 4 } }, h('strong', null, '将发送的正文：')),
                  h('div', { className: 'dsp-scroll', style: { background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))', borderRadius: 8, padding: '10px 12px' } },
                    h('pre', { className: 'dsp-pre', style: { maxHeight: 'none' } }, testResult.text || '（空）')),
                  testResult.wouldSend ? h('p', { className: 'dsp-field-hint', style: { marginTop: 8, marginBottom: 0 } }, testResult.wouldSend) : null,
                ),
          ),
        ),

        // ── 活动记录 ────────────────────────────────────────
        h(Card, {
          open: open.activity === true,
          onToggle: () => toggle('activity'),
          title: '活动记录',
          subtitle: '每轮「发现 → 判定 → 发送/跳过」都记一条。试运行模式下这里是唯一的观察窗口',
          tag: h(Tag, null, `${activity.length} 条`),
          footNote: ' ',
          footAction: h('button', { className: 'dsp-btn dsp-btn-secondary', disabled: busy !== '', onClick: () => void act('clear', '/activity/clear') }, '清空记录'),
        },
          activity.length === 0
            ? h('div', { className: 'dsp-note' }, '暂无记录。若你刚在群里发过关键词，可点上面的「立即检查一次」。')
            : h('ul', { className: 'dsp-list dsp-scroll' },
                activity.map((e, i) => h('li', { key: e.ts ?? i, className: 'dsp-li' },
                  h('div', { className: 'dsp-li-head' },
                    h(Tag, { kind: e.decision === 'sent' ? 'ok' : e.decision === 'failed' ? 'err' : null },
                      `${e.action ?? '?'} / ${e.decision ?? '?'}`),
                    h('span', { className: 'dsp-li-time' }, humanTime(e.ts)),
                    e.conversationName ? h('span', { className: 'dsp-li-name' }, e.conversationName) : null,
                  ),
                  e.conversationId ? h('div', { className: 'dsp-li-line dsp-mono' }, e.conversationId) : null,
                  e.triggerText ? h('div', { className: 'dsp-li-line' }, `触发：${e.triggerText}`) : null,
                  e.mention && e.mention.mode && e.mention.mode !== 'none'
                    ? h('div', { className: 'dsp-li-line' },
                        `@：${e.mention.name || '?'}（${e.mention.mode}${e.mention.confidence ? ` / ${e.mention.confidence}` : ''}）— ${e.mention.reason ?? ''}`)
                    : null,
                  Array.isArray(e.attachments) && e.attachments.length > 0
                    ? h('div', null,
                        h('div', { className: 'dsp-li-line' }, `附件（${e.attachmentSummary || ''}）：`),
                        ...e.attachments.map((a, ai) => {
                          const icon = a.status === 'ok' ? '✔' : a.status === 'image' ? '🖼' : a.status === 'error' ? '✖' : 'ℹ';
                          const what = a.status === 'ok' ? `提取 ${a.chars} 字` : a.status === 'image' ? '图片已交给模型查看' : '未提取内容';
                          return h('div', { key: ai, className: 'dsp-li-sub' },
                            `${icon} ${a.name}｜${humanSize(a.size)}｜${what}${a.fromCache ? '｜缓存命中' : ''}${a.note ? `｜${a.note}` : ''}`);
                        }),
                      )
                    : null,
                  e.error ? h('div', { className: 'dsp-li-line', style: { color: 'var(--dsw-alias-state-error-primary, #ec1313)' } }, `错误：${e.error}`) : null,
                  e.note ? h('div', { className: 'dsp-li-sub' }, e.note) : null,
                  e.text ? h('pre', { className: 'dsp-pre' }, e.text.slice(0, 500)) : null,
                )),
              ),
        ),

        // ── 说明 ────────────────────────────────────────────
        h(Card, {
          open: open.about === true,
          onToggle: () => toggle('about'),
          title: '几点要知道的',
        },
          h('div', { className: 'dsp-note' },
            h('ul', null,
              h('li', null, '触发条件严格限定为「你自己发的消息」——同事在群里说同样的话不会有任何反应，这是设计如此。'),
              h('li', null, '@ 必须在正文里用 <@openDingtalkId> 占位符，这是钉钉的硬要求，插件已自动处理；若 @ 发送失败，会自动去掉 @ 重发一次，保证文案一定送达。'),
              h('li', null, '插件用轮询而不是事件推送，是因为钉钉会把「你自己发的消息」从事件流里过滤掉，长连接收不到。'),
              h('li', null, `设置文件：${status.settingsPath ?? '（未知）'}。改动写盘后立即生效，无需重启。`),
            ),
          ),
        ),

        // 全局错误提示（只在出错时出现）
        error.length > 0 ? h('div', { className: 'dsp-note dsp-note-err' }, `错误：${error}`) : null,
      );
    }

    // ─────────────────────────── 装配 ───────────────────────────

    const inject = ['slots'];

    function apply(ctx) {
      const slots = ctx.slots;
      if (slots === undefined) return;

      ctx.effect(() => injectStyles(), 'dsh-presale: styles');

      ctx.effect(() => slots.inject('settings.section', () => {
        try {
          return slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            order: 60,
            label: () => '售前助手',
          }, Panel);
        } catch (error) {
          console.error('[dsh-presale] 注册设置入口失败', error);
          return () => {};
        }
      }), 'dsh-presale: settings section');

      return {};
    }

    module.exports = { apply, inject };
    return module.exports;
  },
});
