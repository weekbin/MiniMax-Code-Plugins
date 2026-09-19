/**
 * Local Trajectory Studio web panel.
 *
 * Bound to 127.0.0.1 only. Requests are fenced by an authority check, an origin
 * check, and a required custom header on every API call, so a page loaded from
 * anywhere else cannot read local session data. Static assets are served with a
 * deny-by-default CSP and no remote origins are reachable from the page.
 */

import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { redactEvent, redactPath, redactText } from './redact.mjs';

const WEB_ROOT = new URL('../web/', import.meta.url);
const CLIENT_HEADER = 'x-trajectory-client';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Fixed entry points. Everything else is refused. */
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
]);

/**
 * The client is split into ES modules under `/js/`. Serve them by a narrow name
 * pattern rather than by enumerating files, so adding a module needs no change
 * here, while anything outside the pattern stays denied by default.
 */
const CLIENT_MODULE = /^\/js\/[a-z0-9-]+\.js$/;

function resolveStatic(pathname) {
  const mapped = STATIC_FILES.get(pathname);
  if (mapped) return mapped;
  if (CLIENT_MODULE.test(pathname)) return pathname.slice(1);
  return null;
}

const MAX_BODY_BYTES = 64 * 1024;

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
}

/* ----------------------------------------------------------------- studio -- */

export function createStudio({ store, homeDir, pluginDataDir = null }) {
  let server = null;
  let port = null;
  let focusSessionId = null;

  async function start({ sessionId, port: requested } = {}) {
    if (sessionId) focusSessionId = sessionId;
    if (server && port) {
      return { url: `http://127.0.0.1:${port}/`, port, reused: true, sessionId: focusSessionId };
    }

    const handler = createRequestHandler({ store, homeDir, getFocus: () => focusSessionId, setFocus: (id) => { focusSessionId = id; } });
    server = http.createServer((req, res) => {
      handler(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
        }
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    server.keepAliveTimeout = 5000;

    const preferred = Number.isInteger(requested) ? requested : (await readPersistedPort(pluginDataDir));
    const bound = await listenOnFreePort(server, preferred);
    if (Number.isInteger(preferred) && preferred >= 1024 && bound !== preferred) {
      // Silently moving to another port hides the real problem: something else is
      // already serving the requested one, so the old panel keeps answering and the
      // reader is looking at stale code.
      process.stderr.write(
        `[trajectory-studio] port ${preferred} is in use; listening on ${bound} instead. ` +
        `Another instance is still serving ${preferred}.\n`);
    }
    port = bound;
    await persistPort(pluginDataDir, port);
    return { url: `http://127.0.0.1:${port}/`, port, reused: false, sessionId: focusSessionId };
  }

  async function stop() {
    if (!server) return false;
    const closing = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closing;
    server = null;
    port = null;
    return true;
  }

  return {
    start,
    stop,
    get status() {
      return { running: Boolean(server), port, sessionId: focusSessionId };
    },
  };
}

function listenOnFreePort(server, preferred) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    const target = Number.isInteger(preferred) && preferred >= 1024 && preferred <= 65535 ? preferred : 0;
    server.listen(target, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

function portFile(pluginDataDir) {
  return path.join(pluginDataDir, 'studio-port.json');
}

async function readPersistedPort(pluginDataDir) {
  if (!pluginDataDir) return null;
  try {
    const value = JSON.parse(await readFile(portFile(pluginDataDir), 'utf8'));
    return Number.isInteger(value?.port) ? value.port : null;
  } catch {
    return null;
  }
}

async function persistPort(pluginDataDir, port) {
  if (!pluginDataDir) return;
  try {
    await mkdir(pluginDataDir, { recursive: true });
    await writeFile(portFile(pluginDataDir), JSON.stringify({ port }), 'utf8');
  } catch {
    /* the panel still works without a persisted port */
  }
}

/* ---------------------------------------------------------------- request -- */

export function createRequestHandler({ store, homeDir, getFocus, setFocus }) {
  const json = (res, value, status = 200) => {
    res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify(value));
  };
  const fail = (res, status, message) => json(res, { error: message }, status);

  return async function handle(req, res) {
    const host = req.headers.host;
    const authority = `127.0.0.1:${req.socket.localPort}`;
    if (host !== authority && host !== `localhost:${req.socket.localPort}`) {
      return fail(res, 403, 'forbidden_host');
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${authority}` && origin !== `http://localhost:${req.socket.localPort}`) {
      return fail(res, 403, 'forbidden_origin');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed');

    const url = new URL(req.url, `http://${authority}`);

    if (url.pathname.startsWith('/api/')) {
      // A custom header cannot be set cross-origin without a CORS preflight, which
      // this server never approves.
      if (req.headers[CLIENT_HEADER] !== '1') return fail(res, 403, 'missing_client_header');
      if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return fail(res, 403, 'cross_site');
      try {
        const payload = await api(store, homeDir, url, { getFocus, setFocus });
        return json(res, payload ?? { ok: true });
      } catch (error) {
        return fail(res, 400, error instanceof Error ? error.message : String(error));
      }
    }

    const file = resolveStatic(url.pathname);
    if (!file) return fail(res, 404, 'not_found');
    try {
      const body = await readFile(new URL(file, WEB_ROOT));
      res.writeHead(200, securityHeaders({ 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' }));
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return fail(res, 500, 'static_unavailable');
    }
  };
}

/* -------------------------------------------------------------------- api -- */

async function api(store, homeDir, url, { getFocus, setFocus }) {
  const route = url.pathname;

  if (route === '/api/meta') {
    return {
      dataDir: store.dataDir,
      sqliteAvailable: Boolean(store.db),
      ftsAvailable: store.hasFts,
      readOnly: true,
      boundTo: '127.0.0.1',
      focusSessionId: getFocus() ?? null,
      warnings: store.warnings,
    };
  }

  if (route === '/api/sessions') {
    // A single-session lookup lets the sidebar force-include the session on screen
    // even when a limit or filter would have excluded it, so the highlight can never
    // disagree with the detail pane.
    const only = url.searchParams.get('id');
    const raw = only
      ? [store.getSession(only)].filter(Boolean)
      : store.listSessions({
          limit: Number(url.searchParams.get('limit')) || 50,
          agent: url.searchParams.get('agent') || undefined,
          kind: url.searchParams.get('kind') || undefined,
          includeArchived: url.searchParams.get('includeArchived') === '1',
        });
    const sessions = (await store.annotateWorkspaces(raw))
      .map((session) => ({ ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) }));
    return { sessions };
  }

  if (route === '/api/agents') {
    // Agents differ per machine — sub-agent names come from whatever presets that
    // install has — so the filter's options are read from the data, not hard-coded.
    return { agents: store.listAgents() };
  }

  if (route === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const raw = store.searchSessions({ query, limit: Number(url.searchParams.get('limit')) || 50 });
    const sessions = (await store.annotateWorkspaces(raw))
      .map((session) => ({ ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) }));
    return { query, sessions };
  }

  if (route === '/api/overview') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) {
      const [latest] = store.listSessions({ limit: 1 });
      if (!latest) return { session: null, stats: null, events: [], tasks: [] };
      return overview(store, homeDir, latest.sessionId);
    }
    setFocus?.(sessionId);
    return overview(store, homeDir, sessionId);
  }

  if (route === '/api/timeline') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) throw new Error('session_required');
    return { sessionId, points: store.getTimeline(sessionId) };
  }

  if (route === '/api/task-output') {
    const taskId = url.searchParams.get('taskId');
    if (!taskId) throw new Error('taskId_required');
    const maxBytes = Math.min(262144, Math.max(256, Number(url.searchParams.get('maxBytes')) || 16384));
    const output = await store.readTaskOutput(taskId, { maxBytes });
    return { ...output, text: redactText(output.text, { maxLength: 262144 }) };
  }

  if (route === '/api/events') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) throw new Error('session_required');
    const detailLevel = url.searchParams.get('detailLevel') === 'full' ? 'full' : 'summary';
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const turnId = url.searchParams.get('turnId') || undefined;
    let page = store.getEvents({ sessionId, offset, limit, detailLevel, turnId });
    if (page.events.length === 0 && page.source !== 'sqlite') {
      page = await store.readJsonlEvents({ sessionId, limit, detailLevel });
      page = { ...page, total: page.events.length, nextOffset: null };
    }
    const events = detailLevel === 'full'
      ? page.events.map((event) => redactEvent(event, { maxLength: 20000 }))
      : page.events;
    return {
      sessionId,
      detailLevel,
      source: page.source,
      offset,
      total: page.total,
      nextOffset: page.nextOffset,
      events,
    };
  }

  throw new Error(`unknown_route:${route}`);
}

function overview(store, homeDir, sessionId) {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`session_not_found:${sessionId}`);
  const stats = store.getStats(sessionId);
  const tasks = store.listBackgroundTasks(sessionId, { limit: 500 });
  const agent = store.getAgentDefinition(sessionId);
  // No events here on purpose: the client asks /api/events for the page it will
  // actually render. Fetching them here only to discard them was the single
  // largest waste in a session switch.
  return {
    session: { ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir }) },
    stats,
    turns: store.getTurnSummaries(sessionId),
    agent: agent
      ? { ...agent, systemPrompt: agent.systemPrompt ? redactText(agent.systemPrompt, { maxLength: 20000 }) : null }
      : null,
    tasks,
  };
}

export const STUDIO_STATIC_FILES = [...STATIC_FILES.keys()];
export const webRootPath = fileURLToPath(WEB_ROOT);
