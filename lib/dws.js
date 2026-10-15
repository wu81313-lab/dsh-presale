// dws（DingTalk Workspace CLI）调用封装。
//
// 三条必须守住的底线：
//   1. **绝不在日志里输出凭据**。dws 的 token 在 ~/.dws 里，我们只调命令、不碰文件。
//   2. **参数必须完整无损地到达 dws**。这一点踩过大坑，见下面的说明。
//   3. **超时必须有上限**。dws 会挂（网络抖动、配额限流），不能让它把插件拖死。
//
// ── 关于「怎么调 dws」的完整来龙去脉（别回退）────────────────────────
//
// dws 的安装结构是三层：
//   npm shim（dws.cmd） → node bin/dws.js → vendor/dws.exe（Go 二进制）
//
// 最初走 `spawn('dws', args, {shell:true})`，即经 cmd.exe 执行 .cmd shim。
// 结果是**多行文案发不出去**：
//   · 真实换行被 cmd.exe 吃掉（实测正文从 "AAA\nBBB\nCCC" 变成 "AAA"）；
//   · 退而求其次传字面 `\n`，dws 会原样保留，钉钉里显示成反斜杠 n，同样不能用。
// 为了防注入，当时的做法是「参数白名单 + 自己拼命令行 + 加双引号」，
// 而白名单顺带拒绝了换行——于是插件对你的多行文案永远发不出去。
//
// 正解是**绕开 shell**：直接执行 vendor/dws.exe，参数以数组形式交给 Node。
// 这样命令行不经 cmd.exe，换行/引号/反引号/百分号/管道符/尖括号全部原样到达
// （已用 dry-run 实测：多行正文完整还原，<@oid> 占位符也正确生效）。
// 数组传参也顺带解决了注入问题——不存在「拼字符串」这一步，所以不需要白名单。
//
// 因此：**不要改回 shell:true，也不要把参数拼成字符串。**

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 参数校验。
 *
 * 参数现在以数组直接交给子进程（不经 shell），所以 shell 元字符**不再有特殊含义**，
 * 正常的正文可以包含换行、引号、反引号、百分号、管道符、尖括号。
 * 只拒绝两类真正会破坏调用或无法表示的内容：
 *   · NUL：Windows 命令行根本无法传递；
 *   · 不成对的代理项（lone surrogate）：UTF-8 编码会失败。
 *
 * 注意这里**不再**是安全边界——安全边界是「不用 shell + 数组传参」这个事实。
 *
 * @param {unknown} value - 待校验的参数。
 * @returns {string} 字符串形式。
 * @throws {Error} 含 NUL 或非法字符时抛出。
 */
export function assertSafeArg(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new Error(`dws: 参数必须是字符串或数字，收到 ${typeof value}`);
  if (value.includes('\u0000')) {
    throw new Error('dws: 参数含 NUL 字符，无法传递给子进程');
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error('dws: 参数含不成对的代理项字符，无法编码');
  }
  return value;
}

/** dws 用这些中文提示告诉我们「该重新登录了」。 */
const AUTH_HINTS = ['未登录', '登录已过期', 'token', 'unauthorized', 'invalid_grant', '认证', '授权'];

/**
 * 定位 dws 可执行文件，优先返回**可绕过 shell 直接执行**的那个。
 *
 * 优先级：
 *   ① 显式配置的路径（用户自己指定的一律尊重）；
 *   ② PATH 里的 `dws.exe`（若存在，直接就是二进制）；
 *   ③ npm 全局装的 `…/dingtalk-workspace-cli/vendor/dws.exe`（本机实测路径）；
 *   ④ 退回 `dws`（会经 .cmd shim，多行正文会坏——放在最后只为不至于完全不可用）。
 *
 * @param {string} configured - 配置里的 dwsPath。
 * @returns {{path: string, direct: boolean, note: string}} 选择结果。
 */
export function resolveDwsExecutable(configured = 'dws') {
  const custom = typeof configured === 'string' ? configured.trim() : '';
  if (custom.length > 0 && custom !== 'dws') {
    // 用户显式指定的路径：尊重，但提示 .cmd 的换行限制
    const isCmd = /\.cmd$/iu.test(custom);
    return {
      path: custom,
      direct: !isCmd,
      note: isCmd ? '（显式配置了 .cmd，多行文案可能被 shell 吃掉）' : '',
    };
  }

  const candidates = [];
  const appData = process.env.APPDATA ?? '';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  if (appData.length > 0) {
    candidates.push(join(appData, 'npm', 'node_modules', 'dingtalk-workspace-cli', 'vendor', 'dws.exe'));
  }
  if (localAppData.length > 0) {
    candidates.push(join(localAppData, 'npm', 'node_modules', 'dingtalk-workspace-cli', 'vendor', 'dws.exe'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, direct: true, note: '' };
  }

  return {
    path: 'dws',
    direct: false,
    note: '未找到 dws.exe，回退到 dws 命令（经 npm shim）；多行文案可能无法完整传递',
  };
}

/**
 * 调用一次 dws 并收集输出。
 *
 * @param {object} options
 * @param {string} options.dwsPath - dws 可执行文件（'dws' 或绝对路径）。
 * @param {string[]} options.args - 参数数组（会被逐个校验）。
 * @param {number} [options.timeoutMs] - 超时毫秒，默认 60 秒。
 * @param {number} [options.maxOutputBytes] - stdout 上限，默认 8MB（超出即中止，防跑飞）。
 * @param {string} [options.cwd] - 工作目录。**下载命令必须显式指定**：
 *   dws 的 --output 只接受工作目录内的相对路径，因此「文件落到哪」完全由 cwd 决定。
 *   不传就会落在 DSH 进程的当前目录（启动方式不同则位置不同，不可控）。
 * @param {{warn?: Function, info?: Function}} [options.logger] - 日志。
 * @returns {Promise<{ok: true, data: unknown, stdout: string, stderr: string, ms: number}
 *   | {ok: false, code: string, message: string, stdout: string, stderr: string, ms: number}>}
 */
export async function runDws({ dwsPath = 'dws', args = [], timeoutMs = 60000, maxOutputBytes = 8 * 1024 * 1024, cwd, logger = console } = {}) {
  const started = Date.now();
  const safeArgs = [];

  if (typeof dwsPath !== 'string' || dwsPath.trim().length === 0) {
    return { ok: false, code: 'BAD_DWS_PATH', message: 'dws 路径为空', stdout: '', stderr: '', ms: 0 };
  }
  // 定位可执行文件（优先能绕开 shell 直接执行的 dws.exe）
  const resolved = resolveDwsExecutable(dwsPath);
  const bin = resolved.path;
  if (resolved.note.length > 0) logger.warn?.(`dsh-presale: ${resolved.note}`);

  try {
    for (const arg of args) safeArgs.push(assertSafeArg(arg));
  } catch (error) {
    return {
      ok: false,
      code: 'BAD_ARG',
      message: error instanceof Error ? error.message : String(error),
      stdout: '',
      stderr: '',
      ms: Date.now() - started,
    };
  }

  return await new Promise(resolve => {
    let child;
    try {
      // 参数以**数组**直接交给子进程，不经 shell：
      //   · 换行、引号、反引号、百分号、管道符、尖括号全部原样到达（已实测）；
      //   · 不存在「拼命令行」这一步，因此没有注入面。
      // direct 为 true 时是 .exe，shell 必须是 false；
      // 回退到 `dws`（npm shim 的 .cmd）时才需要 shell，但那条路会吃掉换行。
      child = spawn(bin, safeArgs, {
        shell: resolved.direct !== true,
        windowsHide: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // cwd 只在显式传入时设置（下载命令用它决定落点）
        ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
      });
    } catch (error) {
      resolve({
        ok: false,
        code: 'SPAWN_FAILED',
        message: error instanceof Error ? error.message : String(error),
        stdout: '',
        stderr: '',
        ms: Date.now() - started,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let oversized = false;

    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      // 超时：先温和终止，再放手（不等待它的清理逻辑，避免拖住插件）
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已经退出 */
      }
      finish({
        ok: false,
        code: 'TIMEOUT',
        message: `dws 调用超时（${timeoutMs}ms）：${safeArgs.slice(0, 3).join(' ')}`,
        stdout,
        stderr,
        ms: Date.now() - started,
      });
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > maxOutputBytes) {
        oversized = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString('utf8');
      // stderr 只保留尾部，避免 dws 的版本检查/告警把内存撑爆
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });

    child.on('error', error => {
      finish({
        ok: false,
        code: 'SPAWN_FAILED',
        message: error instanceof Error ? error.message : String(error),
        stdout,
        stderr,
        ms: Date.now() - started,
      });
    });

    child.on('close', code => {
      const ms = Date.now() - started;
      if (oversized) {
        finish({ ok: false, code: 'OUTPUT_TOO_LARGE', message: 'dws 输出超过上限，已中止', stdout, stderr, ms });
        return;
      }
      const trimmed = stdout.trim();
      const combined = `${stderr}\n${trimmed}`;

      // 认证问题优先识别：它决定插件要「暂停并提示」而不是「机械重试」
      const authIssue = AUTH_HINTS.some(hint => combined.toLowerCase().includes(hint.toLowerCase()));

      if (trimmed.length === 0) {
        finish({
          ok: false,
          code: authIssue ? 'AUTH' : code === 0 ? 'EMPTY_OUTPUT' : 'EXIT_NONZERO',
          message: authIssue
            ? 'dws 未登录或登录已过期，需要重新执行 dws auth login'
            : `dws 无输出（退出码 ${code}）：${stderr.trim().slice(0, 300) || '无 stderr'}`,
          stdout,
          stderr,
          ms,
        });
        return;
      }

      // dws 的错误体是 stderr 上的 JSON：{"error":{"category":"validation","code":3,"message":"…"}}
      const errMatch = /\{[\s\S]*"error"[\s\S]*\}/u.exec(stderr);
      if (code !== 0 && errMatch !== null) {
        try {
          const parsed = JSON.parse(errMatch[0]);
          const err = parsed?.error ?? {};
          const category = typeof err.category === 'string' ? err.category : '';
          const msg = typeof err.message === 'string' ? err.message : '';
          const rate = category === 'rate_limit' || /限流|过于频繁|quota|too many/i.test(`${category}${msg}`);
          finish({
            ok: false,
            code: authIssue ? 'AUTH' : rate ? 'RATE_LIMIT' : (category || 'EXIT_NONZERO').toUpperCase(),
            message: msg.length > 0 ? `${msg}（${category}）` : `dws 退出码 ${code}`,
            stdout,
            stderr,
            ms,
          });
          return;
        } catch {
          /* 不是合法 JSON，走下面的通用分支 */
        }
      }

      if (code !== 0 && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        finish({
          ok: false,
          code: authIssue ? 'AUTH' : 'EXIT_NONZERO',
          message: `dws 退出码 ${code}：${stderr.trim().slice(0, 300) || trimmed.slice(0, 300)}`,
          stdout,
          stderr,
          ms,
        });
        return;
      }

      // 走到这里认为命令本身成功，尝试解析 JSON
      try {
        const data = JSON.parse(trimmed);
        finish({ ok: true, data, stdout, stderr, ms });
      } catch {
        finish({
          ok: false,
          code: 'BAD_JSON',
          message: 'dws 输出不是合法 JSON',
          stdout,
          stderr,
          ms,
        });
      }
    });
  });
}

/**
 * 调用 dws 并返回 JSON 结果，失败时抛出带 code 的错误。
 *
 * @param {object} options - 同 {@link runDws}。
 * @returns {Promise<unknown>} 解析后的 JSON。
 * @throws {Error & {dwsCode?: string}} 失败时抛出。
 */
export async function runDwsJson(options) {
  const result = await runDws(options);
  if (result.ok) return result.data;
  const error = new Error(result.message);
  error.dwsCode = result.code;
  throw error;
}

/**
 * 判断 dws 是否已登录且可用。
 *
 * @param {{dwsPath?: string, logger?: object, timeoutMs?: number}} options - 配置。
 * @returns {Promise<{authenticated: boolean, userName: string, userId: string, corpName: string, message: string}>}
 */
export async function checkAuth({ dwsPath = 'dws', logger = console, timeoutMs = 30000 } = {}) {
  const result = await runDws({ dwsPath, args: ['auth', 'status', '-f', 'json'], timeoutMs, logger });
  if (!result.ok) {
    return { authenticated: false, userName: '', userId: '', corpName: '', message: result.message };
  }
  const data = result.data;
  const authenticated = data?.authenticated === true && data?.token_valid !== false;
  return {
    authenticated,
    userName: typeof data?.user_name === 'string' ? data.user_name : '',
    userId: typeof data?.user_id === 'string' ? data.user_id : '',
    corpName: typeof data?.corp_name === 'string' ? data.corp_name : '',
    message: authenticated ? '' : 'dws 未登录或 token 无效',
  };
}
