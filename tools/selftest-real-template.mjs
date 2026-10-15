// 端到端验证：用**设置文件里真实的**多行文案走一次发送链路（dry-run，不发送）。
//
// 这一步是为了证明"换行被拒"的 bug 真的修好了：
// 之前的实现会在这里报 BAD_ARG，现在应该能完整到达 dws 的发送计划。
//
// 安全：只加 --dry-run，不会往任何群发消息。
// 运行：node tools/selftest-real-template.mjs

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createSender, mentionPlaceholder } from '../lib/send.js';
import { resolveDwsExecutable } from '../lib/dws.js';
import { TEST_GROUP, TEST_OID, requireFixtures } from './fixtures.mjs';

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const realSettingsPath = join(home, 'presale', 'settings.json');
const real = JSON.parse(readFileSync(realSettingsPath, 'utf8'));

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-realtpl-'));
const logger = { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: () => {} };

const settings = createSettings({
  settingsPath: join(dir, 'settings.json'),
  config: {
    settingsPath: join(dir, 'settings.json'),
    activityPath: join(dir, 'a.ndjson'),
    watermarkPath: join(dir, 'w.json'),
  },
  logger,
});
const sender = createSender({ getSettings: () => settings.get(), logger });

const GROUP = TEST_GROUP; // 测试群由环境变量提供（见 tools/fixtures.mjs）
const OID = TEST_OID;

try {
  const ready = requireFixtures(['DSH_PRESALE_TEST_GROUP', 'DSH_PRESALE_TEST_OID']);
  if (!ready) {
    console.log('==== 用真实配置文案走发送链路的检查已跳过 ====');
    process.exitCode = 0;
  } else {
  console.log('== 环境 ==');
  const resolved = resolveDwsExecutable('dws');
  console.log(`  dws 可执行文件：${resolved.path}`);
  console.log(`  可直接执行（绕开 shell）：${resolved.direct}`);

  const template = real.triggers?.provide?.template ?? '';
  console.log(`\n== 真实文案 ==`);
  console.log(`  长度：${template.length} 字符，${template.split('\n').length} 行`);

  console.log('\n== 无 @ 的发送（dry-run）==');
  const plain = await sender.send({ conversationId: GROUP, text: template, preview: true });
  check('多行真实文案能通过并到达 dws', plain.ok, plain.ok ? '' : plain.error);
  if (plain.ok) {
    const plan = plain.raw;
    check('dws 确认这是 dry-run（没真发）', plan?.dry_run === true, `dry_run=${String(plan?.dry_run)}`);
    const content = plan?.actions?.[0]?.arguments?.content ?? '';
    let inner = content;
    if (typeof content === 'string' && content.startsWith('{')) {
      try { inner = JSON.parse(content)?.content ?? content; } catch { /* 原样 */ }
    }
    check('正文在 dws 侧完整还原（换行没丢）', inner === template,
      inner === template ? `${inner.split('\n').length} 行完整` : `期望 ${template.length} 字，实际 ${String(inner).length} 字`);
    // 刻意不断言具体文字：文案是用户自己编辑的，写死首末句会让测试在他们改文案后
    // 假报警（已踩到过）。真正要保证的是"逐字节完整还原"，上面那条已经覆盖；
    // 这里只额外确认首末行非空，能发现"开头/结尾被吃掉"这类截断。
    const lines = String(inner).split('\n');
    check('首行非空', lines[0].trim().length > 0, JSON.stringify(lines[0].slice(0, 30)));
    check('末行非空', lines[lines.length - 1].trim().length > 0, JSON.stringify(lines[lines.length - 1].slice(0, 30)));
  }

  console.log('\n== 带 @ 的发送（dry-run）==');
  const text = `${mentionPlaceholder(OID)} ${template}`;
  const withAt = await sender.send({ conversationId: GROUP, text, mentionIds: [OID], preview: true });
  check('多行 + @ 能通过', withAt.ok, withAt.ok ? '' : withAt.error);
  if (withAt.ok) {
    const plan = withAt.raw;
    const args0 = plan?.actions?.[0]?.arguments;
    check('@ 目标已传递', Array.isArray(args0?.atOpenDingTalkIds) && args0.atOpenDingtalkIds?.includes?.(OID)
      || (args0?.atOpenDingTalkIds?.[0] === OID), JSON.stringify(args0?.atOpenDingtalkIds));
    const content = args0?.content ?? '';
    let inner = content;
    if (typeof content === 'string' && content.startsWith('{')) {
      try { inner = JSON.parse(content)?.content ?? content; } catch { /* 原样 */ }
    }
    check('占位符与多行同时保留', String(inner).includes(mentionPlaceholder(OID)) && String(inner).includes('\n'),
      `${String(inner).split('\n').length} 行`);
  }

  console.log('\n== 本地校验仍然拦得住真正的畸形输入 ==');
  const empty = await sender.send({ conversationId: GROUP, text: '   ', preview: true });
  check('空正文被拒', empty.ok === false, empty.error.slice(0, 40));
  const missingPlaceholder = await sender.send({ conversationId: GROUP, text: '没有占位符', mentionIds: [OID], preview: true });
  check('要 @ 但无占位符被拒', missingPlaceholder.ok === false, missingPlaceholder.error.slice(0, 50));
  }
} catch (error) {
  failures += 1;
  console.log(`\n✖ 抛出异常：${error.stack ?? error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${failures === 0 ? '真实文案端到端验证通过' : `验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
