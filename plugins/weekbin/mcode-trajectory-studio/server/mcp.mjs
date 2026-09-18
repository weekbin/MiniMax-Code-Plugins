/**
 * MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Implemented against the protocol directly so the Plugin stays dependency-free:
 * no node_modules is shipped and nothing needs a build step.
 */

import { createInterface } from 'node:readline';

import { redactEvent, redactPath, redactText } from './redact.mjs';
import { SESSION_KINDS } from './store.mjs';

export const SERVER_NAME = 'mcode-trajectory-studio';
export const SERVER_VERSION = '0.1.0';

const DETAIL_LEVELS = ['summary', 'full'];

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

export const TOOLS = [
  {
    name: 'trajectory_list',
    description:
      'List recent local MiniMax Code sessions from the runtime SQLite projection, with non-content metadata only (no message text). Use this first to find a session ID, then call trajectory_summary or trajectory_get.',
    inputSchema: obj({
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
      agent: str('Filter by agent name, for example "mavis", "explore", "worker", "verifier".'),
      kind: str('Filter by session kind.', { enum: SESSION_KINDS }),
      sinceMs: int('Only sessions updated at or after this epoch-millisecond timestamp.', { minimum: 0 }),
      includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
    }),
  },
  {
    name: 'trajectory_summary',
    description:
      'Return per-session trajectory statistics for one MiniMax Code session: turns, steps, LLM/tool/decode wall-clock milliseconds, token totals, tool-call and failure counts, compactions, sub-agent tasks, assets, and the trigger-source breakdown. Equivalent to the dsh sessionStats projection. Omit sessionId to use the most recently updated session.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
    }),
  },
  {
    name: 'trajectory_get',
    description:
      'Return a page of trajectory records for one session, in insert order. Summary mode returns timing, token usage, roles, turn IDs and tool-call names only. Full mode additionally returns message text, thinking, tool arguments and tool results, redacted and length-bounded; request it only after explicit user consent.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      offset: int('Zero-based record offset.', { minimum: 0, default: 0 }),
      limit: int('Maximum records to return.', { minimum: 1, maximum: 1000, default: 200 }),
      turnId: str('Restrict to one turn ID.'),
      detailLevel: str('Use summary by default.', { enum: DETAIL_LEVELS, default: 'summary' }),
    }),
  },
  {
    name: 'trajectory_search',
    description:
      'Full-text search across local session titles, agent names, statuses and workspace paths using the runtime FTS5 index.',
    inputSchema: obj({
      query: str('Search text. Multi-character queries are matched as a phrase.', { minLength: 1, maxLength: 200 }),
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
    }, ['query']),
  },
  {
    name: 'trajectory_tasks',
    description:
      'List the background tasks and sub-agent dispatches owned by one session, with status, wall-clock duration, the command or objective, the sub-agent name, and the child session ID when a sub-agent ran. This is the nested-tool view for a trajectory.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      limit: int('Maximum tasks to return.', { minimum: 1, maximum: 2000, default: 200 }),
      kind: str('Restrict to one task kind, for example "bash" or "subagent".'),
    }),
  },
  {
    name: 'trajectory_task_output',
    description:
      'Read the tail of the captured output for one background task, bounded to the last 16 KiB by default. Use it to explain why a task failed without opening the session directory by hand.',
    inputSchema: obj({
      taskId: str('Exact task ID, as returned by trajectory_tasks.', { minLength: 1 }),
      maxBytes: int('Maximum bytes of trailing output to return.', { minimum: 256, maximum: 262144, default: 16384 }),
    }, ['taskId']),
  },
  {
    name: 'trajectory_studio',
    description:
      'Start (or reuse) the local Trajectory Studio web panel bound to 127.0.0.1 and return its URL. Open that URL with the host built-in browser. The server is read-only, independent of the chat session, and never leaves the machine.',
    inputSchema: obj({
      sessionId: str('Session to focus when the panel opens.'),
      port: int('Preferred TCP port. Omit to reuse the last port or pick a free one.', { minimum: 1024, maximum: 65535 }),
      stop: { type: 'boolean', description: 'Stop the running panel instead of starting it. Default false.' },
    }),
  },
];

export function createHandler({ store, studio, homeDir }) {
  const warnings = [];
  return { call: (name, args) => callTool({ store, studio, homeDir, warnings }, name, args), warnings };
}

async function resolveSessionId(store, sessionId) {
  if (sessionId) return sessionId;
  const [latest] = store.listSessions({ limit: 1 });
  return latest?.sessionId ?? null;
}

async function callTool(ctx, name, args = {}) {
  const { store, studio, homeDir, warnings } = ctx;
  const detailLevel = DETAIL_LEVELS.includes(args.detailLevel) ? args.detailLevel : 'summary';
  const options = { maxLength: 4000 };

  switch (name) {
    case 'trajectory_list': {
      const sessions = store.listSessions({
        limit: args.limit ?? 20,
        agent: args.agent,
        kind: args.kind,
        sinceMs: args.sinceMs,
        includeArchived: Boolean(args.includeArchived),
      }).map((session) => ({
        ...session,
        workspaceDir: redactPath(session.workspaceDir, { homeDir }),
      }));
      return {
        dataDir: store.dataDir,
        sqlite: Boolean(store.db),
        returned: sessions.length,
        sessions,
        warnings: [...store.warnings, ...warnings],
      };
    }

    case 'trajectory_summary': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      const stats = store.getStats(sessionId);
      if (!stats) throw new Error(`session_not_found:${sessionId}`);
      return { ...stats, workspaceDir: redactPath(stats.workspaceDir, { homeDir }) };
    }

    case 'trajectory_get': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      let page = store.getEvents({
        sessionId,
        offset: args.offset ?? 0,
        limit: args.limit ?? 200,
        turnId: args.turnId,
        detailLevel,
      });
      if (page.events.length === 0 && page.source !== 'sqlite') {
        page = await store.readJsonlEvents({ sessionId, detailLevel });
        page = { ...page, total: page.events.length, nextOffset: null };
      }
      const events = detailLevel === 'full'
        ? page.events.map((event) => redactEvent(event, options))
        : page.events;
      return {
        sessionId,
        detailLevel,
        source: page.source,
        offset: args.offset ?? 0,
        returned: events.length,
        total: page.total,
        nextOffset: page.nextOffset,
        events,
      };
    }

    case 'trajectory_search': {
      const sessions = store.searchSessions({ query: args.query, limit: args.limit ?? 20 })
        .map((session) => ({ ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) }));
      return { query: args.query, returned: sessions.length, sessions };
    }

    case 'trajectory_tasks': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      const tasks = store.listBackgroundTasks(sessionId, { limit: args.limit ?? 200, kind: args.kind });
      return {
        sessionId,
        returned: tasks.length,
        totalMs: tasks.reduce((sum, task) => sum + (task.durationMs ?? 0), 0),
        failed: tasks.filter((task) => task.status === 'failed').length,
        subagents: tasks.filter((task) => task.kind === 'subagent').length,
        tasks,
      };
    }

    case 'trajectory_task_output': {
      const output = await store.readTaskOutput(args.taskId, { maxBytes: args.maxBytes ?? 16384 });
      return { ...output, text: redactText(output.text, { maxLength: 64000 }) };
    }

    case 'trajectory_studio': {
      if (!studio) throw new Error('studio_unavailable');
      if (args.stop) return { stopped: await studio.stop() };
      const started = await studio.start({ sessionId: args.sessionId, port: args.port });
      return {
        url: started.url,
        port: started.port,
        reused: started.reused,
        sessionId: started.sessionId ?? null,
        readOnly: true,
        boundTo: '127.0.0.1',
      };
    }

    default:
      throw new Error(`unknown_tool:${String(name)}`);
  }
}

/* ------------------------------------------------------------- transport -- */

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function handleRpcMessage(handler, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Read-only trajectory inspection for local MiniMax Code sessions. Prefer summary detail; request full detail only with explicit user consent.',
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    return handler.call(name, args).then(
      (value) => rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
      }),
      (error) => rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }),
    );
  }
  return rpcError(id, -32601, `Method not found: ${String(method)}`);
}

/** Serve MCP over stdio until stdin closes. */
export async function serveStdio(handler, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // Notifications carry no id and must not be answered.
    if (message.id === undefined) {
      handleRpcMessage(handler, message);
      continue;
    }
    const response = await handleRpcMessage(handler, message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
