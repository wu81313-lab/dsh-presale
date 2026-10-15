// 真实链路验证：直接打本机 dws，验证插件的两大依赖确实可用。
//
// 只读：不发送任何消息、不修改任何群。可以放心反复跑。
// 运行：node tools/selftest-live.mjs
//
// 验证三件事：
//   1. 身份锚定能把「登录账号」解析成一个真的 openDingtalkId（而不是 userId 冒充）；
//   2. 全局搜索能按发送者搜到消息，且返回里带 conversationId；
//   3. 群成员表里带 openDingtalkId，@ 所需的数据确实能拿到。

import { mkdtempSync, rmSync } from 'node:fs';
import { TEST_GROUP, TEST_GROUP2, TEST_OID, TEST_NAME } from './fixtures.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSettings } from '../lib/settings.js';
import { createIdentity } from '../lib/identity.js';
import { createDiscoverer } from '../lib/discover.js';
import { runDws } from '../lib/dws.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-presale-live-'));
const logger = { info: () => {}, warn: (...a) => console.log('    [warn]', ...a), error: () => {} };

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const settings = createSettings({
  settingsPath: join(dir, 'settings.json'),
  config: { settingsPath: join(dir, 'settings.json'), activityPath: join(dir, 'a.ndjson'), watermarkPath: join(dir, 'w.json') },
  logger,
});

try {
  // ── 0. dws 可用性与登录态 ──────────────────────────────────
  console.log('== dws 登录态 ==');
  const auth = await runDws({ dwsPath: 'dws', args: ['auth', 'status', '-f', 'json'], timeoutMs: 30000, logger });
  check('dws auth status 成功', auth.ok, auth.ok ? '' : auth.message);
  if (auth.ok) {
    check('已登录', auth.data?.authenticated === true, String(auth.data?.authenticated));
    console.log(`    组织：${auth.data?.corp_name ?? '?'}  账号：${auth.data?.user_name ?? '?'}`);
  }

  // ── 1. 身份锚定 ────────────────────────────────────────────
  console.log('\n== 身份锚定（解析「哪个 openDingtalkId 是我」）==');
  const identity = createIdentity({ getSettings: () => settings.get(), logger });
  const id = await identity.resolve();
  console.log(`    状态：${id.state}`);
  console.log(`    姓名：${id.myName}`);
  console.log(`    我的 openDingtalkId：${id.myOid || '(未解析)'}`);
  console.log(`    说明：${id.message}`);

  check('身份锚定成功（state 不是 unresolvable）', id.state !== 'unresolvable', id.message);
  check('拿到的 openDingtalkId 非空', typeof id.myOid === 'string' && id.myOid.length > 0);
  check(
    'openDingtalkId 与 userId 不是同一个值（防止拿错了 ID 命名空间）',
    id.myOid !== id.myUserId || id.myUserId === '',
    `oid=${id.myOid} userId=${id.myUserId}`,
  );
  check('openDingtalkId 以 D 开头（钉钉开放 ID 的实际形状）', id.myOid.startsWith('D'), id.myOid);

  // ── 2. 全局搜索（发现层主通道）─────────────────────────────
  console.log('\n== 全局搜索（发现层主通道）==');
  const discoverer = createDiscoverer({
    getSettings: () => settings.get(),
    getIdentity: () => identity.status(),
    logger,
  });

  if (id.myOid.length > 0) {
    // 用**生产实际使用的窗口**来验（轮询只看最近几分钟），而不是 30 天：
    // 长窗口的翻页/边界行为与生产无关，拿它做验收会得出误导性结论。
    const allIds = new Set([id.myOid, ...(id.aliasIds ?? [])]);
    const search = await discoverer.searchMine({ startMs: Date.now() - 15 * 60 * 1000, endMs: Date.now() });
    check('全局搜索调用成功', search.ok, search.ok ? '' : search.message);
    if (search.ok) {
      console.log(`    近 15 分钟搜到我发的消息：${search.messages.length} 条（耗时 ${search.ms}ms，complete=${search.complete}）`);
      check('结果里带 conversationId', search.messages.every(m => m.conversationId.length > 0));
      check('结果里带可解析的时间', search.messages.every(m => m.createTimeMs !== null));

      // 最重要的一条：绝不能混进别人的消息（否则插件会对着别人的话触发）
      const foreign = [...new Set(
        search.messages.map(m => m.senderId).filter(sid => sid.length > 0 && !allIds.has(sid)),
      )];
      check(
        '结果里没有别人的 senderId（「只认我本人」的前提）',
        foreign.length === 0,
        foreign.length > 0 ? `发现外来 ID：${foreign.slice(0, 3).join(', ')}` : '',
      );

      const conversations = [...new Set(search.messages.map(m => m.conversationId))];
      if (conversations.length > 0) {
        console.log(`    覆盖 ${conversations.length} 个会话，例如：`);
        for (const cid of conversations.slice(0, 3)) {
          const sample = search.messages.find(m => m.conversationId === cid);
          console.log(`      ${cid}`);
          console.log(`        ${(sample?.text ?? '').slice(0, 50).replace(/\n/gu, ' ')}`);
        }
      }
    }

    // 确认别名 ID 确实能搜出东西（证明收别名是必要的，不是画蛇添足）。
    //
    // ⚠️ 这条**不能断言"一定有消息"**：别名是单聊作用域的 ID，
    // 如果最近没在单聊里说过话，30 天窗口内就是 0 条——那是数据事实，
    // 不是代码缺陷。之前写死断言，导致测试随环境时好时坏（已踩到）。
    // 正确做法：遍历所有别名，只要能捞到就给出更强结论；全都捞不到就如实报告。
    const aliases = id.aliasIds ?? [];
    if (aliases.length > 0) {
      let totalFromAliases = 0;
      let hitAlias = '';
      for (const alias of aliases) {
        const aliasOnly = createDiscoverer({
          getSettings: () => settings.get(),
          getIdentity: () => ({ myOid: alias, aliasIds: [] }),
          logger,
        });
        // eslint-disable-next-line no-await-in-loop
        const aliasResult = await aliasOnly.searchMine({
          startMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
          endMs: Date.now(),
        });
        if (aliasResult.ok && aliasResult.messages.length > 0) {
          totalFromAliases += aliasResult.messages.length;
          if (hitAlias.length === 0) hitAlias = alias;
        }
      }
      if (hitAlias.length > 0) {
        console.log(`    别名单独搜索命中 ${totalFromAliases} 条（首个命中的别名：${hitAlias.slice(0, 16)}…）`);
        check('别名 ID 能捞出消息（收别名是必要的）', true, `${totalFromAliases} 条`);
      } else {
        console.log(`    ${aliases.length} 个别名在 30 天内都没有消息`);
        console.log('    （这是数据事实而非缺陷：别名是单聊作用域的 ID，最近没在单聊里发言就搜不到）');
      }
    }
  }

  // ── 3. 群成员表（@ 所需数据）───────────────────────────────
  console.log('\n== 群成员表（@ 所需数据）==');
  const knownGroup = TEST_GROUP; // 由环境变量提供
  const members = await runDws({
    dwsPath: 'dws',
    args: ['chat', '+chat-members-list', '--conversation-id', knownGroup, '--member-types', 'user', '-f', 'json'],
    timeoutMs: 60000,
    logger,
  });
  check('成员表调用成功', members.ok, members.ok ? '' : members.message);
  if (members.ok) {
    const users = Array.isArray(members.data?.users) ? members.data.users : [];
    console.log(`    成员数：${users.length}`);
    check('成员表非空', users.length > 0);
    const withOid = users.filter(u => typeof u?.openDingtalkId === 'string' && u.openDingtalkId.length > 0);
    check(
      '成员表里带 openDingtalkId（键名必须是小写 t）',
      withOid.length === users.length,
      `${withOid.length}/${users.length} 有 ID`,
    );
    if (id.myOid.length > 0) {
      const me = users.find(u => u.openDingtalkId === id.myOid);
      check('能在成员表里按 oid 找到我自己（交叉校验通过）', me !== undefined, me ? `name=${me.name}` : '未找到');
    }
  }

  // ── 4. 关键词匹配（离线，用真实配置）───────────────────────
  console.log('\n== 关键词匹配（离线）==');
  const samples = [
    ['提供完整项目需求', 'provide'],
    ['请大家提供完整项目需求', 'provide'],
    ['梳理项目需求', 'summarize'],
    ['好的 DSH 梳理项目需求', 'summarize'], // 无前缀时关键词出现在句中也要命中
    ['提供完整需求', null], // 不是配置的关键词，不该触发
    ['今天讨论一下产品追溯的事情', null],
  ];
  for (const [text, expected] of samples) {
    const matched = discoverer.matchTriggers([{
      messageId: `t-${text}`, conversationId: 'cidTest', createTime: '', createTimeMs: Date.now(),
      sender: '张三', senderId: id.myOid, text, textNorm: (await import('../lib/util.js')).normalizeText(text),
      aiSendFlag: '', quoted: null,
    }]);
    const hit = matched.provide.length > 0 ? 'provide' : matched.summarize.length > 0 ? 'summarize' : null;
    check(`「${text}」→ ${hit ?? '不触发'}`, hit === expected, expected === null ? '本应不触发' : `期望 ${expected}`);
  }
} catch (error) {
  failures += 1;
  console.log(`\n✖ 验证过程抛出异常：${error.stack ?? error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${failures === 0 ? '真实链路验证全部通过' : `真实链路验证失败 ${failures} 项`} ====`);
process.exitCode = failures === 0 ? 0 : 1;
