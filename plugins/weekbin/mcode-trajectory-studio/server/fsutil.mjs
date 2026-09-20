/**
 * Filesystem helpers. Leaf module over `node:fs` plus the path candidates from
 * `config`, so path layout decisions live in exactly one place.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { sessionsCandidates } from './config.mjs';

/** readdir that yields an empty list for a missing or unreadable directory. */
export async function safeReadDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Find the session-artifact root on this machine.
 *
 * Canonical first; a hit elsewhere means a differently laid-out build, which the
 * caller records rather than hides.
 *
 * @returns {{dir: string, discovered: boolean, found: boolean}}
 */
export function resolveSessionsRoot(dataDir) {
  const candidates = sessionsCandidates(dataDir);
  for (const [index, dir] of candidates.entries()) {
    if (existsSync(dir)) return { dir, discovered: index > 0, found: true };
  }
  return { dir: candidates[0], discovered: false, found: false };
}
