// 测试夹具：真实环境下的群 ID / 成员 ID。
//
// **为什么单独抽一个文件**：这些值取自真实的钉钉会话，本机开发时用来跑
// selftest 最有用（真实数据才能验证真实契约）。但它们属于**个人数据**，
// 仓库是公开的，所以：
//
//   1. 仓库里**不写任何真实 ID**，默认值为空；
//   2. 本机开发时通过环境变量注入（见下面的变量名）；
//   3. 没有配置时，依赖这些夹具的检查会**跳过并明确告知**，
//      而不是拿一个假 ID 去跑——假 ID 会得到"看起来通过"的假结论。
//
// 需要的环境变量（都在本机设置即可，不要提交到仓库）：
//   DSH_PRESALE_TEST_GROUP    一个真实群会话 ID（cid…），用于发送/成员表验证
//   DSH_PRESALE_TEST_GROUP2   第二个真实群（可含明确的项目讨论），用于 @ 判别验证
//   DSH_PRESALE_TEST_OID      该群里任意一个真实成员的 openDingtalkId
//   DSH_PRESALE_TEST_NAME     上面这个成员在群里的显示名
//
// 运行：node tools/selftest-*.mjs

/** 从环境变量取一个测试夹具值。 */
function env(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** 第一个测试群（用于发送链路与成员表）。 */
export const TEST_GROUP = env('DSH_PRESALE_TEST_GROUP');

/** 第二个测试群（建议选有真实项目讨论的群，用于验证 @ 判别）。 */
export const TEST_GROUP2 = env('DSH_PRESALE_TEST_GROUP2');

/** 测试群里的一个真实成员 ID（@ 需要它）。 */
export const TEST_OID = env('DSH_PRESALE_TEST_OID');

/** 上面那个成员的显示名。 */
export const TEST_NAME = env('DSH_PRESALE_TEST_NAME');

/**
 * 检查夹具是否齐备；不齐时打印可操作的提示并返回 false。
 *
 * @param {string[]} needed - 需要的环境变量名。
 * @returns {boolean} 是否齐备。
 */
export function requireFixtures(needed) {
  const missing = needed.filter(name => env(name).length === 0);
  if (missing.length === 0) return true;
  console.log('');
  console.log('  跳过：本项检查需要真实钉钉数据，但未配置夹具。');
  console.log(`  缺失的环境变量：${missing.join('、')}`);
  console.log('  设置方法（PowerShell，仅本机生效）：');
  for (const name of missing) {
    const hint = name.endsWith('_OID') ? 'D8HS…（群成员表里的 openDingtalkId）'
      : name.endsWith('_NAME') ? '张三'
        : 'cid…（会话 ID）';
    console.log(`    setx ${name} "${hint}"`);
  }
  console.log('  说明：这里故意不内置真实 ID——它们属于个人数据，不该进公开仓库。');
  return false;
}
