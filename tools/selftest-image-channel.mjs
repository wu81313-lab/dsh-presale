// 探测：DSH 的图片通道到底能不能把"钉钉群里的图片"交给模型。
//
// 背景：我先前判定"图片读不了"是错的。DSH 有 attachments 服务：
//   saveImage({data, mediaType, name}) → ImageAttachmentRef
//   然后 {type:'image', attachment: ref} 就能作为内容块喂给 llm.stream()。
// 而 deepseek-v4.1-flash 的模型目录声明了 inputModalities: ['text','image']。
//
// 这个脚本在**真实 DSH 进程里**跑（通过插件工具），验证：
//   ① 能拿到 attachments 服务
//   ② 图片字节能通过 saveImage 落成引用（含尺寸校验）
//   ③ 把图片引用喂给模型，模型能描述出图里有什么
//
// 运行：node tools/selftest-image-channel.mjs（需要夹具）
// 注意：脚本自身**拿不到 ctx**（LLM 与 attachments 都在 DSH 进程内），
// 所以真正的验证走插件工具 presale_image_selftest。

console.log('本脚本只说明验证路径，实际验证请用插件工具。');
console.log();
console.log('为什么不能在脚本里直接验：');
console.log('  · ctx.attachments 与 ctx.llm 都只存在于 DSH 宿主进程内；');
console.log('  · 外部 node 进程没有 ctx，无法调用 saveImage 或 llm.stream。');
console.log();
console.log('因此在插件里新增了工具 presale_image_selftest，它在宿主进程内运行，');
console.log('会下载一张真实的钉钉图片、saveImage 落库、再让模型描述它。');
console.log();
console.log('请在 DSH 会话里直接调用：presale_image_selftest');
