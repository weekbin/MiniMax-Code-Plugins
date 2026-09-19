/**
 * Configuration: where the data lives, and every bound the rest of the server
 * enforces. Leaf module — imports nothing, so anything may import it.
 */

import path from 'node:path';

/** Resolve the runtime data directory, in the order the runtime itself uses. */
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

export function backgroundTasksRoot(dataDir) {
  return path.join(dataDir, 'background-tasks');
}

/** Folding limits. */
export const LIMITS = Object.freeze({
  sessions: { min: 1, max: 500, default: 20 },
  events: { min: 1, max: 1000, default: 200 },
  tasks: { min: 1, max: 2000, default: 200 },
  search: { min: 1, max: 200, default: 20 },
  timeline: 6000,
  taskOutputBytes: { min: 256, max: 256 * 1024, default: 16 * 1024 },
  jsonlLineBytes: 2 * 1024 * 1024,
});

/** Per-session folded totals kept warm; browsing revisits sessions constantly. */
export const CACHE_ENTRIES = 96;

/** Records fetched per MCP page and per web request. */
export const DETAIL_LEVELS = Object.freeze(['summary', 'full']);

/** `tool_call_status` 2 is the runtime's success code. */
export const TOOL_STATUS_OK = 2;

/** Input provenance, used to separate a person's words from injected context. */
export const INPUT_KINDS = Object.freeze(['human', 'injected', 'unknown']);

export function clamp(value, { min, max, default: fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
