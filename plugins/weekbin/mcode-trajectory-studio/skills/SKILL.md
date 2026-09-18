---
name: mcode-trajectory-studio
description: Inspect and visualize MiniMax Code session trajectories from the local runtime's read-only SQLite projection. Use when the user asks what happened in a session, why a task was slow or expensive, how many turns or tool calls a run took, which tools failed, how much wall-clock time went to the model versus tools, where context was spent, when compaction ran, which sub-agents were dispatched, or wants an interactive timeline of a session. Trigger phrases include "轨迹", "trajectory", "这个会话花了多久", "为什么这么慢", "调用了哪些工具", "session 时长/轮次", "看看某个 session".
---

# MiniMax Code Trajectory Studio

Read-only trajectory inspection for local MiniMax Code sessions. The Plugin reads the
runtime's own SQLite projection and never writes to session storage.

## Pick the detail level first

| Level | Returns | When |
|---|---|---|
| `summary` (default) | roles, turn IDs, timings, token usage, tool **names** and statuses | Any question about duration, cost, turns, failures, structure |
| `full` | additionally message text, thinking, tool **arguments**, tool **results** | Only after the user explicitly asks to see content |

Never widen to `full` on your own. The user's session content is theirs; ask before returning it.

## Tools

1. `trajectory_list` — find a session. Returns metadata only, newest first. Filter by `agent`
   (`mavis`, `explore`, `worker`, `verifier`), `kind`, or `sinceMs`.
2. `trajectory_summary` — the dsh `sessionStats` equivalent for one session: `turns`, `steps`,
   `llmMs`, `toolMs`, `decodeMs`, `thinkingMs`, `inputTokens`/`cacheReadTokens`/`totalTokens`,
   `toolCalls`/`toolFailures`, `compactions`, `subagentTasks`, `assets`, and a `sources` breakdown.
   Omit `sessionId` for the most recently updated session.
3. `trajectory_get` — page through records in insert order. Use `offset`/`limit`; narrow with
   `turnId`. Read `nextOffset` and keep paging when you need the whole session.
4. `trajectory_search` — full-text search over titles, agent names, statuses, and workspace paths.
5. `trajectory_tasks` — background tasks and sub-agent dispatches owned by a session, with status,
   wall-clock duration, the command or objective, the sub-agent name, and the child session ID.
   This is the nested view.
6. `trajectory_task_output` — the tail of one task's captured output (bounded). Use it to explain a
   failure without opening the session directory by hand.
7. `trajectory_studio` — start the local web panel and return its URL.

## Answering common questions

- **"How long did this session take?"** → `trajectory_summary`, then report `llmMs`, `toolMs`,
  `decodeMs`, and `steps`. Say that `llmMs + toolMs` is the machine time, not wall-clock elapsed.
- **"Why is it slow?"** → compare `llmMs` against `toolMs`; if tools dominate, call
  `trajectory_tasks` and report the slowest tasks by `durationMs`.
- **"Why did this task fail?"** → `trajectory_tasks` to find the failed row, then
  `trajectory_task_output` for its captured output.
- **"What tools ran / what failed?"** → `trajectory_get` (summary) and read `toolCalls[].name` plus
  `toolCalls[].status`; `status !== 2` means the call did not succeed.
- **"What did the sub-agents do?"** → `trajectory_tasks`, then filter `kind === 'subagent'`; each row
  carries `agentName`, `description`, and `childSessionId`. Pass that child ID back into
  `trajectory_summary` or `trajectory_get` to inspect the sub-agent's own trajectory.
- **"How many turns?"** → `trajectory_summary.turns`, then `trajectory_get` to show per-turn
  totals from the `turnId` grouping.
- **"Where did the context go?"** → `trajectory_get` and read each record's `contextUsage`
  component breakdown (SYSTEM_PROMPT / MEMORY / TOOLS / SKILLS / MESSAGES).

## Open the Studio panel

When the user wants to browse a trajectory themselves:

1. Call `trajectory_studio` with the `sessionId` to focus. It returns a `url` on `127.0.0.1`.
2. Find the host's browser skill in the current Skill catalog — for example
   `browser-use:control-in-app-browser` only if that exact name is listed. Load it, then open the
   returned URL with the host's browser tool.
3. Confirm the page actually rendered before reporting success. If no browser capability is
   available, give the user the URL and say the panel is running locally.
4. The panel is read-only, bound to loopback, and stops when the MCP connection closes. Call
   `trajectory_studio` with `stop: true` only if the user asks to shut it down.

## Data source notes

- Primary source is `<dataDir>/v2/sqlite/runtime-state.sqlite`, opened `mode=ro`. `<dataDir>` is
  `MINIMAX_DATA_DIR`, else `MAVIS_DATA_DIR`, else `~/.minimax`.
- Sessions the projection has not indexed fall back to `messages.jsonl`; timings are then missing.
  The `source` field on `trajectory_get` reports which path was used.
- **Time-to-first-token is not persisted by the runtime.** `trajectory_summary.ttftMs` is always
  `null` and must be reported as unavailable, never estimated.
- `decodeMs` is an approximation: `Σ(request_duration_ms − thinking_duration_ms)`.
- If `sqliteAvailable` is false, say so plainly instead of reporting empty results as "no activity".

## Boundaries

- Read-only: never edit, move, or delete anything under the session directories.
- The SQLite tables are an internal runtime detail. Missing tables or fields degrade to `null`;
  do not treat an absent field as proof that the event did not happen.
- Report what the tools returned. Do not infer message text from a `contentLength`.
