# mcode 配置

## 配置文件位置

| 用途 | 路径 |
| --- | --- |
| 主配置 | `<数据目录>/config.yaml`（本机为 `~/.minimax/config.yaml`） |
| 用户级 MCP | `<数据目录>/mcp.json`（本机 `~/.minimax/mcp.json`） |
| 项目级 MCP | `<workspace>/.mcp.json` |
| 运行时权限状态 | `<数据目录>/permission.json` |
| 项目规则 | `<workspace>/AGENTS.md` |

数据目录可通过 `MINIMAX_DATA_DIR` 指定（用于隔离测试配置）。

TUI 内用 `/config` 查看**生效的只读配置**；`mcode exec --config <path>` 可为单次进程指定配置文件。

## 已验证的顶层键

| 键 | 说明 |
| --- | --- |
| `logLevel` | 日志级别 |
| `provider` | 内置 Provider 配置 |
| `defaultModel` | 默认模型，形如 `minimax/MiniMax-M3.1-Flash-Preview` |
| `permissionMode` | 权限模式，取值见 `permissions.md` |
| `custom_provider` | 自定义 Provider 映射 |
| `tui` | 终端界面行为 |
| `statusLine` / `customStatusLine` | 状态栏项 |
| `defaultModelContextWindow` | 默认上下文窗口 |
| `defaultModelVariant` | 默认模型变体，如 `thinking` |
| `defaultModelThinking` | 含 `.effort`，保存默认思考强度 |

## `tui` 段

```yaml
tui:
  terminalTitle: [status, session-name, app-name]
  notifications:
    when: unfocused
    method: auto
    events: [turn-complete, turn-failed, permission-required, question-required]
```

### `terminalTitle`

- 可用项：`status`、`session-name`、`app-name`、`project-name`，可排序或省略。
- 设为 `null` 或 `[]` 可禁用标题更新。
- 未知项被忽略。
- 终端标题形如 `Needs approval | Fix login | MCode`；重命名或切换 Session 会更新。
- 未命名 Session 使用项目名与短 Session ID。

### `notifications`

| 键 | 取值 | 说明 |
| --- | --- | --- |
| `when` | `unfocused` / `always` / `never` | 何时通知 |
| `method` | `auto` / `osc9` / `osc777` / `bel` | 通知协议 |
| `events` | 事件数组 | 省略 = 全部四项；`[]` = 关闭 |

- 通知标识 Session 并抑制重复；完成通知会等待该 Session 的队列结束。
- `auto` 使用检测到的终端通知协议，失败回退到响铃。
- 已知前台聚焦默认抑制通知；焦点未知时为尽力而为。
- tmux 内 OSC 通知需要外层终端透传支持，可用 `method: bel` 回退。
- **配置改动需重启 mcode 生效。**

VS Code 终端默认显示进程名；要显示 mcode 的 Session 标题：

```json
"terminal.integrated.tabs.title": "${sequence}"
```

## 能力开关 `agents`

```yaml
agents:
  default:
    persona:
      enabled: false
    tools: [read, write, edit, bash, grep, glob]
    builtinTools: []
    skills: []
    features:
      mavis: false
      delegation: false
      webSearch: false
```

- `tools` —— 基础工具白名单
- `builtinTools` —— 额外启用的内置工具
- `skills` —— 启用的 Skill
- `features.mavis` / `delegation` / `webSearch` —— 子 Agent、委派、联网搜索开关
- `persona.enabled` —— 人格设定

## Memory 与其它开关

```yaml
memory:
  enabled: false
  proactive: false

askUser:
  enabled: false

skills:
  external:
    enabled: false

skillEvolve:
  enabled: false
```

## `beta.*` 开关全量

以下为 0.5.7 随包 `configs/data-minimal.yaml` 中出现的**全部** beta 开关，
默认均为 `false`：

| 开关 | 作用 |
| --- | --- |
| `autoMemory` | 自动记忆 |
| `skillEvolve` | Skill 自演进 |
| `skillEvolveBuiltinMr` | 内置 Skill 自演进 |
| `skillProposal` | Skill 提案 |
| `browserBridge` | Browser 桥接 |
| `filePanelBrowser` | 文件面板 Browser Provider |
| `filePanelBrowserMultiTab` | 文件面板多标签 |
| `browserUseTooling` | **Browser 工具装配的前提** |
| `browserUseAutoOpenPanel` | 自动打开 Browser 面板 |
| `browserAgentCursor` | Agent 光标 |
| `desktopPlanMode` | 桌面端 Plan Mode |
| `peek` | Peek |
| `keepAlive` | Keep Alive |
| `promptOverride` | Prompt 覆盖 |
| `asr` | 语音识别 |
| `taskHistoryProjectGrouping` | 任务历史按项目分组 |
| `threadGoal` | Thread Goal |
| `mcodeTools` | mcode-tools |
| `codexOAuth` | Codex OAuth |

## 网络代理

读取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式。
**无需**设置 `NODE_USE_ENV_PROXY`。`localhost`、`127.0.0.1`、`::1` 始终直连。

```bash
HTTPS_PROXY=http://127.0.0.1:7890 mcode
```

交互会话、`exec`、更新下载与 Matrix 工具请求使用相同代理规则。

## Telemetry

默认全部关闭，需分别开启（`telemetry.diagnostics` 等）。
`MCODE_DISABLE_TELEMETRY` 或 `DO_NOT_TRACK` 覆盖全部分析通道。

## 修改配置后的生效方式

- 大部分配置**重启 mcode 生效**（尤其 `tui` 段）。
- TUI 内可用 `/reload` 重载 TUI 配置与 Plugins。
- 改完建议用 `/config` 核对生效值。
