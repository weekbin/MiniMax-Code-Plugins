import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestHandler } from '../server/http.mjs';

/**
 * The panel's error contract.
 *
 * Two CodeQL findings landed on this surface: a reflected value (the route was
 * interpolated into the error message) and information exposure (an unexpected
 * error's message was sent to the client). Both are now impossible by
 * construction — the client only ever receives a code from a fixed set, and
 * anything unexpected is logged to stderr instead. These tests pin that, because
 * it is the kind of thing that silently comes back.
 */

const CLIENT_HEADER = 'x-trajectory-client';
const PORT = 7399;

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

function makeReq({ method = 'GET', url = '/api/meta', host, headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: host ?? `127.0.0.1:${PORT}`, ...headers },
    socket: { localPort: PORT },
  };
}

function makeStore(overrides = {}) {
  return {
    dataDir: '/tmp/trajectory-studio-test',
    db: {},
    hasFts: false,
    warnings: [],
    listSessions: () => [],
    getSession: () => null,
    listAgents: () => [],
    annotateWorkspaces: (sessions) => sessions,
    searchSessions: () => [],
    getTimeline: () => [],
    getEvents: () => ({ events: [], total: 0, nextOffset: null, source: 'sqlite' }),
    getTurnSummaries: () => [],
    listBackgroundTasks: () => [],
    getStats: () => null,
    getAgentDefinition: () => null,
    readTaskOutput: async () => ({ taskId: 'x', available: false, bytes: 0, truncated: false, text: '' }),
    ...overrides,
  };
}

const handler = (store) => createRequestHandler({
  store,
  homeDir: '/home/tester',
  getFocus: () => null,
  setFocus: () => {},
});

async function request(store, req, { captureStderr = false } = {}) {
  const res = makeRes();
  let stderr = '';
  const original = process.stderr.write;
  if (captureStderr) process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    await handler(store)(req, res);
  } finally {
    process.stderr.write = original;
  }
  return { res, stderr };
}

async function jsonBody(res) {
  return JSON.parse(res.body);
}

test('an unknown API route answers with a fixed code, not the route', async () => {
  const { res } = await request(makeStore(), makeReq({ url: '/api/definitely-not-a-route', headers: { [CLIENT_HEADER]: '1' } }));
  assert.equal(res.status, 404);
  const body = await jsonBody(res);
  assert.equal(body.error, 'unknown_route');
  // The request value must not appear anywhere in the response.
  assert.equal(res.body.includes('definitely-not-a-route'), false, `response reflected the route: ${res.body}`);
});

test('the search endpoint does not echo the query back', async () => {
  const { res } = await request(
    makeStore(),
    makeReq({ url: `/api/search?q=${encodeURIComponent('<script>alert(1)</script>')}`, headers: { [CLIENT_HEADER]: '1' } }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.includes('<script>'), false, `response reflected the query: ${res.body}`);
  assert.deepEqual(await jsonBody(res), { sessions: [] });
});

test('an unexpected error is a generic code, and its detail goes to stderr', async () => {
  const detail = '/api/internal-detail-that-must-not-ship';
  const store = makeStore({ listSessions: () => { throw new Error(detail); } });
  const { res, stderr } = await request(store, makeReq({ url: '/api/sessions', headers: { [CLIENT_HEADER]: '1' } }), { captureStderr: true });
  assert.equal(res.status, 500);
  assert.equal((await jsonBody(res)).error, 'internal_error');
  assert.equal(res.body.includes(detail), false, `response leaked the error message: ${res.body}`);
  assert.equal(res.body.includes('at '), false, 'response must not contain a stack frame');
  assert.ok(stderr.includes(detail), 'the detail must still reach the operator on stderr');
});

test('a missing session is a bad request, not a server fault', async () => {
  const { res } = await request(makeStore(), makeReq({ url: '/api/events', headers: { [CLIENT_HEADER]: '1' } }));
  assert.equal(res.status, 400);
  assert.equal((await jsonBody(res)).error, 'session_required');
});

test('a rejected task id is reported as a bad request', async () => {
  const store = makeStore({ readTaskOutput: async () => { throw new Error('invalid_task_id'); } });
  const { res } = await request(
    store,
    makeReq({ url: '/api/task-output?taskId=..%2Fetc%2Fpasswd', headers: { [CLIENT_HEADER]: '1' } }),
  );
  assert.equal(res.status, 400);
  assert.equal((await jsonBody(res)).error, 'invalid_task_id');
  assert.equal(res.body.includes('passwd'), false, 'response must not reflect the supplied id');
});

test('an unknown session is a not-found, without naming the id', async () => {
  const { res } = await request(
    makeStore(),
    makeReq({ url: '/api/overview?id=mvs_injected-value', headers: { [CLIENT_HEADER]: '1' } }),
  );
  assert.equal(res.status, 404);
  assert.equal((await jsonBody(res)).error, 'session_not_found');
  assert.equal(res.body.includes('mvs_injected-value'), false, 'response must not reflect the supplied id');
});

test('every response carries the hardening headers', async () => {
  const { res } = await request(makeStore(), makeReq({ url: '/api/meta', headers: { [CLIENT_HEADER]: '1' } }));
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /^application\/json/);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(res.headers['Content-Security-Policy'], /default-src 'none'/);
});

test('the request fences still hold', async () => {
  const wrongHost = await request(makeStore(), makeReq({ url: '/api/meta', host: 'evil.example:7399', headers: { [CLIENT_HEADER]: '1' } }));
  assert.equal(wrongHost.res.status, 403);
  assert.equal((await jsonBody(wrongHost.res)).error, 'forbidden_host');

  const wrongOrigin = await request(makeStore(), makeReq({ url: '/api/meta', headers: { origin: 'http://evil.example', [CLIENT_HEADER]: '1' } }));
  assert.equal(wrongOrigin.res.status, 403);
  assert.equal((await jsonBody(wrongOrigin.res)).error, 'forbidden_origin');

  const noHeader = await request(makeStore(), makeReq({ url: '/api/meta' }));
  assert.equal(noHeader.res.status, 403);
  assert.equal((await jsonBody(noHeader.res)).error, 'missing_client_header');

  const crossSite = await request(makeStore(), makeReq({ url: '/api/meta', headers: { 'sec-fetch-site': 'cross-site', [CLIENT_HEADER]: '1' } }));
  assert.equal(crossSite.res.status, 403);
  assert.equal((await jsonBody(crossSite.res)).error, 'cross_site');

  const wrongMethod = await request(makeStore(), makeReq({ method: 'POST', url: '/api/meta', headers: { [CLIENT_HEADER]: '1' } }));
  assert.equal(wrongMethod.res.status, 405);

  const outsideApi = await request(makeStore(), makeReq({ url: '/../package.json' }));
  assert.equal(outsideApi.res.status, 404);
});
