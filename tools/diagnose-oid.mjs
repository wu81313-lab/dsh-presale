// 诊断：openDingtalkId 是否按会话变化？
//
// 背景：同一个登录账号在不同来源给出了两个不同的 ID——
//   成员表（示例工作群）→ D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001
//   全局搜索的消息 senderId → D8HS2VhbIeHFm6jlxdxQByiiiiLYXZXx0002
// 而两者都"能搜到我的消息"。这直接决定 @ 该用哪个 ID，必须查清。
//
// 做法：在同一会话里同时取「成员表中的我」和「我发的消息的 senderId」并对比。
// 只读。运行：node tools/diagnose-oid.mjs

import { runDws } from '../lib/dws.js';
import { pickConversationId, pickString, unwrapDwsPayload } from '../lib/util.js';

const logger = { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: () => {} };
const MY_NAME = '张三';

const run = (args, timeoutMs = 60000) => runDws({ dwsPath: 'dws', args, timeoutMs, logger });

/** 找一批有我发言的会话。 */
async function conversationsWithMyMessages() {
  const search = await run(['chat', '+search-msg', '--senders', 'WO', '--days', '3', '-f', 'json'], 60000);
  // 这个调用只为了探测，真正取会话用 recent-conversations（不依赖 oid）
  const recent = await run(['chat', '+recent-conversations', '-f', 'json'], 60000);
  if (!recent.ok) throw new Error(`recent-conversations 失败：${recent.message}`);
  const payload = unwrapDwsPayload(recent.data);
  const list = Array.isArray(payload.conversations) ? payload.conversations : [];
  return list.map(item => ({
    id: pickConversationId(item),
    name: pickString(item, 'name'),
    type: pickString(item, 'type'),
    latest: pickString(item, 'latestMessageTime'),
  })).filter(x => x.id.length > 0);
}

(async () => {
  console.log('== 取会话列表 ==');
  const conversations = await conversationsWithMyMessages();
  console.log(`   最近有消息的会话：${conversations.length} 个`);

  // 只查前 6 个，控制调用量
  const probe = conversations.slice(0, 6);
  const rows = [];

  for (const conv of probe) {
    process.stdout.write(`   检查「${conv.name || conv.id.slice(0, 16)}」… `);

    // a) 成员表里我的 ID
    const members = await run(['chat', '+chat-members-list', '--conversation-id', conv.id, '--member-types', 'user', '-f', 'json']);
    let memberOid = '';
    let memberFound = false;
    if (members.ok) {
      const users = Array.isArray(members.data?.users) ? members.data.users : [];
      const me = users.find(u => pickString(u, 'name') === MY_NAME);
      if (me !== undefined) {
        memberFound = true;
        memberOid = pickString(me, 'openDingtalkId');
      }
    }

    // b) 该会话最近消息里「我」的 senderId
    const messages = await run(['chat', '+chat-messages', '--group', conv.id, '--order', 'desc', '--limit', '50', '-f', 'json']);
    const senderIds = new Map();
    if (messages.ok) {
      const list = Array.isArray(messages.data?.messages) ? messages.data.messages : [];
      for (const m of list) {
        const name = pickString(m, 'sender');
        if (name !== MY_NAME) continue;
        const sid = pickString(m, 'senderId');
        if (sid.length === 0) continue;
        senderIds.set(sid, (senderIds.get(sid) ?? 0) + 1);
      }
    }
    const mySenderIds = [...senderIds.keys()];

    rows.push({ conv, memberFound, memberOid, mySenderIds, membersOk: members.ok, messagesOk: messages.ok });
    console.log(memberFound ? `成员表=${memberOid.slice(0, 22)}… | 我发言的senderId=${mySenderIds.map(s => s.slice(0, 22) + '…').join(',') || '(无)'}` : '（成员表里没找到我）');
  }

  console.log('\n== 汇总 ==');
  const found = rows.filter(r => r.memberFound);
  console.log(`   在成员表里找到「${MY_NAME}」的会话数：${found.length}/${rows.length}`);
  const distinctMemberOids = [...new Set(found.map(r => r.memberOid).filter(Boolean))];
  console.log(`   成员表给出的我的 ID（去重）：${distinctMemberOids.length} 种`);
  for (const oid of distinctMemberOids) console.log(`     ${oid}`);

  const allSenderIds = [...new Set(rows.flatMap(r => r.mySenderIds))];
  console.log(`   消息 senderId 给出的我的 ID（去重）：${allSenderIds.length} 种`);
  for (const oid of allSenderIds) console.log(`     ${oid}`);

  console.log('\n== 一致性 ==');
  let consistent = 0;
  let mismatched = 0;
  for (const r of rows) {
    if (!r.memberFound || r.mySenderIds.length === 0) continue;
    const agrees = r.mySenderIds.includes(r.memberOid);
    if (agrees) consistent += 1; else mismatched += 1;
    console.log(`   ${agrees ? '一致' : '不一致'}  ${r.conv.name || r.conv.id.slice(0, 20)}：成员表 ${r.memberOid.slice(0, 24)}… vs 消息 ${r.mySenderIds.map(s => s.slice(0, 24) + '…').join(',')}`);
  }
  console.log(`\n   结论：${consistent} 个会话两路一致，${mismatched} 个不一致`);
  console.log(mismatched > 0
    ? '   → ID 随会话变化：@ 必须使用「该会话成员表」里的 ID，不能用全局搜索的 senderId'
    : '   → 两路始终一致：身份锚定可任选其一');
})();
