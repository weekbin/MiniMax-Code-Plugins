import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openStore, resolveDataDir, encodeFtsQuery } from '../server/store.mjs';
import { resolveWorkspaceIdentity } from '../server/git.mjs';
import { redactValue, redactText, redactPath } from '../server/redact.mjs';
import { TOOLS, handleRpcMessage } from '../server/mcp.mjs';

/* ------------------------------------------------------------- fixtures -- */

async function makeDataDir({ withSqlite = true, withJsonl = true } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-studio-'));
  const sqliteDir = path.join(dataDir, 'v2', 'sqlite');
  await mkdir(sqliteDir, { recursive: true });

  if (withSqlite) {
    const db = new DatabaseSync(path.join(sqliteDir, 'runtime-state.sqlite'));
    db.exec(`
      CREATE TABLE local_runtime_sessions (
        session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
        agent_name TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
        parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
      );
      CREATE TABLE local_runtime_message_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
        role TEXT, turn_id TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL,
        source TEXT, source_context_json TEXT, UNIQUE(session_id, msg_id)
      );
      CREATE TABLE local_runtime_background_tasks (
        task_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER, record_json TEXT NOT NULL
      );
      CREATE TABLE local_runtime_session_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
        role TEXT, message_created_at_ms INTEGER NOT NULL, asset_index INTEGER NOT NULL,
        asset_key TEXT NOT NULL, source_tag TEXT NOT NULL, path TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE TABLE local_runtime_session_agent_definitions (
        session_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE local_runtime_sessions_fts USING fts5(
        session_id UNINDEXED, session_id_terms, agent_name_terms, title_terms,
        workspace_dir_terms, purpose_terms, status_terms, session_type_terms,
        tokenize = 'unicode61'
      );
    `);

    const session = (id, title, agent, updated, parent = null) => db.prepare(`
      INSERT INTO local_runtime_sessions
        (session_id, record_json, updated_at_ms, agent_name, status, session_kind, title, created_at_ms, parent_session_id, workspace_dir)
      VALUES (?, '{}', ?, ?, 'idle', 'conversation', ?, ?, ?, '/home/tester/ws')
    `).run(id, updated, agent, title, updated - 1000, parent);

    session('sess-a', 'Alpha task', 'mavis', 2000);
    session('sess-b', 'Beta subtask', 'explore', 1500, 'sess-a');
    session('sess-archived', 'Old task', 'mavis', 500);
    db.prepare('UPDATE local_runtime_sessions SET archived = 1 WHERE session_id = ?').run('sess-archived');

    // The FTS columns store `c<hex codepoint>` tokens.
    const encode = (text) => [...text].map((ch) => `c${ch.codePointAt(0).toString(16)}`).join(' ');
    for (const [id, title, agent] of [['sess-a', 'Alpha task', 'mavis'], ['sess-b', 'Beta subtask', 'explore']]) {
      db.prepare(`
        INSERT INTO local_runtime_sessions_fts
          (session_id, session_id_terms, agent_name_terms, title_terms, workspace_dir_terms, purpose_terms, status_terms, session_type_terms)
        VALUES (?, ?, ?, ?, ?, '', 'idle', 'conversation')
      `).run(id, encode(id), encode(agent), encode(title), encode('/home/tester/ws'));
    }

    const row = (sessionId, msgId, role, turnId, createdAtMs, data) => db.prepare(`
      INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, msgId, role, turnId, createdAtMs, JSON.stringify(data), data.source ?? null);

    row('sess-a', 'm1', 'user', 'turn-1', 1000, { msg_id: 'm1', role: 'user', source: 'api', msg_type: 1, msg_content: 'please fix the bug', turn_id: 'turn-1' });
    row('sess-a', 'm2', 'assistant', 'turn-1', 1200, {
      msg_id: 'm2', role: 'assistant', source: 'api', msg_type: 2, msg_content: 'looking at it',
      thinking_content: 'hmm', thinking_duration_ms: 200, finish_reason: 'toolUse',
      turn_id: 'turn-1', turnId: 'turn-1',
      usage: { input_tokens: 100, output_tokens: 50, cache_read: 900, total_tokens: 1050, context_window: 200000, request_duration_ms: 1500 },
      context_usage: { usedTokens: 1000, contextWindowTokens: 200000, totalCountSource: 'LOCAL_ESTIMATE', components: [{ kind: 'TOOLS', tokens: 400 }] },
      tool_calls: [{ tool_name: 'bash', tool_call_id: 'c1', tool_call_status: 2, tool_call_args: '{"command":"ls"}', tool_call_result_data: '{"text":"ok"}' }],
    });
    row('sess-a', 'm3', 'assistant', 'turn-2', 1400, {
      msg_id: 'm3', role: 'assistant', source: 'thread-goal', msg_type: 2, msg_content: 'done',
      turn_id: 'turn-2', turnId: 'turn-2',
      usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, total_tokens: 15, context_window: 200000, request_duration_ms: 500 },
      tool_calls: [{ tool_name: 'edit', tool_call_id: 'c2', tool_call_status: 3, tool_call_args: '{}', tool_call_result_data: '{"error":"boom"}' }],
    });
    row('sess-a', 'm4', 'assistant', 'turn-2', 1500, {
      msg_id: 'm4', role: 'assistant', kind: 'compaction', msg_type: 2,
      turn_id: 'turn-2', turnId: 'turn-2',
      metadata: { compactionId: 'ctx-1', messagesBefore: 40, messagesAfter: 2, tokensBefore: 90000, tokensAfter: 5000 },
    });
    row('sess-a', 'm5', 'user', 'turn-3', 1600, {
      msg_id: 'm5', role: 'user', source: 'thread-goal', msg_type: 1, msg_content: 'injected objective',
      turn_id: 'turn-3', sourceContext: { origin: { type: 'thread-goal-kickoff', goalId: 'tg-1' } },
    });
    row('sess-a', 'm6', 'user', 'turn-4', 1700, {
      msg_id: 'm6', role: 'user', source: 'questionnaire', msg_type: 1, msg_content: 'a person answered',
      turn_id: 'turn-4',
    });

    db.prepare(`
      INSERT INTO local_runtime_session_agent_definitions (session_id, definition_json)
      VALUES ('sess-a', ?)
    `).run(JSON.stringify({
      definitionVersion: 2,
      exactOwnerName: 'worker',
      model: { providerId: 'minimax', modelId: 'MiniMax-M3', variant: 'thinking', contextWindow: 512000, maxOutputTokens: 128000 },
      project: { workspaceDir: '/home/tester/ws' },
      systemPrompt: 'You are a worker.',
      capabilities: { tools: ['read', 'bash'], disallowedTools: [], mcpServers: [], skills: ['a-skill'], extensionSkills: ['ext:b'] },
    }));

    db.prepare(`
      INSERT INTO local_runtime_background_tasks (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
      VALUES ('t1', 'sess-a', 'bash', 'succeeded', 1000, 1300, 1300,
              '{"description":"ls -la","toolCallId":"c1","metadata":{"command":"ls -la","parentTurnId":"turn-1"},"outputRef":{"uri":"/tmp/x.log"}}'),
             ('t2', 'sess-a', 'subagent', 'running', 1400, 1400, NULL,
              '{"description":"Map the call graph","metadata":{"agentName":"explore","childSessionId":"sess-b"}}')
    `).run();
    db.prepare(`
      INSERT INTO local_runtime_session_assets (session_id, msg_id, message_created_at_ms, asset_index, asset_key, source_tag, path, data_json)
      VALUES ('sess-a', 'm2', 1200, 0, 'k', 'media', '/tmp/a.png', '{}')
    `).run();
    db.close();

    const taskDir = path.join(dataDir, 'background-tasks', 't1');
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, 'output.log'), 'line one\nline two\nlisting complete\n', 'utf8');
  }

  if (withJsonl) {
    const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-jsonl');
    await mkdir(dir, { recursive: true });
    const lines = [
      { message_id: 'j1', turn_id: 'turn-j1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 10 } },
      {
        message_id: 'j2',
        turn_id: 'turn-j1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'thinking hard' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
          usage: { input: 5, output: 7, cacheRead: 0, totalTokens: 12 },
          stopReason: 'toolUse',
          timestamp: 20,
          model: 'MiniMax-M3',
        },
      },
    ];
    await writeFile(path.join(dir, 'messages.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  }

  return dataDir;
}

/* ------------------------------------------------------------- data dir -- */

test('resolveDataDir prefers env vars then HOME', () => {
  assert.equal(resolveDataDir({ MINIMAX_DATA_DIR: '/tmp/a' }, '/home/x'), '/tmp/a');
  assert.equal(resolveDataDir({ MAVIS_DATA_DIR: '/tmp/b' }, '/home/x'), '/tmp/b');
  assert.equal(resolveDataDir({}, '/home/x'), path.join('/home/x', '.minimax'));
  assert.throws(() => resolveDataDir({}, ''));
});

test('encodeFtsQuery mirrors the runtime token encoding', () => {
  assert.equal(encodeFtsQuery('mavis'), 'c6d c61 c76 c69 c73');
  assert.equal(encodeFtsQuery('轨迹'), 'c8f68 c8ff9');
  assert.equal(encodeFtsQuery(''), '');
});

/* ---------------------------------------------------------------- store -- */

test('listSessions hides archived rows and reports metadata', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const sessions = store.listSessions({ limit: 10 });
  assert.deepEqual(sessions.map((s) => s.sessionId), ['sess-a', 'sess-b']);
  assert.equal(sessions[0].title, 'Alpha task');
  assert.equal(sessions[0].agent, 'mavis');
  assert.equal(store.listSessions({ limit: 10, includeArchived: true }).length, 3);
  assert.deepEqual(store.listSessions({ limit: 10, agent: 'explore' }).map((s) => s.sessionId), ['sess-b']);
});

test('getStats folds the dsh sessionStats fields', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const stats = store.getStats('sess-a');
  assert.equal(stats.turns, 4, 'four distinct turn IDs');
  assert.equal(stats.steps, 2, 'two records carrying request_duration_ms');
  assert.equal(stats.llmMs, 2000);
  assert.equal(stats.thinkingMs, 200);
  assert.equal(stats.decodeMs, 1800, 'llmMs - thinkingMs');
  assert.equal(stats.decodeTokens, 55);
  assert.equal(stats.inputTokens, 110);
  assert.equal(stats.cacheReadTokens, 900);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.toolFailures, 1, 'status 3 is not a success');
  assert.equal(stats.compactions, 1);
  assert.equal(stats.assets, 1);
  assert.equal(stats.backgroundTasks, 2);
  assert.equal(stats.subagentTasks, 1);
  assert.equal(stats.ttftMs, null, 'ttft is never fabricated');
  assert.equal(stats.ttftAvailable, false);
  assert.equal(stats.children, 1, 'sess-b is a child of sess-a');
  assert.deepEqual(stats.sources.map((s) => s.source).sort(), ['api', 'questionnaire', 'thread-goal']);
});

test('tool wall-clock is summed from background tasks', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const tasks = store.listBackgroundTasks('sess-a');
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((task) => task.taskId === 't1').durationMs, 300);
  assert.equal(store.getStats('sess-a').toolMs, 300, 'running task has no ended_at_ms');
});

test('tasks carry description, agent, child session and output availability', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const tasks = store.listBackgroundTasks('sess-a');
  const bash = tasks.find((task) => task.taskId === 't1');
  assert.equal(bash.description, 'ls -la');
  assert.equal(bash.command, 'ls -la');
  assert.equal(bash.toolCallId, 'c1');
  assert.equal(bash.parentTurnId, 'turn-1');
  assert.equal(bash.hasOutput, true);
  assert.equal(bash.status, 'succeeded');

  const sub = tasks.find((task) => task.taskId === 't2');
  assert.equal(sub.kind, 'subagent');
  assert.equal(sub.agentName, 'explore');
  assert.equal(sub.childSessionId, 'sess-b', 'sub-agent tasks link to their child session');
  assert.equal(sub.hasOutput, false);

  assert.deepEqual(store.listBackgroundTasks('sess-a', { kind: 'subagent' }).map((task) => task.taskId), ['t2']);
});

test('task output is read as a bounded tail and rejects unsafe ids', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const output = await store.readTaskOutput('t1');
  assert.equal(output.available, true);
  assert.match(output.text, /listing complete/);

  const tail = await store.readTaskOutput('t1', { maxBytes: 256 });
  assert.equal(tail.available, true);
  assert.equal(tail.truncated, false, 'file is smaller than the floor of 256 bytes');

  const missing = await store.readTaskOutput('t_missing');
  assert.equal(missing.available, false);
  assert.equal(missing.text, '');

  for (const bad of ['../../etc/passwd', 'a/b', '', 'x'.repeat(200)]) {
    await assert.rejects(() => store.readTaskOutput(bad), /invalid_task_id/);
  }
});

test('child sessions are listed for drill-down', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  assert.deepEqual(store.listChildSessions('sess-a').map((session) => session.sessionId), ['sess-b']);
  assert.deepEqual(store.listChildSessions('sess-b'), []);
});

test('getEvents omits content in summary mode and includes it in full mode', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const summary = store.getEvents({ sessionId: 'sess-a', detailLevel: 'summary' });
  assert.equal(summary.total, 6);
  assert.equal(summary.source, 'sqlite');
  const withTools = summary.events.find((event) => event.toolCallCount > 0);
  assert.equal(withTools.content, undefined, 'summary must not leak text');
  assert.equal(withTools.toolCalls[0].args, undefined, 'summary must not leak tool args');
  assert.equal(withTools.toolCalls[0].result, undefined);
  assert.equal(withTools.toolCalls[0].name, 'bash', 'summary still reports tool names');
  assert.equal(withTools.usage.inputTokens, 100);
  assert.equal(withTools.contextUsage.components[0].kind, 'TOOLS');

  const full = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' });
  const fullEvent = full.events.find((event) => event.msgId === 'm2');
  assert.equal(fullEvent.content, 'looking at it');
  assert.equal(fullEvent.thinking, 'hmm');
  assert.equal(fullEvent.toolCalls[0].args, '{"command":"ls"}');
  assert.equal(fullEvent.toolCalls[0].result, '{"text":"ok"}');
});

test('getEvents paginates and filters by turn', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const first = store.getEvents({ sessionId: 'sess-a', limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.nextOffset, 2);
  const second = store.getEvents({ sessionId: 'sess-a', offset: first.nextOffset, limit: 2 });
  assert.equal(second.events.length, 2);
  assert.equal(second.nextOffset, 4, 'four of six records consumed');
  const third = store.getEvents({ sessionId: 'sess-a', offset: second.nextOffset, limit: 2 });
  assert.equal(third.events.length, 2);
  assert.equal(third.nextOffset, null, 'no more pages');

  const turn2 = store.getEvents({ sessionId: 'sess-a', turnId: 'turn-2' });
  assert.deepEqual(turn2.events.map((event) => event.msgId), ['m3', 'm4']);
});

test('compaction records carry their metadata', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const full = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' });
  const compaction = full.events.find((event) => event.kind === 'compaction');
  assert.equal(compaction.metadata.messagesBefore, 40);
  assert.equal(compaction.metadata.tokensBefore, 90000);
});

test('searchSessions uses the runtime token encoding', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  assert.equal(store.hasFts, true);
  assert.deepEqual(store.searchSessions({ query: 'Alpha' }).map((s) => s.sessionId), ['sess-a']);
  assert.deepEqual(store.searchSessions({ query: 'mavis' }).map((s) => s.sessionId), ['sess-a']);
  assert.deepEqual(store.searchSessions({ query: 'nope-not-here' }), []);
});

test('a missing SQLite projection degrades instead of throwing', async (t) => {
  const dataDir = await makeDataDir({ withSqlite: false });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  assert.equal(store.db, null);
  assert.equal(store.hasFts, false);
  assert.deepEqual(store.listSessions(), []);
  assert.equal(store.getStats('sess-a'), null);
  assert.deepEqual(store.getEvents({ sessionId: 'sess-a' }).events, []);
  assert.deepEqual(store.searchSessions({ query: 'x' }), []);
  assert.ok(store.warnings.some((warning) => warning.startsWith('sqlite_unavailable:')));
});

test('jsonl fallback reads a session the projection does not index', async (t) => {
  const dataDir = await makeDataDir({ withSqlite: true, withJsonl: true });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const dir = await store.findSessionDir('sess-jsonl');
  assert.ok(dir, 'session directory is located by suffix');

  const summary = await store.readJsonlEvents({ sessionId: 'sess-jsonl', detailLevel: 'summary' });
  assert.equal(summary.source, 'jsonl');
  assert.equal(summary.events.length, 2);
  assert.equal(summary.events[1].toolCalls[0].name, 'bash');
  assert.equal(summary.events[1].content, undefined);

  const full = await store.readJsonlEvents({ sessionId: 'sess-jsonl', detailLevel: 'full' });
  assert.equal(full.events[0].content, 'hi');
  assert.equal(full.events[1].thinking, 'thinking hard');
  assert.equal(full.events[1].model, 'MiniMax-M3');
});

test('session directory lookup rejects traversal attempts', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  assert.equal(await store.findSessionDir('../../etc/passwd'), null);
  assert.equal(await store.findSessionDir('a/b'), null);
  assert.equal(await store.findSessionDir(''), null);
});

/* --------------------------------------------------- dimensions & joins -- */

test('human input is distinguished from harness-injected context', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const events = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' }).events;
  const byId = new Map(events.map((event) => [event.msgId, event]));

  assert.equal(byId.get('m1').inputKind, 'human', 'a plain api user message is human');
  assert.equal(byId.get('m5').inputKind, 'injected', 'a goal objective is injected');
  assert.equal(byId.get('m5').originType, 'thread-goal-kickoff');
  assert.equal(byId.get('m5').goalId, 'tg-1');
  assert.equal(byId.get('m6').inputKind, 'human', 'a questionnaire answer is still the person');
  assert.equal(byId.get('m2').inputKind, null, 'an assistant row has no input doorway');
});

test('tool calls are joined to their measured task duration', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const events = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' }).events;
  const call = events.find((event) => event.msgId === 'm2').toolCalls[0];
  assert.equal(call.id, 'c1');
  assert.equal(call.ok, true);
  assert.equal(call.durationMs, 300, 'joined from the background task by tool call id');
  assert.equal(call.taskId, 't1');
  assert.equal(call.taskStatus, 'succeeded');
  assert.equal(call.hasOutput, true);
  assert.equal(call.description, 'ls -la');

  const failing = events.find((event) => event.msgId === 'm3').toolCalls[0];
  assert.equal(failing.ok, false, 'status 3 is a failure');
  assert.equal(failing.durationMs, null, 'no task means no measured duration, never estimated');
  assert.equal(events.find((event) => event.msgId === 'm3').failureCount, 1);
});

test('agent definition exposes model, capabilities and prompt', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const agent = store.getAgentDefinition('sess-a');
  assert.equal(agent.ownerName, 'worker');
  assert.equal(agent.model.modelId, 'MiniMax-M3');
  assert.equal(agent.model.contextWindow, 512000);
  assert.deepEqual(agent.tools, ['read', 'bash']);
  assert.deepEqual(agent.skills, ['a-skill']);
  assert.deepEqual(agent.extensionSkills, ['ext:b']);
  assert.equal(agent.systemPrompt, 'You are a worker.');
  assert.equal(store.getAgentDefinition('sess-b'), null, 'no definition is not an error');
});

test('workspaces group by git repository so worktrees merge', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'trajectory-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  const git = (args, cwd = repo) => new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 15000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
      (error) => resolve(!error));
  });

  const available = await git(['init', '-q', '-b', 'main']);
  if (!available) {
    t.skip('git is not available in this environment');
    return;
  }
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'a.txt'), 'a\n', 'utf8');
  await git(['add', '.']);
  await git(['commit', '-qm', 'init']);

  const worktree = path.join(root, 'wt');
  const madeWorktree = await git(['worktree', 'add', '-q', '-b', 'feature', worktree]);

  const main = await resolveWorkspaceIdentity(repo);
  assert.equal(main.kind, 'git');
  assert.equal(main.label, 'repo');
  assert.equal(main.worktree, false);

  if (madeWorktree) {
    const linked = await resolveWorkspaceIdentity(worktree);
    assert.equal(linked.key, main.key, 'a worktree shares its repository group');
    assert.equal(linked.worktree, true);
    assert.equal(linked.branch, 'feature');
  }

  const outside = path.join(root, 'plain');
  await mkdir(outside, { recursive: true });
  const plain = await resolveWorkspaceIdentity(outside);
  assert.equal(plain.kind, 'path', 'a non-repository directory falls back to path grouping');
  assert.notEqual(plain.key, main.key);

  assert.equal((await resolveWorkspaceIdentity('')).kind, 'path');
});

test('annotateWorkspaces labels every session with its group', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());

  const annotated = await store.annotateWorkspaces(store.listSessions({ limit: 10 }));
  assert.equal(annotated.length, 2);
  for (const session of annotated) {
    assert.ok(session.groupKey, 'every session gets a group key');
    assert.ok(session.groupLabel, 'every session gets a human label');
    assert.ok(['git', 'path'].includes(session.groupKind));
  }
});

/* ------------------------------------------------------------- redaction -- */

test('redactText removes credentials and bounds length', () => {
  assert.match(redactText('api_key=abcdef123456'), /api_key=\[redacted\]/);
  assert.match(redactText('Authorization: Bearer abcdefghijklmnop'), /\[redacted\]/);
  assert.doesNotMatch(redactText('sk-abcdefghijklmnopqrst'), /sk-abcdefghijklmnopqrst/);
  assert.match(redactText('postgres://user:pw@host/db'), /\[redacted\]/);
  const long = redactText('x'.repeat(100), { maxLength: 10 });
  assert.ok(long.startsWith('xxxxxxxxxx'));
  assert.match(long, /truncated 90 chars/);
});

test('redactValue scrubs nested secrets by key name', () => {
  const value = redactValue({ command: 'ls', env: { API_KEY: 'secret', nested: { token: 'abc' } } });
  assert.equal(value.command, 'ls');
  assert.equal(value.env.API_KEY, '[redacted]');
  assert.equal(value.env.nested.token, '[redacted]');
});

test('redactPath collapses the home prefix', () => {
  assert.equal(redactPath('/home/tester/ws/x', { homeDir: '/home/tester' }), '~/ws/x');
  assert.equal(redactPath('/opt/other', { homeDir: '/home/tester' }), '/opt/other');
});

/* ------------------------------------------------------------------- mcp -- */

test('tools are declared with the expected names and bounded schemas', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'trajectory_list', 'trajectory_summary', 'trajectory_get', 'trajectory_search',
    'trajectory_tasks', 'trajectory_task_output', 'trajectory_studio',
  ]);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
  }
});

test('handleRpcMessage answers initialize, tools/list and tool calls', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };
  const handler = { call: (name, args) => callHandlerForTest({ store, studio }, name, args) };

  const init = handleRpcMessage(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'mcode-trajectory-studio');

  const list = handleRpcMessage(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 7);

  const notif = handleRpcMessage(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif, null, 'notifications are not answered');

  const unknown = handleRpcMessage(handler, { jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(unknown.error.code, -32601);

  const summary = await handleRpcMessage(handler, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'trajectory_summary', arguments: { sessionId: 'sess-a' } },
  });
  assert.equal(summary.result.structuredContent.turns, 4);
  assert.equal(summary.result.structuredContent.ttftMs, null);
});

test('full detail over MCP is redacted', async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = openStore({ dataDir });
  t.after(() => store.close());
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };
  const handler = { call: (name, args) => callHandlerForTest({ store, studio }, name, args) };

  const response = await handleRpcMessage(handler, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'trajectory_get', arguments: { sessionId: 'sess-a', detailLevel: 'full' } },
  });
  const events = response.result.structuredContent.events;
  assert.ok(events.every((event) => typeof event.content !== 'string' || !/api[_-]?key\s*[:=]/i.test(event.content)));
  assert.equal(response.result.structuredContent.detailLevel, 'full');
});

/* The MCP module owns tool dispatch; import it through the public handler factory. */
async function callHandlerForTest(ctx, name, args) {
  const { createHandler } = await import('../server/mcp.mjs');
  const handler = createHandler({ store: ctx.store, studio: ctx.studio, homeDir: '/home/tester' });
  return handler.call(name, args);
}
