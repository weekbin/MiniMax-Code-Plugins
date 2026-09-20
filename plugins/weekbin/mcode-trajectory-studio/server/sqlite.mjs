/**
 * The SQLite projection driver.
 *
 * Opening the runtime database read-only, and probing which optional tables and
 * columns this particular runtime build actually has. Every table and column here
 * is an internal implementation detail, so nothing is assumed: each probe degrades
 * to "absent" rather than throwing.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { sqliteCandidates } from './config.mjs';

/**
 * Find the runtime projection on this machine.
 *
 * The canonical location is tried first. A hit on any other candidate means this
 * build lays its data out differently, which the caller surfaces as a warning
 * rather than letting it pass silently — a quiet fallback is how a stale or wrong
 * database would go unnoticed.
 *
 * @returns {{file: string, discovered: boolean, found: boolean}}
 */
export function resolveSqliteFile(dataDir) {
  const candidates = sqliteCandidates(dataDir);
  for (const [index, file] of candidates.entries()) {
    if (existsSync(file)) return { file, discovered: index > 0, found: true };
  }
  return { file: candidates[0], discovered: false, found: false };
}

/** Columns present on a table, or an empty set when the table is absent. */
export function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

/** Whether a table or view exists, without throwing on a locked or odd schema. */
export function tableExists(db, table) {
  try {
    return Boolean(db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    ).get(table));
  } catch {
    return false;
  }
}

/**
 * Open the projection strictly read-only and confirm the one table the Plugin
 * cannot work without.
 *
 * Failure is not fatal: a missing table or an unreadable file returns null with a
 * reason, so the caller degrades to the JSONL fallback instead of crashing.
 *
 * @returns {{db: object|null, error: string|null}}
 */
export function openReadOnlyProjection(file) {
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT 1 AS ok FROM local_runtime_sessions LIMIT 1').get();
    return { db, error: null };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return { db: null, error: error instanceof Error ? error.message : String(error) };
  }
}
