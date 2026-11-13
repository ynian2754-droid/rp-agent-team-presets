# Local Aliveness / 局部生命感：预设设计说明

状态：**设计稿 v2（按作者第一轮意见修订），仍待审核**。本文不是可导入的成品预设，也没有安装、试跑或写入任何聊天。

核对日期：2026-10-05

---

## 0. 基线与核对范围

| 项 | 实际情况 |
|---|---|
| 插件源码 | `C:\Users\O4\Desktop\agent rp team\GitHub\rp-agent-team`，分支 `main` |
| HEAD | `ee6d43a90aaa534e6a635df97b0fd4dd3856db6b`（父提交 `fc2e5a0…`），与交接说明一致 |
| 工作区 | tracked 文件无改动；未跟踪目录有 `docs/upstream-host-audit/`（另一项工作）和 `docs/handoffs/`（内含本次交接说明）。两者都已保留，没有动 |
| 插件 / 配置版本 | 0.4.0 / `schemaVersion: 2` |
| 本次做了什么 | 只读核对源码，写出并修订本文（v2）。没有改代码或配置，没有调用模型，没有运行 Trial，也没有重新跑测试（交接说明记录的 83 项离线测试是上一位执行的） |

本次为确认设计能落地，逐项读过的源码（相对源码根目录）：

- `src/shared/schema.mjs`：Team/Agent/Trigger/Context/Communication/Handoff/State/Limits 的规范化与校验
- `src/shared/value-schema.mjs`：只支持 `type/properties/required/items/enum/minimum/maximum`
- `src/shared/author-parameters.mjs`：参数类型、绑定目标、`text` 模式只适用于 text 参数
- `src/shared/memory.mjs`、`src/host/memory-tools.mjs`：集合绑定、搜索、add/update/archive 的实际约束
- `src/host/event-triggers.mjs`、`src/host/scheduler.mjs`：periodic/state_changed/condition 的匹配，以及“没触发就 skipped、之后仍可重新排队”
- `src/host/communication.mjs`：send/request 的 ACL、handoff 强制、结果回传的 ACL
- `src/host/state-store.mjs`：路径声明、子路径读写、CAS 版本
- `src/host/agent-context.mjs`、`src/host/context-world-adapter.mjs`：子会话提示词与上下文投影
- `src/host/native-policy.mjs`、`src/host/runtime.mjs`（工具分组、`spawnTeammate`、`captureStateBefore/notifyStateChanged`）
- `src/host/trials.mjs`、`src/host/trial-worker.mjs`：场景、initialState、四种断言

### 0.1 交接说明没写明、但影响设计的源码事实

1. **成员子会话是 `context: 'fresh'`，提示词只有“策略说明 + 过滤后的上下文包”**（`runtime.mjs` `spawnTeammate` 调用；`agent-context.mjs:childPrompt`）。宿主侧的会话上下文也经 `projectConversationContext` 按成员来源投影：没选 `current_input` 时 `currentUserInput` 为空串，没选历史时 `history` 为空。所以“Actor 不读原始输入”是一条**硬边界**。唯一的例外是挂载的原生 Agent preset 自带的系统提示词，它在上下文包之外，需要在 Preview 中核对。
2. **只要发送方对某目标声明了任意一条 handoff，发给该目标的普通 `rp_team_send`、普通 `rp_team_request` 和 `to:"*"` 广播都会被拒绝**（`RP_TEAM_HANDOFF_REQUIRED`）。因此本设计的每一条通信边都显式声明为 handoff。这样还能顺带得到 requestSchema 校验。
3. **await/resume 发起时就检查回传 ACL**：目标的 `sendTo` 必须含调用方，调用方的 `receiveFrom` 必须含目标（`communication.mjs:96`），否则请求直接失败。
4. **state_changed 比较的是触发器自己的路径**，不是被写入的路径。`captureStateBefore` 会以监听成员的身份读取触发路径的前值，写入后再读后值（`runtime.mjs:672-694`）。所以可以监听一个对象内部的叶子（如 `/perception/current/signals/body`）：写整个对象时，只有这片叶子真的变了才触发。
5. **StateStore 允许读写已声明路径的子路径**（`state-store.mjs:stateDefinition` 取最长前缀）。可以只声明一个 `/microstate` 对象，再按叶子授权读取，例如 Inhibition 只读 `/microstate/embarrassment`。
6. **调度器在第一轮循环就把未触发的成员标为 `skipped`**，但之后的 state_changed、condition 或 request 仍能把它重新排队（`scheduler.mjs:69-94, 489`）。`after` 检查的是此刻的状态：已重新排队的成员不算结束，依赖它的成员会继续等。
7. **记忆 update 的 patch 不能含 `id/createdAt/updatedAt/active`**。改 `active` 必须用 archive/restore。
8. **`capabilities` 非空时进入显式模式**，只保留 `enabled:true` 的类别。全部写成 `enabled:false` 就只剩 `rp-team` 组（`native-policy.mjs:allowedGroupsForAgent`）。所有 `rp_team_*` 名称的工具，包括 `rp_team_memory_*`，都归入这个组（`runtime.mjs:classifyTool`）。
9. Trial 的 `initialState` 行形状是 `{namespace, path, value}`，以作者状态编辑（`operation:'set'`）写入，两个方案都会执行，因此路径必须在两个方案中都声明。
10. **成员消息不跨轮保存**：新一轮从空信箱开始（`runtime.mjs:512`）；只有"明确重试"会把已完成且不在重试名单里的成员的消息带过来（`runtime.mjs:529-533`）。所以"上一轮没送出去的消息漏到下一轮"不存在；同一轮内消息入信箱后即对目标可见，但整轮失败时信箱随运行一起作废。
11. **工具报错 ≠ 激活失败**：工具错误只是还给模型的结果，会话正常结束就记 `complete`（`scheduler.mjs:326-363`）。反过来说，输出成员正常结束但没有 `rp_team_publish` 时，整轮按 `RP_TEAM_PUBLICATION_REQUIRED` 失败（`runtime.mjs:656, 948`）——这给"没收到感知就拒答"留了一个硬出口。
12. **`rp_team_write_state` 一次只暂存一条路径**（`team-tools.mjs:72`），"同一步写状态和发消息"没有原子性；能控制部分失败后果的只有步骤顺序（见 §6.3）。
13. **condition 支持的判定**：`exists` / `compare`（eq、ne、gt、gte、lt、lte，只跟字面量比）/ `all` / `any` / `not`（`schema.mjs:402-425, 648-669`）。没有"数组里含未处理项"这类运算，也不能把两条路径互相比。同一个 condition 触发器每轮至多命中一次（`scheduler.mjs:133` 的 `firedConditions`）。
14. **宿主侧的两块结构**（ElecKoi，固定基线）：角色卡 `persona` 是 loose 对象，固定键只有名字/头像/开场白/用户资料，其余字段由卡的写法决定——selector 只能整字段地选，拆不开一个长文本字段的内部。变量状态由"变量配置"里声明的对象树生成（`initialState.ts: buildVariableState`），新键 `local_aliveness_truth` 要作者先在宿主变量配置里声明；插件和成员都不能代建。

---

## 1. 目标、非目标与三层划分

### 1.1 目标声明（原样保留）

> This preset does not guarantee the smartest, most helpful, or most user-pleasing response on every turn. Causally plausible misunderstanding, omission, hesitation, trivial association and imperfect expression are intentional when they arise from the character's current cognition.

中文说明：这套预设不保证每一轮都给出最聪明、最有帮助、最讨用户喜欢的回应。只要误解、遗漏、犹豫、琐碎联想和不完美表达来自角色此刻的认知状态，就是有意保留的效果。

### 1.2 设计目标

- **有限注意**：角色每轮只“注意到”少数东西。没注意到的内容，表达成员在机制上就看不到。
- **竞争解释**：同一句话可以同时保留几种理解，并带有信心和证据，跨轮修正。
- **状态惯性**：精力、烦躁、尴尬、背景焦点和未完成的小目标会缓慢变化，并持续影响行为，但不直接写进台词。
- **琐碎记忆**：一个小线索可以唤起一段不重要的生活记忆。“什么都没想起来”也是合法结果。
- **表达抑制**：想说的和说得出口的明显冲突时，才限制“说到什么程度”。

### 1.3 非目标

- 不保证每轮推进剧情、制造冲突、升级关系或给用户惊喜。
- 不追求“完美理解用户”，也不追求“每轮都出点错”。
- 不实现心理学模型；数值只是给模型的有限提示，不是可计算的情绪。
- 不改 Runtime，不增加 schema 字段、向量检索、后台时钟或评分器。
- 不是“主笔 + 审稿 + 剧情推进”。没有任何成员负责润色正文或评判写作质量。

### 1.4 三层标签

| 标签 | 含义 | 本文怎么用 |
|---|---|---|
| **[Runtime]** | 源码已实现、可测试的机制 | 只写已在第 0 节核对过的内容 |
| **[Preset]** | 这套预设的选择 | 成员分工、路径、提示词、预算，都可以改 |
| **[Hypothesis]** | 待实验验证的效果 | 第 13 节集中列出，不写成结论 |

---

## 2. 与交接候选结构的差异及理由

保留了六个成员及其 ID、三常驻（perception/belief/actor）、两稀疏（microstate/association）、一按需（inhibition）的总体节奏。具体改动如下：

| # | 候选结构 | 本设计 | 理由 |
|---|---|---|---|
| D1 | `/signals/body_cue`、`/signals/interaction_cue` 两条独立路径 | 并入 `/perception/current/signals/{body,interaction}` | 每轮 Perception 少一次读和一次写。state_changed 可以监听对象内的叶子（0.1-4），写整个对象时，只有信号叶子变了才唤醒 Microstate |
| D2 | 微状态拆成 7 条叶子路径 | 一个 `/microstate` 对象，读权限仍可按叶子授予 | 读写各一次就能完成；子路径授权已核对（0.1-5） |
| D3 | 待记忆片段带 `processed` 字段，由 Association 标记 | ~~Perception 是唯一写入者~~ → **已被 D11 修正**：Association 整理后把看过的从队列删掉，`/memory/processed_cues` 保留为台账 | 旧的单写入者方案会让队列永远非空、整理触发器反复空跑 |
| D4 | microstate→actor 按需发消息 | 不设这条边，Actor 每轮直接读 `/microstate` | 稀疏轮和更新轮走同一条路径，旧值不会被误当作本轮新消息 |
| D5 | Association 可另外 notify Actor | Association 只回传给请求者；Belief 把至多 1 条已选回忆放进发给 Actor 的视图 | 少一条边；回忆经 Belief 筛选后再给 Actor，路径更短、更可审计 |
| D6 | Association 可试低频 periodic | 改为 `condition: exists /memory/pending_cues/0` 加 `cooldownTurns: 3` | periodic 会在“从来没有待处理片段”时空跑；condition 只在确有片段时才可能运行，并受冷却限制 |
| D7 | Perception 失败可继续 | Perception `onFailure: "stop"` | 在严格感知门控下，Perception 是 Actor 了解本轮输入的唯一渠道。它失败后若继续，Actor 只能回应一条它看不到的消息。宁可整轮失败、让用户重试 |
| D8 | 预算 maxRequests=20、maxReportedTokens=20000、180s | maxRequests=24，**先不启用 token 上限**，maxElapsedMs=240000 | 按第 9 节逐成员估算，最坏的计划内轮次正好约 24 次请求，20 会让少数完整轮次整轮失败。每次请求都会带上原生 preset 系统提示词和上下文包，20000 tokens 可能几次请求就用完；服务商不报告用量时还会直接停止。串行关键路径最多约 18 次请求，180s 偏紧。三项都是**待测起点** |
| D9 | 可另外提供初始能量参数 | 首版不提供 | `/microstate` 是一个对象，单个数字参数无法用 `state_default` 只改其中一个字段；为此再声明嵌套定义会让“哪个默认值生效”变得难懂。而且 default 只初始化缺失节点，容易被误解为“立刻改能量” |
| D10 | 可选 world 事实记忆集合 | 首版不声明 | 没有成员负责世界事实，声明了也没人维护 |
| D11 | 待记忆片段留在队列里，Association 只记已处理 id | `/memory/pending_cues` 只放**未处理**片段：Association 整理后把它看过的从队列删掉 | 旧设计的 condition `exists /0` 在“队列里只剩已处理片段”时永远为真，整理任务每轮空跑。condition 没有“数组含未处理项”的判定（0.1-13），最省事的真值来源就是让队列本身只含未处理项 |
| D12 | 感知先概括再传话 | `source:"heard"` 的条目 `content` 里尽量保留**原句**，解释只进 uncertainties | Actor 看不到原文，感知若先翻译成“用户在生气”，误解就发生在管道里而不是角色身上。允许遗漏，不要求每轮制造误解 |
| D13 | “同一步写状态和发消息”当作原子操作 | 各成员按固定收尾顺序：`actor_view` 只在送达成功后写；Actor 的 publish 永远是最后一个工具调用 | 工具调用是顺序 RPC，每次都可能单独失败（0.1-12）。排序让“最近一次送达的视图”这类语义在部分失败下依然成立 |

---

## 3. 总体拓扑与一轮时序

```text
            ┌────────────── percept-to-belief (notify) ──────────────┐
本轮输入 ─→ perception ──── percept-to-actor (notify) ───────────────┼────────→ actor ──→ 唯一正文
   │            │ 写 /perception/current（含 signals）              │            │  ▲
   │            └─ signals 变化 ─(state_changed)─→ microstate ──写 /microstate ─┘  │
   │                                                                 ↓            │
   │                                                              belief ─ belief-view-to-actor (notify)
   │                                                                 │ ▲
   │                                              belief-recall(await)│ │结果
   │                                                                 ▼ │
   │                                                            association ◀── actor-recall(await)
   │                                                                              actor-restraint(await) ──→ inhibition
   └─ （Actor 不直接读本轮输入）
```

调度 **[Runtime]** 与约定 **[Preset]**：

1. `perception`（always）先跑。
2. `belief`（always，after perception）。`microstate` 若因 periodic 或信号变化被触发，在 Perception 结束后和 Belief 并行。
3. `actor`（always，after perception、belief、microstate）。Microstate 没触发时已是 `skipped`，不会阻塞。
4. `association` 和 `inhibition` 只在被 await 时运行。await 期间调用方释放调度槽，结果回来后在同一次激活中继续。
5. Actor 调用 `rp_team_publish`。之后由宿主交付、确认回执，再整体提交本轮状态。

**等待环检查**：`after` 图为 perception ← belief ← actor，perception ← microstate ← actor，perception ← association，没有环。await 边是 belief→association、actor→association、actor→inhibition。Association 只 after perception，Inhibition 没有 after，都不依赖调用方，所以不存在等待环。Runtime 也会拒绝固定依赖环和自等（`validateExecutionGraph`、handoff 自身目标校验）。

---

## 4. 成员规格

以下各成员**共同**的设置：

```json
"presetId": "",
"compaction": {},
"capabilities": [
  {"id": "builtin:web", "enabled": false},
  {"id": "builtin:setting-library", "enabled": false},
  {"id": "builtin:variables", "enabled": false},
  {"id": "builtin:workflow", "enabled": false},
  {"id": "builtin:roleplay-workflow", "enabled": false}
]
```

- 显式列出并全部关闭，结果只剩 `rp-team` 组（0.1-8）。**不要写 `capabilities: []`**，空数组会继承根会话的工具类别。`execution.trustedTools: []`。
- `presetId: ""` 会继承挂载的原生 preset。**Preview 时要检查**该 preset 的系统提示词有没有写“请写出角色回复”这类指令，或者注入了角色卡、世界书全文。如果有，后台成员应改用一个精简的原生 preset。这一项只能由作者在 Preview 中确认，本文不假定。
- 后台成员会话短、用完即弃，不需要压缩。

### 4.0 角色卡：自知资料方案（先查后定）

已核对 **[Runtime / 宿主]**：

- `character_card` 投影出来是 `{id, name, persona}`；`persona` 是 loose 对象，固定键只有 `assistant_name`、`assistant_avatar`、`assistant_square`、`assistant_cover`、`opening`、`show_opening`、`user_name` 等身份/外观字段，其余键完全取决于这张卡实际怎么写（0.1-14）。
- 来源的 `selector` 是 JSON Pointer，只能**整字段**地选（如 `/persona/personality`），不能从一个长文本字段里拆出其中几句。同一个 type 写多条会按指针合并回一个对象，所以"每个自知键各写一条"是合法写法。
- selector 指到的键不存在时，这个来源被静默跳过（`context-policy.mjs`），不会报错。

方案 **[Preset]**：

1. **首选（字段级裁剪）**：作者在 Preview / Context Catalog 里看这张卡的 `persona` 实际有哪些键，标出"角色自己知道"的键；各读卡成员分别写若干条 `{"type":"character_card","selector":"/persona/<键名>"}`。没选的键（作者注、剧情伏笔、对方秘密）不会进入任何成员的上下文。
2. **兜底（作者维护的自知资料）**：自知内容混在长文本字段里拆不开时，启用共享路径 `/character/self_known`（§6.1 #15），由作者用状态编辑维护一份"角色自己知道的设定"；相关成员加一条 `read` 权限后用 `rp_team_read_state` 读。代价：手工维护，和卡会脱钩，改卡时要记得两边同步。
3. **过渡默认**：在 1 或 2 落地之前，各成员**不配**全卡，只放最无害的 `{"type":"character_card","selector":"/persona/assistant_name"}`。宁可先没有——成员看到过一次的秘密收不回来。

**已核对 dev 卡并获作者裁定（2026-10-05，只读 SQLite 导出）**：目标卡"陈加怡"的自知内容混在 `persona.opening` 长文本与设定库条目（世界设定/基础信息/性格调色盘/外貌/语料库/标签事件）里，字段级 selector 拆不开"她知道的"和"作者写的"。**按方案 2 执行**：作者手工维护 `/character/self_known`，审核稿见 `SELF_KNOWN_DRAFT_陈加怡.zh-CN.md`。同时按作者裁定增设 `/character/inner_directives`（#16）：内在矛盾这类深层动机只作后台认知模块的作者指导，actor、perception 不读，不得转述成她的自我陈述，不要求每轮体现。作者裁定的知情边界：感知通道不赋予也不否认，只记现实观察；知情者只保留"别人在场、有默契"一层；标签事件只收她目击/听到的部分（"断章取义"不写成她已知）；性格倾向不等于知识，不自动扩展成未列出的细节；私人记录只列她说过的几样、注明非全部。未定的设定层真相（通道归属、知情者名单、标签真相、记录全文）不进任何运行时状态。

### 4.1 perception：有限注意

| 字段 | 值 |
|---|---|
| 职责 | 从本轮输入和可感知环境中挑出少数 foreground/background，保留原话，标出可观察信号，必要时记下一条琐碎片段 |
| triggers | `[{"type":"always"}]` |
| execution | `{"after": [], "onFailure": "stop", "trustedTools": []}`（见 D7） |
| context.sources | `{"type":"current_input"}`；`{"type":"recent_history","limit":4}`；`{"type":"character_card","selector":"/persona/assistant_name"}`（Perception 不读自知资料与后台指导，只看输入）；`{"type":"hidden_state","selector":"/variables/local_aliveness_truth/sensory"}`（可选接入，键不存在时这项来源被跳过，见 §6.1 注） |
| 不给 | worldbook、full_history、agent_messages、drafts |
| outputAuthority | `{"internal": true, "draft": false, "state": true, "user": false}` |
| 模型能力 | 便宜、稳定，能可靠调用工具、输出结构化结果；不需要 reasoning |

`recent_history` 的 `limit` 按**条目**算（`schema.mjs` 默认 12），4 条大约是最近两轮往返，用来察觉“回复突然变短”或“刚才那个问题”。宿主把历史和 `currentUserInput` 分开提供（`projectConversationContext`），本轮输入不重复计入历史；Preview 时仍应确认一次。

statePermissions：

```json
[
  {"namespace": "shared", "path": "/perception/current", "access": "readwrite"},
  {"namespace": "shared", "path": "/continuity/subjective", "access": "readwrite"},
  {"namespace": "shared", "path": "/memory/pending_cues", "access": "readwrite"},
  {"namespace": "shared", "path": "/memory/processed_cues", "access": "read"},
  {"namespace": "shared", "path": "/microstate/attention", "access": "read"},
  {"namespace": "world", "path": "/variables/local_aliveness_truth/sensory", "access": "read"}
]
```

communication：

```json
{
  "sendTo": ["belief", "actor"], "receiveFrom": [], "requestTo": [], "requestFrom": [],
  "handoffs": [
    {"id": "percept-to-belief", "to": "belief", "mode": "notify",
     "requestSchema": {"$ref": "PerceptEnvelope（见 §5.2）"},
     "requestSelectors": ["/summary", "/data"]},
    {"id": "percept-to-actor", "to": "actor", "mode": "notify",
     "requestSchema": {"$ref": "PerceptActorEnvelope（见 §5.2）"},
     "requestSelectors": ["/summary", "/data/foreground", "/data/background", "/data/signals"]}
  ]
}
```

（`$ref` 只是本文的写法，Runtime 不支持引用，落地时要把 §5.2 的 Schema 原文内联进去。）

给 Actor 的版本**故意去掉 `uncertainties`**，也就是“猜他为什么这样说”的部分。解释交给 Belief，Actor 只拿到 Belief 筛过的几种可能。

提示词草案：

```text
你是角色的“感知”过程。你不写正文，不替任何人做决定。
你能看到：本轮输入、最近几条对话、角色自知资料、角色此刻能感知到的环境片段。
注意风格：{{param:attention_style}}

怎么做：
1. 先读 /microstate/attention。注意力低时 foreground 只挑 1 件，正常时 1～3 件；background 0～3 件。其余内容就当没注意到：不要放进 summary，也不要放进任何字段。**一件都没注意到也是正常输出。**
2. source 为 "heard" 的条目，content 里尽量**保留对方的原句**——后面的过程看不到原文，也没有机会再核对。不要把原句先翻译成“用户在生气”这类结论；猜测只能写进 uncertainties。遗漏是允许的，曲解不是必须的：大多数轮次忠实转录即可。
3. 区分“听到/看到了什么”（foreground/background）与“猜对方为什么这样”（只能写进 uncertainties，不能写成事实）。
4. signals.body、signals.interaction 只写可观察的变化，例如回复突然变短、长时间停顿、雨声变大。没有变化时保持原文不动，不要换个说法重写。
5. 角色确实会留下印象的琐碎细节（错别字、一个表情、一句没回答的问话），最多 1 条追加到 /memory/pending_cues。追加前先看 /memory/processed_cues，最近处理过的内容不要重复加。队列只放**未处理**的片段，保留最近 5 条，超出时删最早的。
6. /continuity/subjective 只在角色已知的场景或话题真的变了时才改。

步骤（能并行就并行）：
- 读：/perception/current、/continuity/subjective、/microstate/attention；需要追加片段时再读 /memory/pending_cues 和 /memory/processed_cues。
- 写：/perception/current（每轮），其余路径只在有变化时写；写时带上刚读到的 expectedVersion。
- 发：rp_team_send 用 handoffId "percept-to-belief" 和 "percept-to-actor" 各发一次，summary 用一句话写“角色注意到了什么”。任何一条返回错误就重发一次；仍失败的话在结束摘要里写明发送失败——Actor 收不到消息会拒绝发布，整轮按失败处理。
- 用一句话结束。

不要：总结对方的动机或情绪，给建议，写台词，补回没注意到的内容，把原话改写成结论。
```

### 4.2 belief：竞争解释

| 字段 | 值 |
|---|---|
| 职责 | 根据 Perception 的有限观察，维护几种竞争解释（带证据、反证和信心），给 Actor 一个简短的可用视图 |
| triggers | `[{"type":"always"}]` |
| execution | `{"after": ["perception"], "onFailure": "continue", "trustedTools": []}` |
| context.sources | `{"type":"agent_messages","agentIds":["perception","association"]}`；`{"type":"character_card","selector":"/persona/assistant_name"}`；状态读权限：`/character/self_known`（关系与他相关段落）、`/character/inner_directives`（§4.0） |
| 不给 | current_input、任何历史、hidden_state |
| outputAuthority | `{"internal": true, "draft": false, "state": true, "user": false}` |
| 模型能力 | 能同时保留多种解释、不急于下结论；可以试低档 reasoning，但不预设开启 |

statePermissions：

```json
[
  {"namespace": "shared", "path": "/belief/hypotheses", "access": "readwrite"},
  {"namespace": "shared", "path": "/belief/actor_view", "access": "readwrite"},
  {"namespace": "shared", "path": "/memories/belief", "access": "readwrite"},
  {"namespace": "shared", "path": "/continuity/subjective", "access": "read"},
  {"namespace": "shared", "path": "/goals/micro", "access": "read"},
  {"namespace": "shared", "path": "/microstate/irritation", "access": "read"},
  {"namespace": "shared", "path": "/microstate/social_energy", "access": "read"}
]
```

communication：

```json
{
  "sendTo": ["actor"], "receiveFrom": ["perception", "association"],
  "requestTo": ["association"], "requestFrom": [],
  "handoffs": [
    {"id": "belief-view-to-actor", "to": "actor", "mode": "notify",
     "requestSchema": {"$ref": "BeliefViewEnvelope"},
     "requestSelectors": ["/data/possibilities", "/data/openQuestion", "/data/recall"]},
    {"id": "belief-recall", "to": "association", "mode": "await",
     "timeoutMs": 90000, "onFailure": "return_error",
     "requestSchema": {"$ref": "RecallRequestEnvelope"},
     "requestSelectors": ["/summary", "/data/cue", "/data/cueTags", "/data/purpose"],
     "responseSchema": {"$ref": "RecallResponseEnvelope"},
     "responseSelectors": ["/data/none", "/data/recalled"]}
  ]
}
```

- 发给 Actor 的视图**不含 summary**，避免 Belief 的分析长文绕到 Actor 那里。
- `receiveFrom` 含 association，满足 await 结果回传的 ACL（0.1-3）。

提示词草案：

```text
你是角色的“理解”过程。你只知道感知过程告诉你的内容（perception 消息），再加上角色自知资料和已有的旧理解。你看不到原始输入，也不要假装看得到。
解释风格：{{param:attention_style}}

怎么做：
1. 先读 /belief/hypotheses、/continuity/subjective、/microstate/irritation、/microstate/social_energy。
2. 对本轮的新观察，保留 2～4 种可能的理解，每种带 evidence、counterEvidence 和 confidence（0～1，不要求加起来等于 1）。烦躁或疲惫可以让某种理解显得更顺手，但不能把它变成事实。
3. 旧理解只有在出现新的可见证据时才修正（status 改为 revised 或 rejected）；没有证据就保留，可以小幅降低 confidence。不要一轮之内把所有歧义都解决掉。
4. 某个线索可能勾起回忆时，可以用 handoffId "belief-recall" 向 association 请求一次（每轮最多一次，大多数轮次不需要）。返回 none=true 是正常结果。
5. 写回 /belief/hypotheses（活跃的不超过 4 条，其余标为 rejected 或删掉最旧的）。值得长期保留的“曾这样理解 / 后来改了看法”，最多写 1 条进记忆集合 character-beliefs。
6. 用 handoffId "belief-view-to-actor" 给 actor 发一次：possibilities（至多 3 条，只用角色可知的说法）、openQuestion（角色心里没解决的一个小问题，可以为空）、recall（至多 1 条回忆，没有就是空数组）。
7. **发送成功以后**，把刚发出去的视图原样写进 /belief/actor_view——它表示“最近一次实际送达的理解”。发送失败就**不要写**，让旧值留着。顺序不能反。

没有 perception 消息时：不更新理解，只把 /belief/actor_view 的旧值原样发给 actor（送达成功后再写回它，值不变），然后结束。
不要：替对方下定论，写台词，把内部推理写进发给 actor 的内容。
```

### 4.3 microstate：状态惯性

| 字段 | 值 |
|---|---|
| 职责 | 小幅、缓慢地更新精力、注意、烦躁、尴尬、背景焦点、未完成想法和微目标 |
| triggers | 见下方 JSON。**顺序固定**：参数 `microstate_interval` 绑定的是 `/triggers/0/every` |
| execution | `{"after": ["perception"], "onFailure": "continue", "trustedTools": []}` |
| context.sources | `{"type":"character_card","selector":"/persona/assistant_name"}`；状态读权限：`/character/self_known`（习惯、身体相关段落）、`/character/inner_directives` |
| 不给 | current_input、历史、agent_messages（直接读 `/perception/current`，不需要消息） |
| outputAuthority | `{"internal": true, "draft": false, "state": true, "user": false}` |
| 模型能力 | 便宜、稳定，能可靠地做结构化写入；不需要 reasoning |

```json
"triggers": [
  {"id": "ms-periodic", "type": "periodic", "every": 3, "offset": 1},
  {"id": "ms-body", "type": "state_changed", "namespace": "shared",
   "path": "/perception/current/signals/body", "cooldownTurns": 1},
  {"id": "ms-interaction", "type": "state_changed", "namespace": "shared",
   "path": "/perception/current/signals/interaction", "cooldownTurns": 1}
]
```

- 多条触发是“任一命中即可”。periodic 用的是当前分支的用户轮次，`offset: 1` 让第 1、4、7… 轮运行。
- state_changed 要求 Microstate 能读该路径（`validateConditionReferences`），并且只在前后值都确知、确实不同时才触发。`cooldownTurns: 1` 表示触发提交后，下一轮同一规则不再触发。
- **不监听自己写的 `/microstate`**，避免自我唤醒。

statePermissions：

```json
[
  {"namespace": "shared", "path": "/microstate", "access": "readwrite"},
  {"namespace": "shared", "path": "/goals/micro", "access": "readwrite"},
  {"namespace": "shared", "path": "/perception/current", "access": "read"},
  {"namespace": "shared", "path": "/habits/cues", "access": "read"}
]
```

communication：全部为空，不声明 handoff。

更新规则 **[Preset]**（Runtime 不会执行任何公式，这些只是给模型的约束，靠跨轮检查验收）：

- 每次激活，每个数值字段默认变化不超过 ±0.15。只有出现明确可见的事件（如“终于可以休息了”）时，才允许单次变化到 ±0.3。
- 没有相关信号时向基线（`/microstate` 的作者初值）回归一小步（≤0.05），也可以不变。**没有理由就保持原值**。
- 噪声默认关闭。
- 用户一句“没事”不能让疲劳或烦躁立刻归零。
- `/goals/micro`：活跃的不超过 3 条；没有就是 `[]`；不要每轮发明新目标；已完成的改为 `done`，搁置的改为 `parked`。

提示词草案：

```text
你是角色的“身体与情绪余量”过程。你不写正文，也不决定角色说什么。
先读 /microstate、/goals/micro、/perception/current、/habits/cues。
根据这次可观察到的信号（perception/current 的 signals 和 foreground），小幅调整数值：每个字段一般不超过 ±0.15；只有明确可见的事件才允许到 ±0.3。没有相关信号就保持原值，或者向初始水平回归一点点。不要每次都改，不要随机重抽。
background_focus 和 unfinished_thought 写成角色脑子里挂着、但未必说出口的一件小事；没有就保持原样。
微目标最多 3 条活跃，不要凭空发明，也不要设定剧情目标。
一次写回 /microstate，必要时写 /goals/micro，带 expectedVersion。
用 rp_team_submit_internal 写一句摘要，说明改了什么、为什么（例如“social_energy 0.55→0.45：对方连续催促”），然后结束。
不要把状态翻译成固定动作或台词（例如“烦躁=叹气”）。
```

### 4.4 association：琐碎记忆

| 字段 | 值 |
|---|---|
| 职责 | 被请求时用工具检索少量候选、选出可能浮现的回忆；稀疏地把待记忆片段整理进集合 |
| triggers | 见下方 JSON |
| execution | `{"after": ["perception"], "onFailure": "continue", "trustedTools": []}`。**不 after belief 或 actor**，否则会形成等待环 |
| context.sources | `{"type":"agent_messages","agentIds":["belief","actor"]}`（请求消息经 requested_by_agent 授权可见）；`{"type":"character_card","selector":"/persona/assistant_name"}`；状态读权限：`/character/self_known`（经历、关系相关段落）、`/character/inner_directives` |
| 不给 | current_input、full_history、hidden_state |
| outputAuthority | `{"internal": true, "draft": false, "state": true, "user": false}` |
| 模型能力 | 会检索和取舍即可，普通档；不需要高档 reasoning |

```json
"triggers": [
  {"id": "assoc-request", "type": "requested_by_agent", "from": ["belief", "actor"]},
  {"id": "assoc-consolidate", "type": "condition", "cooldownTurns": 3,
   "condition": {"op": "exists", "namespace": "shared", "path": "/memory/pending_cues/0"}}
]
```

条件触发在本轮开始时以及每次状态通知时求值；`exists` 引用的路径被 `/memory/pending_cues` 的定义覆盖，Association 也有读权限，能通过校验。冷却 3 表示一次整理提交后，3 个用户轮次内不再因为这条规则运行。**关键语义变化**：`/memory/pending_cues` 现在只放未处理片段（整理后 Association 把看过的删掉），所以 `exists /0` 为真 = “确有未处理片段”，不会出现队列里全是旧货还反复空跑的情况。

statePermissions：

```json
[
  {"namespace": "shared", "path": "/memories/episodic", "access": "readwrite"},
  {"namespace": "shared", "path": "/memories/belief", "access": "read"},
  {"namespace": "shared", "path": "/memory/pending_cues", "access": "readwrite"},
  {"namespace": "shared", "path": "/memory/processed_cues", "access": "readwrite"},
  {"namespace": "shared", "path": "/memory/recall_history", "access": "readwrite"},
  {"namespace": "shared", "path": "/habits/cues", "access": "read"}
]
```

communication：

```json
{"sendTo": ["belief", "actor"], "receiveFrom": [], "requestTo": [], "requestFrom": ["belief", "actor"]}
```

`sendTo` 是为了满足结果回传 ACL。按 ACL 它也能给 Belief/Actor 发普通消息，**禁止多发只是提示词约定**。

提示词草案：

```text
你是角色的“联想”过程。你不写正文。
回忆倾向：{{param:recall_tendency}}

被请求时（消息里有 cue/cueTags/purpose）：
1. 用 rp_team_memory_search 在 character-episodes 中检索，可以用 query、tag 或 fields 缩小范围，limit 不超过 8；需要时再查 character-beliefs。同时读 /memory/recall_history。
2. 从候选中选 0～2 条“此刻可能浮现”的回忆。依据是 cue 是否相似、角色习惯、最近有没有回忆过（recallCount 高的少选），不按“能否推动剧情”选。没有合适的就返回 none=true，这是正常结果。
3. 回忆可以模糊，可以记错细节，但必须保留 source；不确定时 uncertain=true。不能编造关于对方身份、重大经历或关系的事实。
4. 更新 /memory/recall_history（memoryId、cue、recallCount+1、一句 lastReason）。
5. 用 rp_team_submit_internal 返回：summary 写一句话；data = {none, recalled:[{memoryId, content, source, confidence, uncertain}]}。不要另外 rp_team_send。

因为待记忆片段而运行时（没有请求消息）：
1. 读 /memory/pending_cues 和 /memory/processed_cues。队列里只会放未处理的片段，processed_cues 是最近看过的 id 台账。
2. 至多选 1 条值得长期保留的：先用 rp_team_memory_search 按 content 在 character-episodes 里查一下是否已有几乎相同的记录，没有再 rp_team_memory_add（content、source、perspective、confidence、tags、cueTags 必填；不要写 id/createdAt）。
3. **先写 /memory/pending_cues**（把这次看过的片段从队列删掉，即使一条都没选中）；**再写 /memory/processed_cues**（追加看过的 id，保留最近 20 个）。顺序不能反：先记台账再删队列时如果中间失败，片段会卡在队列里，整理任务反复空跑。
4. 一句话 submit_internal，然后结束。不发消息。
```

### 4.5 inhibition：表达抑制

| 字段 | 值 |
|---|---|
| 职责 | Actor 遇到明显的表达冲突时，给出“说到什么程度”的方向，不写正文 |
| triggers | `[{"id":"inhib-request","type":"requested_by_agent","from":["actor"]}]` |
| execution | `{"after": [], "onFailure": "continue", "trustedTools": []}`。不 after actor |
| context.sources | `{"type":"agent_messages","agentIds":["actor"]}`；`{"type":"character_card","selector":"/persona/assistant_name"}`；状态读权限：`/character/self_known`（习惯、边界相关段落）、`/character/inner_directives` |
| outputAuthority | `{"internal": true, "draft": false, "state": false, "user": false}` |
| 模型能力 | 能稳定输出短结构；不需要 reasoning |

statePermissions：

```json
[
  {"namespace": "shared", "path": "/microstate/social_energy", "access": "read"},
  {"namespace": "shared", "path": "/microstate/embarrassment", "access": "read"},
  {"namespace": "shared", "path": "/microstate/irritation", "access": "read"},
  {"namespace": "shared", "path": "/habits/cues", "access": "read"}
]
```

communication：`{"sendTo": ["actor"], "receiveFrom": [], "requestTo": [], "requestFrom": ["actor"]}`

提示词草案：

```text
你是角色的“说不说得出口”过程。你不写台词，也不评价写得好不好。
表达克制倾向：{{param:restraint_style}}
Actor 会告诉你它想表达什么（intent）和卡在哪里（conflict）。先读 /microstate 的三个数值和 /habits/cues。
用 rp_team_submit_internal 返回：summary 写一句话；data = {
  limit: "say_fully" | "say_partly" | "deflect" | "action_only",
  direction: 一句话的方向（例如“只问一半，用别的事岔开”），
  avoid: 0～3 个此刻说不出口的点
}。
不要重写 Actor 的话，不要给出完整句子，不要因为“写得更好”而改变方向。
```

### 4.6 actor：唯一正文发布者

| 字段 | 值 |
|---|---|
| 职责 | 以角色身份，用主观可知的材料行动并发布唯一正文 |
| triggers | `[{"type":"always"}]` |
| execution | `{"after": ["perception", "belief", "microstate"], "onFailure": "stop", "trustedTools": []}`（发布者失败必然停止，这里显式写出） |
| context.sources | `{"type":"character_card","selector":"/persona/assistant_name"}`；`{"type":"agent_messages","agentIds":["perception","belief","association","inhibition"]}`；状态读权限：`/character/self_known`（全文；**不给 `/character/inner_directives`**，§4.0） |
| **不给** | current_input、recent_history、full_history、worldbook、hidden_state、scene_state、long_memory、drafts |
| outputAuthority | `{"internal": true, "draft": false, "state": true, "user": true}` |
| parameters | `{"maxTokens": 1500}`（由参数 `actor_max_tokens` 设定） |
| 模型 | 默认 `"inherit"`，即本轮冻结的聊天模型；是否开 reasoning 由试演决定 |

statePermissions：

```json
[
  {"namespace": "shared", "path": "/microstate", "access": "read"},
  {"namespace": "shared", "path": "/goals/micro", "access": "read"},
  {"namespace": "shared", "path": "/continuity/subjective", "access": "read"},
  {"namespace": "shared", "path": "/belief/actor_view", "access": "read"},
  {"namespace": "shared", "path": "/behavior/recent", "access": "readwrite"}
]
```

communication：

```json
{
  "sendTo": [], "receiveFrom": ["perception", "belief", "association", "inhibition"],
  "requestTo": ["association", "inhibition"], "requestFrom": [],
  "handoffs": [
    {"id": "actor-recall", "to": "association", "mode": "await",
     "timeoutMs": 90000, "onFailure": "return_error",
     "requestSchema": {"$ref": "RecallRequestEnvelope"},
     "requestSelectors": ["/summary", "/data/cue", "/data/cueTags", "/data/purpose"],
     "responseSchema": {"$ref": "RecallResponseEnvelope"},
     "responseSelectors": ["/data/none", "/data/recalled"]},
    {"id": "actor-restraint", "to": "inhibition", "mode": "await",
     "timeoutMs": 60000, "onFailure": "return_error",
     "requestSchema": {"$ref": "RestraintRequestEnvelope"},
     "requestSelectors": ["/data/intent", "/data/conflict"],
     "responseSchema": {"$ref": "RestraintResponseEnvelope"},
     "responseSelectors": ["/data/limit", "/data/direction", "/data/avoid"]}
  ]
}
```

两条回传都**不含 summary**，后台成员的长分析不会作为摘要绕回 Actor。

提示词草案：

```text
你就是角色本人，正在回应眼前的人。
你只知道这些：
- 感知过程告诉你的（perception 消息，其中有你注意到的原话）。没注意到的事，你就是不知道。
- 你对对方的几种暂定理解（belief 消息）。它们可能是错的。
- 你此刻的余量（/microstate）、手头的小事（/goals/micro）、已知的场景和话题（/continuity/subjective）、你最近说过做过的（/behavior/recent）。
- 你是谁（角色资料）。

开始时并行读 /microstate、/goals/micro、/continuity/subjective、/behavior/recent。如果没有 belief 消息，再读 /belief/actor_view，把它当作“上一次实际送达的理解”（可能来自更早的轮次，不是本轮的）。
你可以：只回应其中一部分；按某种理解行动，哪怕可能误会；停顿、改口、转回自己的小事；提出一个很小的需求；什么都不推进。
需要回想时（某个线索让你想起点什么），且 belief 没带来回忆：可以用 handoffId "actor-recall" 请求一次。
想说的和说得出口的明显打架时（例如想问又怕显得太在意）：可以用 handoffId "actor-restraint" 请求一次，按返回的方向说，不要复述返回的内容。
两种请求每轮各最多一次，大多数轮次都不需要。

**如果没有 perception 消息**：说明对方这轮说了什么根本没送到你这里。不要编内容，也不要发布正文，直接用 rp_team_submit_internal 写明情况后结束——缺少正文会让本轮按失败处理，好过回应一条你没看到的消息。

不要：报告心理状态或数值；逐条回应对方的每句话；为推进剧情制造事件；重复 /behavior/recent 里最近用过的动作或口头禅。
结束前：先在 /behavior/recent 末尾追加本轮 1～2 条表面行为（kind/signature/content），只保留最近 8 条，带 expectedVersion。**写入成功后**，用 rp_team_publish 发布正文——publish 必须是最后一个工具调用。行为记录写入失败时重试一次，仍失败就照常发布（缺一条行为记录比整轮重来便宜），不要为了补记录在发布后再调用任何工具。
```

---

## 5. 通信与交接总表

### 5.1 边列表（全部为 handoff，见 0.1-2）

| handoffId | 发起方 → 目标 | mode | 发起工具 | 投影出去的字段 | 回传字段 | 超时 / 失败 |
|---|---|---|---|---|---|---|
| percept-to-belief | perception → belief | notify | rp_team_send | /summary, /data | — | — |
| percept-to-actor | perception → actor | notify | rp_team_send | /summary, /data/foreground, /data/background, /data/signals | — | — |
| belief-view-to-actor | belief → actor | notify | rp_team_send | /data/possibilities, /data/openQuestion, /data/recall | — | — |
| belief-recall | belief → association | await | rp_team_request | /summary, /data/cue, /data/cueTags, /data/purpose | /data/none, /data/recalled | 90s / return_error |
| actor-recall | actor → association | await | rp_team_request | 同上 | 同上 | 90s / return_error |
| actor-restraint | actor → inhibition | await | rp_team_request | /data/intent, /data/conflict | /data/limit, /data/direction, /data/avoid | 60s / return_error |

ACL 自检（Runtime 规则：普通发送需要 `发送方.sendTo ∋ 接收方` 且 `接收方.receiveFrom ∋ 发送方`；请求需要 `requestTo/requestFrom`，并且目标有能匹配的 `requested_by_agent`；await 还要能反向发送）：

| 边 | 正向 ACL | 目标触发 | 回传 ACL |
|---|---|---|---|
| perception→belief | P.sendTo∋belief，B.receiveFrom∋perception ✓ | 不需要 | — |
| perception→actor | P.sendTo∋actor，A.receiveFrom∋perception ✓ | 不需要 | — |
| belief→actor | B.sendTo∋actor，A.receiveFrom∋belief ✓ | 不需要 | — |
| belief→association | B.requestTo∋association，As.requestFrom∋belief ✓ | assoc-request.from∋belief ✓ | As.sendTo∋belief，B.receiveFrom∋association ✓ |
| actor→association | A.requestTo∋association，As.requestFrom∋actor ✓ | from∋actor ✓ | As.sendTo∋actor，A.receiveFrom∋association ✓ |
| actor→inhibition | A.requestTo∋inhibition，I.requestFrom∋actor ✓ | inhib-request.from∋actor ✓ | I.sendTo∋actor，A.receiveFrom∋inhibition ✓ |

所有带 incoming handoff 的成员（belief、actor、association、inhibition）都有 `internal:true`。没有 handoff 的 microstate 也保留 internal，用于 `rp_team_submit_internal`。

### 5.2 信封 Schema（只用 Runtime 支持的关键字）

```json
{
  "ObservationItem": {"type": "object",
    "properties": {"id": {"type": "string"}, "content": {"type": "string"},
      "source": {"type": "string", "enum": ["heard", "seen", "felt", "history"]},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1}},
    "required": ["id", "content", "source", "confidence"]},

  "Signals": {"type": "object",
    "properties": {"body": {"type": "string"}, "interaction": {"type": "string"}},
    "required": ["body", "interaction"]},

  "PerceptEnvelope": {"type": "object",
    "properties": {"summary": {"type": "string"},
      "data": {"type": "object",
        "properties": {"foreground": {"type": "array", "items": "ObservationItem"},
          "background": {"type": "array", "items": "ObservationItem"},
          "uncertainties": {"type": "array", "items": {"type": "string"}},
          "signals": "Signals"},
        "required": ["foreground", "background", "uncertainties", "signals"]}},
    "required": ["summary", "data"]},

  "PerceptActorEnvelope": "与 PerceptEnvelope 相同，但 data.required 为 [foreground, background, signals]，并且不声明 uncertainties（投影后已不存在）",

  "BeliefViewEnvelope": {"type": "object",
    "properties": {"data": {"type": "object",
      "properties": {
        "possibilities": {"type": "array", "items": {"type": "object",
          "properties": {"hypothesisId": {"type": "string"}, "interpretation": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1}},
          "required": ["hypothesisId", "interpretation", "confidence"]}},
        "openQuestion": {"type": "string"},
        "recall": {"type": "array", "items": {"type": "object",
          "properties": {"memoryId": {"type": "string"}, "content": {"type": "string"},
            "uncertain": {"type": "boolean"}},
          "required": ["memoryId", "content", "uncertain"]}}},
      "required": ["possibilities", "openQuestion", "recall"]}},
    "required": ["data"]},

  "RecallRequestEnvelope": {"type": "object",
    "properties": {"summary": {"type": "string"}, "data": {"type": "object",
      "properties": {"cue": {"type": "string"}, "cueTags": {"type": "array", "items": {"type": "string"}},
        "purpose": {"type": "string", "enum": ["interpret", "express"]}},
      "required": ["cue", "cueTags", "purpose"]}},
    "required": ["data"]},

  "RecallResponseEnvelope": {"type": "object",
    "properties": {"data": {"type": "object",
      "properties": {"none": {"type": "boolean"},
        "recalled": {"type": "array", "items": {"type": "object",
          "properties": {"memoryId": {"type": "string"}, "content": {"type": "string"},
            "source": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "uncertain": {"type": "boolean"}},
          "required": ["memoryId", "content", "source", "confidence", "uncertain"]}}},
      "required": ["none", "recalled"]}},
    "required": ["data"]},

  "RestraintRequestEnvelope": {"type": "object",
    "properties": {"data": {"type": "object",
      "properties": {"intent": {"type": "string"}, "conflict": {"type": "string"}},
      "required": ["intent", "conflict"]}},
    "required": ["data"]},

  "RestraintResponseEnvelope": {"type": "object",
    "properties": {"data": {"type": "object",
      "properties": {"limit": {"type": "string", "enum": ["say_fully", "say_partly", "deflect", "action_only"]},
        "direction": {"type": "string"},
        "avoid": {"type": "array", "items": {"type": "string"}}},
      "required": ["limit", "direction", "avoid"]}},
    "required": ["data"]}
}
```

（为便于阅读，`"items": "ObservationItem"` 这类写法表示内联引用；落地时必须展开成完整对象，Runtime 不支持引用。）

Schema **能**硬校验：字段存在、类型、enum、数值范围。**不能**校验：数组长度（如“至多 3 条”）、措辞质量、summary 里有没有夹带秘密。这些靠提示词约定和人工验收。

---

## 6. 状态规格

### 6.1 定义总表

S = shared，W = world。“写入者”指唯一的主要写入者 **[Preset]**；读写能力本身由 §4 各成员的 ACL **[Runtime]** 决定。

| # | ns / path | type | 默认值 | 写入者 | 读取者 | 跨轮语义 |
|---|---|---|---|---|---|---|
| 1 | S `/perception/current` | object | `{"foreground":[],"background":[],"uncertainties":[],"cueTags":[],"signals":{"body":"","interaction":""}}` | perception | microstate | 每轮整体覆盖；signals 只在可见变化时改字面值 |
| 2 | S `/continuity/subjective` | object | `{"knownScene":"","noticedTopics":[],"unresolved":[]}` | perception | belief, actor | 只在角色已知内容变化时改 |
| 3 | S `/microstate` | object | `{"attention":0.6,"physical_energy":0.7,"social_energy":0.6,"irritation":0.1,"embarrassment":0.1,"background_focus":"","unfinished_thought":""}` | microstate | perception（attention）、belief（irritation、social_energy）、inhibition（social_energy、embarrassment、irritation）、actor（全部） | 稀疏更新；没触发的轮次沿用已提交值 |
| 4 | S `/goals/micro` | array | `[]` | microstate | belief, actor | 活跃 ≤3（约定） |
| 5 | S `/belief/hypotheses` | array | `[]` | belief | belief | 活跃 ≤4（约定）；保留修正记录 |
| 6 | S `/belief/actor_view` | object | `{"possibilities":[],"openQuestion":"","recall":[]}` | belief | actor（降级时读） | 只在 belief-view 送达成功后写；=“最近一次实际送达的理解”（§6.3） |
| 7 | S `/memory/pending_cues` | array | `[]` | perception（追加）+ association（整理后删除） | perception, association | 只放**未处理**片段，≤5（约定）；两个写入者，严格先后（D11、§6.3） |
| 8 | S `/memory/processed_cues` | array | `[]` | association | perception, association | 字符串 id 台账，≤20（约定）；Perception 用它避免重复追加 |
| 9 | S `/memory/recall_history` | array | `[]` | association | association | 每个 memoryId 一条 |
| 10 | S `/memories/episodic` | array | `[]`（试演可用作者合成初值） | association（经记忆工具） | association | 集合 `character-episodes` |
| 11 | S `/memories/belief` | array | `[]` | belief（经记忆工具） | belief, association | 集合 `character-beliefs` |
| 12 | S `/habits/cues` | array | `[]`（作者初值） | 首版无成员写入 | microstate, association, inhibition | 只读背景 |
| 13 | S `/behavior/recent` | array | `[]` | actor | actor | ≤8（约定）；用于人工检查重复 |
| 14 | W `/variables/local_aliveness_truth` | object | `{"sensory":{"visible":[],"audible":[],"bodily":[]},"facts":[]}` | 作者 / 宿主；**没有成员可写** | perception（只读 `/sensory`） | 世界真相，不受角色信念修正；**可选接入，见下注** |
| 15 | S `/character/self_known` | object | 作者维护（已定，§4.0 方案 2；草稿见 SELF_KNOWN_DRAFT_陈加怡.zh-CN.md） | 作者状态编辑；**没有成员可写** | actor（全文）；belief、microstate、association、inhibition（按段落）；perception 不读 | 兜底自知资料；无 valueSchema |
| 16 | S `/character/inner_directives` | object | 作者维护（§4.0） | 作者状态编辑；**没有成员可写** | belief、microstate、association、inhibition；**actor、perception 不读** | 后台性格指导：深层动机与知情边界，不作她的自我陈述；无 valueSchema |

`/memory/pending_cues`、`/memories/*`、`/habits/cues` 都是数组，default `[]` 满足记忆集合“绑定已声明 array 路径”的要求（`memory.mjs:normalizeMemoryConfig`）。

**#14 改为可选接入，不阻塞首版**：定义照常在 `state.definitions` 里声明（声明本身不产生数据）。宿主变量配置里没有 `local_aliveness_truth` 这个对象时，成员读它得到"不存在"，hidden_state 的 selector 落到空值会被跳过——预设照常运行，只是没有世界真相层。要启用时，由**作者**在宿主变量配置里声明这个对象（宿主校验说了算，插件不能代建），之后 Perception 自动开始拿到 `/sensory`。注意场景 8 的 world `initialState` 走 `applyStateEdit`，写 world 路径会要求宿主回执（`author-state.mjs` 的 `hostRequired` 流程），所以这个试演场景只有在该键已声明后才跑得起来。

### 6.2 valueSchema（逐条）

```json
{
  "/perception/current": {"type": "object",
    "properties": {
      "foreground": {"type": "array", "items": "ObservationItem"},
      "background": {"type": "array", "items": "ObservationItem"},
      "uncertainties": {"type": "array", "items": {"type": "string"}},
      "cueTags": {"type": "array", "items": {"type": "string"}},
      "signals": "Signals"},
    "required": ["foreground", "background", "uncertainties", "cueTags", "signals"]},

  "/continuity/subjective": {"type": "object",
    "properties": {"knownScene": {"type": "string"},
      "noticedTopics": {"type": "array", "items": {"type": "string"}},
      "unresolved": {"type": "array", "items": {"type": "string"}}},
    "required": ["knownScene", "noticedTopics", "unresolved"]},

  "/microstate": {"type": "object",
    "properties": {
      "attention": {"type": "number", "minimum": 0, "maximum": 1},
      "physical_energy": {"type": "number", "minimum": 0, "maximum": 1},
      "social_energy": {"type": "number", "minimum": 0, "maximum": 1},
      "irritation": {"type": "number", "minimum": 0, "maximum": 1},
      "embarrassment": {"type": "number", "minimum": 0, "maximum": 1},
      "background_focus": {"type": "string"},
      "unfinished_thought": {"type": "string"}},
    "required": ["attention", "physical_energy", "social_energy", "irritation", "embarrassment", "background_focus", "unfinished_thought"]},

  "/goals/micro": {"type": "array", "items": {"type": "object",
    "properties": {"id": {"type": "string"}, "description": {"type": "string"},
      "salience": {"type": "number", "minimum": 0, "maximum": 1},
      "status": {"type": "string", "enum": ["active", "parked", "done"]},
      "origin": {"type": "string"}},
    "required": ["id", "description", "salience", "status", "origin"]}},

  "/belief/hypotheses": {"type": "array", "items": {"type": "object",
    "properties": {"id": {"type": "string"}, "subject": {"type": "string"},
      "interpretation": {"type": "string"},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1},
      "evidence": {"type": "array", "items": {"type": "string"}},
      "counterEvidence": {"type": "array", "items": {"type": "string"}},
      "status": {"type": "string", "enum": ["tentative", "supported", "revised", "rejected"]}},
    "required": ["id", "subject", "interpretation", "confidence", "evidence", "counterEvidence", "status"]}},

  "/belief/actor_view": "与 BeliefViewEnvelope.data 相同的对象 Schema",

  "/memory/pending_cues": {"type": "array", "items": {"type": "object",
    "properties": {"id": {"type": "string"}, "content": {"type": "string"},
      "cueTags": {"type": "array", "items": {"type": "string"}},
      "source": {"type": "string"}, "perspective": {"type": "string"},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1}},
    "required": ["id", "content", "cueTags", "source", "perspective", "confidence"]}},

  "/memory/processed_cues": {"type": "array", "items": {"type": "string"}},

  "/memory/recall_history": {"type": "array", "items": {"type": "object",
    "properties": {"memoryId": {"type": "string"}, "cue": {"type": "string"},
      "recallCount": {"type": "number", "minimum": 0}, "lastReason": {"type": "string"}},
    "required": ["memoryId", "cue", "recallCount", "lastReason"]}},

  "/memories/episodic": "见 §7.2 EpisodicRecord（数组 items）",
  "/memories/belief": "见 §7.2 BeliefRecord（数组 items）",

  "/habits/cues": {"type": "array", "items": {"type": "object",
    "properties": {"id": {"type": "string"}, "cue": {"type": "string"},
      "tendency": {"type": "string"},
      "strength": {"type": "number", "minimum": 0, "maximum": 1},
      "evidence": {"type": "array", "items": {"type": "string"}}},
    "required": ["id", "cue", "tendency", "strength", "evidence"]}},

  "/behavior/recent": {"type": "array", "items": {"type": "object",
    "properties": {"id": {"type": "string"},
      "kind": {"type": "string", "enum": ["utterance", "action", "topic"]},
      "signature": {"type": "string"}, "content": {"type": "string"}},
    "required": ["id", "kind", "signature", "content"]}},

  "world:/variables/local_aliveness_truth": {"type": "object",
    "properties": {
      "sensory": {"type": "object",
        "properties": {"visible": {"type": "array", "items": {"type": "string"}},
          "audible": {"type": "array", "items": {"type": "string"}},
          "bodily": {"type": "array", "items": {"type": "string"}}},
        "required": ["visible", "audible", "bodily"]},
      "facts": {"type": "array", "items": {"type": "object",
        "properties": {"id": {"type": "string"}, "content": {"type": "string"}, "source": {"type": "string"}},
        "required": ["id", "content", "source"]}}},
    "required": ["sensory", "facts"]}
}
```

没有使用 `integer`、`oneOf`、`additionalProperties`、`minItems/maxItems`、字符串长度或日期格式校验，这些 Runtime 都不支持。`recallCount` 应为整数，这只是约定。`/character/self_known`（§6.1 #15）有意不声明 valueSchema——作者自管的兜底资料，结构随卡而定。

### 6.3 提交、回退与降级语义 **[Runtime]**

- 本轮写入先暂存，有权限的成员立即可读。正文经 publish 暂存为候选，宿主回执确认后整轮状态才提交；整轮失败、取消或预算耗尽时，暂存写入随运行一起丢弃。正式回退时恢复到检查点。
- 写入必须带 `expectedVersion`：先读再写，冲突时明确失败，不会“最后写入者悄悄胜出”。除 `/memory/pending_cues` 外每条路径只有一个写入者；pending_cues 的两个写入者严格先后（Association `after: perception`），正常情况下不会冲突。
- **没有“同一步原子完成”这回事**：`rp_team_write_state` 一次只暂存一条路径（0.1-12），发消息是另一次调用，每次都可能单独失败。能控制后果的只有**步骤顺序**。工具报错也不会让激活失败（0.1-11），所以下面这张表是约定，不是机制保证；选这些顺序是因为出错后的残留都可接受。
- **单个成员失败不会单独回滚它已暂存的写入**。比如 Belief 写了 `/belief/hypotheses` 之后崩溃，如果本轮最终成功，这条写入仍会提交。
- **成员消息不跨轮保存**（0.1-10）：新一轮从空信箱开始，只有明确重试会保留已完成成员的消息。所以“上一轮没送出去的消息漏到下一轮”不存在。
- default 只在节点缺失时生效。修改 default 或绑定参数，**不会**覆盖已经积累的状态。

各成员的收尾顺序 **[Preset]**：

| 成员 | 收尾顺序 | 部分失败时的残留 |
|---|---|---|
| perception | 写状态 → 两条 notify | 激活失败 → `onFailure: stop`，整轮丢弃。激活正常结束但漏发 → 由 Actor 兜底（§6.4） |
| belief | 写 hypotheses / 记忆 → send → **送达后才写 actor_view** | `actor_view` 永远等于“最近一次实际送达的视图”；send 失败时它保留旧值，不会把本轮没送出去的新值当成旧印象 |
| microstate | 写 `/microstate` → submit_internal | submit 失败时数值可能已暂存并随本轮提交——可接受，它只是倾向值，不会标成“刚刚变化” |
| association（整理） | 检索 → add → **先删 pending_cues，再记 processed_cues** → submit | 删队列失败 → 下轮重跑，正常；记台账失败 → 片段可能被再整理一次；add 成功而台账失败 → 可能多一条重复记忆（用 content 搜索兜底，约定） |
| association（应答） | 检索 → 写 recall_history → submit_internal | submit 失败时 recallCount 可能多记一次没送达的回忆——接受 |
| inhibition | 无写入 | — |
| actor | 读 →（可选两次 await）→ **先写 /behavior/recent → 最后 publish** | publish 会锁定正文候选并结束会话；写在先保证失败重试不会重复记录——失败轮的暂存全部丢弃。写行为失败重试一次仍失败则照常发布 |

### 6.4 “本轮新值”和“旧值”的区分

| 情况 | Actor 看到什么 | 怎么区分 |
|---|---|---|
| Microstate 本轮运行 | `/microstate` 已含本轮暂存值 | Actor 不需要区分：数值只影响倾向，不作为本轮事件 |
| Microstate 未运行 | 上轮已提交值 | 同上；提示词明确“这是你此刻的余量”，不写成“刚刚发生了变化” |
| Belief 本轮送达 | belief 消息 | 有消息就是本轮的——信箱每轮清空（0.1-10），旧消息漏不进来 |
| Belief 没发、发送失败或激活失败 | 没有 belief 消息 → 读 `/belief/actor_view` | 语义是“最近一次实际送达的理解”，可能来自几轮前。因为只在送达成功后才写，它**不可能**是没送出去的本轮新值 |
| Perception 激活失败 | （走不到这里） | `onFailure: stop` 已让整轮停止 |
| Perception 正常结束但漏发 | 没有 perception 消息 | Actor 不编内容、不发布，直接结束 → `RP_TEAM_PUBLICATION_REQUIRED` 整轮失败（0.1-11），用户可明确重试 |
| 没有回忆 | `recall: []` 或 `none: true` | 合法结果，不需要解释 |

---

## 7. 记忆集合

### 7.1 集合

```json
"memory": {"collections": [
  {"id": "character-episodes", "name": "角色的生活片段", "namespace": "shared", "path": "/memories/episodic",
   "description": "主观、可以模糊或记错；不会被自动纠正为世界真相。"},
  {"id": "character-beliefs", "name": "角色曾经的理解", "namespace": "shared", "path": "/memories/belief",
   "description": "“曾这样理解 / 后来改了看法”的主观记录。"}
]}
```

### 7.2 记录 Schema

工具会自动加 `id`、`createdAt`、`active`。要求 `content` 非空；`people/tags` 必须是字符串数组，`source/perspective` 必须是文本，`confidence` 必须是有限数值（`memory-tools.mjs:createMemoryRecord`）。下面的 valueSchema 再加一层作者约束：

```json
{
  "EpisodicRecord": {"type": "object",
    "properties": {
      "id": {"type": "string"}, "content": {"type": "string"}, "createdAt": {"type": "string"},
      "updatedAt": {"type": "string"}, "active": {"type": "boolean"},
      "people": {"type": "array", "items": {"type": "string"}},
      "tags": {"type": "array", "items": {"type": "string"}},
      "source": {"type": "string"}, "perspective": {"type": "string"},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1},
      "cueTags": {"type": "array", "items": {"type": "string"}},
      "sensoryCue": {"type": "string"}, "emotionalTone": {"type": "string"},
      "storyTime": {"type": "string"},
      "status": {"type": "string", "enum": ["intact", "blurred", "revised"]}},
    "required": ["id", "content", "createdAt", "active", "source", "perspective", "confidence"]},

  "BeliefRecord": {"type": "object",
    "properties": {
      "id": {"type": "string"}, "content": {"type": "string"}, "createdAt": {"type": "string"},
      "updatedAt": {"type": "string"}, "active": {"type": "boolean"},
      "people": {"type": "array", "items": {"type": "string"}},
      "tags": {"type": "array", "items": {"type": "string"}},
      "source": {"type": "string"}, "perspective": {"type": "string"},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1},
      "interpretation": {"type": "string"},
      "status": {"type": "string", "enum": ["held", "revised", "dropped"]}},
    "required": ["id", "content", "createdAt", "active", "source", "perspective", "confidence"]}
}
```

### 7.3 流程与边界

- **检索 [Runtime]**：`rp_team_memory_search` 先按 ACL 过滤，再做子串匹配（content/source/perspective/people/tags）、`fields` 精确匹配，排序只有 newest/oldest，limit 默认 20、最大 100。**没有语义检索，也没有按情绪加权**。“选哪条浮现”是 Association 模型的判断 **[Preset]**。
- **写入 [Runtime]**：`memory_add` 和 `memory_update` 都需要 `expectedVersion`，可以从 search 返回的 `version` 取得。update 每次只能改一个字段，并且不能改 `id/createdAt/updatedAt/active`；归档和恢复用 archive/restore。
- **时间**：`createdAt` 是工具保存的时间，不是故事里事情发生的时间。故事时间写进 `storyTime`，`since/until` **不会**按 storyTime 过滤。
- **错误记忆**：回忆可以偏移细节、顺序和语气，用 `status: "blurred"` 和较低的 `confidence` 表示，`source` 必须保留。不能虚构关于对方的核心事实；回忆也不会同步进 world truth。客观事实、信念和回忆三者可以不一致，Runtime 没有自动纠偏器。
- **稀疏性**：大多数待记忆片段不会变成长期记忆。每次整理至多新增 1 条。没选中任何片段、回忆返回 `none:true`，都是合法结果。
- **试演初值**：初始记忆通过 Trial 的 `initialState` 写入，属于作者编辑，可以写固定的合成 `id/createdAt`（见 §11）。

---

## 8. 作者参数

前四项是“常用”面板，其余放在“高级”里。

| id | 名称 | type | 默认值 | 约束 | 绑定（精确） |
|---|---|---|---|---|---|
| attention_style | 注意与解释风格 | text | “注意力有限，容易被具体的小细节抓住；解释偏谨慎，宁可保留几种可能。” | — | `{kind:"agent",agentId:"perception",path:"/systemPrompt"}` mode `text`；`{kind:"agent",agentId:"belief",path:"/systemPrompt"}` mode `text` |
| restraint_style | 表达克制倾向 | text | “不太会直说在意的事，常说一半或换个话题。” | — | `{kind:"agent",agentId:"inhibition",path:"/systemPrompt"}` mode `text` |
| recall_tendency | 琐碎回忆倾向 | text | “偶尔被很小的线索勾起无关紧要的往事；大多数时候什么都没想起来。” | — | `{kind:"agent",agentId:"association",path:"/systemPrompt"}` mode `text` |
| microstate_interval | 微状态更新间隔（轮） | number | 3 | valueSchema `{"type":"number","minimum":1,"maximum":12}` | `{kind:"agent",agentId:"microstate",path:"/triggers/0/every"}` mode `set` |
| actor_model | 正文模型 | model | `"inherit"` | — | `{kind:"agent",agentId:"actor",path:"/modelRef"}` mode `set` |
| background_model | 后台模型 | model | `"inherit"` | — | mode `set`，5 个目标：perception、belief、microstate、association、inhibition 的 `/modelRef` |
| actor_max_tokens | 正文输出上限 | number | 1500 | valueSchema `{"type":"number","minimum":200,"maximum":8000}` | `{kind:"agent",agentId:"actor",path:"/parameters/maxTokens"}` mode `set` |
| turn_request_cap | 单轮请求上限 | number | 24 | valueSchema `{"type":"number","minimum":8,"maximum":60}` | `{kind:"team",path:"/execution/budget/maxRequests"}` mode `set`。D11 修正后最坏计划内轮次约 26 次请求，若试演中频繁触顶调到 28（§9.5） |

说明：

- `text` 模式只替换目标字符串中的 `{{param:ID}}`。§4 的提示词草案里，每个被绑定的 prompt 都**恰好含有**对应标记；缺少标记时，解析会报错，不会静默忽略（`author-parameters.mjs:resolveAuthorParameters`）。
- 数字参数的“正整数”无法用 valueSchema 表达。如果填 2.5，参数解析后会重新校验整份配置（periodic 的 `every` 和 `maxTokens` 必须是安全整数），整份配置会被拒绝，不会被四舍五入。面板说明应写“请填整数”。
- `/triggers/0/every` 按数组索引定位。**调整 Microstate 触发器顺序后，必须复查这项绑定**。
- 参数不改变 ACL 或发布权限，所以不会出现 `authorityChange`。
- **没有** initial-only 参数（见 D9）。如果以后要加，必须标注“只初始化缺失状态，不影响已积累的值”。
- 不提供“噪声”“信心阈值”“世界真相共享给 Actor”这类开关。

---

## 9. 执行例子与成本

估算假设模型能在一次回复里**并行**发出多个工具调用。如果模型只能逐个调用，请求数会明显上升，需要在试演中实测。表中“请求”指一次模型调用。

### 9.1 普通轮（第 2 轮，没有特殊线索）

| 步骤 | 成员 | 请求 | 内容 |
|---|---|---|---|
| 1 | perception | 1 | 并行读 `/perception/current`、`/continuity/subjective`、`/microstate/attention` |
| 2 | perception | 1 | 写 `/perception/current`，send percept-to-belief、percept-to-actor |
| 3 | perception | 1 | 一句话结束 |
| 4 | belief | 1 | 读 hypotheses、continuity、两个 microstate 叶子 |
| 5 | belief | 1 | 写 hypotheses 和 actor_view，send belief-view-to-actor |
| 6 | belief | 1 | 结束 |
| 7 | actor | 1 | 并行读 4 条路径 |
| 8 | actor | 1 | publish，写 `/behavior/recent` |
| 9 | actor | 1 | 结束 |

约 **9 次请求**（7～14），3 次激活。串行关键路径约 9 次请求。Microstate 已在第一轮循环被标为 skipped（periodic 第 2 轮不命中，信号也没变），不阻塞 Actor。

### 9.2 微状态轮（第 4 轮，或信号变化）

在普通轮的基础上，Perception 写入后 Microstate 被唤醒（或在本轮开始时因 periodic 入队），在 Perception 结束后和 Belief 并行：读 → 写 `/microstate`（必要时写 `/goals/micro`）→ submit_internal 并结束，**约 +3**，合计约 12 次请求。关键路径基本不变（和 Belief 并行）。

### 9.3 记忆轮（scenario 5 一类）

Belief 在第 4 步后发 `belief-recall`（await，释放槽）→ Association：search 加读 recall_history（1）、写 recall_history 加 submit_internal（1）、结束（1）→ 结果回到 Belief 的同一次激活 → Belief 写入并发送（1）→ 结束。**约 +4**，合计约 13 次请求；串行关键路径约 13。

### 9.4 表达冲突轮（scenario 6 一类）

Actor 读完状态后发 `actor-restraint`（await）→ Inhibition：读 3 个叶子（1）、submit_internal（1）、结束（可能 1）→ Actor 按方向写正文并 publish（1）。**约 +3～4**。

### 9.5 计划内最坏轮

perception 3 + belief 4（await）+ microstate 3 + association 应答 3 + 整理至多 5（读 → 查重 → add 加删队列 → 记台账 → submit）+ inhibition 3 + actor 5（两次 await）≈ **26 次请求**，8 次激活。第三次 Association 激活（例如再叠加一次整理）会被 `maxPerAgent: 2` 阻止，请求方收到 `return_error` 后继续。串行关键路径约 18～20 次请求。

**注意**：D11 修正让最坏计划内轮次从约 24 升到约 26，略高于已定上限 24。撞上时整轮失败、可重试——这种"三件事全凑在一轮"的情况应该很少；如果试演里频繁出现，优先把 `turn_request_cap` 调到 28，而不是降成员的收尾顺序。

### 9.6 降级

| 失败点 | 结果 |
|---|---|
| perception 激活失败 | `onFailure: stop`，整轮失败，暂存写入随轮丢弃；用户可以明确重试 |
| perception 正常结束但漏发 | Actor 无 perception 消息 → 不发布 → `RP_TEAM_PUBLICATION_REQUIRED`，整轮失败可重试 |
| belief | continue；Actor 没有 belief 消息 → 读 `/belief/actor_view`（= 最近一次实际送达的视图） |
| microstate | continue；沿用已提交值 |
| association（失败、超时或达到上限） | `return_error`；调用方当作“没想起来”继续 |
| inhibition | `return_error`；Actor 自己判断，倾向少说 |
| actor | 发布者失败，整轮停止 |

**辅助成员失败一律不解释成角色的心理事件**，提示词里不写“如果没有回忆就表现得茫然”这类规则。

---

## 10. 默认限制、预算与禁止行为

### 10.1 执行限制

```json
"execution": {
  "concurrency": 2, "maxActivations": 10, "maxPerAgent": 2, "maxDepth": 4,
  "budget": {"maxRequests": 24, "maxElapsedMs": 240000}
},
"output": {"agentId": "actor"}
```

- `concurrency ≤ maxActivations`、`maxPerAgent ≤ maxActivations`，满足 schema 校验。
- 暂不写 `maxReportedTokens`（见 D8）。先在试演中记录每轮实际 reported tokens，再取 p95 × 1.3 作为上限；并且只在确认所用服务商会报告用量后才启用，因为启用后遇到一次没有用量报告的请求就会停止。
- 如果中转线路对并发敏感，可以把 concurrency 设为 1。await 会释放槽，团队仍能跑完，只是更慢。

### 10.2 禁止行为（提示词约定，Runtime 不检查）

- Actor：心理报告、数值外露、逐条覆盖输入、为推进剧情制造事件、复读最近的动作或口头禅。
- 后台成员：写台词、润色正文、给用户建议、总结用户动机并当作事实。
- Perception：补回没注意到的内容，把猜测写进 foreground，把原话改写成结论，每轮都制造曲解。
- Association：编造关于对方的核心事实，全库倾倒。
- 所有成员：使用 shell、网页、MCP、原生协作工具（已由 capabilities 硬性关闭）；直接写 world 状态（ACL 已硬性禁止）。

---

## 11. 试演场景

通用约定：

- 每条输入都加 `{"type":"single_output"}`。
- 每个场景都加 `{"type":"body_not_contains","text":"physical_energy"}` 和 `{"type":"body_not_contains","text":"hypothes"}`，用来抓后台字段名漏进正文。
- 场景 8、9、10 额外对 world truth 整行做 `state_equals`。**这三个场景需要先在宿主变量配置里声明 `local_aliveness_truth`（§6.1 注），未启用前跳过**。
- 泄露检测只使用**合成标记** `SYNTHETIC_WORLD_SECRET_7Q`，不用真实秘密。

`state_equals` 按 getState 返回的精确 namespace/path 行比较，因此检查的是整个 `world /variables/local_aliveness_truth` 对象。A、B 两个方案都必须声明这条定义（§12）。

| # | 场景 | 输入序列 | initialState | 内置断言 | 人工 / 轨迹检查 |
|---|---|---|---|---|---|
| 1 | 模糊短句 | “嗯，随便吧，反正你想去就去。” → “我只是有点困。” → “刚才那个问题还没说完。” | 无 | 通用 | 第 1 轮 hypotheses 有 ≥2 条、confidence 都不高；第 2 轮因新证据修正（revised），而不是第 1 轮就读心、和解；第 3 轮 continuity 的 unresolved 被用上 |
| 2 | 多事项输入 | “今天下雨了，你那个杯子我洗好放柜子里了，周末要不要去看展？明天我得早起。” → “所以周末呢？” | 无 | 通用 | foreground ≤3；Actor 没有补回未被注意的事项（对照 percept-to-actor 消息）；第 2 轮能接上被追问的那一项 |
| 3 | 状态惯性 | 起点历史中已有角色疲惫的表述；“早。” → “快点，别磨蹭了。” → “算了，你先歇会儿吧。” | `shared /microstate` = `{"attention":0.4,"physical_energy":0.25,"social_energy":0.3,"irritation":0.2,"embarrassment":0.1,"background_focus":"昨晚没睡好","unfinished_thought":""}` | 通用 | 用 Trial 结果的状态行和轨迹核对：相邻轮数值变化 ≤0.15（显著事件 ≤0.3），没有回到默认值的重抽；正文没有每轮固定叹气 |
| 4 | 跨轮误解 | “算了，不聊了。” → “刚才是电话响了。” → “我回来啦。” | 无 | 通用 | 第 1 轮可以误解；第 2 轮出现 counterEvidence 并降低信心；第 3 轮没有固执，也没有立刻完全恢复 |
| 5 | 琐碎记忆再激活 | “晚安～” → “外面又下雨了。” | `shared /memories/episodic` = 下方 2 条合成记录；`shared /habits/cues` = 1 条合成习惯 | 通用 | 有 `rp_team_memory_search` 的工具证据；选中的记录有 source；允许不表达；不强制回收伏笔 |
| 6 | 表达冲突 | “今天又见到她了。” → “对了，明天几点出门？” | 无 | 通用 + `body_not_contains` “后台分析” | 只有第 1 轮可能出现 actor-restraint；返回内容只有 limit/direction/avoid；正文没有心理报告，也没有固定的吃醋台词；第 2 轮不再调用 |
| 7 | 没有主线压力 | “我坐着看了一会儿窗外。” → “嗯。” → “还没想好。” | 无 | 通用 | 没有凭空引入事件、危机或关系升级；可以安静、琐碎，或提一个小需求 |
| 8 | 世界真相隔离 | “今天过得怎么样？” → “你在看什么？” | `world /variables/local_aliveness_truth` = 下方含标记的对象 | 通用 + `body_not_contains` 标记 + `state_equals` 整行 | **逐个核对各成员子会话的实际请求**，Actor 的请求中都不应出现标记；Perception 只拿到 `/sensory`；所有 summary 和消息中也不应出现 |
| 9 | 稀疏与降级 | 4 条普通输入，第 3 条带“晚安”线索 | 同场景 5 | 成功轮：通用 + `state_equals` world truth | 统计每轮激活：普通轮约 3 次；第 3 轮才有 association。辅助成员失败的注入需要本地 fixture，**不在本次设计授权内**，只记录为后续验收项 |
| 10 | 取消、预算与回退 | 先成功一轮；第 2 轮手动取消；再明确重试 | 无 | 已提交轮：通用 + `state_equals` world truth | 取消的那一轮没有正文、没有新记忆、`/behavior/recent` 没变；重试从最后提交的检查点继续；冷却记录不含被取消的那一轮。这些需要核对轨迹，不是单条断言能证明的 |
| 11 | 普通闲聊（反向检查） | “吃了吗？” → “今天天气不错。” → “你在忙什么？” | 无 | 通用 | **反向验收**：没有需要误解的输入时，hypotheses 允许只有 0～1 条直白理解；association 和 inhibition 都不应被调用（无 cue、无表达冲突）；`/memory/pending_cues` 至多新增 0～1 条；正文不强行制造误会、不强行回忆、不强行小动作。闲聊也出戏就说明干预过重，要减 |

场景 5 和 9 的合成初值：

```json
[
  {"namespace": "shared", "path": "/memories/episodic", "value": [
    {"id": "ep-syn-0001", "content": "有次把“晚安”打成了“碗安”，对方回了一个碗的表情。",
     "createdAt": "2026-01-01T00:00:00.000Z", "active": true, "people": ["对方"],
     "tags": ["打字", "晚上"], "source": "作者合成初值", "perspective": "角色自己的回忆",
     "confidence": 0.7, "cueTags": ["晚安", "打错字"], "status": "intact"},
    {"id": "ep-syn-0002", "content": "某个下雨天问过对方喜不喜欢雨声，对方没回答就岔开了。",
     "createdAt": "2026-01-02T00:00:00.000Z", "active": true, "people": ["对方"],
     "tags": ["下雨", "没回答"], "source": "作者合成初值", "perspective": "角色自己的回忆",
     "confidence": 0.5, "cueTags": ["雨"], "status": "blurred"}
  ]},
  {"namespace": "shared", "path": "/habits/cues", "value": [
    {"id": "hb-syn-0001", "cue": "下雨", "tendency": "会多看几眼窗外，话变少",
     "strength": 0.4, "evidence": ["作者合成初值"]}
  ]}
]
```

场景 8 的初值：

```json
[{"namespace": "world", "path": "/variables/local_aliveness_truth", "value": {
  "sensory": {"visible": ["桌上有一个没拆的快递盒"], "audible": ["楼下有人在搬东西"], "bodily": []},
  "facts": [{"id": "f-syn-1", "content": "快递是对方偷偷准备的礼物 SYNTHETIC_WORLD_SECRET_7Q", "source": "作者合成"}]
}}]
```

注意：

- `initialState` 是作者编辑。快照中已有值时，config default 不会把它清空。A/B 必须从**同一个快照**、执行**同一组** initialState。
- **不要**用 `body_contains` 强制角色说“犹豫”“随便”之类的词，那会制造新的模板。
- 微状态的精确小数不做 `state_equals`；没有可控 fixture 时，只按范围和趋势人工核对。

---

## 12. A/B：与单 Actor 基线的公平对照

### 12.1 方案 B（单 Actor）

- 只有一个成员 `actor`。保留同一稳定 ID、`user:true`、`output.agentId: "actor"`。
- `systemPrompt`：沿用 A 的 Actor 中关于角色身份、“可以停顿或只回应一部分”“不必推进剧情”“不报告心理”的部分，删掉所有关于后台过程、handoff 和状态路径的句子。**不要**把 A 的后台规则改写成长篇心理分析塞给 B。
- context.sources：`current_input`、`{"type":"recent_history","limit":12}`、`character_card`（selector 与 A 相同）。
- capabilities 与 A 相同（全部关闭）；`parameters.maxTokens` 用同一参数值；modelRef 与 A 的 actor 相同。
- statePermissions：`[]`；`outputAuthority`：`{"internal": false, "draft": false, "state": false, "user": true}`。
- `state.definitions`：**原样复制 A 的全部定义，但不授权给任何人**，只为让共同的 `initialState` 和 `state_equals` 在 B 中也有效。B 不声明 memory 和 authorParameters（除 actor_model、actor_max_tokens 外）。
- execution：`{"concurrency": 1, "maxActivations": 2, "maxPerAgent": 1, "maxDepth": 1, "budget": {"maxRequests": 24, "maxElapsedMs": 240000}}`。

### 12.2 实验组

| 实验 | 对照 | 改变的变量 | 回答的问题 |
|---|---|---|---|
| E1 | A（严格门控）vs B | 整套架构：A 的 Actor 看不到原文，B 看得到 | 整体是否值得增加的成本 |
| E2（可选） | A vs A-open：A-open 的 Actor 额外获得 `current_input` 和 `recent_history` limit 4 | 只改变信息门控 | 门控本身的效果，与模块分工分开 |
| E3（可选） | B vs B-restricted：B 只获得 Perception 风格的受限输入 | 只改变分工 | 受限输入下，分工是否有额外收益 |

一次 Trial 最多两个方案，因此 E2、E3 都是独立的 Trial，记录时不能混在一起。

### 12.3 公平性要求

1. 从同一个快照开始；记录 snapshotId、两份 config 的 sourceHash/resolvedHash、模型路由和参数值。
2. 场景 3 的“疲惫”必须同时写进起点历史（两方都能看到）和 A 的 `/microstate`（只有 A 能读）。这个差异属于架构变量，要记录下来。
3. 两个方案顺序运行，各自从同一起点开始；A 的状态和记忆不会进入 B。
4. 所有尝试都要计入，包括失败、预算耗尽和取消，不能只挑好看的片段。
5. 先盲看正文，再看轨迹。不用模型自动打分。不同模型的采样有差异，也没有固定 seed 的契约，所以只报告样本数，不声称统计显著。

### 12.4 指标

| 指标 | 记录方法 | 不应误判 |
|---|---|---|
| 重复模板率 | 人工标注重复措辞或微动作，按总轮数和相邻轮分别统计；A 可以参照 `/behavior/recent` | 动作多样不等于因果合理 |
| 全覆盖倾向 | 先标出输入中的独立事项，再数回复处理了几项 | 安全或现实中的关键信息被漏掉，不算优点 |
| 微小主动行为 | 能追溯到状态、线索或目标的非主线行为次数 | 无缘无故的怪癖不算 |
| 误判的延续与修正 | 跟踪同一 hypothesis 跨轮的 evidence/confidence/status | 越偏执不等于越像人 |
| 琐碎记忆再激活 | 检索 → 选中 → 返回 → 是否表达，四步分别计数 | 编造的记忆、每轮回收伏笔不算 |
| 内部状态外露 | 正文中出现心理字段、分析式措辞的次数 | 正常的内心独白按作者文风判断 |
| 强迫推进 | 没有局部原因却升级关系或引入危机的轮数 | 角色自然发起的行动不算 |
| 成本 | 每轮请求数、reported tokens、耗时、失败数，常驻轮和稀疏轮分开统计 | 激活数 ≠ 请求数；未知的 token 用量不能当作 0 |

### 12.5 Trial 预算（独立于正式运行预算）

§10.1 的每轮预算（24 请求 / 240s / 不设 token 上限）限制的是一轮内部的成员工作；Trial 有自己的两层预算字段（`trials.mjs:normalizeBudget`），是**额外**消耗的模型额度：

- `budget.turn`（每一轮）：`{"maxRequests": 24, "maxReportedTokens": 64000, "maxElapsedMs": 240000}`——请求与耗时对齐正式预算。**`maxReportedTokens: 64000` 是试演专用的停止阈值**（正式预算里没有这一项）：用于测量每轮 token 量级、防止单轮失控；触顶会截断该轮，不影响正式配置。
- `budget.task`（**每个**试演任务）：一次 `rp_team_trial` 调用 = 一个场景 × 两个方案（A/B）。首批 3 个场景 = **3 个独立任务**（场景 1：A/B 各 3 轮共 6 轮；场景 11：6 轮；场景 5：4 轮），每任务起点 `{"maxRequests": 240, "maxReportedTokens": 200000, "maxElapsedMs": 1500000}`——**这是每任务上限，不是三个场景合计**。各场景按每轮顶格 24 的最坏请求数依次为 144/144/96，240 留了重试余量；真耗尽先看轨迹再决定是否放宽，不预先调大。
- 三个任务合计的最坏上限是 720 次请求 / 60 万 reported tokens / 75 分钟，但每任务独立计时计数，且实际消耗由成员激活数、工具往返和重试决定，**无法预先折算成固定费用**。
- **试演模型**：全部成员 `modelRef: "inherit"`，即冻结快照里会话当时的模型。启动时从冻结快照核对实际的 provider、模型与参数（快照是私有文件，`trials.mjs` 保存），**不从 provider 可选列表推断**。既往 run 的 trace 记录过一次解析结果 `provider:"deepseek-default", model:"[OR]inkling"`，只作历史参考。
- 场景 8～10 不进首批：需要先在宿主变量配置里声明 `local_aliveness_truth`，且 world `initialState` 的 `applyStateEdit` 要宿主回执成功。
- 每一批都由作者明确启动；失败、超时和取消的轮次照样计数、照样写进报告。

---

## 13. [Hypothesis] 待验证的效果

1. 限制 Actor 的输入能减少“全覆盖”式模板，同时保持足够的连续性。反面风险是门控过强，角色显得笨拙，遗漏关键信息（E2 检验）。
2. 多种竞争解释能带来跨轮的误解与修正，而不是让后台模型再写一份“完美心理分析”。
3. 稀疏更新的 Microstate 能形成惯性，而不是带来延迟、僵硬或固定的情绪动作。
4. condition 触发的整理加上按需检索，能让琐碎记忆自然浮现，而不只是增加工具成本、制造人为伏笔。
5. 按需 await Inhibition 能改善表达矛盾。如果实际几乎每轮都调用，说明它退化成了重复写作器，应合并或删除。
6. 三常驻加三稀疏的收益足以抵消约 2～3 倍的请求数和延迟。如果收益不明显，优先考虑删掉 Inhibition 或 Association，而不是加成员。

以上都是创作实验，不是已验证的心理学模型。权限、提交和身份可以靠测试证明；“更像人”只能靠样本和作者的判断。

---

## 14. 配置可表达性自检

### 14.1 字段落地

| 设计要素 | Runtime 落点 | 核对位置 |
|---|---|---|
| 六个成员、稳定 ID、唯一发布者 | `agents[]`、`output.agentId`、`user:true` | `schema.mjs:normalizeOutput` |
| 只保留 Team 工具 | 非空 `capabilities` 全部 disabled，`trustedTools: []` | `native-policy.mjs:allowedGroupsForAgent`、`runtime.mjs:classifyTool` |
| periodic/state_changed/condition/requested_by_agent | 字段名与校验都和 §4 一致 | `schema.mjs:normalizeTriggers`、`validateAgentReferences` |
| 监听对象内叶子 | state_changed 的前后值按触发路径读取 | `runtime.mjs:captureStateBefore/notifyStateChanged` |
| 未触发成员不阻塞 `after` | 先标 skipped，之后可重新排队 | `scheduler.mjs:489, 69-94` |
| 子路径授权 | 最长前缀定义加路径 ACL | `state-store.mjs:stateDefinition` |
| Actor 不读原文 | fresh 子会话，提示词只有过滤后的上下文包；宿主会话上下文按来源投影 | `agent-context.mjs:childPrompt`、`context-world-adapter.mjs:projectConversationContext` |
| handoff 强制、投影与回传 ACL | 全部边都用 handoffId；回传要求反向 canSend | `communication.mjs:29-98, 370-388` |
| responseSchema 与 submit_internal | 目标在对应执行中提交有类型的结果 | `communication.mjs:234`、`agent-context.mjs:185` |
| valueSchema 关键字 | 只用了 7 个支持的关键字 | `value-schema.mjs` |
| 记忆集合与工具约束 | 绑定 array 定义；add 由宿主分配 id；update 只改一个键 | `memory.mjs`、`memory-tools.mjs` |
| 参数绑定 | text 标记、model/number 的 set、team 的 execution 路径 | `author-parameters.mjs` |
| 预算字段 | `execution.budget.{maxRequests,maxElapsedMs}` | `schema.mjs:normalizeLimits` |
| Trial 场景、initialState、4 种断言 | 形状与 §11 一致 | `trials.mjs:normalizeScenario/normalizeAssertion/normalizeInitialState` |

不需要新的 Runtime 功能、脚本、向量库、后台时钟，也不需要隐式共享世界事实。

### 14.2 硬保证与软约束

| 硬保证 **[Runtime]** | 只能软约束 **[Preset]** |
|---|---|
| Actor 的上下文包里没有本轮原文、历史、世界书和 world 状态 | Perception 到底挑了哪几件事、有没有在 summary 里偷偷补回 |
| 没有成员能写 world truth；Perception 只能读 `/sensory` | 角色卡或 sensory 本身是否含有秘密（需要作者审查） |
| 每条通信边受 ACL 和 handoff 投影限制；summary 不会回传给 Actor | 被投影出去的字段里写了什么（一个合法字段仍可能夹带秘密） |
| 只有 Actor 能发布正文 | 正文是否克制、是否不报告心理 |
| 写入需要 CAS，有冲突会显式失败；未提交的轮次整体丢弃 | 数值的变化幅度、回归基线、“没有理由不改” |
| 触发、冷却、最大激活数、深度、请求数和耗时都由 Runtime 计数 | “大多数轮次不调用 Inhibition/Association” |
| 记忆的 id、createdAt 由宿主分配；搜索先按 ACL 过滤 | 选哪条回忆、是否记错、是否表达 |

**summary 泄露提醒**：Perception 发给 Belief 的版本含 `/summary`。Perception 只拿到 sensory，没有 facts，所以 summary 本身接触不到 world truth。但如果角色卡含有秘密，并且作者没有用 selector 裁剪，任何 summary 都可能把它带出去。

---

## 15. 可选的未来需求（首版不做）

- 按 role 过滤的历史来源（例如“只给 Actor 它自己说过的话”），可替代 `/behavior/recent`。
- valueSchema 支持 `integer`、`maxItems`，把“≤3 条”“整数间隔”从约定变成硬校验。
- 参数绑定支持对象内的单字段默认值，用于恢复初始能量参数。
- 基于 cue 相似度的检索排序。
- 单个成员级的暂存回滚。
- Trial 断言支持数值范围、正则和调用次数。
- condition 与 periodic 的 AND 组合。

---

## 16. 请作者审核的决定点

1. **角色卡自知资料**（**已定**）：dev 卡陈加怡走方案 2，作者手工维护 `/character/self_known`，草稿在 `SELF_KNOWN_DRAFT_陈加怡.zh-CN.md`（本文档同目录）审完后定稿；另设 `/character/inner_directives` 后台性格指导（actor、perception 不读）；未定设定不进运行时。prod 的 Fable 卡暂不动。
2. **原生 preset**（**已定，2026-10-05**）：先继承挂载的 preset（`presetId: ""`）。Preview 时检查它的系统提示词，如果会让后台成员去写角色回复，再换精简 preset。
3. **Perception 失败即停止**（**已定**）：接受 D7，`perception.execution.onFailure = "stop"`。
4. **预算**（**已定**）：正式运行以 `maxRequests 24 / maxElapsedMs 240000 / 不设 maxReportedTokens` 为起点（D8）；试演预算另列在 §12.5。
5. **world truth 接入方式**（**已定**）：可选接入，不是首版必要条件。定义照常声明；宿主没声明 `local_aliveness_truth` 时一切照常运行；要启用时由作者在宿主变量配置里声明（宿主校验优先，插件不代建）。场景 8～10 等宿主侧可用后再排。
6. **首批试演范围**（待定，等作者单独说"开始试演"）：场景 1（A/B 各 3 轮）+ 场景 11 闲聊（6 轮）+ 场景 5（4 轮），共 16 轮、3 个独立任务；预算见 §12.5（240 请求 / 20 万 reported tokens / 25 分钟为**每任务**上限）。启动时从冻结快照核对实际 provider、模型与参数。

本文到此为止，等待作者审核；不安装，不试跑。
