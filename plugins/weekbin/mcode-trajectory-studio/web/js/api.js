/**
 * The one way this page talks to its own server: a same-origin JSON fetch that
 * carries the custom request header every API route requires.
 */

import { API_HEADER } from './state.js';

export async function api(pathname) {
  const response = await fetch(pathname, { headers: API_HEADER, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}
