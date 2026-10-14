// 宿主 HTTP API：挂在 DSH 自己的 Web 服务下（同源、仅回环可访问）。
//
// 它是设置面板的唯一后端。之所以走同源 HTTP 而不是客户端 RPC：
//   DSH 的客户端插件没有通用 RPC 通道（dsh-local-kb 也是这么做的），
//   同源 fetch 最简单，也不需要在 HTML 里注入任何东西。
//
// 安全边界：
//   · 只监听回环（DSH 本身如此），另外再校验 Host 头挡 DNS rebinding；
//   · 只允许 GET / POST；
//   · 请求体大小上限；
//   · 本接口不会泄露任何凭据（dws 的 token 我们从不读取）。

import { mentionPlaceholder } from './send.js';

const MAX_BODY = 512 * 1024;

/** 只接受回环 Host：挡 DNS rebinding（恶意网页把域名解析到 127.0.0.1 后打本接口）。 */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]|\[::ffff:127\.0\.0\.1\])(?::\d+)?$/iu;

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 注册面板 API。
 *
 * @param {object} webServer - DSH 的 webServer 服务。
 * @param {object} deps - 插件各层句柄。
 * @param {{webPath?: string, logger?: object}} options - 选项。
 * @returns {() => void} 注销函数（由 ctx.effect 持有）。
 */
export function registerWebApi(webServer, deps, { webPath = '/presale-api', logger = console } = {}) {
  const base = webPath.endsWith('/') ? webPath.slice(0, -1) : webPath;
  const { settings, activity, poller, identity, llm, conversationData, handlers, discoverer } = deps;

  const handler = async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' });
      res.end();
      return;
    }
    if (!LOOPBACK_HOST.test(String(req.headers?.host ?? ''))) {
      json(res, 403, { error: '只允许本机回环访问' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.slice(base.length).replace(/\/+$/u, '') || '/';

    try {
      // ── 状态 ────────────────────────────────────────────────
      if (method === 'GET' && route === '/status') {
        const id = identity.status();
        json(res, 200, {
          poller: poller.status(),
          identity: {
            state: id.state,
            myName: id.myName,
            myOid: id.myOid,
            myUserId: id.myUserId,
            myCorp: id.myCorp,
            message: id.message,
            evidence: id.evidence,
          },
          llm: {
            available: llm.available(),
            route: llm.describe(),
          },
          settingsPath: settings.path,
          settingsWarnings: settings.warnings(),
          rosterCacheSize: typeof conversationData.rosterCacheSize === 'function' ? conversationData.rosterCacheSize() : 0,
        });
        return;
      }

      // ── 设置读写 ────────────────────────────────────────────
      if (route === '/settings') {
        if (method === 'GET') {
          json(res, 200, { settings: settings.get(), warnings: settings.warnings(), path: settings.path });
          return;
        }
        const body = await readBody(req);
        // strict：面板保存时做真校验（空模板直接拒），把错误显示给用户
        const next = settings.update(body.patch ?? body, { strict: body.strict === true });
        json(res, 200, { settings: next, warnings: settings.warnings() });
        return;
      }

      if (method === 'POST' && route === '/settings/reset') {
        const body = await readBody(req);
        const next = settings.reset(Array.isArray(body.keys) ? body.keys : undefined);
        json(res, 200, { settings: next, warnings: settings.warnings() });
        return;
      }

      // ── 活动日志 ────────────────────────────────────────────
      if (method === 'GET' && route === '/activity') {
        const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
        json(res, 200, { entries: activity.recent(limit), path: activity.path });
        return;
      }
      if (method === 'POST' && route === '/activity/clear') {
        activity.clear();
        json(res, 200, { cleared: true });
        return;
      }

      // ── 轮询控制 ────────────────────────────────────────────
      if (method === 'POST' && route === '/start') {
        settings.update({ enabled: true });
        const started = poller.start();
        json(res, 200, { started, poller: poller.status() });
        return;
      }
      if (method === 'POST' && route === '/stop') {
        const stopped = poller.stop();
        settings.update({ enabled: false });
        json(res, 200, { stopped, poller: poller.status() });
        return;
      }
      if (method === 'POST' && route === '/restart') {
        poller.stop();
        settings.update({ enabled: true });
        poller.start();
        json(res, 200, { poller: poller.status() });
        return;
      }
      if (method === 'POST' && route === '/check-now') {
        const status = await poller.tickNow();
        json(res, 200, { poller: status });
        return;
      }
      if (method === 'POST' && route === '/seed-now') {
        json(res, 200, { watermark: poller.seedNow() });
        return;
      }

      // ── 身份重锚 ────────────────────────────────────────────
      if (method === 'POST' && route === '/reidentify') {
        identity.invalidate();
        const id = await identity.resolve({ force: true });
        json(res, 200, { identity: id });
        return;
      }

      // ── 试跑（dry-run 组装，不发送）──────────────────────────
      //
      // 面板上「立即试跑」用这个：用真实会话数据走完整链路，
      // 但只返回组装结果与 @ 判定理由，绝不发消息。
      if (method === 'POST' && route === '/test') {
        const body = await readBody(req);
        const kind = body.kind === 'summarize' ? 'summarize' : 'provide';
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        if (conversationId.length === 0) {
          json(res, 400, { error: '需要指定 conversationId（会话 ID）' });
          return;
        }

        const id = identity.status();
        if (typeof id.myOid !== 'string' || id.myOid.length === 0) {
          json(res, 409, { error: '身份尚未锚定，无法试跑；请先点「重新识别身份」' });
          return;
        }

        const conversationName = discoverer.cachedName(conversationId) || '(未命名会话)';
        const simulated = {
          messageId: 'test-message',
          conversationId,
          createTime: new Date().toLocaleString('zh-CN'),
          createTimeMs: Date.now(),
          sender: typeof body.senderName === 'string' && body.senderName.length > 0 ? body.senderName : id.myName,
          senderId: id.myOid,
          text: typeof body.text === 'string' && body.text.length > 0 ? body.text : `（试跑：${kind === 'summarize' ? '梳理项目需求' : '提供完整项目需求'}）`,
          textNorm: '',
          aiSendFlag: '',
          quoted: null,
        };

        if (kind === 'provide') {
          // 复用真实逻辑但只组装、不发送：把 sender 换成预览版
          const result = await handlers.previewProvide(simulated, conversationName);
          json(res, 200, { kind, conversationId, conversationName, ...result });
          return;
        }

        const result = await handlers.previewSummarize(simulated, conversationName);
        json(res, 200, { kind, conversationId, conversationName, ...result });
        return;
      }

      json(res, 404, { error: `未知接口 ${method} ${route}` });
    } catch (error) {
      logger.warn?.(`dsh-presale: 接口 ${method} ${route} 失败：${error instanceof Error ? error.message : String(error)}`);
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  return webServer.register({ kind: 'prefix', path: base, handler });
}

/** 供面板显示 @ 占位符用法（避免前端硬编码这个契约）。 */
export { mentionPlaceholder };
