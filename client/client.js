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
.dsp-pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; line-height: 1.7; margin: 0; }
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

    function Field(props) {
      return h('div', { className: 'dsp-row' },
        h('div', { className: 'dsp-label' }, props.label),
        props.children,
        props.hint ? h('div', { className: 'dsp-card-hint', style: { flex: '1 1 100%', margin: '2px 0 0 0' } }, props.hint) : null,
      );
    }

    function Kv(props) {
      return h('div', { className: 'dsp-kv' },
        h('div', { className: 'dsp-kv-k' }, props.k),
        h('div', { className: 'dsp-kv-v' }, props.v),
      );
    }

    function Card(props) {
      return h('section', { className: 'dsp-card' },
        h('h3', { className: 'dsp-card-title' }, props.title),
        props.hint ? h('p', { className: 'dsp-card-hint' }, props.hint) : null,
        props.children,
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
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy('');
        }
      }

      async function runTest(kind) {
        const conversationId = testConversation.trim();
        if (conversationId.length === 0) {
          setTestResult({ error: '请先填一个会话 ID（openConversationId，以 cid 开头）。可从上面的活动记录里复制。' });
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
          hint: '「只认我本人触发」是硬规则：只有你（下面的登录账号）发出的关键词才会被执行，其他人的同类消息会被跳过。',
        },
          h('div', { className: 'dsp-row' },
            ...badges.map(([kind, text], i) => h('span', { key: i, className: `dsp-badge dsp-badge-${kind}` }, text)),
          ),
          h('div', { className: 'dsp-grid', style: { marginTop: 14 } },
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
            h('button', {
              className: 'dsp-btn',
              disabled: busy !== '',
              onClick: () => void act('start', '/start'),
            }, '开始监听'),
            h('button', { className: 'dsp-btn', disabled: busy !== '', onClick: () => void act('stop', '/stop') }, '停止监听'),
            h('div', { className: 'dsp-spacer' }),
            h('button', { className: 'dsp-btn', disabled: busy !== '', onClick: () => void act('check', '/check-now') }, busy === 'check' ? '检查中…' : '立即检查一次'),
            h('button', { className: 'dsp-btn', disabled: busy !== '', onClick: () => void act('seed', '/seed-now') }, '把水位重置为现在'),
            h('button', { className: 'dsp-btn', disabled: busy !== '', onClick: () => void act('id', '/reidentify') }, '重新识别身份'),
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
          h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
            h('button', {
              className: 'dsp-btn dsp-btn-primary',
              disabled: busy === 'save',
              onClick: () => void save({
                triggers: { provide: {
                  keywords: t.provide.keywords,
                  prefix: t.provide.prefix,
                  cooldownSeconds: t.provide.cooldownSeconds,
                  template: t.provide.template,
                } },
              }),
            }, '保存动作一'),
          ),
        ),

        // ── 动作二 ────────────────────────────────────────────
        h(Card, {
          title: '动作二 · 梳理项目需求',
          hint: '插件会读取该群近期消息，交给 DSH 的模型分析，然后把需求总结发回该群（默认不 @ 任何人）。',
        }),
        h(Card, {
          title: '动作二设置',
          hint: '提示词可自定义：改这里就能调整总结的口径、结构与详略。',
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

        // ── @ 策略 ────────────────────────────────────────────
        h(Card, {
          title: '@ 销售人员',
          hint: '插件会读该群聊天记录，让模型判断「谁在把需求和项目信息带进这个群」，通常是提出需求描述的那个人。模型必须排除你自己（你是在发指令，不是需求提出方）。',
        },
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
          h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
            h('button', {
              className: 'dsp-btn dsp-btn-primary',
              disabled: busy === 'save',
              onClick: () => void save({
                mention: settings.mention,
                triggers: { provide: { salesPrompt: t.provide.salesPrompt, salesLookbackMessages: t.provide.salesLookbackMessages } },
              }),
            }, '保存 @ 设置'),
          ),
        ),

        // ── 轮询 ──────────────────────────────────────────────
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

        // ── 公司名 ────────────────────────────────────────────
        h(Card, {
          title: '公司名',
          hint: '提示词里的 {company} 会被替换成这个值，让模型以你的公司口吻说话。留空则显示为「我们公司」。',
        },
          h(Field, { label: '公司名' },
            h('input', {
              className: 'dsp-input',
              value: settings.company ?? '',
              placeholder: '例如：示例智能科技',
              onChange: e => edit('company', e.target.value),
            }),
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

        // ── 试跑 ──────────────────────────────────────────────
        h(Card, {
          title: '试跑（不会发送）',
          hint: '用真实会话数据走完整链路，只把「报文与 @ 判定结果」显示出来，绝不发消息。先在活动记录里复制一个会话 ID 填进来。',
        },
          h(Field, { label: '会话 ID' },
            h('input', {
              className: 'dsp-input dsp-mono',
              value: testConversation,
              placeholder: 'cid…（从下方活动记录或群链接里取）',
              onChange: e => setTestConversation(e.target.value),
            }),
          ),
          h('div', { className: 'dsp-actions', style: { marginTop: 12 } },
            h('button', { className: 'dsp-btn', disabled: busy !== '', onClick: () => void runTest('provide') }, busy === 'test-provide' ? '生成中…' : '试跑动作一'),
            h('button', { className: 'dsp-btn', disabled: busy !== '', onClick: () => void runTest('summarize') }, busy === 'test-summarize' ? '分析中…' : '试跑动作二'),
          ),
          testResult === null ? null : h('div', { className: 'dsp-note', style: { marginTop: 12 } },
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
                        h('ul', { style: { margin: '4px 0 0 18px' } }, (testResult.mention.evidence).map((e, i) => h('li', { key: i }, e))))
                    : null,
                  (testResult.warnings ?? []).length > 0
                    ? h('div', { style: { marginBottom: 8 } }, h('strong', null, '提醒：'),
                        h('ul', { style: { margin: '4px 0 0 18px' } }, (testResult.warnings).map((w, i) => h('li', { key: i }, w))))
                    : null,
                  h('div', { style: { marginBottom: 4 } }, h('strong', null, '将发送的正文：')),
                  h('pre', { className: 'dsp-pre' }, testResult.text || '（空）'),
                  h('div', { className: 'dsp-card-hint', style: { marginTop: 8 } }, testResult.wouldSend ?? ''),
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
                  e.error ? h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-danger, #d64545)' } }, `错误：${e.error}`) : null,
                  e.note ? h('div', { className: 'dsp-card-hint', style: { margin: '2px 0 0 0' } }, e.note) : null,
                  e.text ? h('pre', { className: 'dsp-pre', style: { marginTop: 6, opacity: .85 } }, e.text.slice(0, 500)) : null,
                )),
              ),
        ),

        // ── 保存提示 / 错误 ───────────────────────────────────
        (error.length > 0 || saved.length > 0)
          ? h('div', { className: `dsp-note ${error.length > 0 ? 'dsp-note-err' : ''}` },
              error.length > 0 ? `错误：${error}` : saved)
          : null,

        // ── 说明 ──────────────────────────────────────────────
        h(Card, { title: '几点要知道的' },
          h('ul', { style: { margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.9 } },
            h('li', null, '触发条件严格限定为「你自己发的消息」——同事在群里说同样的话不会有任何反应，这是设计如此。'),
            h('li', null, '@ 必须在正文里用 <@openDingtalkId> 占位符，这是钉钉的硬要求，插件已自动处理；若 @ 发送失败，会自动去掉 @ 重发一次，保证文案一定送达。'),
            h('li', null, '插件用轮询而不是事件推送，是因为钉钉会把「你自己发的消息」从事件流里过滤掉，长连接收不到。'),
            h('li', null, `设置文件：${status.settingsPath ?? '（未知）'}（面板上所有改动都立即写盘并生效，无需重启）`),
          ),
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
