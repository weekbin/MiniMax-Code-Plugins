# mcode-docs

English | [简体中文](./README.zh-CN.md)

**MiniMax Code（`mcode`）能力说明与事实基线。**

本插件不提供 MCP 服务。交付物为可复用 Skill 与纯静态 HTML 文档站；后者可直接在浏览器中
打开 `site/index.html` 离线阅读。

## 立论依据

关于 `mcode` 的资料分散于随包 README、官方开源仓库、运行时配置文件与打包产物之中。
在此情形下，主要风险并非检索困难，而是似是而非的论断被当作事实采纳。以下三类偏差反复出现：

- `mcode mcp add`、`mcode skill list` 等子命令常被假定存在。经直接执行验证，**此类子命令均不存在**；
  对应能力由配置文件与 TUI slash 命令提供。
- 打包产物中检索不到 `PreToolUse`，常被据以推断 mcode 不具备 Hook 系统。源码所证恰相反：
  **已定义 11 个事件**，且**兼容 Claude Code 事件模型**。
- 文件系统快照回滚、Gist 分享、代码格式化器与预热常被归于 mcode。**上述能力均未实现。**

本插件对上述各点逐一澄清，并**保留纠错记录**（见 `VERIFICATION.md`），使每项结论的推导过程
可被检视，而非仅被断言。

## 取证基线

| 来源 | 版本 | 作用 |
| --- | --- | --- |
| 本机安装 `<npm root -g>/@minimax-ai/code` | **0.5.8** | 逐条实跑 `--help`、随包 README、运行时真实配置 |
| [`MiniMax-AI/minimax-code`](https://github.com/MiniMax-AI/minimax-code) `main` | **0.5.8** | TypeScript 权威定义 |

功能定义以**源码**为准：源码携带显式类型，语义无歧义。**实跑**承担互补职能，用以确认某项能力
确在本机 0.5.8 上存在。台账 `VERIFICATION.md` 按 A–D 四级对每条主张的证据强度评级。

## 交付内容

```
mcode-docs/
├── plugin.json                  # agent-plugins.org 清单
├── .minimax-plugin/plugin.json  # mcode 市场清单
├── .claude-plugin/plugin.json   # Claude 兼容清单
├── VERIFICATION.md              # 取证台账：证据、反例与纠错记录
├── icon.png
├── LICENSE
├── skills/mcode-docs/
│   ├── SKILL.md                 # 可复用 Skill
│   └── reference/               # 八份参考文档
│       ├── commands.md          # 52 条 slash 命令全表
│       ├── cli.md               # CLI、无头执行与 ACP
│       ├── config.md            # 配置结构与数据目录
│       ├── agents-skills.md     # Agent、Skill 与工具
│       ├── plugins-hooks.md     # 插件 manifest 契约与 Hook 系统
│       ├── mcp-tools.md         # MCP 与附件
│       ├── permissions.md       # 权限模式、Plan Mode 与会话
│       └── coverage.md          # opencode v2 章节能力边界对照
└── site/                        # 纯静态 HTML 文档站（中英双语）
    ├── index.html               # 中文，默认入口
    ├── index.en.html            # 英文
    └── assets/{style.css, app.js}
```

## HTML 文档站

- **完全静态。** 无构建步骤、无包管理器、无 MCP 服务、无 CDN，不发起任何网络请求。
- **中英双语。** `index.html` 与 `index.en.html` 共享同一套 `assets/style.css` 与
  `assets/app.js`；两版锚点集合与顺序一致。顶栏可切换语言，首访按 `navigator.language`
  判定，手动选择后持久化。不使用 `fetch` 加载语言包，以保持 `file://` 可用。
- 可在 `file://` 下运行；剪贴板降级路径已单独验证。
- 视觉系统取自 **MiniMax 开放平台文档中心**
  （<https://platform.minimax.cn/docs/api-reference/api-overview>）。设计令牌以实测方式提取，
  非目测比对：取自该页 404 个 CSS 变量，并以关键元素的 `getComputedStyle` 补充。主要实测值：
  `--primary 24 30 37`、`--primary-light 74 222 128`、默认边框 `--gray-100 #EEEEEF`、
  标题 `#171717`、二级标题与正文链接 `#1E293B`（字重 600，带下划线）、正文 `#3F3F3F`
  `16px/24px`、导航 `#707071`、行内代码底色 `#F1F1F1@50%`（`2px 8px` 内边距，`6px` 圆角）、
  代码块白底 `14px` 圆角 `14px 16px` 内边距、提示框 `#EFF6FF` 底 `#BFDBFE` 边 `16px` 圆角、
  侧栏宽 `288px`、激活项 `rgba(0,0,0,.1)` 填充 `12px` 圆角、分隔线 `0.667px`。
- **默认浅色主题。** 首访刻意不查询系统 `prefers-color-scheme` 媒体特性；深色主题为可选项，
  选择结果持久化保存。
- 全文检索（`Cmd`/`Ctrl` + `K`）、代码块复制、随滚动定位的大纲、移动端抽屉。

## 使用方式

作为 Skill 使用：插件安装后，当问询对象涉及 mcode 的命令、配置、Agent、Skill、插件、Hook、
MCP、权限或会话时，Agent 加载 `mcode-docs`。

直接阅读：打开 `site/index.html`（中文）或 `site/index.en.html`（英文）。

## 文档口径

**经核实已实现**并给出完整说明：52 条 slash 命令；CLI 与无头执行全量参数；ACP；配置结构
与跨平台数据目录；四个内置 Agent；**十六个**内置 Skill；十二个基础工具；用户级与项目级 MCP；
**11 个 Hook 事件**（`MINIMAX`、`CLAUDE`、`CODEX` 三种格式）；五种 `PermissionMode`；
Plan Mode；会话管理。

**经核实不存在**。文档中均予以明确标注，并给出受支持的替代路径。

| 能力 | 替代路径 |
| --- | --- |
| 文件系统快照与时点回滚（opencode *Snapshots*） | 使用 git 进行版本控制 |
| 代码格式化器（opencode *Formatters*） | 由 Agent 显式调用项目自身的格式化命令 |
| Gist 与远程分享（opencode *Sharing*） | `/export [path.md]` |
| 独立策略引擎（opencode *Policies*） | 经 `/permission` 选择最小可用权限 |
| 预热（opencode *Warming*） | 无需此步骤；模型缓存由 Runtime 处理 |
| *Migrate from V1* | 不适用；经 `mcode update` 升级 |
| TUI/CLI 中的 Browser Use | 未在该端暴露；Browser 属桌面端宿主能力 |

> `/history`、`/fork`、`/rewind` 作用于**会话与对话历史**，并非文件系统快照机制，
> 二者不应混同。

## 维护

版本递增后，按 `VERIFICATION.md` 记录的方式重新核验：

```bash
mcode --version
mcode <cmd> --help
git clone --depth 1 https://github.com/MiniMax-AI/minimax-code.git
```

优先复核对象：两个命令注册表（`packages/tui/src/tui/commands/catalog.ts` 与
`packages/tui/src/application/command-descriptors.ts`）、`PLUGIN_HOOK_EVENTS`、
`PermissionMode`、`MANIFEST_FIELDS`。

## License

[Apache-2.0](./LICENSE)
