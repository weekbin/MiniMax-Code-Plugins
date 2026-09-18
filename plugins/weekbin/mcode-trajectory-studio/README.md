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

The Studio panel is built as a narrative rather than a stack of rows:

- **Sidebar** groups sessions by workspace, with per-group counts and collapsible sections whose
  state persists across reloads.
- **Timeline** uses three lanes sharing one zoomable time axis — `INPUT` (user messages), `MODEL`
  (requests, split into thinking and output segments) and `TOOL` (background tasks and sub-agent
  dispatches, plus faint gaps derived from record spacing and labelled as such). Overlapping blocks
  stack into sub-rows. Wheel zooms, drag pans, double click resets.
- **Records** show content by default, one line with an ellipsis; click a row to open the inspector
  for the full text, token usage and context breakdown.
- **Tasks** expand in place to show the task ID, start/end, duration, owning turn, execution mode,
  sub-agent name, the captured output tail, and buttons to open the sub-agent's own trajectory or
  jump to the record that invoked the call.

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
