# Verification Ledger — mcode-docs

本文件是本插件每一条文档内容的取证台账。**任何未在本文件中出现的功能主张，都不应出现在文档里。**

## 取证来源

| # | 来源 | 版本 | 用途 |
| --- | --- | --- | --- |
| S1 | 本机安装 `<npm root -g>/@minimax-ai/code` | **0.5.8** | 随包 README、`configs/data-minimal.yaml`、命令注册数组、运行时真实配置 |
| S2 | `https://github.com/MiniMax-AI/minimax-code`（官方开源仓库，`main`） | **0.5.8** | TypeScript 源码级权威定义 |
| S3 | `https://platform.minimax.cn/docs/api-reference/api-overview` 及其文档子页 | 线上 | **样式基准**：官方 CSS 变量、样式表源码、`.prose` 排版系统、组件实测值、暗色 callout 实测 |

> **版本声明**：本机运行版本为 **0.5.8**，与官方仓库 `main` 同版本，双源对齐。
> 文档以 **S2 源码**为功能定义的权威来源（源码含类型定义，语义无歧义），
> 并以 **S1 实跑**验证「该能力在本机 0.5.8 上确实存在」。

> **复核记录（2026-09-29）**：本台账初版以 0.5.7 实跑 + 0.5.8 源码为基线。
> 复核时发现两处失准，已按 0.5.8 实测修正：
> 1. 内置 Skill 实为 **16 个**，初版所列的 `x-link-reader` 在 0.5.8 包内与运行时均不存在；
> 2. 内置 Skill 的包内布局已由单一 `assets/skills/` 改为按 Agent 分散
>    （`assets/agents/mavis/skills/`），初版对包内路径的描述已过时。
>
> **内置 Agent 仍为 4 个**（`assets/agents/builtin-agents.json` 实测）。
> 运行时 `~/.minimax/agents/` 下若存在更多目录，属用户自建 Agent，不计入内置清单。

## 证据等级

| 等级 | 含义 |
| --- | --- |
| **A** | 在本机实跑命令得到的真实输出 |
| **B** | S1 随包发布的厂商第一手文件 |
| **C** | S2 源码中的权威定义（类型/常量/注册表） |
| **D** | 本机运行时真实配置或状态文件 |

---

## 1. CLI 命令面（A 级：`mcode <cmd> --help` 逐条实跑）

真实存在的顶层命令：

| 命令 | 说明 |
| --- | --- |
| `mcode [prompt]` | 启动交互式 TUI |
| `mcode init [directory]` | 分析代码库生成 `AGENTS.md`（使用内置 `init` Skill） |
| `mcode exec [prompt]` | 不启动 TUI，执行一次任务 |
| `mcode exec review` | 审查 staged / unstaged / untracked 本地改动 |
| `mcode acp` | 以 Agent Client Protocol 服务运行（stdio） |
| `mcode login` / `mcode logout` | 管理登录态（`--region cn\|global`） |
| `mcode update` | 检查并安装更新 |
| `mcode provider ...` | `list` / `add` / `remove` / `test` / `use` / `set-minimax-key` |
| `mcode plugin ...` | `list` / `add` / `remove` / `enable` / `disable` / `marketplace` |

全局选项（A 级实跑）：`-V, --version`、`-m, --model <provider/model>`、`--lane <lane>`、
`--session [id]`、`-c, --continue`、`--tui-mode <regular|fullscreen>`。

### 1.1 不存在的 CLI 子命令（反例，已实跑确认）

`mcode mcp`、`mcode config`、`mcode agent`、`mcode skill`、`mcode hook`、`mcode workflow`
**全部回落到根帮助**，0.5.8 无这些子命令。对应能力通过**配置文件**与 **TUI slash 命令**提供。

### 1.2 `mcode exec` 完整参数（A 级实跑 `--help`）

`--input <source>`（仅 `-`）、`--input-format text|json`、`--cwd <path>`、`--file <path>`（可重复）、
`--model`、`--effort <level>`、`--prompt-mode tui|coding|work`、`--session <id>`、`--continue`、
`--config <path>`、`--permission smart|full|off`、`--timeout <duration>`、`--max-steps <count>`、
`--output-format text|json|stream-json`、`--diagnostics-dir <path>`、`--output-schema <schema>`、
`-o, --output-last-message <path>`。

`mcode exec review` 仅支持：`--cwd`、`--model`、`--effort`、`--config`、`--permission`、
`--timeout`、`--max-steps`、`--output-format`、`--output-last-message`（B 级：B1 明确说明
`--session`/`--continue`/`--input`/`--file`/`--output-schema`/`--diagnostics-dir` 不支持）。

---

## 2. TUI slash 命令：**52 条**（C 级，两个权威注册表）

mcode TUI 的命令面由**两个源码注册表**共同构成，二者无重叠：

- `packages/tui/src/tui/commands/catalog.ts` → **41** 条
- `packages/tui/src/application/command-descriptors.ts`（`TUI_COMMAND_DESCRIPTORS`）→ **11** 条

> **修正记录**：仅对打包后 minified chunk 做正则提取会漏命令（漏掉 `/doctor`、`/help`、
> `/model` 等 11 条，并漏掉 `/history`、`/fork`、`/rewind`、`/edit`）。
> 本节以源码为准。

### 2.1 Descriptors 注册表（11 条，原文描述）

| 命令 | 描述（源码原文） |
| --- | --- |
| `help` | Show available commands |
| `new` | Start a fresh session in the current workspace |
| `model` | Choose a model |
| `status` | Show account and model status |
| `doctor` | Check the local config file |
| `context` | Show the Runtime-owned context snapshot |
| `skills` | List built-in and user Skills |
| `mcp` | Inspect MCP capabilities and project configuration |
| `usage` | Show session usage |
| `compact` | Shorten the active conversation |
| `export` | Export the current Session as Markdown |

### 2.2 Catalog 注册表（41 条）

`update`、`changelog`、`sessions`、`goal`、`plan`、`review`、`parent`、`btw`、`history`、
`fork`、`rewind`、`edit`、`retry`、`rename`、`archive`、`tasks`、`permission`、`login`、
`logout`、`config`、`steer`、`feedback`、`checkin`、`settings`、`statusline`、`theme`、
`hotkeys`、`reload`、`provider`、`plugins`、`add-dir`、`decision`、`transcript`、`copy`、
`allow`、`always`、`deny`、`permissions`、`stop`、`queue`、`quit`

**别名（C 级，源码 `aliases` 字段全量）**：
`clear` → `new`、`exit` → `quit`、`resume` → `sessions`、`side` → `btw`

**参数提示（源码 `argumentHint`）**：
`sessions [query]`、`goal <objective | action>`、`plan [on | off | status | view]`、
`permission [status | ask | auto | full]`、`btw [question]`、`rename [title]`、
`steer <message>`、`feedback <message>`、`add-dir <path>`、`export [path.md]`、
`plugins [filter]`。

**分类（C 级 `TuiCommandCategory`）**：
`Session` / `Runtime` / `Capability` / `Input` / `Transcript` / `Decision` / `Application`

**侧会话只读命令集**（C 级 `SIDE_MODE_READ_ONLY_COMMANDS`）：
`help`、`changelog`、`context`、`status`、`usage`、`export`、`transcript`、`copy`、`parent`。

---

## 3. Hook 系统：**确实存在**，兼容 Claude Code 事件模型（C 级）

> **修正记录**：早期仅检索打包 minified chunk 时 `PreToolUse` 等事件名命中为 0，
> 曾误判为「mcode 无生命周期 Hook」。源码显示该结论错误，现已按源码更正。
> 本节内容于本轮按 `main` 最新源码逐文件复核并**大幅扩充**。

**取证文件**（S2，均为 `packages/agent-modules/plugin-hooks/src/`）：

| 文件 | 提供的事实 |
| --- | --- |
| `contracts.ts` | 事件常量、来源格式、处理器与控制输出类型、诊断码 |
| `parser.ts` | 注册文档 schema、matcher 校验、字段级格式限制、注册级上限 |
| `command-invocation.ts` | shell / exec 形式的解析与平台差异 |
| `runner.ts` | stdin 输入序列化、环境变量注入、退出码与输出解析、时间预算 |
| `packages/local-runtime-v2/…/hook/documents.ts` | manifest `hooks` 字段的五种引用形式 |
| `docs/hooks.md` | 官方 `systemMessage` 行为说明与手工验证步骤（B 级） |

### 3.1 事件与处理器

`PLUGIN_HOOK_EVENTS` 权威定义 —— **11 个事件**：

```
SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse, SubagentStart, SubagentStop, Stop, PreCompact, PostCompact
```

- **来源格式**：`PluginHookSourceFormat = 'MINIMAX' | 'CLAUDE' | 'CODEX'`（C 级）。
- **处理器结构**（C 级 `PluginHookCommandHandler`）：
  `{ kind, sourceFormat, pluginName, pluginRoot, pluginDataDir?, activationKey?, sourcePath, event, matcher?, command, args?, shell?, condition?, timeoutMs, additionalContextLimit?, declarationOrder }`
- **仅同步 `type: 'command'` 受支持**：`parser.ts` 中 `type !== 'command' || async === true || asyncRewake === true`
  一律判为 `HOOK_HANDLER_UNSUPPORTED`。
- `SessionStart` 来源（`PluginHookSessionStartSource`）：
  `startup | resume | clear | compact | fork | plugin_activation`。
- 工具使用上下文内的 effort（`PluginHookEffort`）：`low | medium | high | xhigh | max`。

### 3.2 注册文档

- manifest `hooks` 字段接受：字符串路径、`{ path }` 对象、二者组成的数组、
  **内联注册文档对象**（`sourcePath` 记为 `<manifest>`）、省略时按默认路径自动纳入（C 级 `documents.ts`）。
- 信封两种等价写法：外层带 `hooks` 键，或直接以事件名为顶层键（C 级 `parser.ts` `readHooksEnvelope`）。
- 注册文档形态（B1）：
  ```json
  { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \"${PLUGIN_ROOT}/scripts/notice.cjs\"", "timeout": 5 } ] } ] } }
  ```
- **`timeout` 单位为秒**（C 级 `timeoutValue`）：整数 1–10，缺省 5000 ms，上限 10000 ms；
  非整数或越界记 `HOOK_SCHEMA_INVALID`。官方示例中的 `"timeout": 5` 即 5 秒。
- 字段级格式限制（C 级 `parser.ts`）：`args` 与 `shell` **仅 `CLAUDE`**；
  `if`（工具谓词如 `Bash(rm *)`）**仅 `CLAUDE`** 且仅 `PreToolUse`/`PermissionRequest`/`PostToolUse`；
  `additionalContextLimit` **仅 `CODEX`** 且仅 5 个事件。
- `matcher` 上限 256 字符；`UserPromptSubmit` 与 `Stop` 不校验内容；`CODEX` 仅接受 `[A-Za-z0-9_|]+`；
  其余须为 `[A-Za-z0-9_.:/-]+` 的分支，或**可移植正则**——仅允许非捕获组 `(?:...)`，
  拒绝环视/命名组/反向引用/悬空转义，同一原子重复量词达 4 次即拒绝。
- **单插件可执行处理器上限 64**（`MAX_EXECUTABLE_HANDLERS`），超出记 `HOOK_HANDLER_LIMIT_EXCEEDED`。

### 3.3 进程环境与输入

- **环境变量继承白名单仅 17 个**（C 级 `safeHookEnvironment`）：
  `PATH HOME LANG TERM SHELL USER TMPDIR TEMP TMP PATHEXT SystemRoot ComSpec
  USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA`。
  宿主注入 `PLUGIN_ROOT`/`PLUGIN_DATA`/`*_PROJECT_DIR` 等 9 个变量，
  `CLAUDE` 格式另注入 `CLAUDE_EFFORT`。**插件根目录只读**（`pluginDataDir` 以 `0700` 创建）。
- **stdin 为单个 UTF-8 JSON 对象**（C 级 `serializeHookInput`）：
  事件特有字段先行展开，其后为 `hook_event_name`、`session_id`、`turn_id?`、`prompt_id?`、
  `transcript_path`（可为 `null`）、`cwd`、`model?`、`permission_mode?`、`effort?`。
  序列化超过 **1 MiB**（`MAX_INPUT_BYTES`）则不投递。

### 3.4 输出、裁决与预算

- **退出码语义**（C 级 `runner.ts`）：`exit 2`（非 `MINIMAX` 格式）触发事件级阻断且
  **JSON 无法覆盖**；`CODEX` 仅在退出码 0 时解释 stdout；`CLAUDE` 在任意退出码均解析 JSON。
- stdout/stderr 各截断于 **64 KiB**（`MAX_OUTPUT_BYTES`），溢出记 `HOOK_INVALID_OUTPUT`。
- **裁决合并**（C 级 `mergePluginHookDecisions`）：按**最强裁决**合并
  （`deny` > `ask` > `defer` > `allow`），而非后者覆盖前者。
  空输出默认裁决：`PermissionRequest` 为 `allow` + `permissionDecision: 'abstain'`，
  `PreToolUse` 为 `allow` + `toolPermissionDecision: 'abstain'`，其余为 `allow`。
- **控制输出字段**（C 级 `PluginHookDecision`，共 20 项）：`decision`、`reason`（≤4096 字符）、
  `continue`、`stopReason`、`continuePrompt`、`defer`、`suppressOutput`、
  `additionalContext`（≤65536 字符）、`updatedInput`、`updatedResult`、
  `updatedResultFormat`、`postToolFeedback`、`terminalSequence`、`systemMessage`、
  `permissionDecision`、`permissionAutoApproval`、`toolPermissionDecision`、
  `updatedPermissions`、`interrupt`。
- **权限更新**：`updatedPermissions` 为原子数组，三种形态 `addRules`/`replaceRules`/`removeRules`、
  `setMode`、`addDirectories`/`removeDirectories`；`destination` 四值、`mode` 七值（C 级）。
- **时间预算**：普通事件 `ORDINARY_EVENT_BUDGET_MS = 15 000`，
  `SessionEnd` `SESSION_END_BUDGET_MS = 3 000`，进程回收 `PROCESS_DRAIN_BUDGET_MS = 500`。
  单处理器实际超时取声明值与剩余预算之较小者。
- **诊断码**：解析期 `HOOK_SCHEMA_INVALID`、`HOOK_EVENT_UNSUPPORTED`、
  `HOOK_HANDLER_UNSUPPORTED`、`HOOK_HANDLER_LIMIT_EXCEEDED`；
  运行期 `HOOK_ABORTED`、`HOOK_INVALID_INPUT`、`HOOK_INVALID_OUTPUT`、
  `HOOK_PROCESS_ERROR`、`HOOK_PROCESS_EXITED`、`HOOK_TIMEOUT`。

### 3.5 `systemMessage` 与事件限制（B 级 `docs/hooks.md`）

- 向 stdout 输出 `{"systemMessage":"..."}` 并 exit 0，可在 TUI 显示提示而**不写入模型上下文**；
  该文本不进入 canonical model history、compaction 输入、最终回答复制与默认 Markdown 导出，
  但**确实**写入本地显示存储。单独返回该字段**不**触发额外模型调用；
  `suppressOutput` **不**控制该通知。
- 通知持久化于 Session 显示历史，重开 Session 恢复且不重复；
  相互独立的 Hook 调用可重复同一文本并各自产生通知；子 Session 通知**不**向父 Session 广播。
- 只有带分类的插件用户消息会显示；诊断消息、终端控制通知与无分类的旧事件保持隐藏。
  该行为仅涉及交互式 TUI，headless 与 ACP 输出策略不变。
- 注意：只有同步 command Hook 覆盖上述通知；`PreCompact` 与手动 `PostCompact`
  当前不发出该通知，`SessionEnd` 为尽力而为。Claude 兼容适配器会丢弃
  `PreCompact`/`PostCompact`/`SessionEnd` 的 `systemMessage`，Codex 适配器丢弃 `SessionEnd` 的。
- 官方 `docs/hooks.md` 另给出 5 步手工验证流程，并明确要求：验证上下文隔离时
  不得将通知标记写入提示词，须检视下一次模型请求与真实 compaction 请求。

---

## 4. 权限模式（C 级 + D 级）

`PermissionMode` 联合类型（`packages/config/src`）—— **5 个取值**：

```
"default" | "acceptEdits" | "bypassPermissions" | "auto" | "off"
```

TUI 界面文案（C 级）：`default` → "Confirm sensitive actions"、
`auto` → "Ask only when risk is high"、`bypassPermissions` → "Run without confirmation"。

- `/permission` 参数提示为 `[status | ask | auto | full]`（C 级）。
- 本机 `~/.minimax/config.yaml` 实测 `permissionMode: bypassPermissions`（D 级）。
- `mcode exec --permission` 是另一套命名空间：`smart | full | off`（A 级）。
- 运行时另存在 `~/.minimax/permission.json`（D 级）。

---

## 5. 内置工具（B/C 级，源码 `packages/agent-tools/src`）

基础工具 **12 个**：

`read`、`write`、`edit`、`bash`、`grep`、`glob`、`task`、`todowrite`、
`skill`、`ask_user`、`web_search`、`web_fetch`

- 本会话实际注入的工具列表与之吻合（含 `mcp__*` 前缀的 MCP 工具、`request_feature_enable` 等宿主工具）。
- Browser 工具需显式开启 beta 开关后才装配（见 §9）。

---

## 6. 内置 Agent 与 Skill（B + D 级，双源互证）

**Agent**：`assets/agents/builtin-agents.json`（B 级）= `["mavis", "explore", "worker", "verifier"]`；
运行时 `~/.minimax/agents/`（D 级）实际目录一致。两个独立来源吻合。

**Skill**（B + D 级，运行时 `~/.minimax/.builtin-skills/`，实测 16 个）：
`code-review`、`deep-research`、`deploy-website`、`docx`、`edit-deployed-website`、`init`、
`lark-tools`、`llm-call`、`mcode-tools-master`、`pdf`、`pptx`、`resume-codex`、`skill-creator`、
`skill-refiner`、`visual-page`、`xlsx`。

> 初版此处记为「包内 `assets/skills/`，实测 17 个」并含 `x-link-reader`。
> 0.5.8 复核：该 Skill 在包内与运行时**均不存在**，已移除。
> 包内路径亦已由 `assets/skills/` 改为 `assets/agents/mavis/skills/`，
> 故本项证据等级由 B 调整为 B + D（包内 + 运行时双证）。

---

## 7. 配置（D 级真实文件 + B 级基线 + C 级类型）

主配置：`~/.minimax/config.yaml`。实测顶层键：`logLevel`、`provider`、`defaultModel`、
`permissionMode`、`custom_provider`、`tui`；二级键含 `statusLine`、`customStatusLine`、
`effort`、`defaultModelContextWindow`、`defaultModelVariant`、`defaultModelThinking.effort`。

**`tui` 段**（B 级，官方 `docs/tui-capabilities.md` 给出完整 schema）：

```yaml
tui:
  terminalTitle: [status, session-name, app-name]   # 可排序/省略；project-name 亦可用；null 或 [] 关闭
  notifications:
    when: unfocused        # unfocused | always | never
    method: auto           # auto | osc9 | osc777 | bel
    events: [turn-complete, turn-failed, permission-required, question-required]   # 省略=全部，[] = 关闭
```

**`beta.*` 开关全量**（B 级 `configs/data-minimal.yaml`）：
`autoMemory`、`skillEvolve`、`skillEvolveBuiltinMr`、`skillProposal`、`browserBridge`、
`filePanelBrowser`、`filePanelBrowserMultiTab`、`browserUseTooling`、`browserUseAutoOpenPanel`、
`browserAgentCursor`、`desktopPlanMode`、`peek`、`keepAlive`、`promptOverride`、`asr`、
`taskHistoryProjectGrouping`、`threadGoal`、`mcodeTools`、`codexOAuth`。

**能力开关**（B 级）：`agents.default.tools`、`agents.default.builtinTools`、
`agents.default.skills`、`agents.default.features.{mavis,delegation,webSearch}`、
`agents.default.persona.enabled`、`memory.{enabled,proactive}`、`askUser.enabled`、
`skills.external.enabled`、`skillEvolve.enabled`。

---

## 8. 插件 manifest 契约（C 级 `MANIFEST_FIELDS`）

MiniMax 格式插件清单路径 `.minimax-plugin/plugin.json`，`schemaVersion` 必须为 `1`。
合法字段**全集**：

```
$schema, schemaVersion, name, displayName, version, description, author,
icon, darkIcon, category, exampleQueries, apps, mcpServers, skills,
hooks, hostBindings
```

字段之外的键会被拒绝。`hostBindings` 元素须为严格 `schemaVersion: 1`，
含 `bindingId`、`logicalToolName`、`hostCapability{id,version}`、`requiredSkills`、
`allowedSurfaces`（当前仅支持 `interactive`）。

---

## 9. MCP / Browser / 网络（B + D 级）

- 用户级 MCP：`~/.minimax/mcp.json`，`{"mcpServers":{"<id>":{type,command,args,env,…}}}`（D 级）。
  实测含 `codegraph`、`playwright`、`codebuddy`；`env` 支持 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`。
- 项目级 MCP：`<workspace>/.mcp.json`，与 Desktop、exec、ACP 共用规则（B1）。
- TUI 查看入口：`/mcp`（descriptors，Inspect MCP capabilities and project configuration）。
- Browser（B1）：默认关闭，需 `beta.browserUseTooling: true`；可用 `browser.chromePath`
  或环境变量 `MCODE_CHROME_PATH`；模型侧仅接受 HTTP(S) URL。
- 网络代理（B1）：读取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及小写形式；
  `localhost`、`127.0.0.1`、`::1` 始终直连；无需 `NODE_USE_ENV_PROXY`。

---

## 10. 明确**不存在**的能力（反例，禁止编造）

| 能力 | 核实结果 | 取证 |
| --- | --- | --- |
| 代码格式化器（opencode Formatters） | 无。源码与打包产物均无 formatter 概念 | B+C |
| 预热（opencode Warming） | 无此概念 | B+C |
| 文件快照 / 一键回滚到任意文件态（opencode Snapshots） | **无此用户可见功能**。TUI 内部 `snapshot` 均为渲染/任务列表状态快照，与文件无关 | C |
| Gist / 远程分享（opencode Sharing） | 无。提供 `/export [path.md]` 导出 Markdown | C |
| 独立策略引擎（opencode Policies） | 无独立策略层；相关语义由 `PermissionMode` 承载 | C |
| Migrate from V1 | 不适用。mcode 无 V1/V2 分代迁移概念 | C |
| Desktop / Web / Docker 客户端 | 本仓库开源范围为「terminal TUI, headless CLI, and ACP」，桌面端源码未公开 | 仓库 README |

> `history` / `fork` / `rewind` 是**会话与对话**层面的操作（回退对话、分叉、重入历史），
> 不是文件系统快照回滚。文档中不得将二者混为一谈。

---

## 11. 其它已验证事实速查

| 事实 | 证据 |
| --- | --- |
| 版本 `0.5.8`；Node `>=22.19 <23 \|\| >=24 <27` | A + B |
| 安装同时提供 `mcode` 与 `mcode-tools` 两个命令 | B1 |
| Shell 模式：`!cmd` 结果交给模型，`!!cmd` 仅本地显示；每条命令独立 Shell | B1 |
| Shell 补全只读本地目录，不调用模型、不执行草稿 | B1 |
| 附件：`--file`、图片 `[Image #n]` 标签；预览上限 20 MB / 2500 万像素 | B1 |
| `/review` 默认 `inline`；配置 `review.mode: subagent` 改用子代理 | B1 |
| `--effort` 与 `--model` 相互独立且不写回 Session | B1 |
| TUI、`exec`、ACP 共用同一进程内 Runtime 生命周期 | B1 |
| Bash 工具：原生长任务时前台等待 60s 后转后台；总超时默认 600s、上限 600s；无 `task_output` 时前台默认 120s、上限 300s | S2 `docs/tui-capabilities.md` |
| 仅退出码 0 视为成功；大输出保留首尾 24 KiB | S2 同上 |
| Telemetry 默认全关，需 `telemetry.diagnostics` 等单独开启；`MCODE_DISABLE_TELEMETRY` / `DO_NOT_TRACK` 全局覆盖 | S2 `docs/telemetry.md` + S2 能力表 |
| 官方快速开始文档位于 `https://agent.minimax.io/docs/cli/quick-start` | S2 `docs/README.md` |

---

## 12. 样式来源与修正记录（S3）

`site/assets/style.css` 中的每一个颜色、尺寸、圆角都取自 S3，**不自创**。
本节记录样式侧的取证方式与修正历史。

### 12.1 取证方式

| 手段 | 产出 |
| --- | --- |
| 读取官方页面 `getComputedStyle` 全量 CSS 变量 | 404 个变量落盘（mint 调色板 17、Tailwind 原语 54、`--tw-prose-*` 18、`--tw-prose-invert-*` 18） |
| 下载官方样式表 | `official-462bacc…css`（4195 B，Inter/PaperMono `@font-face`）、`official-aaa51283…css`（451 651 B） |
| 提取官方内联 `<style>` | 4282 条规则，含 `.prose` 排版系统 214 条 |
| 官网页面逐元素实测 | h1/h2/h3/body/prose 排版、列表、代码块、复制按钮、侧栏、提示框、表格 |
| 官网强制 `.dark` 后实测 | callout 暗色真值（见 12.3） |

### 12.2 已修正的自造值（本轮）

以下问题在终审时被发现并修正，**均为自造或作用域错误，非官方定义**：

| # | 问题 | 修正 | 依据 |
| --- | --- | --- | --- |
| F1 | `li::before` 圆点规则写成全局，污染侧栏 `.sidenav-list` 与搜索结果 `.search-results` | 作用域限定为 `.content`（官方该组规则挂在 `.prose` 下） | 官方作用域 |
| F2 | `strong` 在深色下仍是 `rgb(var(--gray-900))`，对比度 1.09，正文不可读 | 新增 `html[data-theme="dark"] .content strong { color: rgb(var(--gray-50)) }` | 官方 `.prose strong:is(.dark *)`，**逐字照搬** |
| F3 | 深色 warn/danger 提示框用了 `rgba(245,176,32,.10)` / `rgba(220,80,90,.10)` —— **官方 CSS 中不存在这两个值** | 换为官方暗色工具类真值：`oklab(41.3707% .0733197 .0756701/.2)`（`dark:bg-amber-900/20`）、`oklab(57.7099% .191149 .0987651/.2)`（`dark:bg-red-600/20`）、`oklab(47.3189% .0863082 .0900034/.5)`（`dark:border-amber-800/50`）、`#7F1D1D`（`dark:border-red-900`）、`#FDE68A`（`dark:text-amber-200`）、`#FECACA`（`dark:text-red-200`） | 官方样式表类定义 |
| F4 | 深色 note 提示框是自行推导的 `blue-600/12%` + `blue-600/40%` | 改为官网强制 `.dark` 实测真值：`oklab(54.615% -.026671 -.213549/.2)` + `#1E3A8A` | 官网 `.callout` 类名 `dark:bg-blue-600/20 dark:border-blue-900` |
| F5 | 提示框有自造的 3px 左侧强调条 | 删除，对齐官方盒型（`rounded-2xl` + 1px 整框描边 + 整框底色） | 官网实测 `.callout` 类名 |
| F6 | 对照表状态行 `st-no` / `st-warn` 在深色下仍是浅色底（`#FEF2F2`），文字对比度 1.36 | 状态色改为随主题翻转的令牌（见 F3） | 官方暗色工具类 |
| F7 | 删除左侧强调条后 `--note-fg` 成为死令牌 | 浅色/深色两处定义一并删除 | — |
| F8 | **功能 bug**：`app.js` 只有 `localStorage.setItem`，**没有 `getItem`**，主题只写不读 —— 切到深色后刷新即丢失，"切换后持久化"未实现 | 新增 `storedTheme()`，读回存储值初始化；读取同样包在 `try/catch` 内以兼容 `file://` | 需求"深色为可选项，切换后持久化" |

### 12.3 主题行为实测

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 清空存储 + 系统浅色 + 首访 | 浅色 | 浅色 ✔ |
| 清空存储 + **系统深色** + 首访 | 浅色（不跟随系统） | 浅色 ✔（`emulateMedia` 实测） |
| 点击切到深色 | 深色并写入存储 | `dark` / 存储 `dark` ✔ |
| 刷新页面 | 仍为深色 | `dark`，`aria-pressed=true` ✔ |

### 12.4 官方 callout 变体实测

官网 5 个文档页（api-overview / mcp-guide / rate-limits / errorcode / models-intro）实测，
官方 callout 共 4 种变体，**均无左侧强调条、无文字色覆盖**（文字继承正文）：

| 变体 | 亮色 | 暗色 |
| --- | --- | --- |
| note | `border-blue-200 bg-blue-50` | `dark:border-blue-900 dark:bg-blue-600/20` |
| success | `border-green-200 bg-green-50` | `dark:border-green-900 dark:bg-green-600/20` |
| neutral | `border-neutral-200 bg-neutral-50` | `dark:border-neutral-700 dark:bg-white/10` |
| warn / danger | 官网未使用 | 官网未使用 |

> 官网**不存在** amber/red 提示框。本站的 warn / danger 用于证据等级与章节对照，
> 其取值取自官方样式表中**已存在**的 `dark:bg-amber-900/20`、`dark:bg-red-600/20` 等工具类，
> 属于「选用官方已有定义」，不是新造配色。

### 12.5 对齐的官方组件实测值

以下为在 S3 三个文档页（api-overview / errorcode / speech-t2a-http）上
`getComputedStyle` 逐元素实测后写入 `style.css` 的值：

| 组件 | 浅色 | 深色 |
| --- | --- | --- |
| 代码块**外壳**背景 | `#F3F3F3` | `rgba(255,255,255,.05)` |
| 代码块**外壳**描边 | `rgba(0,0,0,.1)` | `rgba(255,255,255,.1)` |
| 代码块外壳圆角 / 内边距 | 16px / 2px | 同 |
| 代码块**内层**背景 | `#FFFFFF` | `#0B0C0E` |
| 代码文字色 / 字号 / 行高 | `#1F2328` / 12px / 21.6px | `#D4D4D4` / 12px / 21.6px |
| 表格 `thead` 分隔线 | `#DFDFDF` | `oklch(0.367679 … / .5)` |
| 表格 `tbody tr` 分隔线 | `#EEEEEF` | `oklch(0.268617 … / .5)` |
| 表头文字 | `#1E293B`、600、14px/20px | `#fff` |
| 单元格内边距 | `8px 8px 8px 0` | 同 |
| 提示框字号 / 行高 / 圆角 / 内边距 | 16px / 28px / 16px / `16px 20px` | 同 |
| 侧栏激活项背景 | `rgba(24,30,37,.1)`（`--primary` @10%） | `rgba(74,222,128,.1)` |
| 阴影 | 官网 header / nav / callout / table / code-block 全部 `box-shadow: none` | 同 |

关键结论：官方文档页为**扁平设计**，不使用投影；代码块为**灰壳 + 白内层双层结构**；
表格**无边框、无背景、无圆角**，分隔线画在 `thead` 与 `tbody tr` 上。

> **测量环境陷阱**：浏览器 DPR = 1.5，普通 `1px` 边框的 `getComputedStyle` 计算值显示为
> `0.666667px`。此前记录的「0.667px 分隔线」系测量假象，实际为 1px。

**本轮补充修正**：

| # | 问题 | 修正 | 依据 |
| --- | --- | --- | --- |
| F9 | **深色模式描边全失效**：`--border` 写成 `rgb(var(--tw-prose-invert-hr))`，而 `--tw-prose-invert-hr` 本身已是 `oklch()` 值，`rgb()` 不能接 `oklch()` 实参，整条声明被丢弃 | 改为 `var(--tw-prose-invert-hr)` | CSS 值类型规则 |
| F10 | 表格首列的 `code` 标识符被折成两行（`additionalCont` / `ext`） | `td:first-child:not(.col-num) code` 的换行豁免改为 `td code:not(:only-child)`，使**纯标识符单元格不折行**、**与正文混排时才允许换行** | 标识符可读性；`.table-wrap` 已有 `overflow-x: auto` |

> F9 同类问题在全表扫描中仅此一处；`--accent-bg` 浅色已按官方改为
> `rgb(var(--primary) / 0.1)`，深色为 `rgb(var(--primary-light) / 0.1)`。

### 12.6 可读性终验

对全站可见文本做 WCAG 对比度计算（自行实现 oklch/oklab → sRGB 转换，阈值 3.0）：

| 主题 | 低于阈值元素 |
| --- | --- |
| 深色 | **0** |
| 浅色 | 9 处，全部为 `--fg-faint`（= 官方 `--gray-400` = `159 159 159`）的次级元信息：侧栏分组标签、表格行号、9 条章节来源注、快捷键提示 |

浅色那 9 处与官网的次级元信息处理一致（同样偏淡）。**未加深**——加深即等于自造取值。

### 12.7 标识

官方标识取自 `https://platform.minimax.cn/docs/_mintlify/favicons/minimax-zh/…/favicon/`，
为粉红→橙红渐变圆角方块 + 白色声波。渐变实测 `#E31A7A`（左上）→ `#FF5F41`（右下）。
`icon.png`（512×512）与 `site/assets/minimax.png`（64×64）均由官方 192×192 资产
LANCZOS 缩放生成，未重绘、未改色。

---

## 13. 本插件自身声明

本插件**不提供 MCP 服务**，交付物为：一个可复用 Skill（`skills/mcode-docs/SKILL.md` +
参考文档）与一套**纯静态 HTML 文档站**（`site/`）。文档内容全部来自本台账，
不含任何未经取证的推测。站点无构建步骤、无 npm、无 CDN、无外部字体与图片，`file://` 双击可用。

站点为**中英双语**：`site/index.html`（中文，默认入口）与 `site/index.en.html`（英文），
共享同一套 `assets/style.css` 与 `assets/app.js`。两版的 `id` 集合与顺序经脚本比对**完全一致**
（各 115 个，无重复、无断裂内部链接），标签配平已校验。

语言解析规则（`app.js` §9）：顶栏切换按钮在点击时把偏好写入 `localStorage`
（键 `mcode-docs-lang`）；首访无偏好时按 `navigator.language` 判定，非中文界面跳转到英文页；
**只有默认入口页**参与自动判定，显式打开 `index.en.html` 一律视为明确选择而不跳转。
