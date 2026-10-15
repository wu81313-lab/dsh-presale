// 工具层：让我在 DSH 会话里直接观察/联调这个插件。
//
// 三个工具的定位：
//   presale_status      —— 一眼看状态：轮询、身份、水位、最近活动。排查「怎么没触发」第一步。
//   presale_recent      —— 看最近「我发的消息」有没有被搜到。排查发现层。
//   presale_send_text   —— 主动往某个会话发一条文本。**写操作**，群里可见，需谨慎。
//
// 明显的非目标：不做「让模型自己判销售」的工具——那属于插件内部链路，
// 不该从工具层绕进去，否则会出现两套不一致的判别逻辑。

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('工具参数必须是对象');
  return value;
}

function requireString(value, field, max = 4000) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} 必须是非空字符串`);
  return value.trim().slice(0, max);
}

function optionalInt(value, field, min, max) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是数字`);
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 把毫秒时间戳格式化成可读文本。 */
function fmt(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '从未';
  try {
    return new Date(ms).toLocaleString('zh-CN');
  } catch {
    return String(ms);
  }
}

/**
 * 注册工具。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} deps - 插件各层句柄。
 * @returns {Array<() => void>} disposer 数组（交给 ctx.effect 持有）。
 */
export function registerTools(ctx, { settings, poller, identity, activity, discoverer, conversationData = null, handlers, sender, llm, attachments = null }) {
  /** 附件处理器（图片通道要用它）。 */
  const attachmentsRef = attachments;
  const statusTool = {
    name: 'presale_status',
    description: [
      '查看 dsh-presale（钉钉售前助手）的运行状态：轮询是否在跑、身份是否锚定、消息水位、',
      'LLM 路由、以及最近的活动记录。排查「为什么没有触发」时先用它。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        activityLimit: { type: 'integer', description: '附带返回最近几条活动记录，默认 10，最大 50。' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw) {
      const args = asRecord(raw ?? {});
      const limit = optionalInt(args.activityLimit, 'activityLimit', 0, 50) ?? 10;
      const cfg = settings.get();
      const st = poller.status();
      const id = identity.status();

      const lines = [
        '## dsh-presale 状态',
        '',
        `总开关 enabled       : ${cfg.enabled ? '开启' : '关闭'}`,
        `试运行 dryRun        : ${cfg.dryRun ? '开启（只记录，不真发）' : '关闭（会真实发送到群）'}`,
        `轮询运行中           : ${st.running ? '是' : '否'}${st.busy ? '（当前正在执行一轮）' : ''}`,
        `当前轮询间隔         : ${st.currentIntervalSeconds > 0 ? `${st.currentIntervalSeconds} 秒` : '（尚未计算）'}`,
        `已完成轮询周期       : ${st.cycles} 次，命中 ${st.hits} 次`,
        `上次检查             : ${fmt(st.lastSearchAt)}`,
        `上次命中             : ${fmt(st.lastHitAt)}`,
        `连续无命中           : ${st.consecutiveEmpty} 轮（会自动退避拉长间隔）`,
        `dws 登录态           : ${st.authOk ? '正常' : `异常 — ${st.authMessage}`}`,
        '',
        `身份锚定状态         : ${id.state}`,
        `我（登录账号）       : ${id.myName || '未知'}${id.myCorp ? ` @ ${id.myCorp}` : ''}`,
        `我的 openDingtalkId  : ${id.myOid || '（未解析）'}`,
        `锚定说明             : ${id.message || '—'}`,
        '',
        `消息水位             : ${fmt(st.watermark.lastSeenMs)}`,
        `水位内已记录消息     : ${st.watermark.seenCount} 条`,
        '',
        `关键词（动作一）     : ${cfg.triggers.provide.keywords.join(' / ') || '（空）'}`,
        `关键词（动作二）     : ${cfg.triggers.summarize.keywords.join(' / ') || '（空）'}`,
        `@ 策略               : ${cfg.mention.enabled ? `开启，最低置信度 ${cfg.mention.minConfidence}` : '关闭'}`,
        `监听范围             : ${cfg.scope.allConversations ? '全部会话' : `指定 ${cfg.scope.includeConversationIds?.length ?? 0} 个`}`,
        `设置文件             : ${settings.path}`,
      ];

      const warnings = settings.warnings();
      if (warnings.length > 0) {
        lines.push('', '⚠️ 配置告警：', ...warnings.map(w => `  - ${w}`));
      }
      if (st.lastError.length > 0) {
        lines.push('', `⚠️ 最近错误：${st.lastError}`);
      }

      if (limit > 0) {
        const entries = activity.recent(limit);
        lines.push('', `## 最近 ${entries.length} 条活动`);
        if (entries.length === 0) {
          lines.push('（暂无记录。若你刚发过关键词，点「立即检查一次」或等一个轮询周期）');
        } else {
          for (const e of entries) {
            const when = fmt(e.ts);
            const where = e.conversationName || (e.conversationId ? `${e.conversationId.slice(0, 18)}…` : '—');
            const bits = [`${when}`, `[${e.action ?? '?'}/${e.decision ?? '?'}]`, where];
            if (e.mention?.mode && e.mention.mode !== 'none') {
              bits.push(`@${e.mention.name || '?'}(${e.mention.mode}${e.mention.confidence ? `/${e.mention.confidence}` : ''})`);
            }
            if (e.error) bits.push(`错误: ${e.error}`);
            if (e.note) bits.push(e.note);
            lines.push(`  - ${bits.join(' | ')}`);
            if (e.text) lines.push(`      正文: ${e.text.slice(0, 120).replace(/\n/gu, ' ')}`);
          }
        }
      }

      return lines.join('\n');
    },
  };

  const sendTool = {
    name: 'presale_send_text',
    description: [
      '主动向指定的钉钉会话发送一条文本消息。**这是写操作，群内可见，且不可撤回**。',
      '仅在用户明确要求「发一条到某个群」时使用；日常的自动触发不经过这个工具。',
      '不指定 @ 任何人（@ 逻辑属于插件内部链路）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        conversationId: { type: 'string', description: '目标会话的 openConversationId（必须以 cid 开头，不要用群名）。' },
        text: { type: 'string', description: '要发送的正文。' },
        confirm: { type: 'boolean', description: '必须显式传 true，表示已确认要真实发送。' },
      },
      required: ['conversationId', 'text', 'confirm'],
    },
    output: textOutput,
    // 写操作：不并发安全
    isConcurrencySafe: () => false,
    async execute(raw) {
      const args = asRecord(raw);
      const conversationId = requireString(args.conversationId, 'conversationId', 300);
      const text = requireString(args.text, 'text', 4000);
      if (args.confirm !== true) {
        return '已拒绝：这是会真实发到群里的写操作，必须显式传 confirm=true 才执行。';
      }
      if (!conversationId.startsWith('cid')) {
        return `已拒绝：conversationId 看起来不是 openConversationId（应以 "cid" 开头），收到：${conversationId.slice(0, 40)}。请先用 dws chat +chat-search 取得真实 ID，不要用群名。`;
      }
      const result = await sender.send({ conversationId, text, mentionIds: [] });
      if (result.ok && result.sent) return `已发送到 ${conversationId}。`;
      return `发送失败：${result.error}`;
    },
  };

  const recentTool = {
    name: 'presale_recent_mine',
    description: [
      '列出最近「我本人发出的钉钉消息」，用来验证发现层是否工作正常：',
      '如果这里看不到你刚发的那条，说明全局搜索有延迟或身份没锚定，而不是关键词没匹配。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minutes: { type: 'integer', description: '回溯多少分钟，默认 60，最大 1440。' },
        limit: { type: 'integer', description: '最多显示几条，默认 20，最大 100。' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw) {
      const args = asRecord(raw ?? {});
      const minutes = optionalInt(args.minutes, 'minutes', 1, 1440) ?? 60;
      const limit = optionalInt(args.limit, 'limit', 1, 100) ?? 20;

      const id = identity.status();
      if (!id.myOid) {
        return '身份尚未锚定，无法按发送者搜索。请先在面板点「重新识别身份」，或在设置里手填 openDingtalkId。';
      }

      const result = await discoverer.searchMine({ startMs: Date.now() - minutes * 60 * 1000, endMs: Date.now() });
      if (!result.ok) return `全局搜索失败：${result.message}`;

      const lines = [
        `最近 ${minutes} 分钟我发出的消息：共 ${result.messages.length} 条`
        + `（搜索完整性 complete=${String(result.complete)}${result.hasMore ? '，还有更多页' : ''}）`,
        '',
      ];
      if (result.messages.length === 0) {
        lines.push('没有搜到。若无误，说明这段时间你确实没发消息；');
        lines.push('若你刚发过，考虑：搜索索引有延迟（等一轮）、或身份锚定的 ID 不对。');
      } else {
        const sorted = result.messages
          .slice()
          .sort((a, b) => (b.createTimeMs ?? 0) - (a.createTimeMs ?? 0))
          .slice(0, limit);
        for (const m of sorted) {
          const name = discoverer.cachedName(m.conversationId);
          lines.push(`- [${m.createTime}] ${name || `${m.conversationId.slice(0, 20)}…`}`);
          lines.push(`    正文: ${m.text.slice(0, 160).replace(/\n/gu, ' ') || '（无正文，可能是图片/文件）'}`);
        }
      }
      if (result.message) lines.push('', `注意：${result.message}`);
      return lines.join('\n');
    },
  };

  /**
   * 诊断工具：在**真实运行环境里**跑一次 LLM 调用，把内部细节暴露出来。
   *
   * 为什么需要它：LLM 调用失败时插件只会记一条「LLM 返回了空内容」，
   * 但这个现象有好几种成因（只有思维链没有正文、路由不对、maxTokens 被推理吃光、
   * 服务未就绪……），从外部无法区分。而静态探针起不来完整的 LLM 服务，
   * 所以只能在插件自己的进程里自报。
   */
  const llmTool = {
    name: 'presale_llm_selftest',
    description: [
      '在插件真实运行环境里测试一次 LLM 调用，返回实际使用的 provider/model 与',
      '返回内容的细节（正文长度、思维链长度、chunk 类型分布）。',
      '当「@ 销售人员」失效或「梳理项目需求」失败时，用它定位到底是模型、路由还是 token 限制的问题。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '可选：自定义测试提示词，默认是一个很短的指令。' },
        maxTokens: { type: 'integer', description: '可选：覆盖本次调用的输出上限，用于验证「是否被推理吃光」。' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw) {
      const args = asRecord(raw ?? {});
      const prompt = typeof args.prompt === 'string' && args.prompt.trim().length > 0
        ? args.prompt.trim()
        : '只回答两个字：收到';
      const maxTokens = optionalInt(args.maxTokens, 'maxTokens', 16, 32768);
      const cfg = settings.get();
      const route = llm.describe();

      const lines = [
        '## LLM 调用自检',
        '',
        `LLM 服务可用      : ${llm.available() ? '是' : '否'}`,
        `设置里的 provider : ${JSON.stringify(cfg.llm.provider)}`,
        `设置里的 model    : ${JSON.stringify(cfg.llm.model)}`,
        `实际解析出的路由  : ${route.provider ? `${route.provider} / ${route.model}（来源 ${route.source}）` : '不可用'}`,
        `本次 maxTokens    : ${maxTokens ?? cfg.llm.maxTokens}`,
        `超时设置          : ${cfg.llm.timeoutMs} ms`,
        '',
        `提示词：${prompt}`,
        '',
      ];

      if (!llm.available()) {
        lines.push('✖ LLM 服务不可用（ctx.llm 未就绪）——「梳理项目需求」与「@ 判别」都无法工作。');
        return lines.join('\n');
      }

      const started = Date.now();
      const result = await llm.complete({ system: '你是测试助手，严格按要求输出。', user: prompt, maxTokens });
      const ms = Date.now() - started;

      lines.push(`耗时：${ms} ms`);
      if (!result.ok) {
        lines.push(`✖ 调用失败：${result.error}`);
        const st = result.stats ?? llm.lastCallStats();
        if (st !== null && st !== undefined) {
          lines.push('');
          lines.push('调用细节：');
          lines.push(`  chunk 总数      : ${st.chunkCount}`);
          lines.push(`  chunk 类型分布  : ${JSON.stringify(st.chunkTypes)}`);
          lines.push(`  正文累计        : ${st.textChars} 字`);
          lines.push(`  思维链累计      : ${st.reasoningChars} 字`);
          lines.push(`  结束原因        : ${st.finishReason || '（未收到 finish chunk）'}${st.errorCode ? ` / ${st.errorCode}` : ''}`);
        }
        lines.push('');
        lines.push('常见原因：');
        lines.push('  · provider/model 未注册 → 检查上面的「实际解析出的路由」');
        lines.push('  · 账号未登录 → 设置 → 账号与余额');
        lines.push('  · 超时 → 调大设置里的「最长等待」');
        lines.push('  · chunk 数为 0 且思维链为 0 → 模型名可能不对');
        lines.push('  · 只有思维链没有正文 → 把「最长输出」调大');
        return lines.join('\n');
      }

      lines.push(`✔ 调用成功，路由：${result.route.provider} / ${result.route.model}（来源 ${result.route.source}）`);
      lines.push(`返回正文：${JSON.stringify(result.text.slice(0, 200))}`);
      lines.push(`正文长度：${result.text.length} 字`);
      const st = result.stats ?? llm.lastCallStats();
      if (st !== null && st !== undefined) {
        lines.push('');
        lines.push('调用细节：');
        lines.push(`  chunk 总数      : ${st.chunkCount}`);
        lines.push(`  chunk 类型分布  : ${JSON.stringify(st.chunkTypes)}`);
        lines.push(`  正文累计        : ${st.textChars} 字`);
        lines.push(`  思维链累计      : ${st.reasoningChars} 字`);
        lines.push(`  结束原因        : ${st.finishReason || '（未收到 finish chunk）'}${st.errorCode ? ` / ${st.errorCode}` : ''}`);
        if (st.reasoningChars > 0 && st.textChars === 0) {
          lines.push('  ⚠️ 只有思维链没有正文 → 把「模型 → 最长输出」调大');
        }
      }
      lines.push('');
      lines.push('这条通路正常 ⇒ 「梳理项目需求」可用；「@ 判别」还取决于模型是否按 JSON 格式返回。');
      return lines.join('\n');
    },
  };

  /**
   * 诊断工具：验证"图片能不能交给模型看"。
   *
   * 为什么必须做成插件工具而不是外部脚本：图片通道依赖两样只在 DSH 宿主
   * 进程里存在的东西——`ctx.attachments`（把字节注册成图片引用）与 `ctx.llm`
   * （多模态调用）。外部 node 脚本没有 ctx，验不了。
   *
   * 它依次做四件事并把每一步如实回报：
   *   ① 从真实会话里找出图片附件
   *   ② 下载并注册成 DSH 附件引用
   *   ③ 让模型直接看图
   *   ④ 打印模型看到的内容
   */
  const imageTool = {
    name: 'presale_image_selftest',
    description: [
      '验证图片通道：下载一张真实钉钉群图片，注册为 DSH 附件，再让模型直接看图并描述。',
      '用来确认「模型能识别图片」这条路是通的（deepseek-v4.1-flash 声明支持 image 输入）。',
      '需要提供 conversationId（cid 开头，可从活动记录里复制一个）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        conversationId: { type: 'string', description: '要从中取图片的会话 ID（cid 开头）。' },
        prompt: { type: 'string', description: '可选：看图时问模型的问题，默认请它描述图片内容。' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw) {
      const args = asRecord(raw ?? {});
      const conversationId = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
      const prompt = typeof args.prompt === 'string' && args.prompt.trim().length > 0
        ? args.prompt.trim()
        : '请描述这张图片的内容。如果图里有文字、表格、图纸标注或型号，请一并读出。';

      const lines = ['## 图片通道自检', ''];
      if (attachmentsRef === null) {
        lines.push('✖ 附件处理器未就绪，「梳理项目需求」的附件功能不可用。');
        return lines.join('\n');
      }
      if (llm.available() !== true) {
        lines.push('✖ LLM 服务不可用。');
        return lines.join('\n');
      }
      if (conversationId.length === 0) {
        lines.push('请提供一个会话 ID（cid 开头），例如：');
        lines.push('  presale_image_selftest conversationId="cid…"');
        lines.push('');
        lines.push('可从活动记录里复制一个真实会话 ID。');
        return lines.join('\n');
      }

      // ① 从该会话近期消息里找图片附件
      const history = await conversationData.history({ conversationId, count: 200 });
      if (!history.ok) {
        lines.push(`✖ 取会话历史失败：${history.error}`);
        return lines.join('\n');
      }
      const images = [];
      const seen = new Set();
      for (const message of history.messages) {
        for (const ref of message.attachments ?? []) {
          if (seen.has(ref.resourceId)) continue;
          seen.add(ref.resourceId);
          const looksImage = ref.contentType === 'image' || /\.(png|jpe?g|webp|gif)$/iu.test(ref.name);
          if (looksImage) images.push(ref);
        }
      }
      lines.push(`会话历史 ${history.messages.length} 条，其中图片 ${images.length} 张。`);
      if (images.length === 0) {
        lines.push('');
        lines.push('该会话近期消息里没有图片，换一个发过图的群再试。');
        return lines.join('\n');
      }

      // ② 下载 + 注册成 DSH 附件
      const target = images[0];
      lines.push('');
      lines.push(`处理第一张：${target.name || '（无文件名）'}`);
      const handled = await attachmentsRef.ensureText(target);
      lines.push(`  状态 ${handled.status}｜${(handled.size / 1024).toFixed(1)}KB｜${handled.note}`);
      if (handled.status !== 'image' || handled.image === null || handled.image === undefined) {
        lines.push('');
        lines.push('✖ 这张图没能注册成模型可读的附件 —— 图片通道未打通。');
        lines.push('常见原因：DSH 附件服务未注册；格式不被接受（只收 png/jpeg/webp/gif）；尺寸或体积超限。');
        return lines.join('\n');
      }
      const imageRef = handled.image;
      lines.push(`  附件引用 ${String(imageRef.attachmentId).slice(0, 16)}… ${imageRef.mediaType} ${imageRef.width}×${imageRef.height} ${imageRef.bytes} 字节`);

      // ③ 让模型看图
      lines.push('');
      lines.push('让模型看图……');
      const result = await llm.complete({
        system: '你是看图助手，如实描述你看到的图片内容，不要编造图里没有的东西。',
        user: prompt,
        images: [{ name: handled.name, attachment: imageRef }],
        maxTokens: 2048,
      });
      if (!result.ok) {
        lines.push(`✖ 模型调用失败：${result.error}`);
        lines.push('');
        lines.push('若错误含 UNSUPPORTED_CONTENT，说明该 provider/model 不支持图片输入；');
        lines.push('可改用 deepseek-account / deepseek-flash（模型目录声明 inputModalities: [text, image]）。');
        return lines.join('\n');
      }

      lines.push(`✔ 模型读到了图片（随行 ${result.stats?.imageCount ?? 0} 张，${result.stats?.ms ?? 0}ms）`);
      lines.push('');
      lines.push('模型描述：');
      lines.push(result.text.slice(0, 1500));
      return lines.join('\n');
    },
  };

  return [statusTool, sendTool, recentTool, llmTool, imageTool].map(tool => ctx.tools.register(tool));
}
