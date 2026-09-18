# MCode Trajectory Studio — 设计文档

> 目标：把 dsh（DeepSeek Harness）Web 端 Trajectory 视图的能力，落到一个 MCode Agent Plugin 上，
> 用于查看 mcode 自身的会话轨迹（轮次 / 时长 / 调用入参 / 结果 / token / 压缩 / 子代理）。
>
> 状态：**已实现并通过验证**（2026-09-18）。设计决策见下文，实现落地情况见第 8 节。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| 现有插件能用吗？ | **不能**。`hetaoBackend/minimax-code-trajectory` 读 `ledger.jsonl`，本机 487 个 session 里 **0 个**存在该文件，实测返回空列表。 |
| 读什么数据源？ | **SQLite**（`~/.minimax/v2/sqlite/runtime-state.sqlite`，只读），`messages.jsonl` 作 fallback。SQLite 覆盖面 480/482，字段量级碾压。 |
| 落成 MCP 还是 mini app？ | **MCP stdio server + 本地 HTTP Web UI**。规范明确「Apps or UI extensions」不是插件能力，但仓库内已有同作者的 `mcode-dynamic-workflows` 用「MCP + 本地 HTTP 面板」实现了 mini app 体验，且被仓库接受。 |
| 改他的版本还是另起炉灶？ | **另起炉灶**在 `plugins/weekbin/mcode-trajectory-studio/`，但借鉴其安全工程做法（拒绝 symlink、行大小上限、CSP）。 |

---

## 1. 前置门调研：现有插件已失效

### 1.1 事实

`plugins/hetaoBackend/minimax-code-trajectory/`（v0.2.0，MCP stdio，纯 Node 标准库）存在，名义上覆盖诉求。

但读它的源码：

```js
// lib/trajectory.mjs:167
const ledgerPath = path.join(sessionDir, 'ledger.jsonl');
// lib/trajectory.mjs:20
const available = discovery.sessions.filter((session) => session.ledgerState === 'file');
```

它**只**接受 `v2/sessions/YYYY/MM/DD/<session>/ledger.jsonl` 形态的会话。

### 1.2 实测

```bash
$ find ~/.minimax -name ledger.jsonl | wc -l
0
$ find ~/.dsh -name ledger.jsonl | wc -l
0
```

会话产物实际存在情况（`~/.minimax/v2/sessions`，共 487 个 session 目录）：

| 文件 | 存在数量 |
|---|---|
| `ledger.jsonl` | **0** |
| `display.jsonl` | 0 |
| `snapshot.json` | 0 |
| `messages.jsonl` | **487** |
| `history-catalog.json` | 445 |
| `user-message-locators.jsonl` | 445 |

直接跑它的 MCP server：

```json
// tools/call → list_minimax_sessions
{"sessions": [], "returned": 0, "discovered": 0, "unavailable": 482, "warnings": []}
```

**结论：该插件在本机完全不可用。** 它自述的 "Manifest-only sessions whose ledger has already been removed are counted as unavailable" 正是这个现象——`ledger.jsonl` 是它假设的旧形态，本机运行时不产出该文件。

这也印证了作者本人「做的不够好」的反馈，以及用户「读 sqlite 获取的信息更多一些」的判断。

---

## 2. dsh 轨迹能力基线（对标目标）

从本机安装的 dsh 包 README 提取的**能力契约**：

### 2.1 `@deepseek-ai/dsh-client-ui-trajectory`（UI 层）

- 按**轮次**组织的事件记录表，覆盖 user / assistant / tool / 嵌套子工具 / 压缩记录
- 轮次与步骤边界标示，带请求编号与累计用量
- **检查器**：点开单条记录 → token 用量、耗时、输入、输出、计时、图片、附件摘要
- **时间概览**：按真实开始时间 + 耗时投影；助手条区分 **TTFT** 与**解码时间**；悬停 500ms 显示精确时刻
- **交互**：拖选区间聚焦、滚轮缩放、右键清除/平移
- 流式跟随尾部；向上滚动暂停跟随
- 压缩请求单独落在 `Between turns` 区段
- 进行中记录**不虚构耗时**

### 2.2 `@deepseek-ai/dsh-session-stats`（统计层）

| 字段 | 含义 |
|---|---|
| `turns` | 含至少一个已关闭步的轮次 |
| `steps` | 已关闭的步（完成/失败/取消/max-tokens 全计） |
| `llmMs` | 模型墙钟时间之和 |
| `toolMs` | `tool/call` → `tool/result` 墙钟时间之和 |
| `ttftMs` / `ttftSteps` | 首 token 延迟之和及承载步数 |
| `decodeMs` / `decodeTokens` | 解码墙钟时间与提供方输出 token |

### 2.3 `@deepseek-ai/dsh-session-turn-outline`（导航层）

`turn` / `seq` / `prompt`（50 字符预览）/ `response`（120 字符预览）

---

## 3. 数据源对比（核心：接口差异）

### 3.1 三个候选

| 源 | 路径 | 覆盖 | 形态 |
|---|---|---|---|
| A `ledger.jsonl` | `v2/sessions/**/ledger.jsonl` | **0 / 487** | 线性事件流 |
| B `messages.jsonl` | `v2/sessions/**/messages.jsonl` | 487 / 487 | 线性消息流 |
| C **SQLite** | `v2/sqlite/runtime-state.sqlite` | **480 / 482 会话**，102 791 行 | 关系表 + JSON 列 + FTS5 |

### 3.2 字段对照

`R` = 直接可得，`D` = 可推导，`—` = 缺失

| dsh 能力 | A ledger | B messages.jsonl | **C SQLite** |
|---|---|---|---|
| turns / 轮次 | — | R | **R** `turn_id` / `turnId` |
| steps / 步 | — | R | **R** |
| llmMs 模型耗时 | — | — | **R** `usage.request_duration_ms` |
| toolMs 工具耗时 | — | — | **R** `background_tasks` `ended_at_ms - created_at_ms` |
| ttftMs 首 token | — | — | **—（运行时不落盘）** |
| decodeMs 解码时间 | — | — | **D** `request_duration_ms - thinking_duration_ms` |
| decodeTokens 输出 token | — | R `usage.output` | **R** `usage.output_tokens` |
| 输入（tool args） | — | R | **R** `tool_calls[].tool_call_args` |
| 结果（tool result） | — | R | **R** `tool_calls[].tool_call_result_data` |
| 调用状态 | — | — | **R** `tool_calls[].tool_call_status` |
| thinking + 思考耗时 | — | R（无耗时） | **R** `thinking_content` + `thinking_duration_ms` |
| 压缩记录 | — | — | **R** `kind=compaction` + `messagesBefore/After` + `tokensBefore/After` |
| 压缩失败 | — | — | **R** `kind=compaction_failed` |
| 子代理 / 嵌套任务 | — | — | **R** `parent_session_id` + `background_tasks` + `background_task_events` + `task_session_bindings` |
| 会话元数据 | manifest 极少 | manifest 极少 | **R** `agent_name` `title` `workspace_dir` `project_id` `session_kind` `status` `archived` `error_message` |
| 触发来源分类 | — | — | **R** `source`：`api` / `thread-goal` / `questionnaire` / `background-task` / `task` / `agent` / `greeting` |
| 上下文用量分解 | — | — | **R** `context_usage.components`：SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES |
| 遥测 | — | — | **R** `context_usage_telemetry`：model / localTokens / providerTokens / divergenceRate / toolCalibrationStatus |
| 全文搜索 | — | — | **R** `local_runtime_sessions_fts`（FTS5） |
| 附件 / 图片 | — | — | **R** `session_assets`（326 条，含 `asset_type` `path` `deliver-assets`/`media` tag） |
| 高精度行时间 | — | R | **R** `created_at_ms`（毫秒） |

### 3.3 关键证据摘录

SQLite 单行（`local_runtime_message_rows.data_json`）的真实字段普查（抽样 3000 行）：

```
TOP-LEVEL: msg_id, timestamp, turnId, source, msg_type, msg_content, role, turn_id,
           finish_reason, usage, context_usage, context_usage_telemetry, tool_calls,
           canonical_message_id, query_key, thinking_content, thinking_duration_ms,
           sourceContext, kind, metadata, operationId, committedRevision
usage.*:   total_tokens, context_window, input_tokens, output_tokens,
           request_duration_ms, cache_read
tool_calls[].*: tool_name, tool_call_id, tool_call_status, tool_call_args, tool_call_result_data
context_usage.*: contextWindowTokens, usedTokens, totalCountSource, components
```

压缩记录实例：

```json
{
  "kind": "compaction",
  "metadata": {
    "compactionId": "ctx_ea6d06bb-…", "strategyVersion": "local-pi-compaction-v1",
    "phase": "iteration", "messagesBefore": 356, "messagesAfter": 1,
    "tokensBefore": 353109, "tokensAfter": …
  }
}
```

耗时样例（本会话前几轮）：

```
turn_id              req_ms  think_ms  out_tok
turn_mu6wn97l_mf3vd6   4129      4369      904
turn_mu6wnx9w_ee64qg   2997      2632      531
turn_mu6wnx9w_ee64qg    900         —       38
turn_mu6wnx9w_ee64qg   2042       457       90
```

### 3.4 结论

**SQLite 完胜**，且是唯一能支撑 dsh 级功能的源。`messages.jsonl` 作为兜底（覆盖 SQLite 未收录的 2 个会话 + 字段缺失时回退）。

### 3.5 SQLite 的风险与缓解

| 风险 | 缓解 |
|---|---|
| 库 2.5 GB 且运行时正在写（WAL 17 MB） | 一律 `file:…?mode=ro` 只读打开，绝不写；不开 exclusive |
| 表名 `local_runtime_*`、列 `columnar_version` 属内部实现，可能变 | 用 `json_extract` 宽松读取 + 缺字段降级；不依赖固定列序；schema 探测失败即降级到 fallback |
| 大结果集 | 强制分页 + 行数上限；按 `session_id, id` 索引走 |
| 隐私（会话含敏感内容） | 本地 127.0.0.1 绑定 + Host/Origin 校验 + CSP + 无外网；不做任何上传 |
| 只读打开时运行时正在 checkpoint | `mode=ro` 下 SQLite 用 WAL 只读快照，安全 |

---

## 4. 形态决策：MCP 服务 vs Mini App

### 4.1 规范事实

`docs/plugin-compatibility.md:134-140`：

> The following are **not** currently public MCode Plugin capabilities in either runtime:
> … **Apps or UI extensions** …

即：**没有官方 mini app / UI 扩展通道**。用户「倾向 mini app」无法通过原生 UI 扩展实现。

### 4.2 但仓库内已有等价先例

同作者 `plugins/hetaoBackend/mcode-dynamic-workflows/`（v0.8.0）采用：

- `mcp.json` → MCP **stdio** server（`dist/main.mjs --stdio`），供 agent 调用
- `src/http.mjs` → 本地 `http.createServer`，服务 `web/index.html` + `app.js` + `style.css` + `/api/*`
- 工具 `workflow_dashboard` 「返回可收藏的本机可视化面板地址，无需 token」
- Skill 指导 agent 用宿主 `mcp_browser({action, input})` 打开该 URL
- 安全：`check(req.headers.host===new URL(origin).host)`、Origin 校验、自定义头防 CSRF、严格 CSP、`nosniff`、`no-store`

**这是仓库已接受的做法**，等价于「mini app 体验」。

### 4.3 决策

> **MCP stdio server（agent 侧）+ 本地 HTTP Web UI（人侧）**，共享同一数据层。

```
┌────────────────────────────┐
│  MCode (mcode 0.4.x)       │
│                            │
│  agent ──MCP stdio──┐      │
│                     ▼      │
│              trajectory-mcp│──┐
│  builtin Browser ◄──┐      │  │ 只读
│         ▲           │      │  ▼
│         │      HTTP 127.0.0.1:port
│         │           │      │  ~/.minimax/v2/sqlite/runtime-state.sqlite
│         └───────────┘      │  (fallback) v2/sessions/**/messages.jsonl
└────────────────────────────┘
```

- **MCP 侧**（给 agent）：`trajectory_list`、`trajectory_summary`、`trajectory_get`、`trajectory_search`、`trajectory_studio`
- **HTTP 侧**（给人）：交互式 Studio —— 时间概览、轮次表、检查器、筛选、搜索、压缩区段
- **打开方式**：`trajectory_studio` 返回 URL，Skill 用宿主 browser 工具打开（与先例一致）

---

## 5. 修改他的版本 vs 另起炉灶

### 决策：**另起炉灶**

| 维度 | 他的版本 | 我们需要 | 可复用性 |
|---|---|---|---|
| 数据源 | `ledger.jsonl`（不存在） | SQLite 只读 + JSONL 兜底 | 0% |
| 架构 | 一次性生成离线 HTML 文件 | 常驻 HTTP 服务 + 实时查询 | 低 |
| 交互 | 静态页面 | 可筛选/搜索/分页的活服务 | 低 |
| 隐私模型 | 默认不带任何文本 | 本地可视化需要内容（本机 127.0.0.1） | 不适用 |
| 安全检查 | symlink 拒绝、2 MiB 行上限、CSP | 同样需要 | **借鉴** |

理由：数据源与架构都不同，唯一值得复用是安全工程做法。同时他占用了 `minimax-code-trajectory` 这个名字，避免命名冲突与目录污染，另起炉灶更干净。

---

## 6. 插件设计

### 6.1 标识

| 项 | 值 |
|---|---|
| 目录 | `plugins/weekbin/mcode-trajectory-studio/` |
| `name` | `mcode-trajectory-studio` |
| 版本 | `0.1.0` |
| License | Apache-2.0（与仓库一致） |
| 目标运行时 | mcode 0.4.x（本机 0.4.12） |

### 6.2 目录结构（双布局，兼容 0.3.x 与 0.4.0+）

```
plugins/weekbin/mcode-trajectory-studio/
├── README.md
├── LICENSE                       # Apache-2.0
├── plugin.json                   # 便携 Agent Plugins 1.0（校验器 & 0.3.x）
├── mcp.json                      # 便携 MCP 声明
├── .claude-plugin/
│   └── plugin.json               # v0.4.0+ 首选清单（含 skills / mcpServers）
├── skills/
│   ├── SKILL.md                  # 顶层（0.4.0+）
│   └── mcode-trajectory-studio/
│       └── SKILL.md              # 字节一致副本（0.3.x & 校验器）
├── server/
│   ├── main.mjs                  # 入口：--stdio / --http
│   ├── mcp.mjs                   # MCP JSON-RPC（stdio）
│   ├── store.mjs                 # 数据层：SQLite 只读 + JSONL fallback
│   ├── schema.mjs                # schema 探测/降级
│   ├── http.mjs                  # 本地 HTTP + API + 静态资源
│   └── redact.mjs                # 脱敏 + 长度封顶
├── web/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── test/
    └── store.test.mjs
```

### 6.3 MCP 工具

| 工具 | 作用 | 入参要点 |
|---|---|---|
| `trajectory_list` | 列出最近会话（元数据，无正文） | `limit`、`agent`、`since` |
| `trajectory_summary` | 单会话统计：turns / steps / llmMs / toolMs / decodeMs / tokens / 压缩数 / 工具调用数 | `sessionId` |
| `trajectory_get` | 分页读取事件记录（轮次分组） | `sessionId`、`offset`、`limit`、`detailLevel` |
| `trajectory_search` | FTS5 全文检索 | `query`、`limit` |
| `trajectory_studio` | 启动/复用本地 HTTP 面板，返回 URL | `sessionId?`、`port?` |

隐私默认：`detailLevel=summary` 不带正文；`full` 需显式请求，且结果经脱敏 + 长度封顶。

### 6.4 HTTP 面板（Studio）

对齐 dsh Trajectory 的观感：

1. **顶部 Overview 时间条** — 按 `created_at_ms` 投影真实开始/耗时；助手条区分「思考段」与「输出段」（用 `thinking_duration_ms` vs `request_duration_ms - thinking_duration_ms` 近似 dsh 的 TTFT/解码双色）；悬停显示精确耗时
2. **轮次记录表** — 按 `turn_id` 分组，标注轮次/步骤边界、请求编号、累计 token
3. **检查器** — 点开一条：token 用量（input/output/cache/total）、`request_duration_ms`、`thinking_duration_ms`、工具入参、工具结果、状态
4. **筛选** — 按 `source`（api/thread-goal/questionnaire/background-task/task）、按角色、按工具名、仅失败
5. **压缩区段** — `kind=compaction` 落独立 `Between turns` 段，显示 messages/tokens 前后
6. **子代理视图** — 通过 `parent_session_id` / `background_tasks` 展示嵌套
7. **搜索** — 走 FTS5
8. 长历史分页 + 只渲染可见行

### 6.5 安全基线（对齐先例）

- 绑定 `127.0.0.1`，仅本机
- `Host` 头必须等于监听 authority；带 `Origin` 时校验同源
- API 要求自定义头，强制跨站请求走被拒的 CORS preflight
- CSP `default-src 'self'`；无远程字体/脚本/样式；无外网请求
- `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`
- SQLite 一律只读打开；不写入任何会话产物
- 拒绝 symlink 的输出目录；单行/单响应大小上限

### 6.6 校验器合规清单（`scripts/validate.mjs`）

- [ ] 目录名 = `plugin.json.name`，符合 `PLUGIN_NAME`，≤64 字符
- [ ] 全目录**无 symlink**
- [ ] `README.md`、`LICENSE` 非空
- [ ] `plugin.json` 声明 `license`
- [ ] 任何 `.md` / `plugin.json` / `mcp.json` 中**不得出现 `T`+`ODO` 占位字面量**
- [ ] 至少一个 Skill 或 MCP server
- [ ] SKILL.md 有 YAML frontmatter，`description` ≤1024，正文非空
- [ ] MCP transport ∈ {stdio, streamable-http, sse}

---

## 7. 待确认事项

1. **插件命名**：`mcode-trajectory-studio` 是否合适？（备选 `mcode-trajectory`、`mcode-flight-recorder`）
2. **形态**：接受「MCP stdio + 本地 HTTP 面板」，还是只要 MCP 工具、不做 Web UI？
3. **分支与推送**：分支名建议 `feat/weekbin-mcode-trajectory-studio`；推送到 `weekbin` fork（已配置远端）。是否批准？
4. ~~**TTFT 取舍**：mcode 不落盘 TTFT~~ → **已定**：`ttftMs` 恒为 `null` 且明确标注不可用，Overview 改用「思考段 / 输出段」双色条（紫/绿）近似。

---

## 8. 实现落地情况（已交付）

### 8.1 文件清单

```
plugins/weekbin/mcode-trajectory-studio/
├── DESIGN.md                     本文件
├── README.md                     用户文档（含隐私与已知限制）
├── LICENSE                       Apache-2.0
├── plugin.json                   便携 Agent Plugins 1.0 清单
├── mcp.json                      MCP stdio 声明
├── .claude-plugin/plugin.json    v0.4.0+ 清单（含 skills / mcpServers）
├── skills/SKILL.md               顶层 Skill（0.4.0+）
├── skills/mcode-trajectory-studio/SKILL.md   字节一致副本（0.3.x + 校验器）
├── server/
│   ├── main.mjs    入口：stdio / --serve / --doctor
│   ├── store.mjs   数据层：SQLite 只读 + messages.jsonl 兜底
│   ├── mcp.mjs     MCP JSON-RPC + 6 个工具
│   ├── http.mjs    本地面板 + /api/* + 安全栅栏
│   └── redact.mjs  脱敏与长度封顶
├── web/
│   ├── index.html
│   ├── app.js      缩放/平移时间轴、轮次表、检查器、筛选
│   └── style.css
└── test/store.test.mjs           18 个测试
```

**零依赖**：仅用 Node 标准库（`node:sqlite` 要求 Node 22+，本机 24.19.0 验证通过），无构建步骤，无 `node_modules`。

### 8.2 验证结果

| 验证项 | 结果 |
|---|---|
| `npm run validate`（仓库校验器） | `OK plugin weekbin/mcode-trajectory-studio`，29 个插件全通过 |
| `npm run check`（全仓库 363 测试） | **363 pass / 0 fail** |
| 插件自带测试 `node --test` | **18 pass / 0 fail** |
| MCP `initialize` / `tools/list` / 6 工具调用 | 全部返回有效结果，真实数据 |
| `--doctor` 真实数据 | 500+ 会话可见，SQLite + FTS 均可用 |
| HTTP 面板（Playwright 实开） | 渲染正常，无 console 错误 |
| 安全栅栏 | 缺自定义头 → 403；伪造 `Host` → 403 |
| 时间概览缩放 | 滚轮 184m→19m52s，标尺重算，91 条条形可见 |
| 检查器 | 计时 / Token / 上下文 5 段分解 / 思考 / 工具入参 / 结果 全部渲染 |
| 正文开关（`full`） | 正确加载入参、结果与完整文本 |

### 8.3 实现期的三个发现

1. **FTS5 用的是自定义编码**：`*_terms` 列存 `c<码点十六进制>` token（如「轨迹」→ `c8f68 c8ff9`），直接 `MATCH` 明文永远搜不到。已复刻编码，见 `encodeFtsQuery()`。
2. **工具耗时能从 `background_tasks` 精确取**：`ended_at_ms - created_at_ms`，比按行时间戳配对更准。`kind` 只出现 `bash` / `subagent` 两种。
3. **压缩记录有完整前后指标**：`messagesBefore/After` 与 `tokensBefore/After`，可直接呈现压缩收益。

### 8.4 与 dsh 的能力差距（诚实记录）

| dsh 能力 | 本插件 | 说明 |
|---|---|---|
| turns / steps / llmMs / toolMs / decodeMs / decodeTokens | ✅ 对等 | 见 `trajectory_summary` |
| ttftMs / ttftSteps | ❌ 不可得 | 运行时不落盘，恒为 `null`，不臆造 |
| 轮次表 + 检查器（用量/耗时/入参/结果） | ✅ 对等 | 检查器还多了 5 段上下文分解 |
| 时间概览双色助手条 | ✅ 近似 | 用「思考段 / 输出段」代替「TTFT / 解码」 |
| 压缩 `Between turns` 区段 | ✅ 对等 | `kind=compaction` 带前后指标 |
| 嵌套子工具 / 子代理 | ✅ 对等 | `parent_session_id` + `background_tasks` |
| 时间轴缩放 / 平移 / 重置 | ✅ 对等 | 滚轮缩放、拖拽平移、双击重置 |
| 全文搜索 | ✅ 对等 | 复刻 runtime 的分词编码 |
| 附件 / 图片摘要 | ⚠️ 部分 | 有 `session_assets` 计数，未渲染图片 |
| 分页 + 只渲染可见行 | ⚠️ 部分 | 有分页与 `offset`/`nextOffset`；前端一次性渲染前 800 条，未做虚拟滚动 |

### 8.5 面板交互修订（v0.1.0 二轮）

| 反馈 | 处理 |
|---|---|
| 侧边栏会话应按 workspace 分类并支持折叠 | 按 `workspaceDir` 分组，组头显示路径尾段与数量徽标，可折叠，折叠状态存 `localStorage`；另加「折叠切换」一键全折/全展 |
| 时间轴应按 INPUT / MODEL / TOOL 三行叙事，而不是按轮次堆叠 | 重做为三条共享时间轴的通道：INPUT（用户消息）、MODEL（请求，内含思考/输出双色段）、TOOL（后台任务与子代理，另加由记录间隔推导的浅色等待段）。通道内重叠块贪心装箱为子行。缩放/平移/重置保留 |
| 默认显示正文，溢出单行省略，点开侧边栏看详情 | `detailLevel` 默认改为 `full`；记录行 `white-space: nowrap` + `text-overflow: ellipsis`；空正文时依次回退到思考内容、工具名，不再显示「（无正文）」；点击行打开右侧检查器 |
| 后台任务/子代理不能展开、看不出作用 | 改为可展开卡片：任务 ID、起止时刻、耗时、所属轮次、执行模式、子代理名、工具调用 ID、子会话 ID、完整命令、**输出日志尾部**（`~/.minimax/background-tasks/<id>/output.log`，最多 16 KiB），以及三个操作：查看输出 / 打开子会话轨迹 / 定位调用记录 |

新增能力对应关系：

- `metadata.childSessionId` 让子代理任务可以下钻到自己的会话轨迹（已在真实数据上验证：点开 `verifier` 子代理后跳转到 `Goal verification` 会话）。
- `output.log` 读取走独立工具 `trajectory_task_output`，路径由数据目录 + 任务 ID 重建（不信任存储的 URI），任务 ID 有严格形状校验，拒绝符号链接，只读尾部若干字节。

### 8.6 面板安全基线（不变）

`127.0.0.1` 绑定 + `Host`/`Origin` 校验 + API 强制自定义头 + 默认拒绝的 CSP。
注意 CSP 的 `style-src 'self'` 会拦下 HTML 里的内联 `style` 属性——样式必须走外部 CSS 或 CSSOM。

---

## 附录 A：本机环境事实

```
dsh         0.1.5-rc.1   (~/.nvm/versions/node/v24.19.0/bin/dsh)
mcode       0.4.12
node        v24.19.0
sqlite3     3.45.1
数据根       ~/.minimax  (MAVIS_DATA_DIR / MINIMAX_DATA_DIR 均未设置)
SQLite      ~/.minimax/v2/sqlite/runtime-state.sqlite  2.5 GB (+17 MB WAL)
会话产物     ~/.minimax/v2/sessions/YYYY/MM/DD/<ts>-<sessionId>/
远端        origin  = MiniMax-AI/MiniMax-Code-Plugins (上游，禁止推送)
            weekbin = weekbin/MiniMax-Code-Plugins   (fork，推送目标)
```

## 附录 B：dsh 相关包（对标参考）

```
dsh-client-ui-trajectory        UI 视图（轮次表 + 时间概览 + 检查器）
dsh-session-stats               turns/steps/llmMs/toolMs/ttftMs/decodeMs
dsh-session-turn-outline        轮次导航（prompt/response 预览）
dsh-session-projection          客户端读模型注册表
dsh-session-query-sqlite        FTS5 全文检索（独立派生库）
dsh-session-telemetry(-otel)    遥测捕获 seam
dsh-compaction                  压缩 seam
```
