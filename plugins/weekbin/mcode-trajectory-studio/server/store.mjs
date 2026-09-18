/**
 * Data layer for MCode Trajectory Studio.
 *
 * Primary source: the local runtime SQLite projection at
 *   <dataDir>/v2/sqlite/runtime-state.sqlite
 * opened strictly read-only. Fallback source for sessions the projection has not
 * indexed: <dataDir>/v2/sessions/YYYY/MM/DD/<stamp>-<sessionId>/messages.jsonl
 *
 * The SQLite tables are an internal implementation detail of the runtime. Every
 * optional column and every optional JSON field is therefore probed before use and
 * degrades to `null` instead of throwing.
 */

import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveWorkspaceIdentities } from './git.mjs';

export const SESSION_KINDS = ['conversation', 'task', 'peek', 'channel', 'cron', 'unknown'];

const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ paths -- */

export function resolveDataDir(env = process.env, homeDir) {
  const fromEnv = env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const home = homeDir || env.HOME || env.USERPROFILE || '';
  if (!home) throw new Error('cannot resolve data directory: set MINIMAX_DATA_DIR or HOME');
  return path.join(path.resolve(home), '.minimax');
}

export function sqlitePath(dataDir) {
  return path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
}

export function sessionsRoot(dataDir) {
  return path.join(dataDir, 'v2', 'sessions');
}

/* ---------------------------------------------------------------- helpers -- */

function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function tableExists(db, table) {
  try {
    return Boolean(db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    ).get(table));
  } catch {
    return false;
  }
}

/** Parse a JSON column without letting malformed rows abort the whole read. */
function parseJson(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Which doorway did this record enter the session through?
 *
 * `human` means the text is the person's own. `injected` means the harness put it
 * there — a goal objective, a questionnaire answer channel, a background-task
 * result — and the reader should not mistake it for something they typed.
 */
function classifyInput(source, originType) {
  if (typeof originType === 'string' && originType) return 'injected';
  if (source === 'thread-goal' || source === 'background-task' || source === 'task' || source === 'agent') {
    return 'injected';
  }
  if (source === 'api' || source === 'questionnaire' || source === 'greeting') return 'human';
  return 'unknown';
}

export { classifyInput };

/**
 * Encode a user query into the token form the runtime's FTS5 index stores.
 * The index keeps `c<hex codepoint>` tokens, so "轨迹" is indexed as "c8f68 c8ff9".
 */
export function encodeFtsQuery(query) {
  const tokens = [];
  for (const char of String(query)) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0x20) continue;
    tokens.push(`c${code.toString(16)}`);
  }
  return tokens.join(' ');
}

/* ------------------------------------------------------------------ store -- */

export class Store {
  constructor({ dataDir, db = null, warnings = [] }) {
    this.dataDir = dataDir;
    this.db = db;
    this.warnings = warnings;
    this.columns = {
      sessions: db ? tableColumns(db, 'local_runtime_sessions') : new Set(),
      rows: db ? tableColumns(db, 'local_runtime_message_rows') : new Set(),
      tasks: db ? tableColumns(db, 'local_runtime_background_tasks') : new Set(),
      assets: db ? tableColumns(db, 'local_runtime_session_assets') : new Set(),
    };
    this.hasFts = Boolean(db) && tableExists(db, 'local_runtime_sessions_fts');
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
  }

  has(scope, column) {
    return this.columns[scope].has(column);
  }

  /* ------------------------------------------------------------ sessions -- */

  listSessions({ limit = 20, agent, kind, sinceMs, includeArchived = false } = {}) {
    if (!this.db) return [];
    const where = ['1 = 1'];
    const params = [];
    if (this.has('sessions', 'columnar_version')) {
      // Columnar rows carry the rich mirrored columns; older rows fall back to JSON.
      where.push('1 = 1');
    }
    if (!includeArchived && this.has('sessions', 'archived')) where.push('archived = 0');
    if (this.has('sessions', 'visibility')) where.push("visibility <> 'hidden'");
    if (agent) {
      where.push('agent_name = ?');
      params.push(agent);
    }
    if (kind) {
      where.push('session_kind = ?');
      params.push(kind);
    }
    if (Number.isFinite(sinceMs)) {
      where.push('updated_at_ms >= ?');
      params.push(sinceMs);
    }
    const order = this.has('sessions', 'updated_at_ms') ? 'updated_at_ms DESC' : 'rowid DESC';
    const sql = `SELECT * FROM local_runtime_sessions WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`;
    params.push(Math.max(1, Math.min(500, limit)));
    let rows = [];
    try {
      rows = this.db.prepare(sql).all(...params);
    } catch (error) {
      this.warnings.push(`session_list_failed:${error.message}`);
      return [];
    }
    return rows.map((row) => this.#sessionSummary(row));
  }

  #sessionSummary(row) {
    const record = parseJson(row.record_json) || {};
    const col = (name, fallback) => (row[name] === undefined || row[name] === null ? fallback : row[name]);
    return {
      sessionId: row.session_id,
      title: col('title', record.title ?? null),
      agent: col('agent_name', record.agentName ?? null),
      sessionKind: col('session_kind', record.sessionKind ?? 'unknown'),
      status: col('status', record.status ?? null),
      runtime: col('runtime', record.runtime ?? null),
      workspaceDir: col('workspace_dir', record.workspaceDir ?? null),
      parentSessionId: col('parent_session_id', record.parentSessionId ?? null),
      createdAtMs: col('created_at_ms', record.createdAtMs ?? null),
      updatedAtMs: col('updated_at_ms', null),
      archived: Boolean(col('archived', 0)),
      errorMessage: col('error_message', null),
    };
  }

  /** Read one session row plus its direct child sessions (sub-agents / tasks). */
  getSession(sessionId) {    if (!this.db) return null;
    let row;
    try {
      row = this.db.prepare('SELECT * FROM local_runtime_sessions WHERE session_id = ?').get(sessionId);
    } catch {
      return null;
    }
    if (!row) return null;
    const summary = this.#sessionSummary(row);
    let children = [];
    if (this.has('sessions', 'parent_session_id')) {
      try {
        children = this.db
          .prepare('SELECT * FROM local_runtime_sessions WHERE parent_session_id = ? ORDER BY created_at_ms ASC LIMIT 200')
          .all(sessionId)
          .map((child) => this.#sessionSummary(child));
      } catch {
        children = [];
      }
    }
    return { ...summary, children };
  }

  /* ------------------------------------------------------------ identity -- */

  /**
   * Annotate sessions with the repository they actually belong to, so every
   * worktree of one project groups together instead of fragmenting by path.
   */
  async annotateWorkspaces(sessions) {
    const resolve = await resolveWorkspaceIdentities(sessions.map((session) => session.workspaceDir));
    return sessions.map((session) => {
      const identity = resolve(session.workspaceDir);
      return {
        ...session,
        groupKey: identity.key,
        groupLabel: identity.label,
        groupKind: identity.kind,
        branch: identity.branch,
        worktree: identity.worktree,
      };
    });
  }

  /**
   * The agent definition the runtime recorded for a session: model selection,
   * tool and skill allowlists, and the system prompt. Present only for sessions
   * the runtime dispatched with an explicit definition (presets, sub-agents).
   */
  getAgentDefinition(sessionId) {
    if (!this.db || !tableExists(this.db, 'local_runtime_session_agent_definitions')) return null;
    let row;
    try {
      row = this.db.prepare(
        'SELECT definition_json FROM local_runtime_session_agent_definitions WHERE session_id = ?',
      ).get(sessionId);
    } catch {
      return null;
    }
    const definition = parseJson(row?.definition_json);
    if (!definition) return null;

    const capabilities = definition.capabilities && typeof definition.capabilities === 'object'
      ? definition.capabilities
      : {};
    const model = definition.model && typeof definition.model === 'object' ? definition.model : {};
    return {
      definitionVersion: num(definition.definitionVersion),
      ownerName: definition.exactOwnerName ?? null,
      model: {
        providerId: model.providerId ?? null,
        modelId: model.modelId ?? null,
        variant: model.variant ?? null,
        contextWindow: num(model.contextWindow),
        maxOutputTokens: num(model.maxOutputTokens),
        parameterSnapshot: model.parameterSnapshot ?? null,
      },
      tools: Array.isArray(capabilities.tools) ? capabilities.tools : [],
      disallowedTools: Array.isArray(capabilities.disallowedTools) ? capabilities.disallowedTools : [],
      mcpServers: Array.isArray(capabilities.mcpServers) ? capabilities.mcpServers : [],
      skills: Array.isArray(capabilities.skills) ? capabilities.skills : [],
      extensionSkills: Array.isArray(capabilities.extensionSkills) ? capabilities.extensionSkills : [],
      systemPrompt: typeof definition.systemPrompt === 'string' ? definition.systemPrompt : null,
      project: definition.project && typeof definition.project === 'object' ? definition.project : null,
    };
  }

  /* --------------------------------------------------------------- stats -- */

  /** The dsh `sessionStats` equivalent, folded from the SQLite projection. */
  getStats(sessionId) {
    const session = this.getSession(sessionId);
    if (!this.db || !session) return null;

    const agg = this.#rowAggregate(sessionId);
    const toolTasks = this.#toolTaskAggregate(sessionId);
    const compactions = this.#compactionAggregate(sessionId);
    const assets = this.#assetAggregate(sessionId);

    const llmMs = agg.requestMs;
    const decodeMs = agg.requestMs !== null && agg.thinkingMs !== null
      ? Math.max(0, agg.requestMs - agg.thinkingMs)
      : null;

    return {
      sessionId,
      title: session.title,
      agent: session.agent,
      sessionKind: session.sessionKind,
      status: session.status,
      workspaceDir: session.workspaceDir,
      parentSessionId: session.parentSessionId,
      createdAtMs: session.createdAtMs,
      updatedAtMs: session.updatedAtMs,
      // dsh parity -------------------------------------------------------
      turns: agg.turns,
      steps: agg.steps,
      llmMs,
      toolMs: toolTasks.totalMs,
      // mcode does not persist time-to-first-token, so this stays unavailable
      // rather than being fabricated.
      ttftMs: null,
      ttftAvailable: false,
      decodeMs,
      decodeTokens: agg.outputTokens,
      // ----------------------------------------------------------------
      thinkingMs: agg.thinkingMs,
      inputTokens: agg.inputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      totalTokens: agg.totalTokens,
      contextWindowTokens: agg.contextWindowTokens,
      toolCalls: agg.toolCalls,
      toolFailures: agg.toolFailures,
      events: agg.events,
      thinkingEvents: agg.thinkingEvents,
      subagentTasks: toolTasks.subagentCount,
      backgroundTasks: toolTasks.taskCount,
      compactions: compactions.total,
      compactionFailures: compactions.failed,
      assets: assets.total,
      sources: agg.sources,
      children: session.children.length,
      warnings: [],
    };
  }

  #rowAggregate(sessionId) {
    const expr = (jsonPath) => `json_extract(data_json, '${jsonPath}')`;
    const sql = `
      SELECT
        COUNT(*) AS events,
        COUNT(DISTINCT NULLIF(${expr('$.turn_id')}, '')) AS turns,
        SUM(CASE WHEN ${expr('$.usage.request_duration_ms')} IS NOT NULL THEN 1 ELSE 0 END) AS steps,
        SUM(COALESCE(${expr('$.usage.request_duration_ms')}, 0)) AS request_ms,
        SUM(COALESCE(${expr('$.thinking_duration_ms')}, 0)) AS thinking_ms,
        SUM(CASE WHEN ${expr('$.thinking_duration_ms')} IS NOT NULL THEN 1 ELSE 0 END) AS thinking_events,
        SUM(COALESCE(${expr('$.usage.input_tokens')}, 0)) AS input_tokens,
        SUM(COALESCE(${expr('$.usage.output_tokens')}, 0)) AS output_tokens,
        SUM(COALESCE(${expr('$.usage.cache_read')}, 0)) AS cache_read,
        SUM(COALESCE(${expr('$.usage.total_tokens')}, 0)) AS total_tokens,
        MAX(${expr('$.usage.context_window')}) AS context_window
      FROM local_runtime_message_rows
      WHERE session_id = ?
    `;
    let base;
    try {
      base = this.db.prepare(sql).get(sessionId) || {};
    } catch (error) {
      this.warnings.push(`row_aggregate_failed:${error.message}`);
      base = {};
    }

    let toolCalls = 0;
    let toolFailures = 0;
    try {
      const row = this.db.prepare(`
        SELECT
          SUM((SELECT COUNT(*) FROM json_each(data_json, '$.tool_calls'))) AS calls,
          SUM((
            SELECT COUNT(*) FROM json_each(data_json, '$.tool_calls') AS tc
            WHERE json_extract(tc.value, '$.tool_call_status') NOT IN (2)
          )) AS failures
        FROM local_runtime_message_rows
        WHERE session_id = ? AND json_extract(data_json, '$.tool_calls') IS NOT NULL
      `).get(sessionId) || {};
      toolCalls = num(row.calls) ?? 0;
      toolFailures = num(row.failures) ?? 0;
    } catch {
      /* older rows may lack the tool_calls shape */
    }

    let sources = [];
    try {
      sources = this.db.prepare(`
        SELECT ${expr('$.source')} AS source, COUNT(*) AS count
        FROM local_runtime_message_rows
        WHERE session_id = ? AND ${expr('$.source')} IS NOT NULL
        GROUP BY source ORDER BY count DESC
      `).all(sessionId).map((row) => ({ source: row.source, count: row.count }));
    } catch {
      sources = [];
    }

    return {
      events: num(base.events) ?? 0,
      turns: num(base.turns) ?? 0,
      steps: num(base.steps) ?? 0,
      requestMs: num(base.request_ms),
      thinkingMs: base.thinking_events ? num(base.thinking_ms) : null,
      thinkingEvents: num(base.thinking_events) ?? 0,
      inputTokens: num(base.input_tokens) ?? 0,
      outputTokens: num(base.output_tokens) ?? 0,
      cacheReadTokens: num(base.cache_read) ?? 0,
      totalTokens: num(base.total_tokens) ?? 0,
      contextWindowTokens: num(base.context_window),
      toolCalls,
      toolFailures,
      sources,
    };
  }

  #toolTaskAggregate(sessionId) {
    if (!this.db || !tableExists(this.db, 'local_runtime_background_tasks')) {
      return { totalMs: null, taskCount: 0, subagentCount: 0 };
    }
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) AS task_count,
          SUM(CASE WHEN kind = 'subagent' THEN 1 ELSE 0 END) AS subagent_count,
          SUM(MAX(0, COALESCE(ended_at_ms, updated_at_ms) - created_at_ms)) AS total_ms
        FROM local_runtime_background_tasks
        WHERE owner_session_id = ?
      `).get(sessionId) || {};
      return {
        totalMs: num(row.total_ms),
        taskCount: num(row.task_count) ?? 0,
        subagentCount: num(row.subagent_count) ?? 0,
      };
    } catch {
      return { totalMs: null, taskCount: 0, subagentCount: 0 };
    }
  }

  #compactionAggregate(sessionId) {
    try {
      const row = this.db.prepare(`
        SELECT
          SUM(CASE WHEN json_extract(data_json, '$.kind') = 'compaction' THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN json_extract(data_json, '$.kind') = 'compaction_failed' THEN 1 ELSE 0 END) AS failed
        FROM local_runtime_message_rows
        WHERE session_id = ?
      `).get(sessionId) || {};
      return { total: num(row.total) ?? 0, failed: num(row.failed) ?? 0 };
    } catch {
      return { total: 0, failed: 0 };
    }
  }

  #assetAggregate(sessionId) {
    if (!this.db || !tableExists(this.db, 'local_runtime_session_assets')) return { total: 0 };
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS total FROM local_runtime_session_assets WHERE session_id = ?',
      ).get(sessionId) || {};
      return { total: num(row.total) ?? 0 };
    } catch {
      return { total: 0 };
    }
  }

  /** Background tasks owned by a session, including sub-agent dispatches. */
  listBackgroundTasks(sessionId, { limit = 200, kind } = {}) {
    if (!this.db || !tableExists(this.db, 'local_runtime_background_tasks')) return [];
    const expr = (jsonPath) => `json_extract(record_json, '${jsonPath}')`;
    const where = ['owner_session_id = ?'];
    const params = [sessionId];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    params.push(Math.max(1, Math.min(2000, limit)));
    let rows = [];
    try {
      rows = this.db.prepare(`
        SELECT
          task_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms,
          MAX(0, COALESCE(ended_at_ms, updated_at_ms) - created_at_ms) AS duration_ms,
          ${expr('$.description')} AS description,
          ${expr('$.toolCallId')} AS tool_call_id,
          ${expr('$.metadata.agentName')} AS agent_name,
          ${expr('$.metadata.childSessionId')} AS child_session_id,
          ${expr('$.metadata.parentTurnId')} AS parent_turn_id,
          ${expr('$.metadata.command')} AS command,
          ${expr('$.metadata.executionMode')} AS execution_mode,
          ${expr('$.startedAt')} AS started_at_ms,
          ${expr('$.outputRef.uri')} AS output_uri
        FROM local_runtime_background_tasks
        WHERE ${where.join(' AND ')}
        ORDER BY created_at_ms DESC
        LIMIT ?
      `).all(...params);
    } catch {
      return [];
    }

    return rows.map((row) => ({
      taskId: row.task_id,
      kind: row.kind,
      status: row.status,
      description: row.description ?? row.command ?? null,
      command: row.command ?? null,
      toolCallId: row.tool_call_id ?? null,
      agentName: row.agent_name ?? null,
      childSessionId: row.child_session_id ?? null,
      parentTurnId: row.parent_turn_id ?? null,
      executionMode: row.execution_mode ?? null,
      createdAtMs: num(row.created_at_ms),
      startedAtMs: num(row.started_at_ms),
      endedAtMs: num(row.ended_at_ms),
      updatedAtMs: num(row.updated_at_ms),
      durationMs: num(row.duration_ms),
      // The absolute log path never leaves the process; consumers ask for the tail instead.
      hasOutput: Boolean(row.output_uri),
    }));
  }

  /** Whether a sub-agent child session exists and is reachable for drill-down. */
  listChildSessions(parentSessionId, { limit = 100 } = {}) {
    if (!this.db || !this.has('sessions', 'parent_session_id')) return [];
    try {
      return this.db.prepare(`
        SELECT * FROM local_runtime_sessions
        WHERE parent_session_id = ?
        ORDER BY created_at_ms DESC
        LIMIT ?
      `).all(parentSessionId, Math.max(1, Math.min(500, limit))).map((row) => this.#sessionSummary(row));
    } catch {
      return [];
    }
  }

  /**
   * Read the tail of a background task's captured output.
   *
   * The path is rebuilt from the data directory and the task ID rather than taken
   * from the stored URI, the ID is validated against a strict shape, and symlinked
   * targets are refused, so a crafted task row cannot turn this into a file read.
   */
  async readTaskOutput(taskId, { maxBytes = 16 * 1024 } = {}) {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
      throw new Error('invalid_task_id');
    }
    const root = path.join(this.dataDir, 'background-tasks');
    const file = path.join(root, taskId, 'output.log');
    if (!file.startsWith(root + path.sep)) throw new Error('invalid_task_id');

    let info;
    try {
      info = await lstat(file);
    } catch {
      return { taskId, available: false, bytes: 0, truncated: false, text: '' };
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      return { taskId, available: false, bytes: 0, truncated: false, text: '' };
    }

    const limit = Math.max(256, Math.min(256 * 1024, maxBytes));
    const start = Math.max(0, info.size - limit);
    const handle = await open(file, 'r');
    try {
      const length = info.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const text = buffer.toString('utf8');
      return {
        taskId,
        available: true,
        bytes: info.size,
        truncated: start > 0,
        text: start > 0 ? `… [tail of ${info.size} bytes]\n${text}` : text,
      };
    } finally {
      await handle.close();
    }
  }

  /* -------------------------------------------------------------- events -- */

  /**
   * Read trajectory records in stable insert order, grouped by turn.
   * `detailLevel` gates whether content is returned at all: `summary` never
   * returns message text, tool arguments or tool results.
   */
  /**
   * Index background tasks by the tool call that spawned them, so a tool call and
   * its measured duration live on one row instead of two separate views.
   */
  #taskIndex(sessionId) {
    const index = new Map();
    for (const task of this.listBackgroundTasks(sessionId, { limit: 2000 })) {
      if (task.toolCallId) index.set(task.toolCallId, task);
      else index.set(`__task__${task.taskId}`, task);
    }
    return index;
  }

  getEvents({ sessionId, offset = 0, limit = 200, detailLevel = 'summary', turnId, withTasks = true } = {}) {
    if (!this.db) return { events: [], total: 0, nextOffset: null, source: 'unavailable' };
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const safeOffset = Math.max(0, offset);

    const where = ['session_id = ?'];
    const params = [sessionId];
    if (turnId) {
      where.push("json_extract(data_json, '$.turn_id') = ?");
      params.push(turnId);
    }

    let total = 0;
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM local_runtime_message_rows WHERE ${where.join(' AND ')}`,
      ).get(...params);
      total = num(row?.n) ?? 0;
    } catch {
      total = 0;
    }

    let rows = [];
    try {
      rows = this.db.prepare(`
        SELECT id, role, created_at_ms, turn_id, source, data_json
        FROM local_runtime_message_rows
        WHERE ${where.join(' AND ')}
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `).all(...params, safeLimit, safeOffset);
    } catch (error) {
      this.warnings.push(`event_read_failed:${error.message}`);
      return { events: [], total: 0, nextOffset: null, source: 'error' };
    }

    const taskByCall = withTasks ? this.#taskIndex(sessionId) : new Map();
    const events = rows.map((row, index) => this.#projectEvent(row, safeOffset + index, detailLevel, taskByCall));
    const consumed = safeOffset + rows.length;
    return {
      events,
      total,
      nextOffset: consumed < total ? consumed : null,
      source: 'sqlite',
    };
  }

  #projectEvent(row, index, detailLevel, taskByCall = new Map()) {
    const data = parseJson(row.data_json) || {};
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
    const contextUsage = data.context_usage && typeof data.context_usage === 'object' ? data.context_usage : null;
    const toolCalls = Array.isArray(data.tool_calls) ? data.tool_calls : null;
    const source = data.source ?? row.source ?? null;
    const origin = data.sourceContext?.origin && typeof data.sourceContext.origin === 'object'
      ? data.sourceContext.origin
      : null;

    const event = {
      index,
      rowId: row.id,
      msgId: data.msg_id ?? null,
      turnId: data.turn_id ?? row.turn_id ?? data.turnId ?? null,
      role: data.role ?? row.role ?? null,
      source,
      msgType: num(data.msg_type),
      kind: data.kind ?? null,
      finishReason: data.finish_reason ?? null,
      createdAtMs: num(row.created_at_ms) ?? num(data.timestamp),
      thinkingDurationMs: num(data.thinking_duration_ms),
      requestDurationMs: usage ? num(usage.request_duration_ms) : null,
      // Only an inbound record has an input doorway. Distinguishes a person's own
      // words from context the harness injected (a goal objective, a task result).
      inputKind: (data.role ?? row.role) === 'user' ? classifyInput(source, origin?.type) : null,
      originType: origin?.type ?? null,
      goalId: origin?.goalId ?? null,
      usage: usage ? {
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read),
        totalTokens: num(usage.total_tokens),
        contextWindowTokens: num(usage.context_window),
      } : null,
      contextUsage: contextUsage ? {
        usedTokens: num(contextUsage.usedTokens),
        contextWindowTokens: num(contextUsage.contextWindowTokens),
        totalCountSource: contextUsage.totalCountSource ?? null,
        components: Array.isArray(contextUsage.components) ? contextUsage.components : null,
      } : null,
      toolCallCount: toolCalls ? toolCalls.length : 0,
      failureCount: toolCalls
        ? toolCalls.filter((call) => num(call?.tool_call_status) !== null && num(call?.tool_call_status) !== 2).length
        : 0,
      hasThinking: typeof data.thinking_content === 'string' && data.thinking_content.length > 0,
      contentLength: typeof data.msg_content === 'string' ? data.msg_content.length : 0,
    };

    event.toolCalls = toolCalls
      ? toolCalls.map((call) => {
          const status = num(call?.tool_call_status);
          const task = call?.tool_call_id ? taskByCall.get(call.tool_call_id) ?? null : null;
          const projected = {
            name: call?.tool_name ?? null,
            id: call?.tool_call_id ?? null,
            status,
            ok: status === 2,
            // The measured wall-clock for this call, when the runtime recorded it
            // as a background task. Never estimated from record spacing.
            durationMs: task?.durationMs ?? null,
            taskId: task?.taskId ?? null,
            taskStatus: task?.status ?? null,
            agentName: task?.agentName ?? null,
            childSessionId: task?.childSessionId ?? null,
            hasOutput: task?.hasOutput ?? false,
          };
          if (detailLevel === 'full') {
            projected.args = call?.tool_call_args ?? null;
            projected.result = call?.tool_call_result_data ?? null;
            projected.description = task?.description ?? null;
          }
          return projected;
        })
      : null;

    if (detailLevel === 'full') {
      event.content = typeof data.msg_content === 'string' ? data.msg_content : null;
      event.thinking = typeof data.thinking_content === 'string' ? data.thinking_content : null;
      if (data.metadata && typeof data.metadata === 'object') event.metadata = data.metadata;
    }

    return event;
  }

  /* -------------------------------------------------------------- search -- */

  searchSessions({ query, limit = 20 } = {}) {
    if (!this.db || !this.hasFts || !query) return [];
    const encoded = encodeFtsQuery(query);
    if (!encoded) return [];
    try {
      return this.db.prepare(`
        SELECT s.* FROM local_runtime_sessions_fts f
        JOIN local_runtime_sessions s ON s.session_id = f.session_id
        WHERE local_runtime_sessions_fts MATCH ?
        ORDER BY s.updated_at_ms DESC
        LIMIT ?
      `).all(encoded, Math.max(1, Math.min(200, limit))).map((row) => this.#sessionSummary(row));
    } catch (error) {
      this.warnings.push(`search_failed:${error.message}`);
      return [];
    }
  }

  /* ------------------------------------------------------ jsonl fallback -- */

  async findSessionDir(sessionId) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
    const root = sessionsRoot(this.dataDir);
    let years;
    try {
      years = await readdir(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const year of years.filter((entry) => entry.isDirectory())) {
      const yearPath = path.join(root, year.name);
      for (const month of await safeReadDir(yearPath)) {
        const monthPath = path.join(yearPath, month.name);
        for (const day of await safeReadDir(monthPath)) {
          const dayPath = path.join(monthPath, day.name);
          for (const session of await safeReadDir(dayPath)) {
            if (!session.name.endsWith(sessionId)) continue;
            const dir = path.join(dayPath, session.name);
            if (!dir.startsWith(root + path.sep)) continue;
            return dir;
          }
        }
      }
    }
    return null;
  }

  /** Fold a `messages.jsonl` artifact into the same event shape as SQLite. */
  async readJsonlEvents({ sessionId, limit = 1000, detailLevel = 'summary' } = {}) {
    const dir = await this.findSessionDir(sessionId);
    if (!dir) return { events: [], source: 'unavailable' };
    const file = path.join(dir, 'messages.jsonl');
    try {
      const info = await stat(file);
      if (!info.isFile() || info.isSymbolicLink()) return { events: [], source: 'unavailable' };
    } catch {
      return { events: [], source: 'unavailable' };
    }

    const events = [];
    let turnCursor = null;
    let index = 0;
    const stream = createReadStream(file, { encoding: 'utf8' });
    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim() || Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) continue;
        if (events.length >= limit) continue;
        const record = parseJson(line);
        if (!record) continue;
        const message = record.message && typeof record.message === 'object' ? record.message : {};
        const parts = Array.isArray(message.content) ? message.content : [];
        const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('');
        const thinking = parts.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join('');
        const toolUses = parts.filter((part) => part?.type === 'toolCall');
        const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
        if (record.turn_id) turnCursor = record.turn_id;
        const event = {
          index: index++,
          source: 'jsonl',
          msgId: record.message_id ?? null,
          turnId: record.turn_id ?? turnCursor,
          role: message.role ?? null,
          sourceKind: null,
          kind: null,
          finishReason: message.stopReason ?? null,
          createdAtMs: num(message.timestamp),
          thinkingDurationMs: null,
          requestDurationMs: null,
          inputKind: message.role === 'user' ? 'human' : 'unknown',
          originType: null,
          goalId: null,
          usage: usage ? {
            inputTokens: num(usage.input),
            outputTokens: num(usage.output),
            cacheReadTokens: num(usage.cacheRead),
            totalTokens: num(usage.totalTokens),
            contextWindowTokens: null,
          } : null,
          contextUsage: null,
          toolCallCount: toolUses.length || (message.toolName ? 1 : 0),
          failureCount: message.isError ? 1 : 0,
          hasThinking: thinking.length > 0,
          contentLength: text.length,
          model: message.model ?? null,
        };
        const callNames = toolUses.length
          ? toolUses.map((call) => ({ name: call.name ?? null, id: call.id ?? null }))
          : (message.toolName ? [{ name: message.toolName, id: message.toolCallId ?? null }] : []);
        event.toolCalls = callNames.length
          ? callNames.map((call, position) => {
              const projected = {
                ...call,
                status: message.isError && position === 0 ? 3 : (message.toolName ? 2 : null),
                ok: !(message.isError && position === 0),
                durationMs: null,
                taskId: null,
                taskStatus: null,
                agentName: null,
                childSessionId: null,
                hasOutput: false,
              };
              if (detailLevel === 'full') {
                projected.args = toolUses[position]?.arguments ?? null;
                projected.result = position === 0 && message.content ? message.content : null;
                projected.description = null;
              }
              return projected;
            })
          : null;
        if (detailLevel === 'full') {
          event.content = text || null;
          event.thinking = thinking || null;
        }
        events.push(event);
      }
    }
    return { events, source: 'jsonl' };
  }
}

async function safeReadDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ open -- */

/**
 * Open the SQLite projection read-only. Failure is not fatal: the Store degrades
 * to the JSONL fallback so a schema change in a future runtime cannot break the
 * Plugin outright.
 */
export function openStore({ dataDir, warnings = [] } = {}) {
  const dir = dataDir || resolveDataDir();
  const file = sqlitePath(dir);
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT 1 AS ok FROM local_runtime_sessions LIMIT 1').get();
  } catch (error) {
    warnings.push(`sqlite_unavailable:${error.message}`);
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
  const store = new Store({ dataDir: dir, db, warnings });
  store.warnings = warnings;
  return store;
}

export async function readManifest(sessionDir) {
  try {
    return parseJson(await readFile(path.join(sessionDir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}
