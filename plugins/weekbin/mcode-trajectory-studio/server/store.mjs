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
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

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
  getSession(sessionId) {
    if (!this.db) return null;
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
  listBackgroundTasks(sessionId, { limit = 100 } = {}) {
    if (!this.db || !tableExists(this.db, 'local_runtime_background_tasks')) return [];
    try {
      return this.db.prepare(`
        SELECT task_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms,
               MAX(0, COALESCE(ended_at_ms, updated_at_ms) - created_at_ms) AS duration_ms
        FROM local_runtime_background_tasks
        WHERE owner_session_id = ?
        ORDER BY created_at_ms DESC
        LIMIT ?
      `).all(sessionId, Math.max(1, Math.min(1000, limit)));
    } catch {
      return [];
    }
  }

  /* -------------------------------------------------------------- events -- */

  /**
   * Read trajectory records in stable insert order, grouped by turn.
   * `detailLevel` gates whether content is returned at all: `summary` never
   * returns message text, tool arguments or tool results.
   */
  getEvents({ sessionId, offset = 0, limit = 200, detailLevel = 'summary', turnId } = {}) {
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

    const events = rows.map((row, index) => this.#projectEvent(row, safeOffset + index, detailLevel));
    const consumed = safeOffset + rows.length;
    return {
      events,
      total,
      nextOffset: consumed < total ? consumed : null,
      source: 'sqlite',
    };
  }

  #projectEvent(row, index, detailLevel) {
    const data = parseJson(row.data_json) || {};
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
    const contextUsage = data.context_usage && typeof data.context_usage === 'object' ? data.context_usage : null;
    const toolCalls = Array.isArray(data.tool_calls) ? data.tool_calls : null;

    const event = {
      index,
      rowId: row.id,
      msgId: data.msg_id ?? null,
      turnId: data.turn_id ?? row.turn_id ?? data.turnId ?? null,
      role: data.role ?? row.role ?? null,
      source: data.source ?? row.source ?? null,
      msgType: num(data.msg_type),
      kind: data.kind ?? null,
      finishReason: data.finish_reason ?? null,
      createdAtMs: num(row.created_at_ms) ?? num(data.timestamp),
      thinkingDurationMs: num(data.thinking_duration_ms),
      requestDurationMs: usage ? num(usage.request_duration_ms) : null,
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
      hasThinking: typeof data.thinking_content === 'string' && data.thinking_content.length > 0,
      contentLength: typeof data.msg_content === 'string' ? data.msg_content.length : 0,
    };

    if (detailLevel === 'full') {
      event.content = typeof data.msg_content === 'string' ? data.msg_content : null;
      event.thinking = typeof data.thinking_content === 'string' ? data.thinking_content : null;
      event.toolCalls = toolCalls
        ? toolCalls.map((call) => ({
            name: call?.tool_name ?? null,
            id: call?.tool_call_id ?? null,
            status: num(call?.tool_call_status),
            args: call?.tool_call_args ?? null,
            result: call?.tool_call_result_data ?? null,
          }))
        : null;
      if (data.metadata && typeof data.metadata === 'object') event.metadata = data.metadata;
    } else {
      event.toolCalls = toolCalls
        ? toolCalls.map((call) => ({
            name: call?.tool_name ?? null,
            id: call?.tool_call_id ?? null,
            status: num(call?.tool_call_status),
          }))
        : null;
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
          usage: usage ? {
            inputTokens: num(usage.input),
            outputTokens: num(usage.output),
            cacheReadTokens: num(usage.cacheRead),
            totalTokens: num(usage.totalTokens),
            contextWindowTokens: null,
          } : null,
          contextUsage: null,
          toolCallCount: toolUses.length,
          hasThinking: thinking.length > 0,
          contentLength: text.length,
          model: message.model ?? null,
        };
        if (detailLevel === 'full') {
          event.content = text || null;
          event.thinking = thinking || null;
          event.toolCalls = toolUses.length
            ? toolUses.map((call) => ({ name: call.name ?? null, id: call.id ?? null, status: null, args: call.arguments ?? null }))
            : (message.toolName
              ? [{ name: message.toolName, id: message.toolCallId ?? null, status: message.isError ? 3 : 2, args: null }]
              : null);
        } else {
          event.toolCalls = toolUses.length
            ? toolUses.map((call) => ({ name: call.name ?? null, id: call.id ?? null, status: null }))
            : (message.toolName ? [{ name: message.toolName, id: message.toolCallId ?? null, status: message.isError ? 3 : 2 }] : null);
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
