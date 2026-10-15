// dsh-presale 客户端半边：设置对话框里的「售前助手」一级导航页。
//
// 装载契约（与已装第三方插件一致，实测得来）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
//   · React 由宿主共享提供，必须 require('react')，不能自带第二份（否则 hooks 失效）；
//   · 模块导出 { apply, inject }，inject 写服务名，这里是 ['slots']；
//   · 注册设置一级导航用的是 **settings.section** 插槽
//     （该插槽只投影 id / order / label，第三方拿不到图标，一律用外壳的齿轮）；
//   · 客户端到宿主没有通用 RPC，一律走同源 fetch 打 /presale-api/*。
//
// 刻意不引入任何打包器：整份代码是普通 JS + React.createElement，
// 出问题能直接在浏览器里读栈、改一行刷新即可。
//
// ── 界面设计要点（改版时踩过的坑都记在这里）────────────────────
//
// ① **CSS 变量名必须是 DSH 的真 token**。早前用的是
//    `--dsw-alias-border` / `--dsw-alias-text-1` / `--dsw-alias-brand` 这类**猜测名**，
//    而真实 token 是 `--dsw-alias-border-l1` / `--dsw-alias-label-primary` /
//    `--dsw-alias-brand-primary`。写错不会报错，只会静默走兜底值——
//    于是「跟随主题」形同虚设，浅色/深色切换时面板并不跟着变。
//    查真实 token 用：cordis_inspect_query(client / Theme / listTokens)。
//
// ② **一个全局保存条，而不是每张卡一个保存按钮**。原来 13 个区块各带一个
//    「保存动作一/二/…」按钮，改三处就要点三次，而且很容易忘了保存。
//    现在底部固定一条，显示「有未保存改动」并提供保存/放弃，改多少都只点一次。
//
// ③ **分区 + 可折叠**。13 张卡平铺成一长条滚动页，找设置靠翻。
//    现在按「用不用得上」分 5 组：状态与开关开着，其余默认收起，
//    点标题展开。日常只关心状态，配置偶尔才动。
//
// ④ 字段改成上下布局（标签在上、控件在下、说明再一行），
//    窄侧栏里比左右布局更省空间，长说明也不会把标签挤成一列。

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
    // 只用 DSH 的真实设计令牌（见文件头 ①），因此深浅主题自动跟随。
    // 每条规则都带中性兜底值，万一某个 token 将来改名也不会变成透明/黑块。

    const CSS = `
.dsp-root { display: flex; flex-direction: column; gap: 14px; padding: 2px 2px 84px; font-size: 13px; line-height: 1.6; }

/* ── 顶部标题 ─────────────────────────────────────────── */
.dsp-head { display: flex; align-items: flex-start; gap: 10px; padding: 2px 2px 0; }
.dsp-head-main { flex: 1; min-width: 0; }
.dsp-head-title { font-size: 16px; font-weight: 600; margin: 0 0 2px; color: var(--dsw-alias-label-primary, inherit); }
.dsp-head-sub { font-size: 12px; margin: 0; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }

/* ── 卡片 ─────────────────────────────────────────────── */
.dsp-card { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, transparent); overflow: hidden; }
.dsp-card-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; cursor: pointer; user-select: none; }
.dsp-card-head:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)); }
.dsp-card-head-static { cursor: default; }
.dsp-card-head-static:hover { background: transparent; }
.dsp-card-title { font-size: 13px; font-weight: 600; margin: 0; color: var(--dsw-alias-label-primary, inherit); flex: 1; min-width: 0; }
.dsp-card-body { padding: 0 14px 14px; }
.dsp-card-hint { font-size: 12px; line-height: 1.65; margin: 0; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dsp-card-head .dsp-card-hint { font-weight: 400; }
.dsp-caret { flex: none; width: 12px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); font-size: 10px; transition: transform .15s ease; }
.dsp-caret-open { transform: rotate(90deg); }

/* ── 状态卡（常驻）──────────────────────────────────────── */
.dsp-state { display: flex; flex-direction: column; gap: 10px; }
.dsp-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.dsp-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 1; padding: 5px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); color: var(--dsw-alias-label-secondary, inherit); white-space: nowrap; }
.dsp-badge-ok { color: var(--dsw-alias-state-success-primary, #2f9e44); border-color: currentColor; }
.dsp-badge-warn { color: var(--dsw-alias-state-warn-primary, #c98a00); border-color: currentColor; }
.dsp-badge-err { color: var(--dsw-alias-state-error-primary, #d64545); border-color: currentColor; }
.dsp-badge-idle { color: var(--dsw-alias-state-idle-primary, rgba(128,128,128,.9)); }
.dsp-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }

/* ── 键值网格 ─────────────────────────────────────────── */
.dsp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 18px; }
.dsp-kv { min-width: 0; }
.dsp-kv-k { font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); margin-bottom: 1px; }
.dsp-kv-v { font-size: 13px; color: var(--dsw-alias-label-primary, inherit); word-break: break-word; }

/* ── 表单 ─────────────────────────────────────────────── */
.dsp-fields { display: flex; flex-direction: column; gap: 14px; }
.dsp-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsp-field-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dsp-field-hint { font-size: 12px; line-height: 1.65; margin: 0; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dsp-field-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsp-input, .dsp-textarea, .dsp-select { width: 100%; min-width: 0; font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary, inherit); box-sizing: border-box; }
.dsp-textarea { min-height: 150px; resize: vertical; line-height: 1.65; font-family: inherit; }
.dsp-input:focus, .dsp-textarea:focus, .dsp-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4b7bec); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 18%, transparent); }
.dsp-input::placeholder, .dsp-textarea::placeholder { color: var(--dsw-alias-label-secondary, rgba(128,128,128,.6)); }
.dsp-check { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); }
.dsp-check input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary, #4b7bec); cursor: pointer; flex: none; }
.dsp-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }

/* ── 按钮 ─────────────────────────────────────────────── */
.dsp-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dsp-btn { font: inherit; font-size: 13px; line-height: 1; padding: 8px 13px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); cursor: pointer; white-space: nowrap; }
.dsp-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); }
.dsp-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsp-btn-primary { background: var(--dsw-alias-brand-primary, #4b7bec); border-color: var(--dsw-alias-brand-primary, #4b7bec); color: #fff; }
.dsp-btn-primary:hover:not(:disabled) { filter: brightness(1.06); }
.dsp-btn-danger { color: var(--dsw-alias-state-error-primary, #d64545); border-color: var(--dsw-alias-state-error-primary, #d64545); background: transparent; }
.dsp-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 10%, transparent); }
.dsp-btn-sm { padding: 6px 10px; font-size: 12px; }
.dsp-spacer { flex: 1; }

/* ── 提示条 ───────────────────────────────────────────── */
.dsp-note { font-size: 12px; line-height: 1.7; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); color: var(--dsw-alias-label-secondary, inherit); }
.dsp-note ul { margin: 6px 0 0 18px; padding: 0; }
.dsp-note-warn { border-left: 3px solid var(--dsw-alias-state-warn-primary, #c98a00); }
.dsp-note-err { border-left: 3px solid var(--dsw-alias-state-error-primary, #d64545); }
.dsp-note-ok { border-left: 3px solid var(--dsw-alias-state-success-primary, #2f9e44); }

/* ── 活动记录 ─────────────────────────────────────────── */
.dsp-log { font-size: 12px; line-height: 1.65; max-height: 340px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06)); padding: 10px 12px; }
.dsp-log-item { padding: 8px 0; }
.dsp-log-item + .dsp-log-item { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16)); }
.dsp-log-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dsp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.dsp-pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; line-height: 1.7; margin: 0; }
.dsp-preview { max-height: 300px; overflow: auto; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06)); border-radius: 8px; padding: 10px 12px; margin-top: 6px; }

/* ── 底部固定保存条 ───────────────────────────────────── */
.dsp-dock { position: sticky; bottom: 0; z-index: 5; margin: 0 -2px -84px; padding: 10px 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff));
  backdrop-filter: blur(6px); }
.dsp-dock-msg { font-size: 12px; flex: 1; min-width: 120px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dsp-dock-dirty { color: var(--dsw-alias-state-warn-primary, #c98a00); font-weight: 500; }
.dsp-dock-err { color: var(--dsw-alias-state-error-primary, #d64545); }
.dsp-dock-ok { color: var(--dsw-alias-state-success-primary, #2f9e44); }
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

    /** 表单字段：标签在上、控件在中、说明在下。窄侧栏里比左右布局省地方。 */
    function Field(props) {
      return h('div', { className: 'dsp-field' },
        props.label ? h('label', { className: 'dsp-field-label' }, props.label) : null,
        props.children,
        props.hint ? h('p', { className: 'dsp-field-hint' }, props.hint) : null,
      );
    }

    function Kv(props) {
      return h('div', { className: 'dsp-kv' },
        h('div', { className: 'dsp-kv-k' }, props.k),
        h('div', { className: 'dsp-kv-v' }, props.v),
      );
    }

    function Badge(props) {
      return h('span', { className: `dsp-badge dsp-badge-${props.kind ?? 'idle'}` },
        h('span', { className: 'dsp-dot' }),
        props.children,
      );
    }

    /**
     * 可折叠区块。
     *
     * open 由父级控制（受控组件），这样「展开状态」可以整体管理，
     * 也方便做"某个区块里有错误就自动展开"这类后续增强。
     */
    function Card(props) {
      const collapsible = typeof props.open === 'boolean';
      const open = collapsible ? props.open : true;
      const headProps = {
        className: `dsp-card-head${collapsible ? '' : ' dsp-card-head-static'}`,
      };
      if (collapsible) {
        headProps.onClick = props.onToggle;
        headProps.role = 'button';
        headProps.tabIndex = 0;
        headProps.onKeyDown = event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onToggle?.();
          }
        };
      }
      return h('section', { className: 'dsp-card' },
        h('div', headProps,
          collapsible ? h('span', { className: `dsp-caret${open ? ' dsp-caret-open' : ''}` }, '▶') : null,
          h('h3', { className: 'dsp-card-title' }, props.title),
          props.badge ?? null,
          props.headRight ?? null,
        ),
        open ? h('div', { className: 'dsp-card-body' },
          props.hint ? h('p', { className: 'dsp-card-hint', style: { marginBottom: 12 } }, props.hint) : null,
          props.children,
        ) : null,
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
      const [testResult, setTestResult] = React.useState(null);
      const [testConversation, setTestConversation] = React.useState('');
      const [attachmentStats, setAttachmentStats] = React.useState(null);
      // 折叠状态：默认只展开「状态」，其余收起——日常只需要看状态
      const [open, setOpen] = React.useState({ state: true });
      const [dirty, setDirty] = React.useState(false);
      const dirtyRef = React.useRef(false);
      /** 上次从服务端拿到的设置，用来判断"当前是否真的有改动"。 */
      const loadedRef = React.useRef('');

      const toggle = key => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

      const refresh = React.useCallback(async () => {
        try {
          const [s, st, act] = await Promise.all([
            api('/settings'),
            api('/status'),
            api('/activity?limit=30'),
          ]);
          // 用户正在编辑时不要把草稿覆盖掉
          if (!dirtyRef.current) {
            setSettings(s.settings);
            loadedRef.current = JSON.stringify(s.settings);
          }
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
        setDirty(true);
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

      /**
       * 保存到磁盘。
       *
       * 传整份 settings 作为 patch：宿主只认它认识的键（未知键会被忽略），
       * 所以不需要在前端精心拼接"改了哪几块"——那是每卡一个保存按钮时代的负担，
       * 也是漏保存的根源。
       */
      async function saveAll() {
        if (settings === null) return;
        setBusy('save');
        try {
          const result = await api('/settings', { method: 'POST', body: { patch: settings, strict: true } });
          dirtyRef.current = false;
          setDirty(false);
          setSettings(result.settings);
          loadedRef.current = JSON.stringify(result.settings);
          setSaved(`已保存 · ${new Date().toLocaleTimeString('zh-CN')}`);
          setError('');
          await refresh();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy('');
        }
      }

      /** 放弃未保存改动，回到磁盘上的值。 */
      function discard() {
        dirtyRef.current = false;
        setDirty(false);
        setSaved('已放弃未保存的改动');
        setError('');
        void refresh();
      }

      /**
       * 只改开关这类"即时生效"的量时，用它直接落盘（不走草稿）。
       * 顶部状态条的开关用它，避免"点了没反应、还得滚到底部保存"。
       */
      async function savePatch(patch, label) {
        setBusy('save');
        try {
          const result = await api('/settings', { method: 'POST', body: { patch, strict: true } });
          setSettings(prev => {
            const next = { ...result.settings };
            loadedRef.current = JSON.stringify(next);
            return next;
          });
          dirtyRef.current = false;
          setDirty(false);
          setSaved(`${label} · ${new Date().toLocaleTimeString('zh-CN')}`);
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

      async function runTest(kind) {
        const conversationId = testConversation.trim();
        if (conversationId.length === 0) {
          setTestResult({ error: '请先填一个会话 ID（openConversationId，以 cid 开头）。可从下面的活动记录里复制。' });
          return;
        }
        setBusy(`test-${kind}`);
        setTestResult(null);
        try {
          const result = await api('/test', { method: 'POST', body: { kind, conversationId } });
          setTestResult(result);
          setError('');
        } catch (err) {
          setTestResult({ error: err.message });
        } finally {
          setBusy('');
        }
      }

      // ── 加载中 / 加载失败 ──────────────────────────────────
      if (settings === null || status === null) {
        return h('div', { className: 'dsp-root' },
          h('div', { className: 'dsp-head' },
            h('div', { className: 'dsp-head-main' },
              h('h2', { className: 'dsp-head-title' }, '售前助手'),
              h('p', { className: 'dsp-head-sub' }, error.length > 0 ? `加载失败：${error}` : '正在读取插件状态…'),
            ),
          ),
          error.length > 0
            ? h('div', { className: 'dsp-actions' }, h('button', { className: 'dsp-btn', onClick: () => void refresh() }, '重试'))
            : null,
        );
      }

      const poller = status.poller ?? {};
      const id = status.identity ?? {};
      const llmInfo = status.llm ?? {};
      const t = settings.triggers ?? { provide: {}, summarize: {} };

      // ── 状态灯：把「为什么没工作」一次说清 ────────────────
      const badges = [];
      if (poller.enabled !== true) badges.push(['warn', '未启用']);
      else if (poller.running) badges.push(['ok', '监听中']);
      else badges.push(['warn', '已启用但未运行']);
      if (poller.dryRun) badges.push(['idle', '试运行：不发送']);
      if (poller.authOk === false) badges.push(['err', 'dws 未登录']);
      if (id.state === 'anchored') badges.push(['ok', `身份已锚定：${id.myName || id.myOid}`]);
      else if (id.state === 'weak') badges.push(['warn', `身份弱校验：${id.myName || id.myOid}`]);
      else badges.push(['err', `身份未锚定${id.myName ? `（${id.myName}）` : ''}`]);
      if (llmInfo.available !== true) badges.push(['err', 'LLM 不可用']);

      const hasProblem = badges.some(([kind]) => kind === 'err' || kind === 'warn');

      // ── 底部保存条文案 ────────────────────────────────────
      const dockMsg = error.length > 0
        ? h('span', { className: 'dsp-dock-err' }, `错误：${error}`)
        : dirty
          ? h('span', { className: 'dsp-dock-dirty' }, '● 有未保存的改动')
          : h('span', { className: saved ? 'dsp-dock-ok' : undefined }, saved || '所有改动都已保存');

      return h('div', { className: 'dsp-root' },

        // ── 标题 ──────────────────────────────────────────────
        h('div', { className: 'dsp-head' },
          h('div', { className: 'dsp-head-main' },
            h('h2', { className: 'dsp-head-title' }, '售前助手'),
            h('p', { className: 'dsp-head-sub' }, '在钉钉群里说关键词即可触发。只认你本人发的消息。'),
          ),
        ),

        // ── 状态（常驻，默认展开）──────────────────────────────
        h(Card, {
          title: '运行状态',
          open: open.state === true,
          onToggle: () => toggle('state'),
          badge: hasProblem ? h(Badge, { kind: 'warn' }, '需要关注') : h(Badge, { kind: 'ok' }, '正常'),
          hint: '「只认我本人触发」是硬规则：只有你（下面的登录账号）发出的关键词才会被执行，其他人的同类消息会被跳过。',
        },
          h('div', { className: 'dsp-state' },
            h('div', { className: 'dsp-badges' },
              ...badges.map(([kind, text], i) => h(Badge, { key: i, kind }, text)),
            ),
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
            id.message ? h('div', { className: 'dsp-note' }, `身份说明：${id.message}`) : null,
            poller.lastError ? h('div', { className: 'dsp-note dsp-note-warn' }, `最近错误：${poller.lastError}`) : null,
            (status.settingsWarnings ?? []).length > 0
              ? h('div', { className: 'dsp-note dsp-note-warn' },
                  '配置告警：', h('ul', null, (status.settingsWarnings ?? []).map((w, i) => h('li', { key: i }, w))))
              : null,

            // 开关与运维动作：放在状态卡里，因为它们都是"看完状态马上要做的事"
            h('div', { className: 'dsp-note' },
              h('div', { className: 'dsp-actions' },
                h('label', { className: 'dsp-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: settings.enabled === true,
                    disabled: busy === 'save',
                    onChange: e => void savePatch({ enabled: e.target.checked }, e.target.checked ? '已开启监听' : '已关闭监听'),
                  }),
                  '启用监听',
                ),
                h('label', { className: 'dsp-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: settings.dryRun === true,
                    disabled: busy === 'save',
                    onChange: e => void savePatch({ dryRun: e.target.checked }, e.target.checked ? '已切到试运行（不发送）' : '已切到真实发送'),
                  }),
                  '试运行（只记录不发送）',
                ),
              ),
              h('p', { className: 'dsp-field-hint', style: { marginTop: 6 } },
                '这两个开关**改完立即生效**，不用点下面的保存。建议先用试运行把文案和 @ 判定调准。'),
            ),
            h('div', { className: 'dsp-actions' },
              h('button', { className: 'dsp-btn dsp-btn-sm', disabled: busy !== '', onClick: () => void act('check', '/check-now') }, busy === 'check' ? '检查中…' : '立即检查一次'),
              h('button', { className: 'dsp-btn dsp-btn-sm', disabled: busy !== '', onClick: () => void act('seed', '/seed-now') }, '水位重置为现在'),
              h('button', { className: 'dsp-btn dsp-btn-sm', disabled: busy !== '', onClick: () => void act('id', '/reidentify') }, '重新识别身份'),
              h('div', { className: 'dsp-spacer' }),
              h('button', { className: 'dsp-btn dsp-btn-sm', disabled: busy !== '' || poller.running === true, onClick: () => void act('start', '/start') }, '开始'),
              h('button', { className: 'dsp-btn dsp-btn-sm', disabled: busy !== '' || poller.running !== true, onClick: () => void act('stop', '/stop') }, '停止'),
            ),
          ),
        ),

        // ── 分组 1：触发与文案 ─────────────────────────────────
        h(Card, {
          title: '触发与文案',
          open: open.trigger === true,
          onToggle: () => toggle('trigger'),
          hint: '你在群里说什么话会触发、触发后发什么内容。两组都改完点底部保存即可。',
        },
          h('div', { className: 'dsp-fields' },
            h('h4', { className: 'dsp-field-label', style: { margin: 0, fontSize: 13 } }, '动作一 · 提供完整项目需求'),
            h('p', { className: 'dsp-field-hint', style: { margin: 0 } },
              '你说触发关键词时，插件会在该群发下面这段文案，并尝试 @ AI 判别出的销售人员。'),
            h('div', { className: 'dsp-cols' },
              h(Field, { label: '触发关键词', hint: '多个关键词用英文逗号分隔。匹配时自动忽略空格、全角/半角与大小写差异。' },
                h('input', {
                  className: 'dsp-input',
                  value: (t.provide.keywords ?? []).join(','),
                  onChange: e => edit('triggers.provide.keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean)),
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
            ),
            h(Field, {
              label: '触发前缀（可选）',
              hint: '留空表示直接说关键词就触发。若担心闲聊时顺口提到会误触发，可填一个前缀（例如「DSH 」），之后必须说「DSH 提供完整项目需求」才会触发。',
            },
              h('input', {
                className: 'dsp-input',
                value: t.provide.prefix ?? '',
                placeholder: '（留空 = 不需要前缀）',
                onChange: e => edit('triggers.provide.prefix', e.target.value),
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

            h('h4', { className: 'dsp-field-label', style: { margin: '10px 0 0', fontSize: 13 } }, '动作二 · 梳理项目需求'),
            h('p', { className: 'dsp-field-hint', style: { margin: 0 } },
              '插件读取该群近期消息（含群文件与图片），交给模型分析，然后把需求总结发回该群（默认不 @ 任何人）。'),
            h('div', { className: 'dsp-cols' },
              h(Field, { label: '触发关键词', hint: '多个用英文逗号分隔。' },
                h('input', {
                  className: 'dsp-input',
                  value: (t.summarize.keywords ?? []).join(','),
                  onChange: e => edit('triggers.summarize.keywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean)),
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
              h(Field, { label: '标题前缀', hint: '拼在总结最前面，例如「【项目需求梳理】」。留空则不加。' },
                h('input', {
                  className: 'dsp-input',
                  value: t.summarize.title ?? '',
                  onChange: e => edit('triggers.summarize.title', e.target.value),
                }),
              ),
            ),
            h(Field, {
              label: '总结提示词',
              hint: '改这里就能调整总结的口径、结构与详略。可用 {company} 与 {owner} 两个占位符。',
            },
              h('textarea', {
                className: 'dsp-textarea',
                style: { minHeight: 220 },
                value: t.summarize.prompt ?? '',
                onChange: e => edit('triggers.summarize.prompt', e.target.value),
              }),
            ),

            h('h4', { className: 'dsp-field-label', style: { margin: '10px 0 0', fontSize: 13 } }, '@ 销售人员'),
            h('p', { className: 'dsp-field-hint', style: { margin: 0 } },
              '插件读该群聊天记录，让模型判断「谁在把需求和项目信息带进这个群」，通常是提出需求描述的那个人。模型必须排除你自己——你是在发指令，不是需求提出方。'),
            h('div', { className: 'dsp-fields' },
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
              h(Field, { label: '判别提示词' },
                h('textarea', {
                  className: 'dsp-textarea',
                  value: t.provide.salesPrompt ?? '',
                  onChange: e => edit('triggers.provide.salesPrompt', e.target.value),
                }),
              ),
            ),
          ),
        ),

        // ── 分组 2：附件读取 ──────────────────────────────────
        h(Card, {
          title: '附件读取',
          open: open.attach === true,
          onToggle: () => toggle('attach'),
          badge: settings.attachments.enabled ? h(Badge, { kind: 'ok' }, '已开启') : h(Badge, { kind: 'idle' }, '已关闭'),
          hint: '钉钉服务端没有「在线读文件正文」的接口，文件必须先下载到本地再解析。很多人只在群里丢一个需求文档就完事，不读附件等于漏掉核心需求。',
        },
          h('div', { className: 'dsp-fields' },
            h(Field, { label: '读取群文件', hint: '关闭则只依据聊天文字，文件仅记录不解析。支持 docx / xlsx / pptx / pdf / 文本，图片直接交给多模态模型看。' },
              h('label', { className: 'dsp-check' },
                h('input', {
                  type: 'checkbox',
                  checked: settings.attachments.enabled,
                  onChange: e => edit('attachments.enabled', e.target.checked),
                }),
                settings.attachments.enabled ? '开启' : '关闭',
              ),
            ),
            h('div', { className: 'dsp-cols' },
              h(Field, { label: '单轮文件数上限', hint: '防止一个群刷了几十个附件。默认 5。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 1,
                  max: 50,
                  value: settings.attachments.maxFilesPerRun,
                  onChange: e => edit('attachments.maxFilesPerRun', Number(e.target.value)),
                }),
              ),
              h(Field, { label: '单文件字数上限', hint: '默认 12000 字。表格类文件往往很长，适当限制可避免挤掉聊天记录。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 500,
                  value: settings.attachments.maxCharsPerFile,
                  onChange: e => edit('attachments.maxCharsPerFile', Number(e.target.value)),
                }),
              ),
              h(Field, { label: '全部附件总字数上限', hint: '默认 30000 字。超出时按份均分，每份都会露头，不会让前几份吃光。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 1000,
                  value: settings.attachments.maxTotalChars,
                  onChange: e => edit('attachments.maxTotalChars', Number(e.target.value)),
                }),
              ),
              h(Field, { label: '单文件大小上限（MB）', hint: '超过就跳过并记明原因。默认 50MB——售前方案 PPT 常有 12MB 以上。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 1,
                  max: 200,
                  value: Math.round((settings.attachments.maxFileBytes ?? 0) / 1024 / 1024),
                  onChange: e => edit('attachments.maxFileBytes', Math.max(1, Number(e.target.value)) * 1024 * 1024),
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
            ),
            h(Field, {
              label: 'Python 路径（解析 PDF 用）',
              hint: '只用于解析 PDF。需要那个 Python 里装了 PyMuPDF 或 pypdf，例如 C:\\Python314\\python.exe。留空则不尝试解析 PDF——读不到时会明确标注「未提取」，不会假装读过。',
            },
              h('input', {
                className: 'dsp-input dsp-mono',
                value: settings.attachments.pythonPath ?? '',
                placeholder: '留空 = 不解析 PDF',
                onChange: e => edit('attachments.pythonPath', e.target.value),
              }),
            ),

            // 缓存用量：属于"看完设置想知道占了多少磁盘"，放同一张卡里
            h('div', { className: 'dsp-note' },
              h('div', { className: 'dsp-actions', style: { marginBottom: 8 } },
                h('strong', { style: { flex: 1, fontSize: 12 } }, '附件缓存'),
                h('button', { className: 'dsp-btn dsp-btn-sm', onClick: () => void loadAttachments() }, '刷新用量'),
                h('button', { className: 'dsp-btn dsp-btn-sm dsp-btn-danger', disabled: busy !== '', onClick: () => void act('attachclear', '/attachments/clear') }, '清空缓存'),
              ),
              attachmentStats === null
                ? h('p', { className: 'dsp-field-hint', style: { margin: 0 } }, '点「刷新用量」查看缓存占用。同一个文件第二次遇到会直接命中缓存、不再走网络。')
                : h('div', null,
                    h('p', { className: 'dsp-field-hint', style: { margin: '0 0 6px' } },
                      `占用 ${humanSize(attachmentStats.totalBytes)}｜${attachmentStats.entryCount} 个条目｜${attachmentStats.fileCount} 个文件`),
                    h('div', { className: 'dsp-mono', style: { marginBottom: 8, opacity: .8 } }, attachmentStats.cacheDir || '（未启用）'),
                    attachmentStats.entries.length === 0
                      ? h('p', { className: 'dsp-field-hint', style: { margin: 0 } }, '缓存为空。')
                      : h('div', null,
                          ...attachmentStats.entries.slice(0, 20).map((entry, i) => h('div', {
                            key: entry.hash ?? i,
                            className: 'dsp-field-hint',
                          }, `${entry.name}｜${humanSize(entry.bytes)}｜最后访问 ${entry.lastUsedText}`)),
                        ),
                  ),
            ),
          ),
        ),

        // ── 分组 3：轮询与性能 ────────────────────────────────
        h(Card, {
          title: '轮询与性能',
          open: open.poll === true,
          onToggle: () => toggle('poll'),
          hint: '插件用「全局搜索我的消息」来发现触发（一次调用覆盖所有群，不逐群扫）。实测单次约 1 秒；连续无命中时会自动拉长间隔省配额，有命中立刻恢复。',
        },
          h('div', { className: 'dsp-fields' },
            h('div', { className: 'dsp-cols' },
              h(Field, { label: '轮询间隔（秒）', hint: '允许 15–300。低于 15 会被自动纠正，避免把接口配额打爆。默认 30。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 15,
                  max: 300,
                  value: settings.poll.intervalSeconds,
                  onChange: e => edit('poll.intervalSeconds', Number(e.target.value)),
                }),
              ),
              h(Field, { label: '时间窗重叠（秒）', hint: '搜索时向前多取一段时间，防止服务端索引延迟导致漏消息。默认 120。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 10,
                  max: 3600,
                  value: settings.poll.windowOverlapSeconds,
                  onChange: e => edit('poll.windowOverlapSeconds', Number(e.target.value)),
                }),
              ),
              h(Field, { label: '无命中退避上限（秒）', hint: '一直没命中时间隔最多拉长到这个值。默认 300。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 60,
                  max: 3600,
                  value: settings.poll.backoffMaxSeconds,
                  onChange: e => edit('poll.backoffMaxSeconds', Number(e.target.value)),
                }),
              ),
            ),
          ),
        ),

        // ── 分组 4：模型 ──────────────────────────────────────
        h(Card, {
          title: '模型',
          open: open.llm === true,
          onToggle: () => toggle('llm'),
          hint: '默认 DeepSeek-V4.1-Flash（deepseek-account / deepseek-flash）。上面的「运行状态」会显示实际用的是哪个；若来源标为 auto，说明默认 provider 未注册、已自动换用别的模型，建议在这里显式指定。',
        },
          h('div', { className: 'dsp-fields' },
            h('div', { className: 'dsp-cols' },
              h(Field, { label: 'provider' },
                h('input', {
                  className: 'dsp-input dsp-mono',
                  value: settings.llm.provider ?? '',
                  placeholder: 'deepseek-account',
                  onChange: e => edit('llm.provider', e.target.value),
                }),
              ),
              h(Field, { label: 'model' },
                h('input', {
                  className: 'dsp-input dsp-mono',
                  value: settings.llm.model ?? '',
                  placeholder: 'deepseek-flash',
                  onChange: e => edit('llm.model', e.target.value),
                }),
              ),
              h(Field, { label: '最长等待（毫秒）', hint: '需求梳理可能比较慢，超时会记失败而不是返回半截结果。默认 120000。' },
                h('input', {
                  className: 'dsp-input',
                  type: 'number',
                  min: 5000,
                  max: 600000,
                  value: settings.llm.timeoutMs,
                  onChange: e => edit('llm.timeoutMs', Number(e.target.value)),
                }),
              ),
            ),
            h('div', { className: 'dsp-cols' },
              h(Field, { label: '公司名（提示词里的 {company}）', hint: '让模型以你的公司口吻说话。留空则显示为「我们公司」。' },
                h('input', {
                  className: 'dsp-input',
                  value: settings.company ?? '',
                  placeholder: '例如：示例智能科技',
                  onChange: e => edit('company', e.target.value),
                }),
              ),
              h(Field, { label: '使用者名（提示词里的 {owner}）', hint: '默认提示词末尾的署名「本消息由{owner}AI售前助理发出」会用它替换。留空则把整行署名去掉——不发读不通的半句。' },
                h('input', {
                  className: 'dsp-input',
                  value: settings.ownerName ?? '',
                  placeholder: '例如：张三',
                  onChange: e => edit('ownerName', e.target.value),
                }),
              ),
            ),
          ),
        ),

        // ── 分组 5：活动记录 ──────────────────────────────────
        h(Card, {
          title: '活动记录',
          open: open.activity === true,
          onToggle: () => toggle('activity'),
          badge: h(Badge, { kind: 'idle' }, `${activity.length} 条`),
          headRight: h('button', {
            className: 'dsp-btn dsp-btn-sm',
            onClick: event => { event.stopPropagation(); void refresh(); },
          }, '刷新'),
          hint: '每轮「发现 → 判定 → 发送/跳过」都记一条。试运行模式下这里是唯一的观察窗口。',
        },
          h('div', { className: 'dsp-actions', style: { marginBottom: 10 } },
            h('button', {
              className: 'dsp-btn dsp-btn-sm dsp-btn-danger',
              disabled: busy !== '',
              onClick: () => void act('clear', '/activity/clear'),
            }, '清空记录'),
          ),
          activity.length === 0
            ? h('div', { className: 'dsp-note' }, '暂无记录。若你刚在群里发过关键词，可点上面的「立即检查一次」。')
            : h('div', { className: 'dsp-log' },
                activity.map((e, i) => h('div', { key: e.ts ?? i, className: 'dsp-log-item' },
                  h('div', { className: 'dsp-log-head' },
                    h('span', { className: `dsp-badge dsp-badge-${e.decision === 'sent' ? 'ok' : e.decision === 'failed' ? 'err' : 'idle'}` },
                      `${e.action ?? '?'} / ${e.decision ?? '?'}`),
                    h('span', { className: 'dsp-field-hint', style: { margin: 0 } }, humanTime(e.ts)),
                    e.conversationName ? h('span', { style: { fontWeight: 500 } }, e.conversationName) : null,
                  ),
                  e.conversationId
                    ? h('div', { className: 'dsp-mono', style: { marginTop: 3, opacity: .8 } }, e.conversationId)
                    : null,
                  e.triggerText ? h('div', { style: { marginTop: 3 } }, `触发：${e.triggerText}`) : null,
                  e.mention && e.mention.mode && e.mention.mode !== 'none'
                    ? h('div', { style: { marginTop: 3 } }, `@：${e.mention.name || '?'}（${e.mention.mode}${e.mention.confidence ? ` / ${e.mention.confidence}` : ''}）— ${e.mention.reason ?? ''}`)
                    : null,
                  // 附件处理结果：排查「模型为什么没读到某个文件」时这是唯一线索
                  Array.isArray(e.attachments) && e.attachments.length > 0
                    ? h('div', { style: { marginTop: 5 } },
                        h('div', { className: 'dsp-field-hint', style: { margin: 0 } }, `附件（${e.attachmentSummary || ''}）：`),
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
                            className: 'dsp-field-hint',
                            style: { paddingLeft: 12 },
                          }, `${icon} ${a.name}｜${humanSize(a.size)}｜${what}${a.fromCache ? '｜缓存命中' : ''}${a.note ? `｜${a.note}` : ''}`);
                        }),
                      )
                    : null,
                  e.error ? h('div', { style: { marginTop: 3, color: 'var(--dsw-alias-state-error-primary, #d64545)' } }, `错误：${e.error}`) : null,
                  e.note ? h('div', { className: 'dsp-field-hint', style: { margin: 0 } }, e.note) : null,
                  e.text ? h('pre', { className: 'dsp-pre', style: { marginTop: 6, opacity: .85 } }, e.text.slice(0, 500)) : null,
                )),
              ),
        ),

        // ── 分组 6：试跑（不发消息）────────────────────────────
        h(Card, {
          title: '试跑（不会发送）',
          open: open.test === true,
          onToggle: () => toggle('test'),
          hint: '用真实会话数据走完整链路，只把「报文与 @ 判定结果」显示出来，绝不发消息。先在活动记录里复制一个会话 ID 填进来。',
        },
          h('div', { className: 'dsp-fields' },
            h(Field, { label: '会话 ID' },
              h('input', {
                className: 'dsp-input dsp-mono',
                value: testConversation,
                placeholder: 'cid…（从活动记录里复制）',
                onChange: e => setTestConversation(e.target.value),
              }),
            ),
            h('div', { className: 'dsp-actions' },
              h('button', { className: 'dsp-btn dsp-btn-primary', disabled: busy !== '', onClick: () => void runTest('provide') }, busy === 'test-provide' ? '生成中…' : '试跑动作一'),
              h('button', { className: 'dsp-btn dsp-btn-primary', disabled: busy !== '', onClick: () => void runTest('summarize') }, busy === 'test-summarize' ? '分析中…' : '试跑动作二'),
            ),
            testResult === null ? null : h('div', { className: `dsp-note ${testResult.error ? 'dsp-note-err' : 'dsp-note-ok'}` },
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
                    h('div', { className: 'dsp-preview' }, h('pre', { className: 'dsp-pre' }, testResult.text || '（空）')),
                    testResult.wouldSend
                      ? h('p', { className: 'dsp-field-hint', style: { marginTop: 8, marginBottom: 0 } }, testResult.wouldSend)
                      : null,
                  ),
            ),
          ),
        ),

        // ── 说明 ──────────────────────────────────────────────
        h(Card, {
          title: '几点要知道的',
          open: open.about === true,
          onToggle: () => toggle('about'),
        },
          h('ul', { className: 'dsp-card-hint', style: { paddingLeft: 18, margin: 0 } },
            h('li', null, '触发条件严格限定为「你自己发的消息」——同事在群里说同样的话不会有任何反应，这是设计如此。'),
            h('li', null, '@ 必须在正文里用 <@openDingtalkId> 占位符，这是钉钉的硬要求，插件已自动处理；若 @ 发送失败，会自动去掉 @ 重发一次，保证文案一定送达。'),
            h('li', null, '插件用轮询而不是事件推送，是因为钉钉会把「你自己发的消息」从事件流里过滤掉，长连接收不到。'),
            h('li', null, `设置文件：${status.settingsPath ?? '（未知）'}。改动写盘后立即生效，无需重启。`),
          ),
        ),

        // ── 底部固定保存条 ────────────────────────────────────
        h('div', { className: 'dsp-dock' },
          h('div', { className: 'dsp-dock-msg' }, dockMsg),
          h('button', { className: 'dsp-btn', disabled: !dirty || busy !== '', onClick: discard }, '放弃改动'),
          h('button', { className: 'dsp-btn dsp-btn-primary', disabled: !dirty || busy !== '', onClick: () => void saveAll() }, busy === 'save' ? '保存中…' : '保存'),
        ),
      );
    }

    // ─────────────────────────── 装配 ───────────────────────────

    const inject = ['slots'];

    function apply(ctx) {
      const slots = ctx.slots;
      if (slots === undefined) return;

      ctx.effect(() => injectStyles(), 'dsh-presale: styles');

      // 注册设置左侧一级导航入口。
      //
      // ⚠️ 契约要点（查宿主源码确认，别凭感觉写）：
      //   · 签名是 **slots.register(options, component)** —— 组件走**第二个参数**，
      //     不是塞进 options 里。（渲染器读的是 entry.component，
      //     由 register 的第二个参数填进来。）
      //   · settings.section 只投影 id / order / label，第三方拿不到图标（一律齿轮）。
      //   · label 必须是**函数**，外壳惰性求值。
      ctx.effect(() => slots.inject('settings.section', () => {
        try {
          return slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            // 排在「备份与迁移」之后，正好落在截图里空出来的那一行
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
