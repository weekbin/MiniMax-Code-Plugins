[English](README.md) | **简体中文**

# MCode Trajectory Studio

> 本地 MiniMax Code 会话的只读"飞行记录仪"，数据取自运行时自身的 SQLite 投影，
> 并附带一个可交互的本地 Studio 面板。

MiniMax Code 的本地运行时会为每个会话在 `<dataDir>/v2/sqlite/runtime-state.sqlite` 维护一份
SQLite 投影。本插件严格按照只读方式读取该投影，并将其转化为结构化的轨迹摘要与可浏览的时间轴
——从而无需打开原始会话文件，就能回答"这次花了多久""时间花在哪里""哪些工具运行过、哪些失败了"
"有多少轮、多少步""上下文预算用在哪里""压缩（compaction）何时发生"以及"派发了哪些子代理"。

## 试一试

```text
用 mcode-trajectory-studio 技能总结我最近更新的会话：
轮数、步数、LLM 与工具的墙钟时间、工具失败数，以及压缩（compaction）。
```

预期结果：agent 调用 `trajectory_summary`，汇报折叠后的统计值，并将 `ttftMs` 标注为不可用，
而不是对它进行估算。

```text
打开该会话的 Trajectory Studio 面板，让我自己看时间轴。
```

预期结果：agent 调用 `trajectory_studio`，拿到一个 `127.0.0.1` URL，并在宿主浏览器中打开。
面板显示时间总览、每轮记录表、每条记录的检查器、过滤器，以及后台任务列表。

## 能力

| 工具 | 用途 |
|---|---|
| `trajectory_list` | 最近的会话及其非内容元数据；可按 agent、kind 或时间过滤 |
| `trajectory_summary` | 等价于 dsh `sessionStats` 的折叠：轮数、步数、`llmMs`、`toolMs`、`decodeMs`、token、工具调用与失败、压缩、子代理、资产、触发来源 |
| `trajectory_get` | 分页的轨迹记录；`summary` 或 `full` 详情 |
| `trajectory_search` | 对标题、agent、状态和工作区路径做全文检索 |
| `trajectory_tasks` | 后台任务与子代理派发，含状态、耗时、命令或目标、子代理名、子会话 ID |
| `trajectory_task_output` | 某个任务捕获输出的有界尾部 |
| `trajectory_studio` | 启动或停止本地 Studio 网页面板 |

Studio 面板不是一摞行的堆叠，而是一段叙事。每个界面只回答一个问题，且不重复另一个界面的答案：

| 界面 | 回答的问题 |
|---|---|
| **Agent 与能力** | 此会话配置了什么——模型、工具白名单、技能、系统提示词 |
| **统计条** | 会话总量是多少——轮数、步数、LLM/工具/解码墙钟时间、token、失败数 |
| **时间轴** | 在时间上发生在何处——仅导航与缩放，不含文字 |
| **轨迹流** | 发生了什么——每条消息、每次工具调用一行，可快速扫读 |
| **检查器** | 恰好选中那一行的完整细节 |

- **侧边栏**是一棵极简的树。会话按 **git 仓库**分组，而非按路径：
  `git rev-parse --git-common-dir` 把一个项目的所有 worktree 折叠进同一个可折叠分组，因此长期
  存在的仓库不会在侧边栏里被打散。不在 git 树内的目录回退为按路径分组。**子代理会话递归嵌套在
  派发它的会话之下**，并带一个 caret 可展开——于是一次扇出读作一棵树，而不是一串长得一样的任务
  会话。行内只保留 caret 和标题；agent、分支、工作区和时长放在 tooltip 里，展开状态跨刷新持久化。
- **时间轴**使用三条共享同一可缩放坐标轴的泳道——`INPUT`（人类消息为蓝色，框架注入的上下文为
  紫色）、`MODEL`（请求拆分为思考段与输出段）和 `TOOLS`（已测量的任务区间为橙色，按记录间距
  推导出的空隙为灰色并标注为"推导"）。滚轮缩放，拖拽平移，双击复位。
- **侧边栏行整行可切换**，而不仅是 caret：点击折叠的父行会选中并展开它，点击已选中且展开的父行
  会折叠它。agent 过滤器是一个下拉框，其选项从数据中读取（`mavis`、`verifier`、`explore`……
  即该机器上实际配置的值），因为子代理预设因安装而异。
- **轨迹流**把消息与工具调用合并成一段叙事：`TOOL bash ▸ {载荷} ⇉ {结果}`，带已测量的耗时、
  子代理的 agent 徽标，以及一键跳进子代理自己的会话。注入的上下文在视觉上有别于用户键入的
  内容。可按人类输入、注入上下文、工具调用或仅失败过滤；也可按轮次 ID 或文本过滤。
- **主题**：浅色与深色，默认跟随系统，一键切换。全局 2px 紧凑圆角，细滚动条同时通过标准属性
  和 WebKit 伪元素实现。
- **轮次标题以人类序数打头**（`第 3 轮`），并把运行时的 turn ID 作为次要文字保留。
- **性能**：轨迹流渲染 150 行并在滚动时追加下一批；行有缓存且过滤从不重建 DOM；文本过滤做了
  防抖；轮次总量在服务端折叠，因此分页视图仍显示整轮数字。一个 600 行会话的切换从约 700 ms
  （含 227 ms 主线程卡顿）降到约 120 ms（无卡顿）。超大会话（1 万条以上记录）另有问题：统计
  折叠会在相关子查询里重新解析每一行的 JSON，因此现在改为在单次 join 中展开 `tool_calls`，并按
  会话的 `updated_at_ms` 缓存折叠结果——复访只需 1 ms，而非 383 ms。记录改为从服务端分页
  （每次 200 条），而不是一次取回 1000 条含完整内容；时间轴读取一份独立的紧凑投影，因此坐标轴
  始终覆盖整个会话。
- **检查器**是分页式的：概要（层级、状态、token 用量、上下文拆分）、载荷（工具参数或消息正文）、
  结果（结果文本加一块**失败证据**）、计时（记录时刻、请求/思考/解码耗时，以及工具耗时是
  "已测量"还是"缺失"）和 Schema。
- **失败定位**是一等公民：标题栏带一个 `⚠ N 处失败（定位）` 跳转，轨迹流内联标记每处失败，
  结果页把**硬**失败（Traceback、stderr、`is_error`）与**软**失败（非零退出码，往往只是 `grep`
  没找到东西）分开。一次调用可能报告成功，但其输出里含 Traceback，因此分类读的是文本，
  而不只是状态码。

## 读取哪些数据

| 来源 | 路径 | 用途 |
|---|---|---|
| SQLite 投影 | `<dataDir>/v2/sqlite/runtime-state.sqlite` | 主要来源。以 `mode=ro` 打开；绝不写入。 |
| 会话产物 | `<dataDir>/v2/sessions/YYYY/MM/DD/<stamp>-<id>/messages.jsonl` | 投影尚未索引的会话的兜底，以及投影字段缺失时的内容来源。 |

`<dataDir>` 按此顺序解析：`MINIMAX_DATA_DIR`、`MAVIS_DATA_DIR`、`~/.minimax`。

### 值得了解的字段

- `usage.request_duration_ms` —— 每次请求的模型墙钟时间（`llmMs`）。
- `thinking_duration_ms` —— 每条记录的思考阶段耗时。
- `tool_calls[].tool_call_args`、`tool_call_result_data`、`tool_call_status` —— 工具输入、输出和
  状态（状态非 `2` 即为未成功）。
- `local_runtime_background_tasks` —— `created_at_ms`/`ended_at_ms` 给出精确的工具与子代理墙钟
  时间（`toolMs`）。
- `kind: compaction` 记录携带 `messagesBefore`/`messagesAfter` 与
  `tokensBefore`/`tokensAfter`。
- `context_usage.components` —— 每次请求对 SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES
  的拆分。
- `source` —— 触发模型调用的来源：`api`、`thread-goal`、`questionnaire`、`background-task`、
  `task`、`agent`、`greeting`。
- `local_runtime_sessions_fts` —— 覆盖会话元数据的 FTS5 索引。

## 诚实的局限

- **运行时并不持久化首 token 时间（TTFT）。** `ttftMs` 恒为 `null`，且从不估算。Studio 总览
  改用"思考段 vs 输出段"来呈现。
- **`decodeMs` 是近似值**：`Σ(request_duration_ms − thinking_duration_ms)`。
- `local_runtime_*` 表属于运行时内部细节。每张可选表、每个可选列和 JSON 字段在使用前都会被
  探测，缺失时降级为 `null`；未来的运行时变更应降低保真度，而不是让插件崩溃。若 SQLite 不可读，
  插件回退到 `messages.jsonl`，那里没有计时字段。
- 工具墙钟时间只对运行时记录为后台任务的调用可用；因此 `toolMs` 覆盖的是这些调用，而非每一次
  内联调用。
- 投影在会话写入时建立索引。极新的会话可能尚未出现；JSONL 兜底覆盖这种情况。

## 隐私

- 本插件是**只读**的。它绝不写入、移动或删除会话存储。
- Studio 面板仅绑定 `127.0.0.1`，且每个 API 路由都要求 authority 校验、origin 校验，以及一个
  自定义请求头——跨源页面若不经过 CORS 预检就无法设置该头，而本服务器从不批准该预检。静态资源
  附带默认拒绝的 CSP。
- `summary` 详情不返回任何消息文本、思考、工具参数或工具结果。
- `full` 详情需显式开启，并会经过一个密钥脱敏器（凭据键值对、bearer token、各家 provider 的
  key 格式、私钥块、连接串中的凭据），外加深度、广度与长度限制。家目录前缀会被折叠为 `~`。
- 不向任何地方上传；没有网络目的地，也没有遥测。

## 环境要求

- MiniMax Code 0.4.0+（`mcode`），需支持 Agent Plugin 与 MCP。
- `PATH` 上有 Node.js 22+。已在 Node.js 24 上验证（提供 `node:sqlite`）。本插件不含任何依赖，
  也无需构建步骤。
- 具备 v2 SQLite 投影的本地运行时，或有 v2 会话产物以走兜底路径。
- 宿主浏览器能力用于自动打开面板；若无，面板 URL 仍可手动访问。

### 支持的平台

- **已在 Linux 上验证**（`x86_64`，Node.js 24.19.0，mcode 0.4.12）——全部测试、MCP 握手与
  Studio 面板都在该平台上跑过。
- **Windows 与 macOS 未测试。** 代码没有写死任何平台相关的东西：路径统一走 `node:path`，
  `git` 以 `execFile` + 参数数组调用而非 shell，SQLite 驱动是 Node 内置的 `node:sqlite`。
  请将这些平台视为"预期可用但未验证"，遇到问题请反馈。
- `git` 是可选的。它仅用于按仓库分组会话；没有它时，分组回退为按工作区路径。

### 测试证据

```bash
npm run validate                                 # 仓库校验器
cd plugins/weekbin/mcode-trajectory-studio
node --test                                      # 31 个插件测试
node server/main.mjs --doctor                    # 针对本机的数据源诊断
```

插件自身的测试覆盖 SQLite 读取、JSONL 兜底、git 分组（含真实 worktree 合并）、输入来源、
工具调用/任务 join、agent 定义查找、脱敏，以及 MCP 协议面。面板另用浏览器做了端到端驱动：
会话切换、树展开、时间轴导航、全部检查器分页、主题切换与失败证据块，覆盖五档视口宽度。仓库
测试套件（376 个测试）跑的正是 CI 所用的同一个校验器。

## 安装

本仓库以源码形式托管插件。把本目录作为本地插件指向 MiniMax Code，或将
`plugins/weekbin/mcode-trajectory-studio/` 复制进你的插件目录。`mcp.json` 中的服务器条目会
自动启动。

## 诊断

```bash
node server/main.mjs --doctor   # 解析后的数据目录、SQLite/FTS 可用性、最新会话统计
node server/main.mjs --serve    # 在 127.0.0.1 上独立运行 Studio 面板
```

## 代码结构

本插件不含依赖、无需构建，源码按分层拆分，任何文件都不必承担多重职责：

- `server/` —— `config` · `json` · `sqlite` · `fsutil`（基础层），`redact` · `git`
  （支撑层），`sessions` · `stats` · `tasks` · `events` · `search` · `jsonl`（领域层），
  `store`（门面），再由 `mcp` · `http` · `main`（接口层）对外。领域层模块以 `Store`
  门面作为第一个参数，因此层间依赖图保持为无环 DAG。
- `web/` —— `app.js` 只负责启动；各界面位于 `web/js/`：`state` · `api` · `format` ·
  `icons` · `results` · `storage` · `theme` · `banner`（基础层），`sidebar` ·
  `capability` · `stats` · `timeline` · `stream` · `inspector`（界面层），以及
  `flow` · `wire`（编排层）。面板以 ES 模块方式提供服务。
- `test/` —— `store.test.mjs`，覆盖数据层与 MCP 协议面的 31 个测试。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE)。

## 设计说明

本插件背后的调研与界面比较——包括为何使用运行时 SQLite 投影而非会话 JSONL 产物——记录在
[DESIGN.md](DESIGN.md)。
