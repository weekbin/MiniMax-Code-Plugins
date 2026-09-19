/**
 * Trajectory Studio client — entry point.
 *
 * Information architecture — each surface owns one question and does not repeat
 * another surface's answer:
 *
 *   Agent 与能力  what was this session configured with (model, tools, skills, prompt)
 *   统计条        what are the session totals (turns, wall-clock, tokens, failures)
 *   时间轴        where in time did things happen (navigation and zoom only)
 *   轨迹流        what happened, one scannable line per message and per tool call
 *   检查器        the full detail of exactly one selected row
 *
 * The timeline draws measured tool spans; the stream carries the same tasks joined
 * by tool call ID. Neither repeats the other's text.
 *
 * This file only boots. The surfaces live in `./js/`:
 *
 *   state / api / format / icons / results / storage / theme / banner   foundations
 *   sidebar / capability / stats / timeline / stream / inspector        surfaces
 *   flow / wire                                                         orchestration
 */

import { state, el } from './js/state.js';
import { api } from './js/api.js';
import { banner } from './js/banner.js';
import { applyTheme, readTheme } from './js/theme.js';
import { hydrateSidebarState } from './js/storage.js';
import { wire } from './js/wire.js';
import { loadAgents, loadSessions, selectSession } from './js/flow.js';

async function boot() {
  applyTheme(readTheme());
  hydrateSidebarState();
  wire();
  el('inspector').setAttribute('data-open', 'false');
  document.body.dataset.inspector = 'false';
  try {
    const meta = await api('/api/meta');
    el('source-line').textContent = meta.sqliteAvailable
      ? `只读 SQLite · FTS ${meta.ftsAvailable ? '可用' : '不可用'}`
      : 'SQLite 不可用 · 回退 JSONL';
    if (!meta.sqliteAvailable) banner('SQLite 投影不可读，已回退到 messages.jsonl，计时字段会缺失。');
    for (const warning of meta.warnings ?? []) banner(warning);
    await loadAgents();
    await loadSessions();
    const first = state.sessionId ?? state.sessions[0]?.sessionId;
    if (first) await selectSession(first);
    document.body.dataset.state = 'ready';
  } catch (error) {
    document.body.dataset.state = 'error';
    banner(`初始化失败：${error.message}`);
  }
}

boot();
