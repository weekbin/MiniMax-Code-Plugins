/**
 * Background tasks: the runtime's record of tool and sub-agent work.
 *
 * A task row carries `created_at_ms`/`ended_at_ms`, which is where a tool call's
 * *measured* wall-clock comes from — the Plugin never estimates a duration from
 * record spacing. Tasks are indexed by the tool call that spawned them so a tool
 * call and its duration live on one row.
 */

import path from 'node:path';
import { lstat, open } from 'node:fs/promises';

import { num } from './json.mjs';
import { tableExists } from './sqlite.mjs';
import { LIMITS, clamp, backgroundTasksRoot } from './config.mjs';

/** Background tasks owned by a session, including sub-agent dispatches. */
export function listBackgroundTasks(store, sessionId, { limit = LIMITS.tasks.default, kind } = {}) {
  if (!store.db || !tableExists(store.db, 'local_runtime_background_tasks')) return [];
  const expr = (jsonPath) => `json_extract(record_json, '${jsonPath}')`;
  const where = ['owner_session_id = ?'];
  const params = [sessionId];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  params.push(clamp(limit, LIMITS.tasks));
  let rows = [];
  try {
    rows = store.db.prepare(`
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

/**
 * Index background tasks by the tool call that spawned them, so a tool call and
 * its measured duration live on one row instead of two separate views.
 */
export function taskIndex(store, sessionId) {
  const index = new Map();
  for (const task of listBackgroundTasks(store, sessionId, { limit: LIMITS.tasks.max })) {
    if (task.toolCallId) index.set(task.toolCallId, task);
    else index.set(`__task__${task.taskId}`, task);
  }
  return index;
}

/**
 * Read the tail of a background task's captured output.
 *
 * The path is rebuilt from the data directory and the task ID rather than taken
 * from the stored URI, the ID is validated against a strict shape, and symlinked
 * targets are refused, so a crafted task row cannot turn this into a file read.
 */
export async function readTaskOutput(store, taskId, { maxBytes = LIMITS.taskOutputBytes.default } = {}) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    throw new Error('invalid_task_id');
  }
  const root = backgroundTasksRoot(store.dataDir);
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

  const limit = clamp(maxBytes, LIMITS.taskOutputBytes);
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
