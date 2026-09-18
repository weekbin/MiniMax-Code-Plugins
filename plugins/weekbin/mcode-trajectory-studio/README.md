# MCode Trajectory Studio

> A read-only flight recorder for local MiniMax Code sessions, backed by the runtime's own
> SQLite projection, with an interactive local Studio panel.

MiniMax Code's local runtime mirrors every session into a SQLite projection at
`<dataDir>/v2/sqlite/runtime-state.sqlite`. This Plugin reads that projection strictly read-only
and turns it into structured trajectory summaries plus a browsable timeline — so you can answer
"how long did this take", "where did the time go", "which tools ran and which failed", "how many
turns and steps", "where did the context budget go", "when did compaction run", and "which
sub-agents were dispatched" — without opening the raw session files.

## Try it

```text
Use the mcode-trajectory-studio skill to summarize my most recently updated session:
turns, steps, LLM versus tool wall-clock time, tool failures, and compactions.
```

Expected result: the agent calls `trajectory_summary`, reports the folded statistics, and names
`ttftMs` as unavailable rather than estimating it.

```text
Open the Trajectory Studio panel for that session so I can look at the timeline myself.
```

Expected result: the agent calls `trajectory_studio`, receives a `127.0.0.1` URL, and opens it in
the host browser. The panel shows a time overview, a per-turn record table, an inspector for each
record, filters, and the background-task list.

## Capabilities

| Tool | Purpose |
|---|---|
| `trajectory_list` | Recent sessions with non-content metadata; filter by agent, kind, or time |
| `trajectory_summary` | dsh `sessionStats`-equivalent fold: turns, steps, `llmMs`, `toolMs`, `decodeMs`, tokens, tool calls and failures, compactions, sub-agents, assets, trigger sources |
| `trajectory_get` | Paged trajectory records; `summary` or `full` detail |
| `trajectory_search` | Full-text search over titles, agents, statuses, and workspace paths |
| `trajectory_tasks` | Background tasks and sub-agent dispatches with status, duration, command or objective, sub-agent name, and child session ID |
| `trajectory_task_output` | Bounded tail of one task's captured output |
| `trajectory_studio` | Start or stop the local Studio web panel |

The Studio panel is built as a narrative rather than a stack of rows. Each surface answers one
question and does not repeat another surface's answer:

| Surface | Answers |
|---|---|
| **Agent 与能力** | What was this session configured with — model, tool allowlist, skills, system prompt |
| **统计条** | What are the session totals — turns, steps, LLM/tool/decode wall-clock, tokens, failures |
| **时间轴** | Where in time did it happen — navigation and zoom only, no text |
| **轨迹流** | What happened — one scannable line per message and per tool call |
| **检查器** | The full detail of exactly one selected row |

- **Sidebar** is a minimal tree. Sessions group by **git repository**, not by path:
  `git rev-parse --git-common-dir` folds every worktree of one project into a single collapsible
  group, so a long-lived repository does not fragment across the sidebar. Directories outside a git
  tree fall back to path grouping. **Sub-agent sessions nest under the session that dispatched them**,
  recursively, with a caret to expand — so a fan-out reads as a tree instead of a flat list of
  look-alike task sessions. Rows carry only a caret and a title; agent, branch, workspace and age
  live in the tooltip, and expansion state persists across reloads.
- **Timeline** uses three lanes sharing one zoomable axis — `INPUT` (human messages in blue,
  harness-injected context in violet), `MODEL` (requests split into thinking and output segments)
  and `TOOLS` (measured task spans in orange, gaps derived from record spacing in grey and labelled
  as derived). Wheel zooms, drag pans, double click resets.
- **Stream** merges messages and tool calls into one narrative: `TOOL bash ▸ {payload} ⇉ {result}`
  with the measured duration, an agent badge for sub-agents, and a one-click jump into the
  sub-agent's own session. Injected context is visually distinct from things the user typed.
  Filter by human input, injected context, tool calls, or failures only; filter by turn ID or text.
- **Inspector** is tabbed: 概要 (hierarchy, status, token usage, context split), 载荷 (tool arguments
  or message body), 结果 (result text plus a **failure evidence** block), 计时 (recorded instant,
  request/thinking/decode time, and whether the tool duration was measured or absent), and Schema.
- **Failure localisation** is first-class: the header carries a `⚠ N 处失败（定位）` jump, the stream
  marks each failure inline, and the result tab separates **hard** failures (Traceback, stderr,
  `is_error`) from **soft** ones (a non-zero exit code, which is often just `grep` finding nothing).
  A call can report success while its output contains a Traceback, so the classification reads the
  text, not only the status code.

## What this reads

| Source | Path | Used for |
|---|---|---|
| SQLite projection | `<dataDir>/v2/sqlite/runtime-state.sqlite` | Primary. Opened `mode=ro`; never written. |
| Session artifact | `<dataDir>/v2/sessions/YYYY/MM/DD/<stamp>-<id>/messages.jsonl` | Fallback for sessions the projection has not indexed, and for content when a projection field is absent. |

`<dataDir>` resolves in this order: `MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR`, `~/.minimax`.

### Fields worth knowing

- `usage.request_duration_ms` — per-request model wall-clock time (`llmMs`).
- `thinking_duration_ms` — thinking-phase duration per record.
- `tool_calls[].tool_call_args`, `tool_call_result_data`, `tool_call_status` — tool input, output,
  and status (a status other than `2` did not succeed).
- `local_runtime_background_tasks` — `created_at_ms`/`ended_at_ms` give exact tool and sub-agent
  wall-clock time (`toolMs`).
- `kind: compaction` records carry `messagesBefore`/`messagesAfter` and `tokensBefore`/`tokensAfter`.
- `context_usage.components` — per-request split of SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES.
- `source` — what triggered the model call: `api`, `thread-goal`, `questionnaire`,
  `background-task`, `task`, `agent`, `greeting`.
- `local_runtime_sessions_fts` — FTS5 index over session metadata.

## Honest limitations

- **Time-to-first-token is not persisted by the runtime.** `ttftMs` is always `null` and is never
  estimated. The Studio overview uses a thinking segment versus output segment instead.
- **`decodeMs` is an approximation**: `Σ(request_duration_ms − thinking_duration_ms)`.
- The `local_runtime_*` tables are an internal runtime detail. Every optional table, column, and
  JSON field is probed before use and degrades to `null`; a future runtime change should reduce
  fidelity rather than break the Plugin. If SQLite is unreadable the Plugin falls back to
  `messages.jsonl`, where timing fields are absent.
- Tool wall-clock time is only available for calls that the runtime recorded as background tasks;
  `toolMs` therefore covers those, not every inline call.
- The projection indexes sessions as they are written. A very recent session may not be present
  yet; the JSONL fallback covers that case.

## Privacy

- The Plugin is **read-only**. It never writes to, moves, or deletes session storage.
- The Studio panel binds to `127.0.0.1` only, and every API route requires an authority check, an
  origin check, and a custom request header that a cross-origin page cannot set without a CORS
  preflight this server never approves. Static assets ship a deny-by-default CSP.
- `summary` detail returns no message text, thinking, tool arguments, or tool results.
- `full` detail is opt-in and passes through a secret redactor (credential key/value pairs,
  bearer tokens, provider key formats, private key blocks, credentials in connection strings)
  plus depth, breadth, and length bounds. Home-directory prefixes are collapsed to `~`.
- Nothing is uploaded anywhere; there are no network destinations and no telemetry.

## Requirements

- MiniMax Code 0.4.0+ (`mcode`) with Agent Plugin and MCP support.
- Node.js 22+ on `PATH`. Verified on Node.js 24, which provides `node:sqlite`. The Plugin ships no
  dependencies and needs no build step.
- A local runtime with the v2 SQLite projection, or v2 session artifacts for the fallback path.
- A host browser capability for automatic panel opening; without it the panel URL still works.

## Install

This repository hosts Plugins as source. Point MiniMax Code at this directory as a local Plugin, or
copy `plugins/weekbin/mcode-trajectory-studio/` into your Plugin directory. The `mcp.json` server
entry starts automatically.

## Diagnostics

```bash
node server/main.mjs --doctor   # resolved data dir, SQLite/FTS availability, latest session stats
node server/main.mjs --serve    # run the Studio panel standalone on 127.0.0.1
```

## License

Apache-2.0. See [LICENSE](LICENSE).

## Design notes

The research and interface comparison behind this Plugin — including why the runtime SQLite
projection is used instead of session JSONL artifacts — is recorded in [DESIGN.md](DESIGN.md).
