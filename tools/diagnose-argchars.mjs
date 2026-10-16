// 诊断：生产模板里到底是哪个字符过不了参数白名单？
//
// 背景：真实触发时发送被拒：「dws: 参数含不允许的字符（引号/反斜杠/管道/分号/% 等）」。
// 但用默认文案做 dry-run 却能通过——说明是**用户自己编辑过的模板**里有问题字符。
// 不能靠猜，逐字符扫一遍，把那一个字符揪出来。
//
// 只读。运行：node tools/diagnose-argchars.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { assertSafeArg } from '../lib/dws.js';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const settingsPath = join(home, 'presale', 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

/** 逐字符找出第一个被拒的字符，以及它周围的上下文。 */
function findRejectedChar(text, label) {
  const rejected = [];
  // 逐字符：单个字符如果被拒，就是它的问题
  for (const ch of text) {
    try {
      assertSafeArg(ch);
    } catch {
      rejected.push(ch);
    }
  }
  const unique = [...new Set(rejected)];

  console.log(`\n== ${label} ==`);
  console.log(`   长度：${text.length} 字符`);
  if (unique.length === 0) {
    console.log('   逐字符检查：全部通过（说明是组合后才触发的？）');
  } else {
    for (const ch of unique) {
      const code = ch.codePointAt(0).toString(16).padStart(4, '0');
      // 找出它出现的位置与上下文，便于人工确认是不是打字带进来的
      const idx = text.indexOf(ch);
      const context = text.slice(Math.max(0, idx - 30), idx + 30).replace(/\n/gu, '⏎');
      console.log(`   ✖ U+${code.toUpperCase()} ${JSON.stringify(ch)}  出现 ${text.split(ch).length - 1} 次`);
      console.log(`        上下文：…${context}…`);
    }
  }

  // 整体测试
  try {
    assertSafeArg(text);
    console.log('   整段检查：通过');
  } catch (error) {
    console.log(`   整段检查：拒绝 — ${error.message}`);
  }
  return unique;
}

console.log('== 设置里的文案来源 ==');
console.log(`  文件：${settingsPath}`);

findRejectedChar(settings.triggers?.provide?.template ?? '', '功能一 · 文案模板');
findRejectedChar(settings.triggers?.summarize?.prompt ?? '', '功能二 · 总结提示词');
findRejectedChar(settings.triggers?.provide?.salesPrompt ?? '', '销售判别提示词');

console.log('\n== 结论 ==');
console.log('  上面对应的字符需要从模板里删掉，或改进参数校验/转义策略。');
console.log('  注意：模板会作为 dws 的命令行参数，所以它必须能安全穿过 shell。');
