# mcode CLI、Headless 与 ACP

全部参数均在本机 `mcode 0.5.8` 实跑 `--help` 验证。

## 安装与版本

要求 Node.js **`>=22.19 <23`** 或 **`>=24 <27`**（不支持 Node 23）。

```bash
npm install -g @minimax-ai/code \
  --allow-scripts=@minimax-ai/code,better-sqlite3 \
  --registry=https://registry.npmjs.org/
```

同时安装 `mcode` 与 `mcode-tools` 两个命令。`mcode-tools` 无需先启动 TUI 即在 `PATH` 上。

```bash
mcode --version          # 0.5.8
mcode update             # 检查并安装更新
npm uninstall -g @minimax-ai/code
```

## 顶层命令

| 命令 | 说明 |
| --- | --- |
| `mcode [prompt]` | 启动交互式 TUI |
| `mcode init [directory]` | 分析代码库生成 / 完善 `AGENTS.md`（使用内置 `init` Skill） |
| `mcode exec [prompt]` | 不启动 TUI，执行一次任务 |
| `mcode exec review` | 审查 staged / unstaged / untracked 本地改动 |
| `mcode acp` | 以 Agent Client Protocol 服务运行（stdio） |
| `mcode login` / `logout` | 管理登录态，`--region cn\|global`，login 支持 `--no-browser` |
| `mcode update` | 检查并安装更新 |
| `mcode provider ...` | `list` / `add` / `remove` / `test` / `use` / `set-minimax-key` |
| `mcode plugin ...` | `list` / `add` / `remove` / `enable` / `disable` / `marketplace` |

## 全局选项

| 选项 | 说明 |
| --- | --- |
| `-V, --version` | 输出版本号 |
| `-m, --model <provider/model>` | 仅为本次 Session 选择模型 |
| `--lane <lane>` | 托管后端通道（测试或预发布构建） |
| `--session [id]` | 省略 id 时打开 Session 浏览器 |
| `-c, --continue` | 继续当前 workspace 最近的 Session |
| `--tui-mode <mode>` | `regular`（默认）或 `fullscreen` |

> `-m` 只影响本次打开或创建的 Session，不改变全局默认模型，可与 `--continue` 或
> `--session <id>` 配合；**无 id 的 Session 浏览器不能同时指定模型**。

## 经核实不存在的子命令

`mcode mcp`、`mcode config`、`mcode agent`、`mcode skill`、`mcode hook`、`mcode workflow`
全部回落到根帮助，**0.5.8 没有这些子命令**。对应能力请用配置文件或 TUI slash 命令。

## `mcode exec`（Headless）

```bash
mcode exec "审查当前改动，并运行相关测试。"
mcode exec --cwd ./repo --file error.log "定位这次构建失败的原因。"
mcode exec --output-format json "总结当前分支。"
mcode exec --model custom_provider:work/deep-reasoner-1 --effort xhigh "规划这次迁移。"
mcode exec review --cwd ./repo
```

### 参数全集

| 参数 | 说明 |
| --- | --- |
| `--input <source>` | 读取显式输入，**仅支持 `-`**（stdin） |
| `--input-format <format>` | `text`（默认）或 `json` |
| `--cwd <path>` | workspace 目录 |
| `--file <path>` | 附加文件，**可重复** |
| `--model <provider/model>` | 仅本次 Run 覆盖 |
| `--effort <level>` | 仅本次 Run 覆盖推理强度 |
| `--prompt-mode <mode>` | `tui`（默认）/ `coding` / `work` |
| `--session <id>` | 在已有活跃 Session 中运行 |
| `--continue` | 继续 `--cwd` 中最近的活跃 Session |
| `--config <path>` | 本进程使用显式 Runtime 配置文件 |
| `--permission <policy>` | `smart`（默认）/ `full` / `off`（`ask` 需 TUI/ACP） |
| `--timeout <duration>` | Run 超时，如 `30s`、`2m` |
| `--max-steps <count>` | 最大 assistant 步数 |
| `--output-format <format>` | `text` / `json` / `stream-json` |
| `--diagnostics-dir <path>` | 保存有界执行诊断到**全新空目录** |
| `--output-schema <schema>` | JSON Schema 文件或内联对象，约束最终回答 |
| `-o, --output-last-message <path>` | 将最终消息写入文件 |

### 关键语义

- `--effort` 只对本次 Run 生效，与 `--model` **相互独立**；启动前会用模型声明的强度校验，
  不支持的强度以非零退出码失败，**不会静默回退**。覆盖**不写回 Session**。
- `--model provider/model#xhigh` 后缀**不是**思考强度：Runtime 会把它当作模型身份的一部分，
  请求的强度被静默丢弃。需要强度生效请用 `--effort xhigh`。
- `--diagnostics-dir` 相对路径基于 `--cwd` 解析，**已有非空目录会被拒绝**，避免覆盖前次证据。
- JSON 校验失败仍返回失败，不会自动修复；`--output-last-message` 只保存成功结果。
- 诊断不混入 stdout；写入失败只告警，不替换原始执行错误。

### `mcode exec review`

只审查 staged、unstaged、untracked 的本地改动。**仅支持**：
`--cwd`、`--model`、`--effort`、`--config`、`--permission`、`--timeout`、`--max-steps`、
`--output-format`、`--output-last-message`。

- 参数可放在 `review` 前后；两处都指定时以 `review` 后的显式值为准。
- `--session`、`--continue`、`--input`、`--input-format`、`--file`、`--output-schema`、
  `--diagnostics-dir` **不支持**，放在 `review` 前会报错。
- **发现问题仍返回退出码 0**；只有调用、Runtime 或审查结果协议失败才返回非零。
- 默认使用 `inline` 模式（当前 Turn 内完成审查）；显式配置 `review.mode: subagent`
  时改用子代理。

## `mcode acp`

```bash
mcode acp
```

通过 stdin/stdout 启动 Agent Client Protocol 服务。支持 ACP 的编辑器与 Agent 客户端
可借此创建、加载、继续和关闭 mcode Session。TUI、`exec` 与 ACP **共用同一进程内 Runtime 生命周期**。

## `mcode provider`

```bash
mcode provider list
mcode provider test <provider-id>
mcode provider add --name Work --base-url https://example.com/v1 \
  --api-format openai-completions --model vision-model \
  --context-limit 128000 --output-limit 8192 --support-image --use
mcode provider remove <provider-id> --yes
mcode provider use <source>
mcode provider set-minimax-key
```

- API Key 从 `MCODE_PROVIDER_API_KEY` 或 `--api-key-env` 指定的环境变量读取。
- `--use` 先测试第一个模型，成功才保存并选为默认；**失败不保存**。不带 `--use` 可先保存后在 `/provider` 测试。
- Token 上限必须是正整数；`--support-image` 显式声明图片输入能力，不凭模型名字猜测。
- 第三方 relay 的自定义 header 位于 `custom_provider.<id>.options.headers`。

## `mcode plugin`

```bash
mcode plugin list --available
mcode plugin add <plugin-id>
mcode plugin enable <plugin-id>
mcode plugin disable <plugin-id>
mcode plugin remove <plugin-id>
mcode plugin marketplace
```

直接运行 `mcode plugin` 会打开交互式 Plugin manager。详见 `plugins-hooks.md`。

## 安装故障排查

### npm 12 阻止安装脚本 / SQLite 原生依赖缺失

症状：安装日志出现 `npm warn install-scripts`；启动时报
`Could not locate the bindings file`、缺少 `better_sqlite3.node`，或 `migration_failed`。

修复（保持原包名、版本与 registry）：

```bash
npm install -g @minimax-ai/code@latest \
  --registry=https://registry.npmjs.org/ \
  --foreground-scripts --ignore-scripts=false \
  --include=optional \
  --allow-scripts=@minimax-ai/code,better-sqlite3
```

- 只加 `--ignore-scripts=false` **不能**代替 npm 12 的脚本授权。
- 看到 `[MCode] Native SQLite check passed.` 后再启动 `mcode`。
- 通过官方 Shell/PowerShell 安装器安装的用户，重跑原安装命令即可。
