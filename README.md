# dsh-presale · 钉钉售前助手

DSH 插件。在钉钉里说触发关键词，插件自动在**你说的那个会话**里发消息。

| 关键词（可改） | 动作 |
|---|---|
| 提供完整项目需求 | 发一段你可自定义的文案（如"请提供产品信息、产线数量、CAD 布局…"），并 **@ AI 判别出的销售人员** |
| 梳理项目需求 | 读该会话近期消息 → 交 DSH 的模型分析 → 把需求总结发回该会话 |

**入口**：设置 → 左侧导航「**售前助手**」（在「备份与迁移」下方）。

---

## 安装

```sh
dsh plugin add github:wu81313-lab/dsh-presale
```

前置条件：

- **DSH**（DeepSeek Harness）桌面版或 CLI
- **DingTalk Workspace CLI（`dws`）** 已安装并登录：`dws auth login`
  - 插件通过 `dws chat +search-msg` / `+chat-messages` / `+messages-send` 工作。
  - 首次安装默认 `enabled=false` + `dryRun=true`，**不会**自动往群里发消息。

安装后在设置里打开「售前助手」，按上面两个关键词试跑，确认满意再关掉试运行。

---

## 一、它不会做什么（先说清楚边界）

- **只有你本人发的关键词才生效**。同事在群里说同样的话，插件会记一条 `skipped`，但群里不会有任何反应。这是设计如此，不是故障。
- **默认不真发消息**。首次安装是「试运行」状态，只在活动记录里显示「本该发什么」。要真发，需要你手动关掉试运行。
- 不会替你做决定：判不出谁是销售人员时**不 @**，而不是随便 @ 一个人。

---

## 二、三条硬规则（都来自实测，踩过才写下来）

### 1. 为什么是"轮询"而不是"事件推送"

钉钉官方有长连接事件通道，但文档明确写着：

> 当前用户**自己发送的消息会被 self-loop 过滤**

也就是说长连接**收不到你自己的消息**。而本插件的触发条件恰恰是"只有我本人发才生效"，所以事件通道在这里用不上，只能轮询。

轮询的实现走的是一条全局搜索：

```bash
dws chat +search-msg --senders <我的ID> --start <RFC3339> --no-enrich --page-all
```

一次调用覆盖你**所有**群和单聊，不需要逐群扫（你有 400+ 个群，逐群扫不可能）。实测单次约 0.5–1 秒。

**顺手的好处**：不需要独占事件订阅锁，也不会在服务端残留订阅。

### 2. @ 必须在正文里写占位符

钉钉的硬要求：要 @ 人，正文里必须出现 `<@openDingtalkId>`，**同时**传 `--at-open-dingtalk-ids`。少一个就直接报错：

```
--at-open-dingtalk-ids 中的成员必须在正文中使用对应 <@openDingTalkId> 占位符
```

插件已自动处理。若带 @ 的发送失败，会自动去掉 @ 重发一次，保证文案本身一定送达。

### 3. 同一个账号会有多个 openDingtalkId

实测发现：主 ID（`D8HS2VhbIeHGbHEUVCofiSaQpBPqHZX0001`）覆盖 80 个会话，另有一个 ID（`…XZXxEY5`）只出现在**和自己的单聊**里。它们是同一账号在不同会话类型下的表示，**不是冲突**。

插件的处理：主 ID 取自群成员表（@ 需要的就是这个作用域的 ID），同时把消息里出现过的其他 ID 作为**别名一起监听**——否则会漏掉单聊里的关键词。

---

## 三、面板能配什么

| 分区 | 内容 |
|---|---|
| 运行状态 | 监听中/已停止、上次检查、上次命中、轮询间隔、消息水位、身份锚定状态、LLM 路由 |
| 总开关 | 启用监听、**试运行（dryRun）**、开始/停止、立即检查一次、重置水位、重新识别身份 |
| 动作一 · 提供完整项目需求 | 触发关键词、触发前缀（可选）、冷却秒数、文案内容（支持占位符） |
| 动作二 · 梳理项目需求 | 触发关键词、读取消息条数、冷却秒数、标题前缀、总结提示词 |
| @ 销售人员 | 开关、最低置信度、中等置信度是否降级为文本提及、判不出时是否 @ 自己、判别提示词 |
| 轮询与性能 | 轮询间隔、时间窗重叠、无命中退避上限 |
| 附件读取 | 是否读群文件、单轮文件数、单文件大小/字数、总字数、缓存有效期、Python 路径（PDF） |
| 附件缓存 | 缓存占用与文件清单、一键清空 |
| 模型 | provider / model（默认 DeepSeek-V4.1-Flash）、最长等待、**公司名**（提示词里 `{company}` 的替换值） |
| 试跑 | 填一个会话 ID，用真实数据跑完整链路，**只显示结果不发送** |
| 活动记录 | 每一轮的「发现 → 判定 → 发送/跳过」，含 @ 判定理由、附件处理结果与最终正文 |

> 「公司名」用于让模型以你的公司口吻说话（默认提示词里写作 `{company}`）。
> 留空会退化成「我们公司」，提示词仍然通顺。

### 读取群文件

钉钉服务端**没有「在线读文件正文」的接口**——文件是不透明的附件，只能先下载到本地再解析。
很多人只在群里丢一个需求文档就完事，不读附件等于漏掉核心需求（实测：一份 6075 字的
技术任务书，不读的话模型只能写出「文件无法读取，请重新上传」）。

下载与提取规则：

| 类型 | 处理 |
|---|---|
| `.docx` | 解析 `word/document.xml`，按段落还原正文（表格单元也纳入） |
| `.xlsx` | 解析共享字符串与工作表，输出 `表名 \| 单元格` 行 |
| `.pptx` | 逐页解析 `ppt/slides/slideN.xml`，带页码与演讲者备注；**按页码数字排序**（否则 1,10,11,2 会让模型看乱顺序） |
| `.txt` `.md` `.csv` `.json` `.xml` `.yaml` 等 | 直接读（UTF-8 优先，乱码则退回 GBK） |
| `.pdf` | 需要设置里的 Python 路径；多引擎自动探测（**PyMuPDF → pypdf**） |
| **图片** | 下载 → 注册为 DSH 附件 → **作为多模态内容块直接交给模型看** |
| 语音 / 视频 | 登记并说明「当前模型只支持文本与图像输入」——不假装处理过 |
| 旧版 Office（`.doc` / `.xls` / `.ppt`） | 二进制格式无法解析；**明确告知另存为新格式**再发 |
| 其它格式 | 登记并说明未支持，**不会假装读过** |

> **图片是"直接给模型看"，不是靠 OCR。** DeepSeek-V4.1-Flash 的模型目录声明了
> `inputModalities: ["text", "image"]`，DSH 的 attachments 服务负责把字节校验、
> 归一化并注册成 `{type:'image', attachment}` 内容块。所以群里的图纸、界面截图、
> 表格照片都能被读懂，图里的文字也会被读出来。
>
> 只接受 png / jpeg / webp / gif；尺寸或体积超限时会明确标注原因。
> 拿不到附件服务时降级为「只登记不交给模型」，**不会假装看过**。
>
> 判断图片**按文件头字节**而不是扩展名——钉钉对同一张图会给出两个 resourceId，
> 其中一个没有 `contentType`、也没有文件名，落盘成 `.bin`，按扩展名判就会被
> 误当成"不支持的格式"（实测踩到过，同一张图一条路读到了、另一条报不支持）。

### 读 PDF（需要配一次 Python）

PDF 无法零依赖解析，要走本机的 Python。**只需在面板「附件读取 → Python 路径」里
填一次解释器路径**，例如：

```
C:\Python314\python.exe
```

填 `python` 这类命令名也可以（会在 PATH 里找）。

需要在那个解释器里装一个 PDF 库，装哪个都行（插件会自动探测）：

```bash
C:\Python314\python.exe -m pip install pymupdf
```

> **为什么默认不锁定单一库**：实测本机两个 Python 能力不同——系统 Python 只装了
> PyMuPDF，DSH runtime 的 Python 一个 PDF 库都没有。写死 `pypdf` 的话，哪怕
> 路径配对也照样读不出来，而用户完全看不出是"库不对"还是"文件有问题"。
> 现在按 **PyMuPDF → pypdf** 的顺序探测，用第一个能用的。
>
> 缺库时的提示会**直接给出 pip 安装命令**（带上你填的那个解释器路径），
> 不用自己猜。

扫描件（只有图片层、没有文字层）会被明确标注「没有可提取的文字」，
不会返回空内容假装读到了。

**落点**：`~/.dsh/presale/attachments/`（面板「附件缓存」里能看到完整路径与占用）。

```
attachments/
  <resourceId 的哈希前 12 位>/
      <原文件名>        原件
      meta.json        来源、大小、下载时间
  extract/<同样哈希>.v<N>.txt   提取出的纯文本
```

> 提取结果的文件名带 `<N>` 版本号（`CACHE_VERSION`）。**改动提取行为时必须 +1**，
> 否则旧的结论会被继续命中——功能明明改好了却依旧读不到，而且从外面完全看不出
> 是缓存的锅（实测踩到过：图片支持上线后，旧的「图片不支持」结论仍在生效）。

用哈希做目录名而不是原文件名，既避免同名文件互相覆盖，也避免文件名里的 `..` 造成路径穿越。

**缓存**：同一个文件第二次遇到直接命中，不再走网络。有效期默认 30 天（防群里文件被替换后
仍读旧内容）；总量默认 200MB，超出按最久未访问淘汰。下载与解析都有上限（单轮 5 个文件、
单文件 50MB、单文件 1.2 万字、总注入 3 万字），超限会在提示词里**显式告知模型**，而不是静默丢掉。

> 单文件上限默认 50MB 而不是 10MB：实测**售前方案 PPT 动辄 12–13MB**（PPT 里塞的
> 都是图片），10MB 会把最该读的方案书直接拒掉。体积大不等于正文长——提取出的文字
> 仍受字数上限约束，所以放大体积上限不会挤掉聊天记录。

**安全性**：附件正文与聊天记录同为**不可信数据**，提示词里明确要求模型只当作资料、
忽略其中的任何「指令」。

---

**改动即时生效**，不需要重启 DSH。

### 模型：默认 DeepSeek-V4.1-Flash

默认路由是 `deepseek-account` / `deepseek-flash`，也就是界面上的 **DeepSeek-V4.1-Flash**。

实测依据（三层印证）：

1. `dsh-llm-deepseek` 的模型目录里写得很直接：`{ id: "deepseek-flash", name: "DeepSeek-V41-Flash" }`；
2. DSH 自身的 `agent-default-model` 用的也正是这一对；
3. `dsh-api-session-controller` 登录后用 `provider = "deepseek-account"` 并取该 provider 下的第一个模型。

**为什么不"自动选第一个可用模型"**：那样结果会随 provider 注册顺序漂移（今天 flash、明天可能是别的），而这里生成的是要发到客户群里的文案，模型换了直接影响输出质量和风格。所以只在**默认路由确实不可用**时才回退到自动探测，并在「运行状态」里把来源标为 `auto` 提醒你。

路由优先级：显式配置 → 默认（V4.1-Flash）→ 自动探测。只填一半（只填 provider 或只填 model）时，另一半用默认值补齐。面板「运行状态」里的 `LLM 路由` 会显示 `provider / model（来源）`，来源为 `settings` / `default` / `auto`。

### 文案可用占位符

`{senderName}` 触发人 · `{groupName}` 群名 · `{keyword}` 命中的关键词 · `{date}` 日期 · `{time}` 时间 · `{salesName}` 判出的销售姓名

未识别的占位符会**原样保留**并在提醒里列出（不会静默吃掉——那样你只会看到文案少一句，不知道是自己写错了）。

---

## 四、@ 判定的护栏

插件会读该会话的近期消息，让模型判断"谁在把需求和项目信息带进这个群"，通常是提出需求描述的那个人。

**模型必须排除你自己**（你是在发指令，不是需求提出方）——这条写进了提示词，聊天记录里你的发言会被标注为「（我·非销售）」。

处置规则（把误 @ 归零）：

| 置信度 | 行为 |
|---|---|
| `high` 且姓名在成员表唯一命中 | **真 @** |
| `medium` | 不真 @，正文写纯文本「@姓名」（不触发提醒） |
| `low` / 判不出 / 返回非 JSON / 姓名不在名单 | **不 @**，记录原因 |

阈值可在面板调整。理由：群里 @ 错人比不 @ 更尴尬。

---

## 五、性能

实测数字（本机）：

| 项 | 值 |
|---|---|
| 一次全局搜索（空窗口） | ~550 ms |
| 一次全局搜索（有结果） | ~1 s |
| 其中 node 进程冷启动 | 67 ms |
| 30 秒轮询的 CPU 占用 | 约 3% |

**四道护栏**：
1. 轮询间隔下限 15 秒（填 1 秒会被自动纠正）；
2. 连续无命中自动退避（30s → 60s → 120s，封顶 300s），有命中立刻回落；
3. 单次调用有超时，且上一轮没结束不会发起下一轮；
4. 撞到限流或"未读全"也会拉长间隔，不硬打。

真正的成本在**触发时**的 LLM 调用（仅在关键词命中时发生）。

---

## 六、出问题时怎么查

### 第一步：看面板「运行状态」

| 现象 | 原因 | 处理 |
|---|---|---|
| 身份未锚定 | 取不到会话做取样点，或 dws 未登录 | 点「重新识别身份」；或在设置里手填 openDingtalkId |
| dws 未登录标红 | token 过期 | 执行 `dws auth login` 重新扫码 |
| LLM 不可用 | DSH 的模型服务未就绪 | 检查设置 → 模型 |
| 连续无命中很大 | 正常（空转），间隔已自动拉长 | 无需处理 |

### 第二步：看「活动记录」

每一条都写明动作、决策、@ 判定理由。常见决策：

- `dry-run` —— 试运行，只记录没发
- `sent` —— 真发了
- `skipped / cooldown` —— 距上次触发不足冷却时间
- `skipped / not-owner` —— **不是你发的**（设计如此）
- `failed` —— 附带 dws 原始错误

### 第三步：命令行自检

```bash
cd ~/.dsh/plugins/dsh-presale

node --test "lib/test/*.test.mjs"       # 单元测试（105 项，不需要真实钉钉数据）
node tools/selftest-assembly.mjs         # 装配自检（mock ctx，不联网）
node tools/selftest-client.mjs           # 客户端半边自检
node tools/selftest-live.mjs             # 真实链路（只读，打本机 dws）
node tools/selftest-send-quoting.mjs     # @ 占位符与多行正文能否到达 dws（dry-run）
node tools/selftest-real-template.mjs    # 用你配置里的真实文案走一遍发送（dry-run）
node tools/selftest-full-chain.mjs       # 完整链路：成员表 → 历史 → @ 编排 → 发送预检
node tools/selftest-attachments.mjs      # 附件链路：真实下载 → 提取正文 → 缓存命中
node tools/selftest-pptx-real.mjs        # 用 python-pptx 生成真实 PPT 验证解析器
node tools/selftest-pdf-real.mjs         # 用 PyMuPDF 生成真实 PDF 验证解析链路
```

拿**真实群文件**验证（不是自己造的样本）：

```bash
node tools/probe-real-files.mjs <会话ID>   # 跑该群里所有 docx/xlsx/pptx/pdf
node tools/probe-pdf-in-group.mjs <会话ID> # 从该会话里找 PDF 并解析
```

**需要真实钉钉数据的自检要先用环境变量提供夹具**（仓库里不含任何真实 ID）：

```powershell
setx DSH_PRESALE_TEST_GROUP  "cid…"        # 一个真实群会话 ID
setx DSH_PRESALE_TEST_GROUP2 "cid…"        # 第二个群（建议有真实项目讨论）
setx DSH_PRESALE_TEST_OID    "D8HS…"       # 该群里任意成员的 openDingtalkId
setx DSH_PRESALE_TEST_NAME   "张三"         # 上面那个成员的显示名
```

没配夹具时，这些检查会**跳过并明确说明缺哪个变量**，而不是拿假 ID 得出"看起来通过"的结论。

诊断脚本（只读，排查用）：

```bash
node tools/selftest-attachments.mjs          # 附件链路：下载 → 提取 → 缓存命中（加 --clear 清缓存）
node tools/diagnose-attachment-cache.mjs     # 附件缓存落盘情况与上限对照
node tools/diagnose-image-cache.mjs          # 图片类附件是否会重复下载
node tools/diagnose-sniff.mjs <文件>          # 按文件头判断某个文件是不是图片
node tools/diagnose-pdf.mjs <pdf> <python>   # PDF 解析失败时看 Python 侧的真实报错
```

**图片通道要在 DSH 会话里用工具验证**（外部脚本没有 `ctx`，验不了）：

```
presale_image_selftest conversationId="cid…"
```

它会下载一张真实群图片、注册成 DSH 附件、再让模型描述它——用来确认
「模型能识别图片」这条路是通的。
node tools/diagnose-oid.mjs        # openDingtalkId 在群成员表与消息里是否一致
node tools/diagnose-oid2.mjs       # 两个 ID 的作用域差异
node tools/diagnose-senders.mjs    # --senders 多值时是否仍在过滤
node tools/diagnose-argchars.mjs   # 逐字符找出文案里过不了参数校验的字符
node tools/probe-models.mjs        # 当前可用的模型与默认路由
```

### 在 DSH 会话里直接问

- `presale_status` —— 状态 + 最近活动
- `presale_llm_selftest` —— **在真实运行环境里测一次 LLM 调用**，返回实际路由与调用细节（chunk 分布、正文/思维链字数、结束原因）。「@ 判别失效」或「梳理需求失败」时先跑它
- `presale_recent_mine` —— 最近我发的钉钉消息（验证发现层）
- `presale_send_text` —— 主动发一条（**写操作**，需显式确认）

### LLM 返回空内容怎么办

这个模型带推理，而**思维链也算输出 token**。上限给小了会稳定出现「只有思维链、正文为空」——实测踩到过（销售判别一开始只给 512 token，必然为空）。

现在的防护：

1. 默认上限 8192（不是 2048）；
2. 销售判别起点 2048；
3. **空返回且只有思维链时，自动把上限加倍重试一次**（只在这一种情况下重试；超时/路由错/未登录重试没意义，不会白打配额）；
4. 失败信息会点明成因，例如「模型只产出了思维链（1200 字）而没有正文，通常是输出上限 512 被推理吃光」。

跑 `presale_llm_selftest` 能看到 chunk 类型分布与结束原因，一眼判断是 token 不够、路由不对还是账号未登录。

---

## 七、已知限制

1. **必须由你本人触发**。这是需求约束，不是缺陷。
2. **轮询有延迟**：默认 30 秒，最坏情况一个周期 + 处理时间。
3. **搜索依赖服务端索引**，理论上可能延迟；因此窗口刻意带 2 分钟重叠，并有「最近活跃会话补查」作为第二条独立路径。
4. **判不出销售时不 @**：宁可安静，也不 @ 错人。
5. **单聊里不 @**（@ 在单聊无意义），但消息照常发。
6. `dws` 升级后建议跑一次 `selftest-live.mjs`，因为本插件依赖的具体命令契约（字段名、信封结构、错误措辞）是实测得来的。

---

## 八、文件结构

```
lib/
  index.js             宿主入口：装配全部组件
  config.js            默认值、校验归一化、关键词编译
  settings.js          设置文件原子读写 + mtime 热读
  activity.js          活动日志（内存环形缓冲 + ndjson 落盘）
  dws.js               dws 调用封装（参数白名单 + 超时 + 错误分类）
  identity.js          身份锚定（主 ID + 别名）
  discover.js          发现层（全局搜索 + 备用通道 + 关键词匹配）
  watermark.js         水位（时间 + messageId 双条件去重）
  conversation-data.js 群成员表与历史消息
  llm.js               LLM 调用（需求梳理 + 销售判别）
  send.js              发送（@ 契约 + 本地校验）
  render.js            模板渲染
  handler.js           两个动作的完整链路
  poller.js            轮询编排（自适应退避）
  web.js               面板 HTTP API
  tools.js             三个 DSH 工具
  test/                单元测试
client/
  client.js            设置面板（注册 settings.section）
tools/                 自检与诊断脚本
cordis.patch.yml       插件装载声明
```

## 九、装卸

**已装**（无需再操作）：

- 代码：`~/.dsh/plugins/dsh-presale`
- profile 的 `package.json` 里 `dependencies` 有 `"dsh-presale": "link:…"`，`dsh.profile.bundles` 里已加入 `"dsh-presale"`
- 链接：`~/.dsh/profiles/desktop/node_modules/dsh-presale`（junction）

**卸载**：从 profile 的 `package.json` 里删掉上述两处，删除链接与代码目录。备份在 `package.json.bak-before-presale-*`。

**改完代码**：

- 改 `lib/`（宿主半边）→ **必须重启 DSH**。DSH 在启动时加载插件模块并缓存，改磁盘上的文件不会热生效。若发现"明明改了却没反应"，先检查运行中的实例是不是旧代码：状态页里有没有你新加的功能。
- 改 `client/client.js` → 刷新页面即可（若 `pnpm run dev:web` 在跑则自动热更）。
- 改 `cordis.patch.yml` → 重启 DSH。
