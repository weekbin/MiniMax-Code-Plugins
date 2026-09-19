/**
 * Filesystem helpers. Leaf module.
 */

import { readdir } from 'node:fs/promises';

/** readdir that yields an empty list for a missing or unreadable directory. */
export async function safeReadDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
