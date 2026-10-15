// 默认配置 + 校验归一化。
//
// 设计原则：配置项一律「宽进严出」——
//   · 缺失 → 补默认值
//   · 类型不对 / 越界 → 回退默认值并记一条 warning（不抛异常，不阻断插件）
//   · 未知键 → 原样保留（面板换代、字段废弃时不丢用户数据）
//
// 之所以不抛异常：配置写错不应该让整个插件加载失败（那会让用户连面板都打不开、
// 没法改回来）。宁可带着默认值启动，把问题显示在面板上。

import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizePatternText, normalizeText } from './util.js';

/** 触发关键词的默认文案（用户可随时在面板里改）。 */
export const DEFAULT_TEMPLATE = [
  '为了能准确评估这个项目，麻烦补充以下信息：',
  '',
  '1. 产品信息：品类、规格、包装形式、单箱数量',
  '2. 产线数量与产能节拍（条/分钟）',
  '3. CAD 布局图：含设备位置、预留空间、厂房尺寸',
  '4. 现有系统与接口情况（ERP / MES / WMS 等）',
  '5. 追溯要求：赋码层级、采集点位、关联关系',
  '6. 计划上线时间与验收标准',
  '',
  '资料可以直接发在群里，或发我单独整理。',
].join('\n');

/** 「梳理需求」的默认提示词。`{company}` 会被设置里的公司名替换。 */
export const DEFAULT_SUMMARY_PROMPT = [
  '你是{company}的售前技术支持。下面是钉钉项目群的一段聊天记录。',
  '',
  '请梳理出这个项目的需求，输出要求：',
  '1. 用中文，Markdown 格式，适合直接发在钉钉群里阅读，不要用表格（手机端显示会乱）。',
  '2. 结构：**项目名称（若无法判断则写「未命名项目」）** / 客户与场景 / 明确的需求 / ',
  '   技术要点（产品、产线、工位、接口、追溯层级等）/ 待确认的问题。',
  '3. 「明确的需求」只写聊天记录里真的有依据的内容，不要脑补、不要补充行业通用做法。',
  '4. 「待确认的问题」列出为了报价和实施必须问清、但记录里没说的点。',
  '5. 总长控制在 600 字以内。',
].join('\n');

/** 「谁是销售人员」的默认判别提示词。`{company}` 会被设置里的公司名替换。 */
export const DEFAULT_SALES_PROMPT = [
  '你是{company}的售前助理。下面是一个钉钉项目群的成员名单和最近聊天记录。',
  '',
  '任务：判断「谁是这个项目的销售人员」——也就是谁在把客户需求和项目信息带进这个群、',
  '谁是这个项目的商务负责人。一般是提出需求描述的那个人。',
  '',
  '硬性规则：',
  '1. 候选**必须排除**标记为「（我）」的那个人——他是在发布指令，不是需求提出方。',
  '2. 只能从成员名单里选人，不要编造名单外的人名。',
  '3. 如果聊天记录里看不出谁在提需求，就老实返回 low，不要猜。',
  '',
  '只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块：',
  '{"name":"姓名或空字符串","confidence":"high|medium|low","reason":"一句话理由","evidence":["依据1","依据2"]}',
].join('\n');

/** 内置默认值。settings.json 只覆盖它存在的那部分键。 */
export function defaultSettings() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return {
    // ── 总开关 ──────────────────────────────────────────────
    enabled: false,
    dryRun: true,
    dwellNote: 'dryRun=true 时只记录「本该发什么」，不会真的发送到群里。',

    // ── 路径与身份 ──────────────────────────────────────────
    dwsPath: 'dws',
    profile: '',
    settingsPath: join(home, 'presale', 'settings.json'),
    activityPath: join(home, 'presale', 'activity.ndjson'),
    watermarkPath: join(home, 'presale', 'watermark.json'),

    // ── 公司名 ──────────────────────────────────────────────
    //
    // 提示词里的 `{company}` 会被这个值替换。
    // 做成配置项而不是写死：这个插件的提示词要带上"以谁的口吻说话"，
    // 但公司名不该硬编码在代码里——否则换一家公司就得改源码。
    // 留空则 `{company}` 会退化成「我们公司」，提示词依然通顺。
    // 这是上游的公开默认值，所以不写具体公司名；在设置面板里填自己的即可。
    company: '',

    // ── 附件 ────────────────────────────────────────────────
    //
    // 钉钉服务端没有「在线读正文」的接口，文件必须先下载到本地才能解析。
    // 这里控制下载与解析的边界，避免某个大文件或一批附件拖死一轮梳理。
    //
    // 落点固定在 <DSH_HOME>/presale/attachments/（见 attachments.cacheDir）。
    // 刻意**不**放在 DSH 进程的工作目录——那会随启动方式变化，位置不可预测。
    attachments: {
      enabled: true,
      /** 单轮最多处理几个文件。 */
      maxFilesPerRun: 5,
      /** 单个文件体积上限（字节），超过就跳过并记明原因。 */
      // 默认 50MB 而不是 10MB：实测**售前方案 PPT 动辄 12–13MB**
      // （PPT 里塞的都是图片），10MB 会把最该读的方案书直接拒掉。
      // 体积大不代表正文长——提取出的文字仍受 maxCharsPerFile 限制。
      maxFileBytes: 50 * 1024 * 1024,
      /** 单个文件注入给模型的字数上限。 */
      maxCharsPerFile: 12000,
      /** 所有附件注入给模型的总字数上限（超出按顺序截断并显式告知）。 */
      maxTotalChars: 30000,
      /** 缓存有效期（天）：超期重新下载，防群里文件被替换后仍读旧内容。 */
      cacheTtlDays: 30,
      /** 缓存总量上限（字节）：超出按最久未访问淘汰。 */
      maxCacheBytes: 200 * 1024 * 1024,
      /** Python 可执行文件路径（仅用于解析 PDF）。留空则不尝试解析 PDF。 */
      pythonPath: '',
    },

    // ── 监听范围：默认全部会话 ──────────────────────────────
    scope: {
      allConversations: true,
      excludeConversationIds: [],
      includeTypes: ['group', 'single'],
    },

    // ── 轮询 ────────────────────────────────────────────────
    poll: {
      intervalSeconds: 30,
      jitterSeconds: 5,
      windowOverlapSeconds: 120,
      reconcileEveryMinutes: 5,
      reconcileWindowMinutes: 30,
      backoffMaxSeconds: 300,
      pageLimit: 100,
      maxPagesPerCycle: 10,
      commandTimeoutMs: 60000,
    },

    // ── 本人身份（留空 = 用 dws 自动锚定，无需手填）──────────
    owner: {
      userId: '',
      userName: '',
      openDingtalkId: '',
      // 同一账号在不同会话类型下可能有不同 ID（实测：群聊一个、单聊另一个）。
      // 自动锚定会自己收集别名；手填主 ID 时用这里补别名，避免漏掉单聊里的消息。
      aliasIds: [],
    },

    // ── 两个触发动作 ────────────────────────────────────────
    triggers: {
      provide: {
        keywords: ['提供完整项目需求'],
        prefix: '',
        cooldownSeconds: 60,
        template: DEFAULT_TEMPLATE,
        salesLookbackMessages: 60,
        salesPrompt: DEFAULT_SALES_PROMPT,
      },
      summarize: {
        keywords: ['梳理项目需求'],
        prefix: '',
        cooldownSeconds: 120,
        historyCount: 200,
        title: '【项目需求梳理】',
        prompt: DEFAULT_SUMMARY_PROMPT,
      },
    },

    // ── 发送与 @ ────────────────────────────────────────────
    mention: {
      enabled: true,
      minConfidence: 'high',
      textualMentionWhenMedium: true,
      fallbackToTriggerWhenUnknown: false,
      skipInSingleChat: true,
      maxTargets: 3,
    },

    // ── LLM ─────────────────────────────────────────────────
    //
    // 默认固定为 DeepSeek-V4.1-Flash。
    // 实测依据：DeepSeek 官方 /models 只返回 `deepseek-flash` 与 `deepseek-v4-pro`；
    // 而 DSH 自身的 agent-default-model 用的正是 deepseek-account / deepseek-flash，
    // 即界面上的 DeepSeek-V4.1-Flash。
    //
    // 之所以不两边留空走自动探测：探测结果是「第一个可用 provider」，
    // 会随 provider 注册顺序变化而漂移（今天 flash、明天可能是别的），
    // 对「生成要发给客户群看的文案」这件事来说不可接受。
    llm: {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      // 这个模型带推理，而**思维链也算输出 token**。上限给小了会出现
      // 「只产出思维链、正文为空」——实测踩到过（销售判别给 512 时必然为空），
      // 所以这里给足，并且 complete() 还会在空返回时自动加倍重试一次。
      maxTokens: 8192,
      timeoutMs: 60000,
    },
  };
}

// ───────────────────────── 校验原语 ─────────────────────────

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value, fallback, max = 2000) {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, max);
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value, fallback, min, max) {
  // 只接受数字或「看起来是十进制数字」的字符串。
  // 不能直接用 Number(value)：Number(null)===0、Number('')===0、Number(false)===0，
  // 于是 null 会被当成合法值 0 混进来（jitterSeconds 就踩过这个坑）。
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : NaN;
  if (!Number.isFinite(candidate)) return fallback;
  const r = Math.round(candidate);
  if (r < min || r > max) return fallback;
  return r;
}

function strArray(value, fallback, { max = 40, itemMax = 200 } = {}) {
  if (!Array.isArray(value)) return fallback;
  const out = value
    .filter(item => typeof item === 'string')
    .map(item => item.trim().slice(0, itemMax))
    .filter(item => item.length > 0)
    .slice(0, max);
  return out.length > 0 ? out : fallback;
}

/**
 * 深合并：以 base 的结构为准，patch 覆盖同名键，**未在 base 里声明的键也保留**。
 *
 * 保留未知键很重要：插件换代时新增/废弃字段，用户手写的配置不该被静默抹掉。
 * 早期版本只遍历 base 的键，结果嵌套层的未知键（如 poll 下的自定义项）会丢。
 */
function mergeKnown(base, patch) {
  if (patch === undefined) return base;
  if (isPlainObject(base)) {
    if (!isPlainObject(patch)) return base;
    const out = {};
    // base 的键：递归合并（保结构、补默认）
    for (const key of Object.keys(base)) out[key] = mergeKnown(base[key], patch[key]);
    // patch 独有的键：原样保留
    for (const key of Object.keys(patch)) {
      if (!Object.prototype.hasOwnProperty.call(base, key)) out[key] = patch[key];
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

// ───────────────────────── 归一化 ─────────────────────────

/**
 * 把（可能被手改坏的）配置归一化成插件能安全使用的形状。
 *
 * @param {unknown} raw - 磁盘上的原始配置对象。
 * @param {object} [opts]
 * @param {boolean} [opts.strict] - true 时不做类型回退（用于「保存前校验」）。
 * @returns {{ settings: object, warnings: string[] }}
 */
export function normalizeSettings(raw, { strict = false } = {}) {
  const d = defaultSettings();
  const warnings = [];
  const src = isPlainObject(raw) ? raw : {};

  // mergeKnown 保证结构存在，再逐字段做类型校验
  const merged = mergeKnown(d, src);

  const out = {
    ...merged,
    enabled: bool(merged.enabled, d.enabled),
    dryRun: bool(merged.dryRun, d.dryRun),
    dwsPath: str(merged.dwsPath, d.dwsPath, 500).trim() || d.dwsPath,
    profile: str(merged.profile, d.profile, 200).trim(),
    settingsPath: str(merged.settingsPath, d.settingsPath, 1000),
    activityPath: str(merged.activityPath, d.activityPath, 1000),
    watermarkPath: str(merged.watermarkPath, d.watermarkPath, 1000),
    // 公司名：提示词里 `{company}` 的替换值。允许留空（会退化成「我们公司」）。
    company: str(merged.company, d.company, 100).trim(),
  };

  // scope
  const scope = isPlainObject(merged.scope) ? merged.scope : {};
  out.scope = {
    ...scope, // 保住未知键
    allConversations: bool(scope.allConversations, d.scope.allConversations),
    excludeConversationIds: strArray(scope.excludeConversationIds, d.scope.excludeConversationIds, { max: 500 }),
    includeTypes: strArray(scope.includeTypes, d.scope.includeTypes, { max: 4, itemMax: 20 }),
  };

  // poll：自适应轮询的边界都在这里收紧，防止面板上填出「1 秒轮询」把配额打爆
  const poll = isPlainObject(merged.poll) ? merged.poll : {};
  const interval = int(poll.intervalSeconds, d.poll.intervalSeconds, 15, 300);
  out.poll = {
    ...poll, // 先摊开，保住 poll 下的未知键（换代不丢用户数据）
    intervalSeconds: interval,
    jitterSeconds: int(poll.jitterSeconds, d.poll.jitterSeconds, 0, 60),
    windowOverlapSeconds: int(poll.windowOverlapSeconds, d.poll.windowOverlapSeconds, 10, 3600),
    reconcileEveryMinutes: int(poll.reconcileEveryMinutes, d.poll.reconcileEveryMinutes, 1, 120),
    reconcileWindowMinutes: int(poll.reconcileWindowMinutes, d.poll.reconcileWindowMinutes, 5, 1440),
    backoffMaxSeconds: int(poll.backoffMaxSeconds, d.poll.backoffMaxSeconds, 60, 3600),
    pageLimit: int(poll.pageLimit, d.poll.pageLimit, 1, 100),
    maxPagesPerCycle: int(poll.maxPagesPerCycle, d.poll.maxPagesPerCycle, 1, 40),
    commandTimeoutMs: int(poll.commandTimeoutMs, d.poll.commandTimeoutMs, 5000, 600000),
  };
  if (poll.intervalSeconds !== undefined && interval !== poll.intervalSeconds) {
    warnings.push(`轮询间隔（poll.intervalSeconds）${String(poll.intervalSeconds)} 越界（允许 15–300 秒），已回退为 ${interval} 秒`);
  }

  // owner
  const owner = isPlainObject(merged.owner) ? merged.owner : {};
  out.owner = {
    ...owner, // 保住未知键
    userId: str(owner.userId, d.owner.userId, 100).trim(),
    userName: str(owner.userName, d.owner.userName, 100).trim(),
    openDingtalkId: str(owner.openDingtalkId, d.owner.openDingtalkId, 200).trim(),
    aliasIds: strArray(owner.aliasIds, d.owner.aliasIds, { max: 20, itemMax: 200 }),
  };

  // triggers
  const tr = isPlainObject(merged.triggers) ? merged.triggers : {};
  const provide = isPlainObject(tr.provide) ? tr.provide : {};
  const summarize = isPlainObject(tr.summarize) ? tr.summarize : {};
  out.triggers = {
    provide: {
      ...provide, // 保住未知键
      keywords: strArray(provide.keywords, d.triggers.provide.keywords, { max: 20 }),
      // 刻意不 trim：前缀尾随空格是有语义的（见 compileTrigger 的注释）
      prefix: str(provide.prefix, d.triggers.provide.prefix, 40),
      cooldownSeconds: int(provide.cooldownSeconds, d.triggers.provide.cooldownSeconds, 0, 86400),
      template: str(provide.template, d.triggers.provide.template, 8000),
      salesLookbackMessages: int(provide.salesLookbackMessages, d.triggers.provide.salesLookbackMessages, 10, 500),
      salesPrompt: str(provide.salesPrompt, d.triggers.provide.salesPrompt, 8000),
    },
    summarize: {
      ...summarize, // 保住未知键
      keywords: strArray(summarize.keywords, d.triggers.summarize.keywords, { max: 20 }),
      prefix: str(summarize.prefix, d.triggers.summarize.prefix, 40),
      cooldownSeconds: int(summarize.cooldownSeconds, d.triggers.summarize.cooldownSeconds, 0, 86400),
      historyCount: int(summarize.historyCount, d.triggers.summarize.historyCount, 10, 1000),
      title: str(summarize.title, d.triggers.summarize.title, 200),
      prompt: str(summarize.prompt, d.triggers.summarize.prompt, 8000),
    },
  };

  // mention
  const mention = isPlainObject(merged.mention) ? merged.mention : {};
  const conf = str(mention.minConfidence, d.mention.minConfidence, 10).trim().toLowerCase();
  out.mention = {
    ...mention, // 保住未知键
    enabled: bool(mention.enabled, d.mention.enabled),
    minConfidence: ['high', 'medium', 'low'].includes(conf) ? conf : d.mention.minConfidence,
    textualMentionWhenMedium: bool(mention.textualMentionWhenMedium, d.mention.textualMentionWhenMedium),
    fallbackToTriggerWhenUnknown: bool(mention.fallbackToTriggerWhenUnknown, d.mention.fallbackToTriggerWhenUnknown),
    skipInSingleChat: bool(mention.skipInSingleChat, d.mention.skipInSingleChat),
    maxTargets: int(mention.maxTargets, d.mention.maxTargets, 1, 10),
  };

  // llm
  const llm = isPlainObject(merged.llm) ? merged.llm : {};
  out.llm = {
    ...llm, // 保住未知键
    provider: str(llm.provider, d.llm.provider, 100).trim(),
    model: str(llm.model, d.llm.model, 200).trim(),
    maxTokens: int(llm.maxTokens, d.llm.maxTokens, 256, 32768),
    timeoutMs: int(llm.timeoutMs, d.llm.timeoutMs, 5000, 600000),
  };

  // attachments
  //
  // 这些上限的作用是"别让一个附件把整理流程拖死"。下限也给足，
  // 否则用户填 0 会让功能静默失效——宁可纠正成默认值并告警。
  const att = isPlainObject(merged.attachments) ? merged.attachments : {};
  out.attachments = {
    ...att, // 保住未知键
    enabled: bool(att.enabled, d.attachments.enabled),
    maxFilesPerRun: int(att.maxFilesPerRun, d.attachments.maxFilesPerRun, 1, 50),
    maxFileBytes: int(att.maxFileBytes, d.attachments.maxFileBytes, 1024, 200 * 1024 * 1024),
    maxCharsPerFile: int(att.maxCharsPerFile, d.attachments.maxCharsPerFile, 500, 200000),
    maxTotalChars: int(att.maxTotalChars, d.attachments.maxTotalChars, 1000, 500000),
    cacheTtlDays: int(att.cacheTtlDays, d.attachments.cacheTtlDays, 0, 3650),
    maxCacheBytes: int(att.maxCacheBytes, d.attachments.maxCacheBytes, 1024 * 1024, 10 * 1024 * 1024 * 1024),
    pythonPath: str(att.pythonPath, d.attachments.pythonPath, 1000).trim(),
  };
  if (out.attachments.maxTotalChars < out.attachments.maxCharsPerFile) {
    warnings.push('附件总字数上限小于单文件上限，单文件内容会被截断得更早；建议把总字数调大一些');
  }

  // 空模板是致命的（会发出空消息），strict 模式直接拒；非 strict 回退默认并告警
  if (out.triggers.provide.template.trim().length === 0) {
    if (strict) throw new Error('「提供完整项目需求」的文案不能为空');
    out.triggers.provide.template = d.triggers.provide.template;
    warnings.push('「提供完整项目需求」的文案为空，已回退为默认文案');
  }

  // 关键词为空：strArray 对「空数组 / 全无效项」会回退默认值，
  // 也就是说删光关键词不会让插件变哑巴，而是回到内置关键词。
  // 这是刻意的（用户误删不该导致完全失效），但必须让用户知道，
  // 否则他会以为「我清空关键词 = 停用」，结果插件又按默认关键词触发了。
  const ProvideFallback = JSON.stringify(out.triggers.provide.keywords) === JSON.stringify(d.triggers.provide.keywords);
  const SummarizeFallback = JSON.stringify(out.triggers.summarize.keywords) === JSON.stringify(d.triggers.summarize.keywords);
  const provideWasCleared = Array.isArray(src?.triggers?.provide?.keywords) && src.triggers.provide.keywords.length === 0;
  const summarizeWasCleared = Array.isArray(src?.triggers?.summarize?.keywords) && src.triggers.summarize.keywords.length === 0;
  if (provideWasCleared && ProvideFallback) {
    warnings.push('动作一的关键词被清空，已回退为内置关键词「提供完整项目需求」。若要停用该动作，请开启「触发前缀」或直接关闭总开关。');
  }
  if (summarizeWasCleared && SummarizeFallback) {
    warnings.push('动作二的关键词被清空，已回退为内置关键词「梳理项目需求」。若要停用该动作，请开启「触发前缀」或直接关闭总开关。');
  }

  return { settings: out, warnings };
}

/**
 * 把「关键词 + 前缀」编译成正则，供匹配用。
 *
 * 前缀的尾随空格**有语义**：用户在面板里填「DSH 」意思是必须说
 * 「DSH 梳理项目需求」。所以这里：
 *   1. 前缀用 normalizePatternText（保留首尾空格）；
 *   2. 关键词 trim 掉首尾空格后归一化；
 *   3. 拼接时若前缀不带尾随空格，**显式补一个空格当分隔符**——
 *      否则 normalizeText 已经把消息里的空格压成单空格，
 *      前缀与关键词会连在一起而失配。
 *
 * 由于归一化会转小写，正则一律带 i 标志。
 */
export function compileTrigger(trigger) {
  const rawPrefix = typeof trigger?.prefix === 'string' ? trigger.prefix : '';
  const keywords = Array.isArray(trigger?.keywords)
    ? trigger.keywords.filter(k => typeof k === 'string' && k.trim().length > 0)
    : [];
  if (keywords.length === 0) return null;

  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escaped = keywords.map(k => escape(normalizeText(k))).filter(k => k.length > 0);
  if (escaped.length === 0) return null;

  const prefixNorm = normalizePatternText(rawPrefix);
  const separator = prefixNorm.length > 0 && !prefixNorm.endsWith(' ') ? ' ' : '';
  try {
    return new RegExp(escape(prefixNorm + separator) + '(?:' + escaped.join('|') + ')', 'iu');
  } catch {
    return null;
  }
}
