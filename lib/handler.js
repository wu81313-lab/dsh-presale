// 动作层：两个触发动作的业务逻辑。
//
// 「提供完整项目需求」的完整链路：
//   命中消息 → 读历史 + 群成员表 → LLM 判「谁是销售人员」→ 按置信度决定 @ 策略
//   → 渲染模板（可选 AI 润色）→ 发送（或 dryRun 只记录）
//
// 「梳理项目需求」的完整链路：
//   命中消息 → 读历史 → LLM 结构化总结 → 发送（或 dryRun 只记录）
//
// 这里集中处理一件事：**每次都要能解释清楚为什么这么发**。
// 判不出销售、置信度不够、成员表取不到 —— 都要降级并留下原因，
// 而不是静默地 @ 错人或静默地不发。

import { mentionPlaceholder } from './send.js';
import { renderHistoryForModel } from './conversation-data.js';
import { extractKeyword, renderTemplate } from './render.js';
import { formatLocalDate, formatLocalTime, truncate } from './util.js';

/**
 * 建立动作执行器。
 *
 * @param {object} options
 * @param {() => object} options.getSettings - 当前设置。
 * @param {() => object} options.getIdentity - 当前身份。
 * @param {object} options.discoverer - 发现器（取会话名）。
 * @param {object} options.conversationData - 会话数据访问器。
 * @param {object} options.llm - LLM 访问器。
 * @param {object} options.sender - 发送器。
 * @param {object} options.activity - 活动日志。
 * @param {object} [options.attachments] - 附件处理器（可选；没有就跳过附件）。
 * @param {{info?: Function, warn?: Function}} [options.logger] - 日志。
 * @returns {{ runProvide: Function, runSummarize: Function }}
 */
export function createHandlers({
  getSettings,
  getIdentity,
  discoverer,
  conversationData,
  llm,
  sender,
  activity,
  attachments = null,
  logger = console,
}) {
  /**
   * 判别「谁是销售人员」并决定 @ 策略。
   *
   * 三级降级（任何一级判不出来都不 @，绝不硬猜）：
   *   ① AI 判别 high 且成员表唯一命中 → 真 @
   *   ② AI 判别 medium → 正文纯文本写「（@姓名）」，不真 @
   *   ③ 判不出 / 名单外 / 调用失败 → 不 @（可配置回退为 @ 触发者本人）
   *
   * @param {object} options
   * @param {string} options.conversationId - 会话 ID。
   * @param {string} options.conversationName - 会话名。
   * @param {string} options.triggerSenderName - 触发者显示名（兜底用）。
   * @returns {Promise<{mode: string, name: string, oid: string, confidence: string, reason: string, evidence: string[]}>}
   */
  async function resolveMention({ conversationId, conversationName, triggerSenderName }) {
    const settings = getSettings();
    const identity = getIdentity();
    const mentionCfg = settings.mention ?? {};
    const none = reason => ({ mode: 'none', name: '', oid: '', confidence: '', reason, evidence: [] });

    if (mentionCfg.enabled !== true) return none('设置里关闭了 @ 功能');
    if (mentionCfg.skipInSingleChat === true && isSingleChat(conversationId, conversationName)) {
      return none('单聊里 @ 无意义，已自动跳过');
    }

    const rosterResult = await conversationData.roster(conversationId);
    if (!rosterResult.ok || rosterResult.members.length === 0) {
      const fallback = fallbackToTrigger(mentionCfg, triggerSenderName, identity);
      if (fallback !== null) return fallback;
      return none(`取不到群成员表：${rosterResult.error || '成员为空'}`);
    }

    // 读历史用于判别（条数可配，默认 60）
    const lookback = Math.max(10, Math.min(500, settings.triggers?.provide?.salesLookbackMessages ?? 60));
    const historyResult = await conversationData.history({ conversationId, count: lookback });
    if (!historyResult.ok || historyResult.messages.length === 0) {
      const fallback = fallbackToTrigger(mentionCfg, triggerSenderName, identity);
      if (fallback !== null) return fallback;
      return none(`取不到会话历史：${historyResult.error || '历史为空'}`);
    }

    const rendered = renderHistoryForModel(historyResult.messages, identity, 12000);
    const inferred = await llm.inferSales({
      prompt: settings.triggers?.provide?.salesPrompt ?? '',
      historyText: rendered.text,
      members: rosterResult.members,
      conversationName,
    });

    if (inferred.status !== 'inferred') {
      const fallback = fallbackToTrigger(mentionCfg, triggerSenderName, identity);
      if (fallback !== null) return fallback;
      return none(inferred.reason || inferred.error || '未能判别出销售人员');
    }

    const member = rosterResult.members.find(m => m.name === inferred.name);
    if (member === undefined) {
      return none(`模型给出「${inferred.name}」，但不在成员表里`);
    }
    if (member.openDingtalkId.length === 0) {
      // 有这个人但拿不到 ID：只能纯文本提及
      return {
        mode: 'textual',
        name: inferred.name,
        oid: '',
        confidence: inferred.confidence,
        reason: `成员表里「${inferred.name}」没有 openDingtalkId，无法真 @`,
        evidence: inferred.evidence,
      };
    }

    const threshold = mentionCfg.minConfidence ?? 'high';
    const rank = { high: 3, medium: 2, low: 1 };
    const meets = (rank[inferred.confidence] ?? 0) >= (rank[threshold] ?? 3);

    if (meets) {
      return {
        mode: 'at',
        name: inferred.name,
        oid: member.openDingtalkId,
        confidence: inferred.confidence,
        reason: inferred.reason,
        evidence: inferred.evidence,
      };
    }

    if (mentionCfg.textualMentionWhenMedium === true && inferred.confidence === 'medium') {
      return {
        mode: 'textual',
        name: inferred.name,
        oid: member.openDingtalkId,
        confidence: inferred.confidence,
        reason: `${inferred.reason}（置信度 medium，未达 ${threshold} 阈值，降级为纯文本提及）`,
        evidence: inferred.evidence,
      };
    }

    return none(`置信度 ${inferred.confidence} 未达阈值 ${threshold}：${inferred.reason}`);
  }

  /** 会话看着像单聊吗（拿不到可靠类型时按名字/成员数推断，宁可保守）。 */
  function isSingleChat(conversationId, conversationName) {
    if (typeof conversationName === 'string' && conversationName.length > 0) {
      // 群聊通常有群名；单聊的会话名往往就是对方姓名（无「群」字），但这不是硬证据
      if (/群|组|项目|Team|群聊/u.test(conversationName)) return false;
    }
    return false; // 拿不准时不当作单聊，交给成员表判断（单聊本来也取不到成员表）
  }

  /** 判不出销售时是否回退 @ 触发者本人。 */
  function fallbackToTrigger(mentionCfg, triggerSenderName, identity) {
    if (mentionCfg.fallbackToTriggerWhenUnknown !== true) return null;
    const oid = identity?.myOid ?? '';
    if (oid.length === 0) return null;
    if (triggerSenderName.length === 0) return null;
    return {
      mode: 'at',
      name: triggerSenderName,
      oid,
      confidence: 'fallback',
      reason: '未能判别销售人员，按设置回退为 @ 触发者本人',
      evidence: [],
    };
  }

  /**
   * 组装「请提供完整项目需求」的正文与 @ 判定（**纯计算，不发送**）。
   *
   * 抽出来是为了让面板的「立即试跑」能走完全相同的链路但不产生副作用：
   * 试跑与真实发送如果各写一份逻辑，就会慢慢跑偏，最后试跑结果不再可信。
   *
   * @param {object} trigger - 命中的消息（试跑时是构造的预览消息）。
   * @param {string} conversationName - 会话名。
   * @returns {Promise<{text: string, mention: object, warnings: string[]}>}
   */
  async function composeProvide(trigger, conversationName) {
    const settings = getSettings();
    const tcfg = settings.triggers?.provide ?? {};
    const warnings = [];

    const mention = await resolveMention({
      conversationId: trigger.conversationId,
      conversationName,
      triggerSenderName: trigger.sender,
    });

    const rendered = renderTemplate(tcfg.template ?? '', {
      senderName: trigger.sender,
      groupName: conversationName,
      keyword: extractKeyword(trigger.textNorm, tcfg),
      date: formatLocalDate(),
      time: formatLocalTime(),
      salesName: mention.name,
    });
    if (rendered.unknown.length > 0) {
      warnings.push(`文案里有未识别的占位符（已原样保留）：${rendered.unknown.join(', ')}`);
    }

    // 组装正文：@ 占位符必须在最前面（钉钉要求正文里出现占位符）
    const parts = [];
    if (mention.mode === 'at' && mention.oid.length > 0) {
      parts.push(mentionPlaceholder(mention.oid));
    } else if (mention.mode === 'textual' && mention.name.length > 0) {
      parts.push(`@${mention.name}`);
    }
    parts.push(rendered.text);

    return { text: parts.join(' ').trim(), mention, warnings };
  }

  /**
   * 动作一：发送「请提供完整项目需求」文案。
   *
   * @param {object} trigger - 命中的消息。
   * @param {string} conversationName - 会话名。
   * @returns {Promise<object>} 结构化结果（写进 activity）。
   */
  async function runProvide(trigger, conversationName) {
    const composed = await composeProvide(trigger, conversationName);
    return await deliver({
      trigger,
      conversationName,
      action: 'provide',
      text: composed.text,
      mention: composed.mention,
      warnings: composed.warnings,
    });
  }

  /**
   * 试跑「提供完整项目需求」：只组装并返回，不发消息、不写 activity 的发送记录。
   *
   * @param {object} trigger - 构造的预览消息。
   * @param {string} conversationName - 会话名。
   * @returns {Promise<object>} 组装结果。
   */
  async function previewProvide(trigger, conversationName) {
    const composed = await composeProvide(trigger, conversationName);
    const settings = getSettings();
    return {
      text: composed.text,
      mention: composed.mention,
      warnings: composed.warnings,
      wouldSend: settings.dryRun === true ? '（dryRun 开启，真实触发时也只记录不发送）' : '（dryRun 关闭，真实触发时会发送到该会话）',
      sent: false,
    };
  }

  /**
   * 组装「需求梳理」的结果（**纯计算，不发送**）。
   *
   * @param {object} trigger - 命中的消息。
   * @param {string} conversationName - 会话名。
   * @returns {Promise<{ok: boolean, text: string, error: string, warnings: string[], historyCount: number, historyComplete: boolean}>}
   */
  async function composeSummarize(trigger, conversationName) {
    const settings = getSettings();
    const tcfg = settings.triggers?.summarize ?? {};
    const identity = getIdentity();
    const warnings = [];

    const count = Math.max(10, Math.min(1000, tcfg.historyCount ?? 200));
    const historyResult = await conversationData.history({ conversationId: trigger.conversationId, count });
    if (!historyResult.ok || historyResult.messages.length === 0) {
      return {
        ok: false,
        error: `取不到会话历史：${historyResult.error || '历史为空'}`,
        text: '',
        warnings,
        historyCount: 0,
        historyComplete: false,
      };
    }

    const rendered = renderHistoryForModel(historyResult.messages, identity, 24000);
    // 截断必须显式告知（不能把「只有一部分消息参与了分析」伪装成完整总结）
    if (historyResult.complete !== true) warnings.push(`会话历史未读全：${historyResult.error}`);
    if (rendered.dropped > 0) warnings.push(`有 ${rendered.dropped} 条早期消息因长度限制未参与分析`);

    // ── 附件 ────────────────────────────────────────────────
    //
    // 钉钉的文件只能下载到本地再解析，没有"在线读正文"的接口。
    // 不处理附件的话，模型只看到「[文件] xx.docx fileId: …」这行字，
    // 于是总结会写成「文件无法读取，请重新上传」——对用户毫无价值。
    let attachmentBlock = '';
    let attachmentSummary = '未启用附件读取';
    let attachmentList = [];
    /** 图片引用：作为多模态内容块直接交给模型看（不是提取文字）。 */
    let attachmentImages = [];
    if (attachments !== null && settings.attachments?.enabled === true) {
      const refs = [];
      const seen = new Set();
      for (const message of historyResult.messages) {
        for (const ref of message.attachments ?? []) {
          if (seen.has(ref.resourceId)) continue;
          seen.add(ref.resourceId);
          refs.push(ref);
        }
      }
      if (refs.length === 0) {
        attachmentSummary = '本轮聊天记录里没有附件';
      } else {
        try {
          const collected = await attachments.collect(refs);
          attachmentBlock = collected.block;
          attachmentSummary = collected.summary;
          attachmentImages = Array.isArray(collected.images) ? collected.images : [];
          attachmentList = collected.results.map(r => ({
            name: r.name,
            status: r.status,
            chars: r.text.length,
            size: r.size,
            fromCache: r.fromCache === true,
            note: r.note,
          }));
          const failed = collected.results.filter(r => r.status === 'error');
          const unsupported = collected.results.filter(r => r.status === 'unsupported');
          if (failed.length > 0) warnings.push(`${failed.length} 个附件下载失败`);
          if (unsupported.length > 0) {
            warnings.push(`${unsupported.length} 个附件无法处理：${unsupported.map(r => r.name).join('、')}`);
          }
          logger.info?.(`dsh-presale: 附件处理完毕——${collected.summary}`);
        } catch (error) {
          attachmentSummary = `附件处理出错：${error instanceof Error ? error.message : String(error)}`;
          warnings.push(attachmentSummary);
        }
      }
    }

    const summary = await llm.summarizeRequirements({
      prompt: tcfg.prompt ?? '',
      title: tcfg.title ?? '',
      historyText: rendered.text,
      attachmentBlock,
      images: attachmentImages,
      conversationName,
    });
    if (!summary.ok) {
      return {
        ok: false,
        error: `需求梳理失败：${summary.error}`,
        text: '',
        warnings,
        historyCount: historyResult.messages.length,
        historyComplete: historyResult.complete === true,
        attachments: attachmentList,
        attachmentSummary,
        imageCount: attachmentImages.length,
      };
    }

    return {
      ok: true,
      error: '',
      text: summary.text,
      warnings,
      historyCount: historyResult.messages.length,
      historyComplete: historyResult.complete === true,
      attachments: attachmentList,
      attachmentSummary,
      imageCount: attachmentImages.length,
    };
  }

  /**
   * 动作二：梳理项目需求并发送总结。
   *
   * @param {object} trigger - 命中的消息。
   * @param {string} conversationName - 会话名。
   * @returns {Promise<object>} 结构化结果（写进 activity）。
   */
  async function runSummarize(trigger, conversationName) {
    const composed = await composeSummarize(trigger, conversationName);
    if (!composed.ok) {
      return {
        action: 'summarize',
        decision: 'failed',
        error: composed.error,
        text: '',
        mention: null,
        historyCount: composed.historyCount,
        historyComplete: composed.historyComplete,
        warnings: composed.warnings,
      };
    }

    // 梳理结果默认不 @（总结本身是给全群看的），保持安静
    return await deliver({
      trigger,
      conversationName,
      action: 'summarize',
      text: composed.text,
      mention: { mode: 'none', name: '', oid: '', confidence: '', reason: '需求梳理结果默认不 @ 任何人', evidence: [] },
      warnings: composed.warnings,
      extra: {
        historyCount: composed.historyCount,
        historyComplete: composed.historyComplete,
        // 附件清单进活动记录：排查「模型为什么没读到某个文件」时这是唯一线索
        attachments: composed.attachments ?? [],
        attachmentSummary: composed.attachmentSummary ?? '',
        imageCount: composed.imageCount ?? 0,
      },
    });
  }

  /**
   * 试跑「梳理项目需求」：会真实调用 LLM 并读历史，但不发送。
   *
   * @param {object} trigger - 构造的预览消息。
   * @param {string} conversationName - 会话名。
   * @returns {Promise<object>} 组装/生成结果。
   */
  async function previewSummarize(trigger, conversationName) {
    const composed = await composeSummarize(trigger, conversationName);
    const settings = getSettings();
    return {
      text: composed.text,
      error: composed.error,
      warnings: composed.warnings,
      historyCount: composed.historyCount,
      historyComplete: composed.historyComplete,
      // 试跑也要能看到附件处理结果（这是"模型到底读到了什么"的直接证据）
      attachments: composed.attachments ?? [],
      attachmentSummary: composed.attachmentSummary ?? '',
      imageCount: composed.imageCount ?? 0,
      mention: { mode: 'none', name: '', confidence: '', reason: '梳理结果不 @ 任何人', evidence: [] },
      wouldSend: settings.dryRun === true ? '（dryRun 开启，真实触发时也只记录不发送）' : '（dryRun 关闭，真实触发时会发送到该会话）',
      sent: false,
    };
  }

  /**
   * 统一投递：dryRun 只记录，否则真发；并写 activity。
   *
   * @param {object} options - 投递参数。
   * @returns {Promise<object>} 结构化结果。
   */
  async function deliver({ trigger, conversationName, action, text, mention, warnings = [], extra = {} }) {
    const settings = getSettings();
    const mentionIds = mention.mode === 'at' && mention.oid.length > 0 ? [mention.oid] : [];
    const dryRun = settings.dryRun === true;

    let sendResult = { ok: true, sent: false, previewed: false, error: '' };
    if (!dryRun) {
      sendResult = await sender.send({
        conversationId: trigger.conversationId,
        text,
        mentionIds,
      });

      // @ 失败时退一步：去掉 @ 重发一次纯文本，保证「文案本身一定送达」
      if (!sendResult.ok && mentionIds.length > 0) {
        logger.warn?.(`dsh-presale: 带 @ 发送失败（${sendResult.error}），尝试去掉 @ 重发`);
        const plainText = text.replace(/<@[^>]+>/gu, '').replace(/^@[^\s]+\s*/u, '').trim();
        const retry = await sender.send({ conversationId: trigger.conversationId, text: plainText, mentionIds: [] });
        if (retry.ok) {
          sendResult = { ...retry, error: '' };
          warnings.push(`原先带 @ 的发送失败，已去掉 @ 重发：${sendResult.error || ''}`.trim());
          mention = { ...mention, mode: 'none', oid: '', reason: `${mention.reason}（@ 发送失败，已降级重发）` };
        } else {
          sendResult = retry;
        }
      }
    }

    const decision = dryRun
      ? 'dry-run'
      : sendResult.ok
        ? 'sent'
        : 'failed';

    const record = {
      action,
      decision,
      conversationId: trigger.conversationId,
      conversationName,
      triggerMessageId: trigger.messageId,
      triggerText: truncate(trigger.text, 200),
      triggerSender: trigger.sender,
      triggerTime: trigger.createTime,
      mention: {
        mode: mention.mode,
        name: mention.name,
        confidence: mention.confidence,
        reason: mention.reason,
        evidence: mention.evidence ?? [],
      },
      text: truncate(text, 4000),
      textLength: text.length,
      sent: sendResult.sent === true,
      error: sendResult.error || '',
      warnings,
      ...extra,
    };

    activity.append(record);
    if (sendResult.error.length > 0) {
      logger.warn?.(`dsh-presale: 发送失败：${sendResult.error}`);
    } else if (dryRun) {
      logger.info?.(`dsh-presale: [dry-run] 本应发到「${conversationName || trigger.conversationId}」：${truncate(text, 80)}`);
    } else {
      logger.info?.(`dsh-presale: 已发送到「${conversationName || trigger.conversationId}」（${mention.mode === 'at' ? `@${mention.name}` : '未 @'}）`);
    }

    return record;
  }

  return { runProvide, runSummarize, previewProvide, previewSummarize };
}
