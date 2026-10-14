// 验证 <@id> 占位符与多行正文能否完整到达 dws。
//
// 历史背景（这段踩坑史值得留着）：
//   早期实现经 shell 执行 dws（npm 的 .cmd shim + shell:true），并自己拼命令行。
//   结果是**多行文案发不出去**——真实换行被 cmd.exe 吃掉，正文被截断。
//   现在改为直接执行 vendor/dws.exe、参数用数组传递，问题消失。
//   这条自检就是防止有人改回老路。
//
// 安全：全程只加 --dry-run，不会真的发消息到群里。
// 需要夹具：见 tools/fixtures.mjs（真实群 ID 与成员 ID 不入库）。
//
// 运行：node tools/selftest-send-quoting.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createSender, mentionPlaceholder, validateSend } from '../lib/send.js';
import { TEST_GROUP, TEST_OID, requireFixtures } from './fixtures.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-send-'));
const logger = { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: () => {} };

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

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

try {
  // 纯函数部分不需要夹具，先跑掉
  console.log('== 本地校验（纯函数，不需要夹具）==');
  check('空正文被拒', validateSend({ conversationId: 'cidX', text: '  ' }).ok === false);
  check('缺会话被拒', validateSend({ conversationId: '', text: 'x' }).ok === false);
  check('@ 缺占位符被拒', validateSend({ conversationId: 'cidX', text: 'x', mentionIds: [TEST_OID || 'PLACEHOLDER'] }).ok === false);

  const ready = requireFixtures(['DSH_PRESALE_TEST_GROUP', 'DSH_PRESALE_TEST_OID']);
  if (!ready) {
    console.log(`\n==== 本地校验通过；真实发送检查已跳过 ====`);
    process.exitCode = failures === 0 ? 0 : 1;
  } else {
    console.log('\n== 带 @ 的 dry-run（验证 <@id> 与多行到达 dws）==');
    const multiline = '第一行：为了评估这个项目，麻烦补充以下信息\n第二行：产线数量与节拍\n第三行：CAD 布局图';
    const text = `${mentionPlaceholder(TEST_OID)}\n${multiline}`;
    const preview = await sender.send({
      conversationId: TEST_GROUP,
      text,
      mentionIds: [TEST_OID],
      preview: true,
    });

    check('sender.send(preview) 调用成功', preview.ok, preview.ok ? '' : preview.error);
    if (preview.ok) {
      const plan = preview.raw;
      check('dws 报告这是 dry-run（没有真发）', plan?.dry_run === true && plan?.executed === false,
        `dry_run=${String(plan?.dry_run)} executed=${String(plan?.executed)}`);

      const actions = Array.isArray(plan?.actions) ? plan.actions : [];
      const args0 = actions[0]?.arguments;
      // ⚠️ 键名大小写：atOpenDingTalkIds（大写 T）。写错只会得到 undefined，不报错。
      check('@ 目标已进入 dws 计划', Array.isArray(args0?.atOpenDingTalkIds) && args0.atOpenDingTalkIds.includes(TEST_OID),
        JSON.stringify(args0?.atOpenDingTalkIds ?? null));

      const content = args0?.content ?? '';
      let inner = content;
      if (typeof content === 'string' && content.startsWith('{')) {
        try { inner = JSON.parse(content)?.content ?? content; } catch { /* 原样 */ }
      }
      check('多行正文完整还原（没被 shell 吃掉）', inner === text,
        inner === text ? `${String(inner).split('\n').length} 行完整` : `期望 ${text.length} 字、实际 ${String(inner).length} 字`);
    }

    console.log('\n== 不带 @ 的 dry-run（对照组）==');
    const plain = await sender.send({ conversationId: TEST_GROUP, text: '普通联调消息', preview: true });
    check('不带 @ 也能成功', plain.ok, plain.ok ? '' : plain.error);

    console.log('\n== 安全防护仍然生效 ==');
    const evil = await sender.send({
      conversationId: TEST_GROUP, text: 'hi', mentionIds: ['x" & calc.exe & "y'], preview: true,
    });
    check('含引号与 & 的异常 ID 被拒绝', evil.ok === false, evil.ok ? '竟然通过了！' : evil.error.slice(0, 60));
  }
} catch (error) {
  failures += 1;
  console.log(`\n✖ 过程抛出异常：${error.stack ?? error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${failures === 0 ? '验证通过' : `验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
