// 装配自检：用 mock ctx 跑一遍 apply()，把「只有真加载才会暴露」的问题提前抓出来。
//
// 为什么需要它：DSH 的插件装载失败往往表现很安静（那行配置不生效、面板不出现），
// 排查成本远高于在这里先跑一遍。本脚本不发送任何消息、不修改任何群。
//
// 运行：node tools/selftest-assembly.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-self-'));
const logs = [];
const logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: (...a) => logs.push(['error', a.join(' ')]),
  debug: () => {},
};

/** 收集所有注册项，便于断言。 */
const registered = { tools: [], effects: [], webHandler: null, webPath: '' };

const ctx = {
  logger,
  effect(factory, label) {
    const result = typeof factory === 'function' ? factory() : undefined;
    registered.effects.push({ label, result });
    return () => {};
  },
  on() {},
  get(name) {
    if (name === 'webServer') {
      return {
        register({ kind, path, handler }) {
          registered.webHandler = handler;
          registered.webPath = `${kind}:${path}`;
          return () => {};
        },
      };
    }
    if (name === 'llm') {
      // 模拟一个可用的 LLM 服务：只验证装配路径，不真的推理
      return {
        listProviders: () => [{ id: 'fake-provider', model: 'fake-model' }],
        stream: async function* stream() {
          yield { type: 'text', text: 'ok' };
        },
      };
    }
    return undefined;
  },
  tools: {
    register(tool) {
      registered.tools.push(tool);
      return () => {};
    },
  },
};

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

try {
  const mod = await import('../lib/index.js');
  console.log('== 模块导出 ==');
  check('导出 name', mod.name === 'dsh-presale', String(mod.name));
  check('导出 apply 函数', typeof mod.apply === 'function');
  check('inject 包含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject));

  console.log('\n== 运行 apply()（用临时设置路径，不碰真实配置）==');
  mod.apply(ctx, {
    settingsPath: join(dir, 'settings.json'),
    activityPath: join(dir, 'activity.ndjson'),
    watermarkPath: join(dir, 'watermark.json'),
    enabled: false,
    dryRun: true,
  });

  console.log('\n== 装配结果断言 ==');
  check('注册了 4 个工具', registered.tools.length === 4, `实际 ${registered.tools.length}`);
  const names = registered.tools.map(t => t.name).sort();
  const expectedNames = ['presale_llm_selftest', 'presale_recent_mine', 'presale_send_text', 'presale_status'];
  check('工具名符合预期', JSON.stringify(names) === JSON.stringify(expectedNames), JSON.stringify(names));

  for (const tool of registered.tools) {
    check(`工具 ${tool.name} 有 description`, typeof tool.description === 'string' && tool.description.length > 20);
    check(`工具 ${tool.name} 有 parameters`, typeof tool.parameters === 'object' && tool.parameters !== null);
    check(`工具 ${tool.name} 有 execute`, typeof tool.execute === 'function');
  }

  check('注册了 web api', registered.webHandler !== null && registered.webPath === 'prefix:/presale-api', registered.webPath);
  check('注册了若干 effect', registered.effects.length >= 2, `实际 ${registered.effects.length}`);

  console.log('\n== 接口冒烟（只读接口）==');
  if (registered.webHandler !== null) {
    const call = (method, url) => new Promise(resolve => {
      const chunks = [];
      const res = {
        writeHead(status) { this.status = status; },
        end(body) { resolve({ status: this.status, body: body === undefined ? '' : String(body) }); },
      };
      const req = {
        method,
        url,
        headers: { host: '127.0.0.1:19387' },
        on(event, cb) {
          if (event !== 'data' && event !== 'end') return;
          chunks.push(cb);
          if (event === 'end') for (const c of chunks) c();
        },
      };
      void registered.webHandler(req, res);
    });

    const status = await call('GET', '/presale-api/status');
    check('GET /status 返回 200', status.status === 200, `实际 ${status.status}`);
    const parsed = JSON.parse(status.body);
    check('status 含 poller 字段', typeof parsed.poller === 'object' && parsed.poller !== null);
    check('status 含 identity 字段', typeof parsed.identity === 'object' && parsed.identity !== null);
    check('status 含 llm.available', typeof parsed.llm?.available === 'boolean');

    const settings = await call('GET', '/presale-api/settings');
    check('GET /settings 返回 200', settings.status === 200, `实际 ${settings.status}`);
    const parsedSettings = JSON.parse(settings.body);
    check('settings 含两个动作的关键词', Array.isArray(parsedSettings.settings?.triggers?.provide?.keywords));

    const unknown = await call('GET', '/presale-api/不存在');
    check('未知路由返回 404', unknown.status === 404, `实际 ${unknown.status}`);

    const badHost = await new Promise(resolve => {
      const res = {
        writeHead(s) { this.status = s; },
        end() { resolve(this.status); },
      };
      const req = { method: 'GET', url: '/presale-api/status', headers: { host: 'evil.example.com' }, on() {} };
      void registered.webHandler(req, res);
    });
    check('非回环 Host 被拒（挡 DNS rebinding）', badHost === 403, `实际 ${badHost}`);
  }

  console.log('\n== 工具只读冒烟 ==');
  const statusTool = registered.tools.find(t => t.name === 'presale_status');
  if (statusTool !== undefined) {
    const text = await statusTool.execute({ activityLimit: 3 });
    check('presale_status 输出可用文本', typeof text === 'string' && text.includes('dsh-presale 状态'), text.slice(0, 60));
    check('presale_status 显示了 dryRun 状态', text.includes('试运行'));
  }

  const sendTool = registered.tools.find(t => t.name === 'presale_send_text');
  if (sendTool !== undefined) {
    const refused = await sendTool.execute({ conversationId: 'cidX', text: 'hi', confirm: false });
    check('未确认时拒绝发送', typeof refused === 'string' && refused.includes('拒绝'), refused.slice(0, 60));
    const badId = await sendTool.execute({ conversationId: '示例工作群', text: 'hi', confirm: true });
    check('群里名而非 cid 时拒绝发送', typeof badId === 'string' && badId.includes('拒绝'), badId.slice(0, 60));
  }

  console.log('\n== 日志（应无 error）==');
  for (const [level, line] of logs) console.log(`  [${level}] ${line}`);
  check('没有 error 级日志', !logs.some(([level]) => level === 'error'), logs.filter(([l]) => l === 'error').map(l => l[1]).join(' | '));
} catch (error) {
  failures += 1;
  console.log(`\n✖ 装配过程抛出异常：${error.stack ?? error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${failures === 0 ? '装配自检全部通过' : `装配自检失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
