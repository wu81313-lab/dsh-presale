// dws 参数传递的测试。
//
// ⚠️ 安全模型与早期版本**不同**，改断言前先读这段：
//
// 早期版本经 shell 执行 dws（`shell:true` + 自拼命令行），所以用「字符白名单」
// 拒绝引号/管道/分号等作为防线。那个模型有个致命副作用：**换行也被拒**，
// 导致多行文案永远发不出去（实测踩到，真实触发时发送失败）。
//
// 现在改为：直接执行 `vendor/dws.exe`，参数以**数组**交给 Node 的 spawn。
//   · 不经过 cmd.exe，所以 shell 元字符（" | & ; % $ ` < > 换行）**没有特殊含义**，
//     会被原样传给 dws（已用 dry-run 实测：多行正文与 <@oid> 都完整还原）；
//   · 不存在「拼命令行」这一步，注入面因此消失——这才是真正的安全边界。
//
// 所以下面**不再**断言"引号被拒绝"，那样会把功能一起禁掉。改为断言：
//   1. 正常内容（含换行/引号/元字符）能通过，不被误伤；
//   2. 只拒绝真正无法表示的字符（NUL、不成对代理项）；
//   3. 调用时确实用数组、且不启用 shell。
//
// 运行：node --test lib/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assertSafeArg, runDws, resolveDwsExecutable } from '../dws.js';

const here = dirname(fileURLToPath(import.meta.url));
const dwsSource = readFileSync(join(here, '..', 'dws.js'), 'utf8');

test('dws: 普通参数原样通过', () => {
  assert.equal(assertSafeArg('chat'), 'chat');
  assert.equal(assertSafeArg('+search-msg'), '+search-msg');
  assert.equal(assertSafeArg('cidEXAMPLE0000000000000000=='), 'cidEXAMPLE0000000000000000==');
  assert.equal(assertSafeArg('示例工作群'), '示例工作群');
  assert.equal(assertSafeArg('2026-10-14T21:54:41+08:00'), '2026-10-14T21:54:41+08:00');
  assert.equal(assertSafeArg(30), '30');
});

test('dws: 多行正文必须能通过（这是真实文案的常态）', () => {
  const multiline = '为了能准确评估这个项目，麻烦补充以下信息：\n1. 产品信息\n2. 产线数量\n3. CAD 布局图';
  assert.equal(assertSafeArg(multiline), multiline);
});

test('dws: shell 元字符不再被拒（因为不再经 shell）', () => {
  // 这些字符在数组传参下只是普通文本。曾经它们被白名单拒绝，
  // 顺带把用户正文里的 % 和换行也挡了——那是过度设计。
  const samples = [
    '折扣 5% | 备注',
    '含"双引号"的正文',
    "含'单引号'的正文",
    '含`反引号`的正文',
    '含 $ 和 & 和 ; 的正文',
    '重定向测试 > 文件 < 输入',
    '<@D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001> 请补充需求',
  ];
  for (const value of samples) {
    assert.equal(assertSafeArg(value), value, `不应被拒：${JSON.stringify(value)}`);
  }
});

test('dws: 空串与非法类型边界', () => {
  assert.equal(assertSafeArg(''), '');
  assert.throws(() => assertSafeArg(null), /必须是字符串或数字/u);
  assert.throws(() => assertSafeArg(undefined), /必须是字符串或数字/u);
  assert.throws(() => assertSafeArg({}), /必须是字符串或数字/u);
  assert.throws(() => assertSafeArg(NaN), /必须是字符串或数字/u);
});

test('dws: NUL 字符被拒绝（命令行无法表示）', () => {
  assert.throws(() => assertSafeArg('a\u0000b'), /NUL/u);
});

test('dws: 不成对的代理项被拒绝（无法编码为 UTF-8）', () => {
  assert.throws(() => assertSafeArg('a\uD800b'), /代理项/u);
  assert.throws(() => assertSafeArg('a\uDC00b'), /代理项/u);
  // 成对的代理项（正常 emoji）必须通过
  assert.equal(assertSafeArg('a😀b'), 'a😀b');
});

test('dws: 调用实现确实用数组传参且不启用 shell（安全边界就在这里）', () => {
  // 这是本文件最重要的一条断言：安全性依赖「不经 shell」，不依赖字符过滤。
  // 若有人改回「拼命令行 + shell:true」，这里会失败。
  assert.match(dwsSource, /spawn\(bin,\s*safeArgs/u, '必须以数组形式传参，不能拼命令行');
  assert.match(dwsSource, /shell:\s*resolved\.direct !== true/u, 'direct 可执行文件必须关闭 shell');
  assert.ok(!/\.map\(quoteArg\)/u.test(dwsSource), '不应再把参数拼成命令行字符串');
});

test('dws: runDws 遇到非法参数时直接失败，不会去起进程', async () => {
  const result = await runDws({
    dwsPath: 'dws',
    args: ['chat', '+messages-send', '--text', 'a\u0000b'],
    timeoutMs: 5000,
    logger: { warn() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_ARG', `实际 ${result.code}`);
  assert.match(result.message, /NUL/u);
});

test('dws: resolveDwsExecutable 优先返回可直接执行的 dws.exe', () => {
  const resolved = resolveDwsExecutable('dws');
  assert.ok(typeof resolved.path === 'string' && resolved.path.length > 0);
  assert.equal(typeof resolved.direct, 'boolean');
  if (resolved.path.endsWith('dws.exe')) {
    assert.equal(resolved.direct, true, 'dws.exe 应标记为可直接执行');
  }
});

test('dws: 显式配置 .cmd 时会被标记（多行有隐患）', () => {
  const resolved = resolveDwsExecutable('C:\\some\\path\\dws.cmd');
  assert.equal(resolved.direct, false);
  assert.match(resolved.note, /多行/u, '应当提示 .cmd 会吃掉多行');
});

test('dws: 显式配置其它路径时尊重用户选择', () => {
  const resolved = resolveDwsExecutable('D:\\tools\\dws.exe');
  assert.equal(resolved.path, 'D:\\tools\\dws.exe');
  assert.equal(resolved.direct, true);
});
