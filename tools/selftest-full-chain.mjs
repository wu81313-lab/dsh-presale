// 端到端验证：在真实项目群里走完整链路（dry-run，不发送）。
//
// 覆盖：读群成员 → 读历史 → 组装 <@oid> 正文 → dws 发送前预检。
// 这是「@ 到底能不能真发出去」的最后一道验证。
//
// 注意：LLM 判别跑不了——LLM 服务在 DSH 进程内，外部脚本拿不到。
// 所以这里只验证「发送编排」这一半；LLM 那一半用 presale_llm_selftest 工具验。
//
// 安全：只加 --dry-run，不会往任何群发消息。
// 运行：node tools/selftest-full-chain.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { TEST_GROUP, TEST_GROUP2, TEST_OID, TEST_NAME } from './fixtures.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createIdentity } from '../lib/identity.js';
import { createConversationData, renderHistoryForModel } from '../lib/conversation-data.js';
import { createSender, mentionPlaceholder } from '../lib/send.js';

// 真实项目群（讨论里能看到明确的销售负责人）
const GROUP = TEST_GROUP2;
const TARGET_NAME = TEST_NAME;

const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-full-'));
const logger = { info: () => {}, warn: (...a) => console.log('    [warn]', ...a), error: () => {} };

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
const identity = createIdentity({ getSettings: () => settings.get(), logger });
const conversationData = createConversationData({ getSettings: () => settings.get(), logger });
const sender = createSender({ getSettings: () => settings.get(), logger });

try {
  console.log('== 1. 身份锚定 ==');
  const id = await identity.resolve();
  check('身份已锚定', id.state !== 'unresolvable', `${id.myName} / ${id.myOid}`);
  if (id.myOid.length === 0) throw new Error('身份未锚定，后续步骤无意义');

  console.log('\n== 2. 读群成员表 ==');
  const roster = await conversationData.roster(GROUP);
  check('成员表可读', roster.ok && roster.members.length > 0, `${roster.members.length} 人`);
  const withOid = roster.members.filter(m => m.openDingtalkId.length > 0);
  check('成员带 openDingtalkId（@ 的前提）', withOid.length === roster.members.length,
    `${withOid.length}/${roster.members.length}`);

  console.log('\n== 3. 读会话历史 ==');
  const history = await conversationData.history({ conversationId: GROUP, count: 60 });
  check('历史可读', history.ok && history.messages.length > 0, `${history.messages.length} 条`);
  check('历史完整性已上报', typeof history.complete === 'boolean');
  const rendered = renderHistoryForModel(history.messages, identity.status(), 24000);
  check('历史可渲染为模型输入', rendered.text.length > 0, `${rendered.text.length} 字，丢弃 ${rendered.dropped} 条`);
  const bigHistory = await conversationData.history({ conversationId: GROUP, count: 200 });
  check('大窗口历史可读（动作二默认 200 条）', bigHistory.ok, `${bigHistory.messages.length} 条`);

  console.log('\n== 4. 组装带 @ 的正文 ==');
  const target = withOid.find(m => m.name === TARGET_NAME) ?? withOid[0];
  check('找到可 @ 的真实成员', target !== undefined, target?.name);
  const template = settings.get().triggers.provide.template;
  const text = `${mentionPlaceholder(target.openDingtalkId)}\n${template}`;
  check('正文含 @ 占位符', text.includes(mentionPlaceholder(target.openDingtalkId)));
  check('正文含多行', text.includes('\n'), `${text.split('\n').length} 行`);

  console.log('\n== 5. 发送前预检（dws --dry-run，不发送） ==');
  const preview = await sender.send({
    conversationId: GROUP,
    text,
    mentionIds: [target.openDingtalkId],
    preview: true,
  });
  check('dws 接受这条带 @ 的多行消息', preview.ok, preview.ok ? '' : preview.error);
  if (preview.ok) {
    const plan = preview.raw;
    check('确认是 dry-run（没真发）', plan?.dry_run === true && plan?.executed === false,
      `dry_run=${String(plan?.dry_run)} executed=${String(plan?.executed)}`);

    const args0 = plan?.actions?.[0]?.arguments;
    // ⚠️ 键名大小写很重要：是 atOpenDingTalkIds（大写 T）。
    // 写成 atOpenDingtalkIds 不会报错，只会永远取到 undefined——
    // 这个笔误曾让我误判「@ 功能坏了」，白排查一轮。别再改回去。
    const echoed = args0?.atOpenDingTalkIds;
    check('@ 目标已进入 dws 计划', Array.isArray(echoed) && echoed.includes(target.openDingtalkId),
      JSON.stringify(echoed ?? null));

    const content = args0?.content ?? '';
    let inner = content;
    if (typeof content === 'string' && content.startsWith('{')) {
      try { inner = JSON.parse(content)?.content ?? content; } catch { /* 原样 */ }
    }
    check('正文在 dws 侧完整还原', inner === text,
      inner === text ? `${String(inner).split('\n').length} 行完整` : `期望 ${text.length} 字、实际 ${String(inner).length} 字`);
  }

  console.log('\n== 6. 本地校验仍拦得住畸形输入 ==');
  const empty = await sender.send({ conversationId: GROUP, text: '   ', preview: true });
  check('空正文被拒', empty.ok === false, empty.error.slice(0, 40));
  const noPlaceholder = await sender.send({
    conversationId: GROUP, text: '没有占位符', mentionIds: [target.openDingtalkId], preview: true,
  });
  check('要 @ 但无占位符被拒', noPlaceholder.ok === false, noPlaceholder.error.slice(0, 50));
} catch (error) {
  failures += 1;
  console.log(`\n✖ 抛出异常：${error.stack ?? error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${failures === 0 ? '完整链路验证通过（含 @ 编排与发送预检）' : `验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
