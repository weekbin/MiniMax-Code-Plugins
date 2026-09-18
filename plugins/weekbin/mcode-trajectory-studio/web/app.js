/**
 * Trajectory Studio client.
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
 */

const API_HEADER = { 'x-trajectory-client': '1' };
const MAX_LANE_ROWS = 8;
const LANE_ROW_PX = 17;
/** Stream rows rendered per batch. The rest load as the reader scrolls. */
const STREAM_PAGE = 150;
/** Records fetched per request. Only what will be rendered is fetched. */
const EVENT_PAGE = 200;
const MAX_STREAM_ROWS = 6000;
const MAX_BARS = 320;

const state = {
  sessions: [],
  sessionId: null,
  events: [],
  turns: new Map(),
  tasks: [],
  agent: null,
  detailLevel: 'full',
  agentFilter: '',
  rowFilter: 'all',
  turnQuery: '',
  textQuery: '',
  selected: null,
  search: '',
  axis: null,
  timeline: [],
  view: { start: 0, end: 1 },
  collapsed: readCollapsed(),
  expanded: readExpanded(),
  tab: 'summary',
  // Stream is cached and paged: rows are rebuilt only when the session's events
  // change, and only STREAM_PAGE of them enter the DOM at a time.
  streamRows: [],
  filteredRows: null,
  renderedRows: 0,
  loadingMore: false,
  // Records are paged from the server: nextOffset is null once the session is fully
  // loaded, and eventsTotal is the server's count for the whole session.
  nextOffset: 0,
  eventsTotal: 0,
  loadingEvents: false,
  eventsSource: 'sqlite',
  turnOrder: [],
  theme: 'dark',
};

const el = (id) => document.getElementById(id);

/* ----------------------------------------------------------------- theme -- */

const THEME_KEY = 'trajectory.theme';

function applyTheme(theme) {
  state.theme = theme;
  // "auto" leaves the attribute off so the prefers-color-scheme rules win.
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const button = document.getElementById('theme-toggle');
  if (button) {
    const showing = theme === 'auto' ? 'auto' : theme;
    button.textContent = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐';
    button.title = `当前：${showing === 'auto' ? '跟随系统' : showing === 'light' ? '浅色' : '深色'} · 点击切换`;
  }
}

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  } catch {
    /* storage is optional */
  }
  return 'auto';
}

/** The theme actually on screen, resolving "auto" against the OS preference. */
function effectiveTheme() {
  if (state.theme === 'light' || state.theme === 'dark') return state.theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** One click flips light/dark, starting from whatever is currently showing. */
function toggleTheme() {
  const next = effectiveTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage is optional */
  }
}

/* ------------------------------------------------------------------ fetch */

async function api(pathname) {
  const response = await fetch(pathname, { headers: API_HEADER, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

/* ---------------------------------------------------------------- helpers */

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('trajectory.collapsedGroups') || '[]'));
  } catch {
    return new Set();
  }
}

function writeCollapsed() {
  try {
    localStorage.setItem('trajectory.collapsedGroups', JSON.stringify([...state.collapsed]));
  } catch {
    /* storage is optional */
  }
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function fmtTokens(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function fmtClock(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function fmtFull(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function fmtAge(ms) {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function shortId(id) {
  return typeof id === 'string' ? id.replace(/^mvs_/, '').slice(0, 10) : '—';
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function oneLine(value, limit = 260) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Pull a readable one-liner out of a tool payload. */
function payloadPreview(args) {
  if (args === null || args === undefined) return '';
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return oneLine(value, 200);
    }
  }
  if (value && typeof value === 'object') {
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'objective', 'description', 'name']) {
      if (typeof value[key] === 'string' && value[key]) return oneLine(value[key], 200);
    }
    const keys = Object.keys(value);
    if (keys.length) return oneLine(`${keys[0]}: ${JSON.stringify(value[keys[0]])}`, 200);
  }
  return oneLine(JSON.stringify(value), 200);
}

/**
 * Flatten a tool result into text plus an honest failure classification.
 *
 * A non-zero exit code is not by itself a problem — `grep` returns 1 for "no
 * matches" — so the reader is shown the raw evidence (exit code, stderr,
 * traceback, the runtime's own is_error flag) instead of a verdict.
 */
function parseResult(result) {
  const empty = { text: '', failed: false, severity: null, signal: null, exitCode: null, isError: false, details: null };
  if (result === null || result === undefined) return empty;

  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      const text = String(result);
      return classifyResult(text, null);
    }
  }
  if (value && typeof value === 'object') {
    const parts = [];
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        if (typeof item?.text === 'string') parts.push(item.text);
      }
    }
    if (typeof value.text === 'string') parts.push(value.text);
    if (typeof value.error === 'string') parts.push(value.error);
    return classifyResult(parts.join('\n'), value.details && typeof value.details === 'object' ? value.details : null);
  }
  return classifyResult(String(value), null);
}

function classifyResult(text, details) {
  const exitCode = Number(text.match(/Command exited with code (-?\d+)/)?.[1] ?? NaN);
  const isError = details?.is_error === true || details?.isError === true;
  const status = typeof details?.status === 'string' ? details.status : null;
  const hasTraceback = /Traceback \(most recent call last\)/.test(text);
  const hasStderr = /\[stderr\]/.test(text);

  let severity = null;
  let signal = null;
  if (hasTraceback) { severity = 'hard'; signal = 'Traceback'; }
  else if (hasStderr) { severity = 'hard'; signal = 'stderr'; }
  else if (isError || status === 'failed') { severity = 'hard'; signal = '运行时报错'; }
  else if (Number.isFinite(exitCode) && exitCode !== 0) {
    // Soft: the command ran and reported a non-zero status. Frequently benign.
    severity = 'exit';
    signal = `退出码 ${exitCode}`;
  }

  return {
    text,
    failed: severity !== null,
    severity,
    signal,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    isError,
    details,
  };
}

/* ---------------------------------------------------------------- icons -- */

const ICONS = {
  folder: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5a1 1 0 0 1 .8.4l.8 1.1h4.7A1.6 1.6 0 0 1 14 6.1v5.3A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4z',
  caretRight: 'M6.5 3.8 10.2 8l-3.7 4.2',
  caretDown: 'M3.8 6.5 8 10.2l4.2-3.7',
};

/** Icons are built once and cloned; rebuilding ~120 SVGs per sidebar render was measurable. */
const ICON_TEMPLATES = new Map();

function icon(name, className = 'ic') {
  const key = `${name}|${className}`;
  let template = ICON_TEMPLATES.get(key);
  if (!template) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name] ?? '');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    template = svg;
    ICON_TEMPLATES.set(key, template);
  }
  return template.cloneNode(true);
}

/* ---------------------------------------------------------------- sidebar */

function visibleSessions() {
  const term = state.search.trim().toLowerCase();
  return state.sessions.filter((session) => {
    if (state.agentFilter && session.agent !== state.agentFilter) return false;
    if (!term) return true;
    return `${session.title ?? ''} ${session.sessionId} ${session.workspaceDir ?? ''} ${session.groupLabel ?? ''}`
      .toLowerCase().includes(term);
  });
}

function readExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem('trajectory.expandedSessions') || '[]'));
  } catch {
    return new Set();
  }
}

function writeExpanded() {
  try {
    localStorage.setItem('trajectory.expandedSessions', JSON.stringify([...state.expanded]));
  } catch {
    /* storage is optional */
  }
}

/** Expand every ancestor of a session so the selected row is actually visible. */
function revealAncestors(sessionId) {
  const byId = new Map(state.sessions.map((session) => [session.sessionId, session]));
  let cursor = byId.get(sessionId);
  let guard = 0;
  while (cursor?.parentSessionId && guard < 64) {
    if (!byId.has(cursor.parentSessionId)) break;
    state.expanded.add(cursor.parentSessionId);
    cursor = byId.get(cursor.parentSessionId);
    guard += 1;
  }
  writeExpanded();
}

function renderSessions() {
  const host = el('session-groups');
  host.textContent = '';
  const rows = visibleSessions();
  if (rows.length === 0) {
    host.append(textNode('p', 'muted small', '  没有匹配的会话'));
    return;
  }

  // Sub-agents are children of the session that dispatched them. Anything whose
  // parent is filtered out (or is not loaded) is promoted to a root so it stays reachable.
  const present = new Set(rows.map((session) => session.sessionId));
  const childrenOf = new Map();
  const roots = [];
  for (const session of rows) {
    const parent = session.parentSessionId;
    if (parent && present.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(session);
    } else {
      roots.push(session);
    }
  }
  for (const list of childrenOf.values()) list.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));

  const groups = new Map();
  for (const session of roots) {
    const key = session.groupKey ?? `path:${session.workspaceDir ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, { key, label: session.groupLabel ?? '(无工作区)', kind: session.groupKind ?? 'path', sessions: [] });
    }
    groups.get(key).sessions.push(session);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => Math.max(...b.sessions.map((s) => s.updatedAtMs ?? 0)) - Math.max(...a.sessions.map((s) => s.updatedAtMs ?? 0)),
  );

  for (const group of ordered) {
    const collapsed = state.collapsed.has(group.key);
    const section = textNode('section', `ws-group${collapsed ? ' is-collapsed' : ''}`);
    const dirs = new Set();
    for (const session of rows) {
      if ((session.groupKey ?? `path:${session.workspaceDir ?? ''}`) === group.key && session.workspaceDir) dirs.add(session.workspaceDir);
    }

    const head = document.createElement('button');
    head.type = 'button';
    head.className = `ws-head ws-${group.kind}`;
    head.title = `${group.label}${dirs.size > 1 ? ` · ${dirs.size} 个工作区` : ''}\n${[...dirs].join('\n')}`;
    head.append(icon(collapsed ? 'caretRight' : 'caretDown', 'ic ws-caret'));
    head.append(icon('folder', 'ic ws-folder'));
    head.append(textNode('span', 'ws-name', group.label));
    head.append(textNode('span', 'ws-count', String(group.sessions.length)));
    head.addEventListener('click', () => {
      if (state.collapsed.has(group.key)) state.collapsed.delete(group.key);
      else state.collapsed.add(group.key);
      writeCollapsed();
      renderSessions();
    });
    section.append(head);

    if (!collapsed) {
      const list = document.createElement('ul');
      list.className = 'ws-sessions';
      const walk = (session, depth) => {
        list.append(renderSessionItem(session, depth, childrenOf));
        if (!state.expanded.has(session.sessionId)) return;
        for (const child of childrenOf.get(session.sessionId) ?? []) walk(child, depth + 1);
      };
      for (const session of group.sessions) walk(session, 0);
      section.append(list);
    }
    host.append(section);
  }
}

/** Keep the highlighted row on screen — a correct highlight you cannot see is no help. */
function scrollSelectedIntoView() {
  const node = el('session-groups').querySelector('.session-item[aria-current="true"]');
  node?.scrollIntoView({ block: 'nearest' });
}

/**
 * One sidebar row.
 *
 * The whole row toggles expansion, not just the caret — a caret-sized target is
 * needlessly fussy. Clicking a collapsed parent selects it and opens it; clicking an
 * already-selected open parent closes it, so the same gesture never hides the row
 * you are reading.
 */
function renderSessionItem(session, depth, childrenOf) {
  const children = childrenOf.get(session.sessionId) ?? [];
  const expanded = state.expanded.has(session.sessionId);
  const isSelected = session.sessionId === state.sessionId;

  const item = document.createElement('button');
  item.type = 'button';
  item.className = `session-item${session.parentSessionId ? ' is-sub' : ''}${children.length ? ' has-children' : ''}`;
  // Indent grows 12px per level and stops growing past level 4, so a deep fan-out
  // does not push titles off the panel.
  item.style.paddingLeft = `${6 + Math.min(depth, 4) * 12}px`;
  item.style.setProperty('--d', String(Math.min(depth, 4)));
  if (isSelected) item.setAttribute('aria-current', 'true');
  item.title = [
    session.title || '(无标题)',
    `${session.agent ?? '?'} · ${session.sessionKind ?? ''}`,
    session.branch ? `分支 ${session.branch}` : null,
    session.workspaceDir,
    session.parentSessionId ? `父会话 ${session.parentSessionId}` : null,
    children.length ? `${children.length} 个子代理` : null,
    `更新于 ${fmtAge(session.updatedAtMs)}`,
    children.length ? '点击行展开 / 收起' : null,
  ].filter(Boolean).join('\n');

  if (children.length) {
    item.append(icon(expanded ? 'caretDown' : 'caretRight', 'ic s-caret'));
  } else {
    item.append(textNode('span', 's-caret-space'));
  }

  if (session.parentSessionId) item.append(textNode('span', 's-sub-dot'));
  item.append(textNode('span', 's-title', session.title || '(无标题)'));
  if (children.length) item.append(textNode('span', 's-child-count', String(children.length)));

  item.addEventListener('click', () => {
    const wasSelected = session.sessionId === state.sessionId;
    if (children.length) {
      if (expanded && wasSelected) {
        state.expanded.delete(session.sessionId);
        writeExpanded();
        renderSessions();
        return;
      }
      if (!expanded) {
        state.expanded.add(session.sessionId);
        writeExpanded();
      }
    }
    selectSession(session.sessionId);
  });

  const li = document.createElement('li');
  li.append(item);
  return li;
}

/* ------------------------------------------------------------- capability */

function renderCapability(agent) {
  const wrap = el('capability');
  const body = el('cap-body');
  body.textContent = '';
  state.agent = agent;

  if (!agent) {
    el('cap-summary').textContent = '该会话未记录 Agent 定义';
    body.append(textNode('p', 'muted small',
      '运行时只为预设或子代理会话写入 Agent 定义（模型、工具白名单、技能、系统提示）。本会话没有这条记录。'));
    return;
  }

  const model = agent.model ?? {};
  el('cap-summary').textContent =
    `${agent.ownerName ?? '—'} · ${model.modelId ?? '—'} · 工具 ${agent.tools.length} · 技能 ${agent.skills.length + agent.extensionSkills.length}`;

  const grid = textNode('div', 'cap-grid');
  const group = (title, rows) => {
    const card = textNode('div', 'cap-card');
    card.append(textNode('h4', '', title));
    const dt = document.createElement('dl');
    dt.className = 'kv';
    for (const [key, value] of rows) {
      if (value === null || value === undefined || value === '') continue;
      dt.append(textNode('dt', '', key));
      dt.append(textNode('dd', '', String(value)));
    }
    card.append(dt);
    return card;
  };

  grid.append(group('模型', [
    ['provider', model.providerId],
    ['model', model.modelId],
    ['variant', model.variant],
    ['上下文窗口', model.contextWindow ? fmtTokens(model.contextWindow) : null],
    ['最大输出', model.maxOutputTokens ? fmtTokens(model.maxOutputTokens) : null],
    ['参数快照', model.parameterSnapshot ? JSON.stringify(model.parameterSnapshot) : null],
  ]));

  grid.append(group('能力', [
    ['工具白名单', agent.tools.join(', ') || '（无）'],
    ['禁用工具', agent.disallowedTools.join(', ')],
    ['MCP 服务', agent.mcpServers.join(', ')],
    ['定义版本', agent.definitionVersion],
  ]));
  body.append(grid);

  if (agent.skills.length || agent.extensionSkills.length) {
    const card = textNode('div', 'cap-card cap-wide');
    card.append(textNode('h4', '', `技能 (${agent.skills.length} 内置 / ${agent.extensionSkills.length} 扩展)`));
    const list = textNode('div', 'cap-chips');
    for (const skill of agent.skills) list.append(textNode('span', 'tool-tag', skill));
    for (const skill of agent.extensionSkills) list.append(textNode('span', 'tool-tag is-ext', skill));
    card.append(list);
    body.append(card);
  }

  if (agent.systemPrompt) {
    const card = textNode('div', 'cap-card cap-wide');
    card.append(textNode('h4', '', '系统提示'));
    card.append(textNode('pre', 'block', agent.systemPrompt));
    body.append(card);
  }
}

/* ------------------------------------------------------------------ stats */

function renderStats(stats) {
  const host = el('stats');
  host.textContent = '';
  if (!stats) return;
  const cards = [
    ['轮次', stats.turns, '', false],
    ['步骤', stats.steps, '', false],
    ['LLM 耗时', fmtMs(stats.llmMs), 'request_duration_ms 之和', false],
    ['工具耗时', fmtMs(stats.toolMs), `${stats.backgroundTasks} 个已记录任务`, false],
    ['解码耗时', fmtMs(stats.decodeMs), '近似：LLM − 思考', false],
    ['TTFT', '不可用', '运行时不落盘', true],
    ['思考耗时', fmtMs(stats.thinkingMs), `${stats.thinkingEvents} 条含思考`, false],
    ['输出 token', fmtTokens(stats.decodeTokens), '', false],
    ['输入 token', fmtTokens(stats.inputTokens), '', false],
    ['缓存读取', fmtTokens(stats.cacheReadTokens), '', false],
    ['工具调用', stats.toolCalls, stats.toolFailures ? `${stats.toolFailures} 次失败` : '无失败', false],
    ['压缩', stats.compactions, stats.compactionFailures ? `${stats.compactionFailures} 次失败` : '', false],
    ['子代理', stats.subagentTasks, '', false],
    ['记录数', stats.events, '', false],
  ];
  for (const [key, value, sub, isNa] of cards) {
    const card = textNode('div', `stat${isNa ? ' is-na' : ''}`);
    card.append(textNode('div', 'k', key));
    card.append(textNode('div', 'v', String(value)));
    if (sub) card.append(textNode('div', 's', sub));
    host.append(card);
  }

  const sources = (stats.sources || []).map((entry) => `${entry.source}:${entry.count}`).join('  ');
  el('session-meta').textContent =
    `${shortId(stats.sessionId)} · ${stats.agent ?? '?'} · ${stats.sessionKind} · 来源 ${sources || '—'} · ` +
    `${stats.workspaceDir ?? ''}${stats.children ? ` · ${stats.children} 个子会话` : ''}`;
  el('session-title').textContent = stats.title || '(无标题)';

  const jump = el('failure-jump');
  if (stats.toolFailures > 0) {
    jump.hidden = false;
    jump.textContent = `⚠ ${stats.toolFailures} 处失败（定位）`;
  } else {
    jump.hidden = true;
  }
}

/* -------------------------------------------------------------- timeline -- */

/**
 * The axis is built from the compact timeline projection, not from the paged stream
 * records, so the overview always covers the whole session.
 */
function buildAxis(points, tasks) {
  const timed = points.filter((point) => Number.isFinite(point.at));
  if (timed.length === 0) return null;

  const inputItems = [];
  const modelItems = [];
  const toolItems = [];

  for (const point of timed) {
    if (point.role === 'user') {
      inputItems.push({ start: point.at, end: point.at + 1, point, injected: point.injected });
      continue;
    }
    const duration = point.durationMs;
    if (duration && duration > 0) {
      modelItems.push({
        start: point.at - duration,
        end: point.at,
        duration,
        point,
        thinking: Math.min(point.thinkingMs ?? 0, duration),
      });
    }
  }

  for (const task of tasks) {
    if (!Number.isFinite(task.createdAtMs)) continue;
    const end = [task.endedAtMs, task.updatedAtMs, task.createdAtMs].find((value) => Number.isFinite(value)) ?? task.createdAtMs;
    toolItems.push({
      start: task.createdAtMs,
      end: Math.max(end, task.createdAtMs + 1),
      task,
      measured: true,
      failed: task.status === 'failed',
      running: task.status === 'running',
    });
  }

  // Gaps between a finished record and the next model call are time the model was
  // not running. Labelled as derived because only task-backed calls are measured.
  const ordered = [...timed].sort((a, b) => a.at - b.at);
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const gapStart = current.at;
    const gapEnd = next.at - (next.durationMs ?? 0);
    if (gapEnd - gapStart > 250) {
      toolItems.push({ start: gapStart, end: gapEnd, derived: true, measured: false });
    }
  }

  const all = [...inputItems, ...modelItems, ...toolItems];
  const min = Math.min(...all.map((item) => item.start));
  const max = Math.max(...all.map((item) => item.end));
  return { inputItems, modelItems, toolItems, min, max: Math.max(max, min + 1) };
}

function packRows(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const rowEnds = [];
  for (const item of sorted) {
    let row = rowEnds.findIndex((end) => end <= item.start);
    if (row === -1) {
      if (rowEnds.length < MAX_LANE_ROWS) {
        rowEnds.push(item.end);
        row = rowEnds.length - 1;
      } else {
        row = MAX_LANE_ROWS - 1;
        rowEnds[row] = Math.max(rowEnds[row], item.end);
      }
    } else {
      rowEnds[row] = item.end;
    }
    item.row = row;
  }
  return Math.max(1, rowEnds.length);
}

function renderOverview(points, tasks) {
  state.timeline = points ?? [];
  state.axis = buildAxis(state.timeline, tasks);
  state.view = { start: 0, end: 1 };
  drawOverview();
}

function drawOverview() {
  const host = el('overview');
  host.textContent = '';
  const axis = state.axis;
  if (!axis) {
    host.append(textNode('p', 'muted small', '没有可用的时间戳。'));
    el('overview-hint').textContent = '';
    return;
  }

  const { min, max } = axis;
  const total = max - min;
  const view = state.view;
  const viewStart = min + total * view.start;
  const viewEnd = min + total * view.end;
  const viewSpan = Math.max(1, viewEnd - viewStart);
  const pctOf = (value) => ((value - viewStart) / viewSpan) * 100;
  const inView = (item) => item.end >= viewStart && item.start <= viewEnd;

  const rulerRow = textNode('div', 'ov-row-grid ov-ruler-row');
  rulerRow.append(textNode('div', 'ov-lane-label', ''));
  const ruler = textNode('div', 'ov-ruler');
  for (let index = 0; index <= 6; index += 1) {
    const tick = textNode('div', 'ov-tick', fmtClock(viewStart + (viewSpan * index) / 6));
    tick.style.left = `${(index / 6) * 100}%`;
    ruler.append(tick);
  }
  rulerRow.append(ruler);
  host.append(rulerRow);

  const lanes = [
    { key: 'input', label: 'INPUT', items: axis.inputItems, className: (item) => `ov-input${item.injected ? ' is-injected' : ''}` },
    { key: 'model', label: 'MODEL', items: axis.modelItems, className: () => 'ov-model' },
    { key: 'tool', label: 'TOOLS', items: axis.toolItems, className: (item) => `ov-tool${item.derived ? ' is-derived' : ''}${item.failed ? ' is-err' : ''}${item.running ? ' is-running' : ''}` },
  ];

  for (const lane of lanes) {
    const visible = lane.items.filter(inView);
    const rowCount = packRows(visible);
    const grid = textNode('div', 'ov-row-grid ov-lane');
    grid.dataset.lane = lane.key;
    grid.append(textNode('div', 'ov-lane-label', lane.label));

    const track = textNode('div', 'ov-lane-track');
    track.style.height = `${rowCount * LANE_ROW_PX}px`;

    for (const item of visible) {
      const start = Math.max(item.start, viewStart);
      const end = Math.min(item.end, viewEnd);
      const block = textNode('div', `ov-block ${lane.className(item)}`);
      block.style.left = `${pctOf(start)}%`;
      block.style.width = `${Math.max(0, pctOf(end) - pctOf(start))}%`;
      block.style.top = `${item.row * LANE_ROW_PX}px`;

      if (lane.key === 'model' && item.duration) {
        if (item.thinking > 0) {
          const segment = textNode('i', 'ov-seg think');
          segment.style.width = `${(item.thinking / item.duration) * 100}%`;
          block.append(segment);
        }
        const output = item.duration - item.thinking;
        if (output > 0) {
          const segment = textNode('i', 'ov-seg out');
          segment.style.width = `${(output / item.duration) * 100}%`;
          block.append(segment);
        }
      }

      block.title = lane.key === 'tool' && item.task
        ? `${item.task.kind} · ${item.task.status} · ${fmtMs(item.end - item.start)}\n${item.task.description ?? ''}\n点击定位到轨迹流`
        : lane.key === 'tool'
          ? `等待 / 工具执行（推导自记录间隔）· ${fmtMs(item.end - item.start)}`
          : lane.key === 'input'
            ? `${item.injected ? '注入上下文' : '人类输入'} · ${fmtClock(item.point.at)}（点击定位到轨迹流）`
            : `MODEL · ${fmtMs(item.duration)}（思考 ${fmtMs(item.thinking)}）· ${fmtClock(item.point.at)}（点击定位到轨迹流）`;

      block.addEventListener('click', (event) => {
        event.stopPropagation();
        if (lane.key === 'tool' && item.task?.toolCallId) locateToolCall(item.task.toolCallId);
        else if (lane.key === 'tool') banner('这是推导出的等待区间，没有对应的单条记录。');
        else locateRow(item.point.rowId);
      });
      track.append(block);
    }
    if (visible.length === 0) track.append(textNode('p', 'ov-empty muted small', '该通道在当前时间窗内无记录'));
    grid.append(track);
    host.append(grid);
  }

  const zoomed = view.end - view.start < 0.999;
  const stacked = axis.toolItems.some((item) => item.row > 0);
  el('overview-hint').textContent =
    `INPUT（人类 ${axis.inputItems.filter((item) => !item.injected).length} / 注入 ${axis.inputItems.filter((item) => item.injected).length}）` +
    ` · MODEL ${axis.modelItems.length}` +
    ` · TOOLS（实测 ${axis.toolItems.filter((item) => item.measured).length} / 推导 ${axis.toolItems.filter((item) => item.derived).length}）` +
    ` · 全跨度 ${fmtMs(total)} · 窗口 ${fmtMs(viewSpan)}` +
    (zoomed ? ' · 已缩放（双击重置）' : ' · 滚轮缩放，拖拽平移') +
    // A lane growing taller is not a second category — it is concurrency, and saying
    // so avoids the obvious misreading.
    (stacked ? ' · 同一通道出现多行表示这些调用在时间上重叠（并行执行），不是分类' : '');
}

function bindTimelineControls() {
  const host = el('overview');
  let drag = null;
  const trackWidth = () => host.querySelector('.ov-lane-track')?.getBoundingClientRect().width ?? 0;

  host.addEventListener('wheel', (event) => {
    if (!state.axis || !event.target.closest('.ov-lane-track')) return;
    event.preventDefault();
    const track = host.querySelector('.ov-lane-track');
    const rect = track.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    const view = state.view;
    const width = Math.min(1, (view.end - view.start) * factor);
    const anchor = view.start + (view.end - view.start) * at;
    let start = anchor - width * at;
    let end = start + width;
    if (start < 0) { start = 0; end = width; }
    if (end > 1) { end = 1; start = Math.max(0, 1 - width); }
    state.view = { start, end };
    drawOverview();
  }, { passive: false });

  host.addEventListener('pointerdown', (event) => {
    if (!state.axis || event.button !== 0) return;
    drag = { x: event.clientX, view: { ...state.view } };
    host.setPointerCapture(event.pointerId);
  });

  host.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const width = drag.view.end - drag.view.start;
    const delta = (event.clientX - drag.x) / Math.max(1, trackWidth());
    const start = Math.min(Math.max(0, drag.view.start - delta * width), 1 - width);
    state.view = { start, end: start + width };
    drawOverview();
  });

  const stopDrag = (event) => {
    if (!drag) return;
    drag = null;
    try { host.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  host.addEventListener('pointerup', stopDrag);
  host.addEventListener('pointercancel', stopDrag);
  host.addEventListener('dblclick', () => {
    if (!state.axis) return;
    state.view = { start: 0, end: 1 };
    drawOverview();
  });
}

/* ----------------------------------------------------------------- stream */

/** Flatten events into scannable rows: one per message, one per tool call. */
function buildStream(events) {
  const rows = [];
  for (const event of events) {
    rows.push({ kind: 'message', event });
    for (const [position, call] of (event.toolCalls ?? []).entries()) {
      rows.push({ kind: 'tool', event, call, position });
    }
  }
  return rows;
}

function toolFailed(call) {
  return call.ok === false || call.taskStatus === 'failed';
}

/** Everything a row can be matched against, as one lowercase string. */
function rowHaystack(row) {
  const parts = row.kind === 'tool'
    ? [row.call.name, row.call.description, row.call.args, row.call.result, row.call.agentName]
    : [row.event.content, row.event.thinking, row.event.originType, row.event.turnId, row.event.source];
  return parts.filter((part) => typeof part === 'string' && part).join(' ').toLowerCase();
}

function rowMatchesFilter(row) {
  switch (state.rowFilter) {
    case 'human': return row.kind === 'message' && row.event.role === 'user' && row.event.inputKind === 'human';
    case 'injected': return row.kind === 'message' && row.event.inputKind === 'injected';
    case 'tools': return row.kind === 'tool';
    case 'failed': return row.kind === 'tool' && toolFailed(row.call);
    default: return true;
  }
}

/** Filter over the cached rows. Rebuilding the DOM is what was slow, not matching. */
function applyFilters() {
  const rows = state.streamRows ?? (state.streamRows = buildStream(state.events));
  const needle = state.textQuery.toLowerCase();
  state.filteredRows = rows.filter((row) => {
    if (!rowMatchesFilter(row)) return false;
    if (state.turnQuery && !String(row.event.turnId ?? '').includes(state.turnQuery)) return false;
    if (needle && !rowHaystack(row).includes(needle)) return false;
    return true;
  });
  state.renderedRows = 0;
  state.lastTurn = undefined;
}

function turnHeader(turnId) {
  const summary = turnId ? state.turns.get(turnId) : null;
  const ordinal = turnId ? state.turnOrder.indexOf(turnId) : -1;
  const head = textNode('div', 'turn-head');
  // Humans count turns; the runtime's turn id is a hash. Lead with the number and
  // keep the id as secondary text rather than the other way round.
  head.append(textNode('span', 'th-ordinal', ordinal >= 0 ? `第 ${ordinal + 1} 轮` : '未分轮'));
  head.append(textNode('span', 'th-id', turnId ? String(turnId) : '(无轮次)'));
  if (summary) head.append(textNode('span', '', `${summary.count} 条`));
  const agg = textNode('div', 'th-agg');
  if (summary) {
    agg.append(textNode('span', '', `LLM ${fmtMs(summary.llmMs)}`));
    agg.append(textNode('span', '', `out ${fmtTokens(summary.outputTokens)} tok`));
  }
  head.append(agg);
  return head;
}

/** Append the next batch of rows. Rows already in the DOM are never rebuilt. */
function appendStreamRows(reset = false) {
  const host = el('stream');
  const rows = state.filteredRows ?? [];
  if (reset) {
    host.textContent = '';
    state.renderedRows = 0;
    state.lastTurn = undefined;
  }
  const total = Math.min(rows.length, MAX_STREAM_ROWS);
  const end = Math.min(total, state.renderedRows + STREAM_PAGE);
  if (state.renderedRows >= end) return false;

  const fragment = document.createDocumentFragment();
  for (let index = state.renderedRows; index < end; index += 1) {
    const row = rows[index];
    const turnId = row.event.turnId ?? null;
    if (turnId !== state.lastTurn) {
      state.lastTurn = turnId;
      fragment.append(turnHeader(turnId));
    }
    fragment.append(row.kind === 'tool' ? renderToolRow(row) : renderMessageRow(row));
  }
  // The sentinel is replaced on every append so it stays last.
  el('stream-more')?.remove();
  host.append(fragment);
  state.renderedRows = end;

  if (end < total) {
    const more = textNode('button', 'stream-more', `加载更多（已显示 ${end} / ${total} 行）`);
    more.id = 'stream-more';
    more.type = 'button';
    more.addEventListener('click', () => appendStreamRows());
    host.append(more);
  } else if (rows.length > MAX_STREAM_ROWS) {
    host.append(textNode('p', 'muted small stream-end',
      `仅渲染前 ${MAX_STREAM_ROWS} 行。请用筛选缩小范围。`));
  } else {
    host.append(textNode('p', 'muted small stream-end', `已显示全部 ${total} 行`));
  }
  return true;
}

function renderStream() {
  applyFilters();
  appendStreamRows(true);
  updateStreamCount();
}

function updateStreamCount() {
  const all = state.streamRows?.length ?? 0;
  const shown = state.filteredRows?.length ?? 0;
  const label = el('record-count');
  if (label) label.textContent = shown === all ? `${all} 行` : `${shown} / ${all} 行`;
}

function markSelected(node, isTool, position) {
  const selected = state.selected;
  if (!selected) return;
  if (node.dataset.eventIndex !== String(selected.eventIndex)) return;
  if (isTool) {
    if (node.dataset.position === String(position)) node.setAttribute('aria-selected', 'true');
    return;
  }
  if (selected.kind === 'message') node.setAttribute('aria-selected', 'true');
}

function renderMessageRow(row) {
  const event = row.event;
  const injected = event.inputKind === 'injected';
  const node = textNode('div', `srow srow-message${injected ? ' is-injected' : ''}${event.role === 'user' ? ' is-user' : ''}`);
  node.dataset.eventIndex = String(event.index);
  node.dataset.rowId = String(event.rowId ?? event.index);
  markSelected(node, false);

  const badge = textNode('div', 'srow-badge');
  if (event.role === 'user') {
    badge.append(textNode('span', `badge ${injected ? 'badge-injected' : 'badge-human'}`, injected ? '注入' : 'INPUT'));
    if (injected && event.originType) badge.append(textNode('span', 'badge-note', oneLine(event.originType, 26)));
  } else {
    badge.append(textNode('span', 'badge badge-assistant', 'ASSISTANT'));
  }
  node.append(badge);

  const body = textNode('div', 'srow-body');
  const text = typeof event.content === 'string' ? event.content.trim() : '';
  const thinking = typeof event.thinking === 'string' ? event.thinking.trim() : '';
  const names = (event.toolCalls ?? []).map((call) => call.name).filter(Boolean);
  if (text) {
    const line = textNode('div', 'srow-text', oneLine(text, 400));
    line.title = text.slice(0, 2000);
    body.append(line);
  } else if (thinking) {
    const line = textNode('div', 'srow-text is-thinking', `[思考] ${oneLine(thinking, 400)}`);
    line.title = thinking.slice(0, 2000);
    body.append(line);
  } else if (names.length) {
    body.append(textNode('div', 'srow-text is-dim', `(仅工具调用: ${names.join(', ')})`));
  } else if (event.kind) {
    body.append(textNode('div', 'srow-text is-dim', event.kind));
  } else {
    body.append(textNode('div', 'srow-text is-dim', '(空记录)'));
  }

  // Marker chips sit inline on the same line rather than in a second row, so every
  // stream row keeps the same one-line rhythm.
  if (event.kind === 'compaction') body.append(textNode('span', 'tool-tag is-compact', '压缩'));
  if (event.kind === 'compaction_failed') body.append(textNode('span', 'tool-tag is-fail', '压缩失败'));
  if (event.hasThinking && text) body.append(textNode('span', 'tool-tag is-think', '思考'));
  node.append(body);

  const meta = textNode('div', 'srow-meta');
  if (event.requestDurationMs) meta.append(textNode('span', '', fmtMs(event.requestDurationMs)));
  if (event.thinkingDurationMs) meta.append(textNode('span', 'is-think', `思${fmtMs(event.thinkingDurationMs)}`));
  if (event.usage?.outputTokens) meta.append(textNode('span', 'is-dim', `${fmtTokens(event.usage.outputTokens)} tok`));
  node.append(meta);

  node.addEventListener('click', () => openInspector({ kind: 'message', eventIndex: event.index }));
  return node;
}

function renderToolRow(row) {
  const { call, event, position } = row;
  const failed = toolFailed(call);
  const parsed = parseResult(call.result);

  const node = textNode('div', `srow srow-tool${failed ? ' is-fail' : ''}${parsed.severity === 'hard' ? ' is-hard' : ''}`);
  node.dataset.eventIndex = String(event.index);
  node.dataset.position = String(position);
  node.dataset.rowId = String(event.rowId ?? event.index);
  node.dataset.toolCallId = call.id ?? '';
  markSelected(node, true, position);

  const badge = textNode('div', 'srow-badge');
  badge.append(textNode('span', 'badge badge-tool', 'TOOL'));
  node.append(badge);

  // Every part is a direct child of the flex body, so the row stays one line and the
  // result text is what absorbs the remaining width.
  const body = textNode('div', 'srow-body');
  body.append(textNode('span', 'tool-name', call.name ?? 'tool'));
  const payload = payloadPreview(call.args) || call.description;
  if (payload) {
    body.append(textNode('span', 'tool-arrow', '▸'));
    const payloadNode = textNode('span', 'tool-payload', oneLine(payload, 150));
    payloadNode.title = typeof call.args === 'string' ? call.args.slice(0, 2000) : '';
    body.append(payloadNode);
  }
  if (parsed.text) {
    body.append(textNode('span', 'tool-arrow', '⇉'));
    const resultNode = textNode('span', `tool-result${parsed.failed ? ' is-fail' : ''}`, oneLine(parsed.text, 200));
    resultNode.title = parsed.text.slice(0, 2000);
    body.append(resultNode);
  }
  if (parsed.signal) {
    body.append(textNode('span', `sig sig-${parsed.severity}`, `⚠ ${parsed.signal}`));
  }
  node.append(body);

  const meta = textNode('div', 'srow-meta');
  meta.append(call.durationMs !== null
    ? textNode('span', '', fmtMs(call.durationMs))
    : textNode('span', 'is-dim', '—'));
  if (call.agentName) meta.append(textNode('span', 'is-sub', `↳ ${call.agentName}`));
  if (call.childSessionId) {
    const drill = document.createElement('button');
    drill.type = 'button';
    drill.className = 'mini-btn';
    drill.textContent = '子会话 ↗';
    drill.title = call.childSessionId;
    drill.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      selectSession(call.childSessionId);
    });
    meta.append(drill);
  }
  node.append(meta);

  node.addEventListener('click', () => openInspector({ kind: 'tool', eventIndex: event.index, position }));
  return node;
}

/* -------------------------------------------------------------- inspector */

function statRow(list, key, value) {
  list.append(textNode('dt', '', key));
  list.append(textNode('dd', '', value === null || value === undefined ? '—' : String(value)));
}

function selectedPayload() {
  const selected = state.selected;
  if (!selected) return null;
  const event = state.events.find((item) => item.index === selected.eventIndex);
  if (!event) return null;
  const call = selected.kind === 'tool' ? event.toolCalls?.[selected.position] ?? null : null;
  return { event, call };
}

function openInspector(selection) {
  state.selected = selection;
  refreshSelectionHighlight();
  el('inspector').setAttribute('data-open', 'true');
  document.body.dataset.inspector = 'true';
  renderInspector();
}

function closeInspector() {
  el('inspector').setAttribute('data-open', 'false');
  document.body.dataset.inspector = 'false';
  state.selected = null;
  refreshSelectionHighlight();
}

/** Toggle the selected styling in place instead of re-rendering the whole stream. */
function refreshSelectionHighlight() {
  for (const node of el('stream').querySelectorAll('.srow[aria-selected]')) node.removeAttribute('aria-selected');
  const selected = state.selected;
  if (!selected) return;
  for (const node of el('stream').querySelectorAll(`[data-event-index="${CSS.escape(String(selected.eventIndex))}"]`)) {
    if (selected.kind === 'tool') {
      if (node.dataset.position === String(selected.position)) node.setAttribute('aria-selected', 'true');
    } else if (node.classList.contains('srow-message')) {
      node.setAttribute('aria-selected', 'true');
    }
  }
}


function renderInspector() {
  const payload = selectedPayload();
  const body = el('ins-body');
  body.textContent = '';
  if (!payload) {
    el('ins-title').textContent = '检查器';
    el('ins-sub').textContent = '';
    body.append(textNode('p', 'muted', '点击轨迹流中的任意一行查看详情。'));
    return;
  }
  const { event, call } = payload;

  el('ins-title').textContent = call ? `工具调用 · ${call.name ?? 'tool'}` : `记录 #${event.index}`;
  el('ins-sub').textContent = `${event.turnId ?? '无轮次'} · ${fmtClock(event.createdAtMs)}`;

  for (const tab of el('ins-tabs').querySelectorAll('.ins-tab')) {
    tab.classList.toggle('is-on', tab.dataset.tab === state.tab);
  }

  if (state.tab === 'summary') renderSummaryTab(body, event, call);
  else if (state.tab === 'payload') renderPayloadAndResultTab(body, event, call);
  else if (state.tab === 'timing') renderTimingTab(body, event, call);
  else renderSchemaTab(body, event, call);
}

function renderSummaryTab(body, event, call) {
  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', '概要'));
  const dt = document.createElement('dl');
  dt.className = 'kv';
  statRow(dt, '层级', call
    ? `${event.role === 'assistant' ? 'Assistant Message' : event.role} › Tool Call ${call.position ?? ''}`
    : event.role);
  statRow(dt, '状态', call
    ? (call.ok === false ? `失败（状态码 ${call.status}）` : call.taskStatus === 'failed' ? '任务失败' : call.ok ? '完成' : '未知')
    : (event.finishReason ?? (event.requestDurationMs ? '完成' : '—')));
  statRow(dt, '输入类型', event.inputKind === 'injected' ? `注入上下文 (${event.originType ?? 'harness'})` :
    event.inputKind === 'human' ? '人类输入' : '—');
  statRow(dt, 'source', event.source);
  statRow(dt, 'turn_id', event.turnId);
  statRow(dt, 'msg_id', event.msgId);
  if (call) {
    statRow(dt, 'call_id', call.id);
    statRow(dt, '任务 ID', call.taskId);
    statRow(dt, '子代理', call.agentName);
    statRow(dt, '子会话', call.childSessionId);
  }
  section.append(dt);
  body.append(section);

  if (event.usage) {
    const usage = textNode('section', 'ins-section');
    usage.append(textNode('h4', '', 'Token 用量'));
    const ud = document.createElement('dl');
    ud.className = 'kv';
    statRow(ud, '输入', event.usage.inputTokens);
    statRow(ud, '输出', event.usage.outputTokens);
    statRow(ud, '缓存读取', event.usage.cacheReadTokens);
    statRow(ud, '总计', event.usage.totalTokens);
    statRow(ud, '上下文窗口', event.usage.contextWindowTokens);
    usage.append(ud);
    body.append(usage);
  }

  if (event.contextUsage?.components) {
    const ctx = textNode('section', 'ins-section');
    ctx.append(textNode('h4', '', `上下文分解 · 已用 ${fmtTokens(event.contextUsage.usedTokens)}` +
      `${event.contextUsage.totalCountSource ? ` (${event.contextUsage.totalCountSource})` : ''}`));
    const cd = document.createElement('dl');
    cd.className = 'kv';
    for (const part of event.contextUsage.components) statRow(cd, part.kind, fmtTokens(part.tokens));
    ctx.append(cd);
    body.append(ctx);
  }

  if (event.metadata) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '压缩元数据'));
    section.append(textNode('pre', 'block', JSON.stringify(event.metadata, null, 2)));
    body.append(section);
  }
}

/**
 * Payload and result in one view.
 *
 * They were separate tabs, which forced a click back and forth to answer the only
 * question that matters — what was sent, and what came back.
 */
function renderPayloadAndResultTab(body, event, call) {
  renderPayloadTab(body, event, call);
  renderResultTab(body, event, call);
}

function renderPayloadTab(body, event, call) {
  if (call) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '工具入参'));
    if (call.args === null || call.args === undefined) {
      section.append(textNode('p', 'muted small', '入参为空。'));
    } else {
      section.append(textNode('pre', 'block', prettyJson(call.args)));
    }
    if (call.description) {
      section.append(textNode('h4', '', '任务描述'));
      section.append(textNode('pre', 'block', call.description));
    }
    body.append(section);
    if (event.thinking) {
      const thinking = textNode('section', 'ins-section');
      thinking.append(textNode('h4', '', '同轮思考'));
      thinking.append(textNode('pre', 'block', event.thinking));
      body.append(thinking);
    }
    return;
  }

  if (event.thinking) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '思考'));
    section.append(textNode('pre', 'block', event.thinking));
    body.append(section);
  }
  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', '正文'));
  section.append(textNode('pre', 'block', event.content || '（无正文）'));
  body.append(section);
}

function renderResultTab(body, event, call) {
  if (!call) {
    body.append(textNode('p', 'muted small', '该记录不是工具调用。选中轨迹流里的 TOOL 行可查看结果。'));
    return;
  }
  const parsed = parseResult(call.result);
  if (!parsed.text && call.ok === false) {
    body.append(textNode('p', 'muted small', '调用标记为失败，但运行时未落盘结果文本。'));
    return;
  }
  if (!parsed.text) {
    body.append(textNode('p', 'muted small', '没有结果文本。'));
    return;
  }

  if (parsed.failed) {
    const alert = textNode('section', `ins-section ins-alert${parsed.severity === 'hard' ? ' is-hard' : ''}`);
    alert.append(textNode('h4', '', `失败证据 · ${parsed.signal}`));
    const evidence = document.createElement('dl');
    evidence.className = 'kv';
    statRow(evidence, '运行时错误标记', parsed.isError ? 'is_error: true' : '—');
    statRow(evidence, '退出码', parsed.exitCode === null ? '未报告' : String(parsed.exitCode));
    statRow(evidence, '调用状态码', call.status);
    statRow(evidence, '判级', parsed.severity === 'hard'
      ? '硬失败（Traceback / stderr / 运行时报错）'
      : '软失败（命令非零退出，常见于 grep 无匹配等，请自行判断）');
    alert.append(evidence);
    alert.append(textNode('pre', 'block', failureExcerpt(parsed.text)));
    body.append(alert);
  }

  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', `完整结果（${parsed.text.length} 字符）`));
  section.append(textNode('pre', 'block', parsed.text));
  body.append(section);

  if (parsed.details) {
    const details = textNode('section', 'ins-section');
    details.append(textNode('h4', '', '附带细节'));
    details.append(textNode('pre', 'block', JSON.stringify(parsed.details, null, 2)));
    body.append(details);
  }
}

/** Show the part of a result that explains the failure, not the head of the log. */
function failureExcerpt(text) {
  const lines = text.split('\n');
  const anchor = lines.findIndex((line) => /Traceback \(most recent call last\)|\[stderr\]|^\s*(Error|Exception):|\bFATAL\b/i.test(line));
  if (anchor === -1) return lines.slice(0, 40).join('\n');
  return lines.slice(Math.max(0, anchor - 2), anchor + 38).join('\n');
}

function renderTimingTab(body, event, call) {
  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', '计时'));
  const dt = document.createElement('dl');
  dt.className = 'kv';
  statRow(dt, '记录时刻', fmtFull(event.createdAtMs));
  statRow(dt, '模型请求耗时', fmtMs(event.requestDurationMs));
  statRow(dt, '思考耗时', fmtMs(event.thinkingDurationMs));
  if (event.requestDurationMs && event.thinkingDurationMs !== null) {
    statRow(dt, '输出耗时(近似)', fmtMs(Math.max(0, event.requestDurationMs - event.thinkingDurationMs)));
  }
  if (call) {
    statRow(dt, '工具耗时(实测)', call.durationMs === null ? '运行时未记录' : fmtMs(call.durationMs));
    statRow(dt, '耗时来源', call.durationMs === null
      ? '该调用不是后台任务，没有独立计时，不做估算'
      : 'local_runtime_background_tasks 的 ended_at_ms − created_at_ms');
  }
  statRow(dt, 'finish_reason', event.finishReason);
  section.append(dt);

  if (event.requestDurationMs) {
    section.append(buildDurationBar(event));
  } else {
    // Say why there is no bar, so an empty area does not read as a broken panel.
    section.append(textNode('p', 'bar-note muted small', call
      ? '这条记录没有模型请求耗时（工具调用本身不产生模型请求），因此没有时长条；工具耗时见上方「工具耗时(实测)」。'
      : '这条记录没有模型请求耗时（运行时未记录 request_duration_ms），因此没有时长条可画。'));
  }
  body.append(section);
}

/**
 * The request-duration bar, with its own legend.
 *
 * Two segments share the axis: thinking, and everything after it. The runtime
 * records the thinking duration but not the first-token instant, so the second
 * segment is derived rather than measured — the legend and the note both say so,
 * and when no thinking duration was recorded the bar is drawn as one honest span
 * instead of inventing a split.
 */
function buildDurationBar(event) {
  const wrap = textNode('div', 'duration-bar');
  const total = event.requestDurationMs;
  const hasThinking = event.thinkingDurationMs !== null && event.thinkingDurationMs !== undefined;
  const recorded = hasThinking ? Math.max(0, event.thinkingDurationMs) : 0;
  const thinking = Math.min(recorded, total);
  const output = Math.max(0, total - thinking);
  // The runtime's two timings disagree on a small share of records: the recorded
  // thinking duration can equal or exceed the whole request. Clamping silently would
  // draw a 0 ms output segment and imply a split that was never measured.
  const overshoot = hasThinking && recorded > total;

  const segments = [];
  if (thinking > 0) segments.push({ cls: 'is-think', ms: thinking, label: '思考段' });
  if (output > 0) segments.push({ cls: 'is-out', ms: output, label: hasThinking ? '输出段' : '全程' });
  if (segments.length === 0) segments.push({ cls: 'is-out is-whole', ms: total, label: '全程' });

  const bar = textNode('div', 'bars');
  for (const segment of segments) {
    const node = textNode('i', `bar-seg ${segment.cls}`);
    node.style.width = `${(segment.ms / total) * 100}%`;
    node.title = `${segment.label} ${fmtMs(segment.ms)}`;
    bar.append(node);
  }
  wrap.append(bar);

  const legend = textNode('div', 'bar-legend');
  for (const segment of segments) {
    const item = textNode('span', 'bar-legend-item');
    item.append(textNode('i', `bar-swatch ${segment.cls.replace(' is-whole', '')}`));
    const approximate = segment.cls.startsWith('is-out') && hasThinking && !overshoot ? '（近似）' : '';
    item.append(textNode('span', '', `${segment.label} ${fmtMs(segment.ms)}${approximate}`));
    legend.append(item);
  }
  legend.append(textNode('span', 'bar-legend-total', `合计 ${fmtMs(total)}`));
  wrap.append(legend);

  let note;
  if (overshoot) {
    note = `运行时为这条记录记下的思考耗时（${fmtMs(recorded)}）不小于请求耗时（${fmtMs(total)}），` +
      '两个数值互相矛盾，因此只按思考段绘制，不推导输出段。';
  } else if (hasThinking) {
    note = '紫色＝思考段（运行时记录）；绿色＝输出段＝请求耗时 − 思考耗时。' +
      '运行时不记录首 token 时刻，所以输出段是推导值，不是实测解码时间。';
  } else {
    note = '本条记录没有思考段（运行时未记录 thinking_duration_ms），整段按请求耗时绘制，不做拆分。';
  }
  wrap.append(textNode('p', 'bar-note muted small', note));
  return wrap;
}

function renderSchemaTab(body, event, call) {
  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', 'Schema'));
  if (!call) {
    body.append(textNode('p', 'muted small', '该记录不是工具调用，没有入参 schema。'));
    return;
  }
  section.append(textNode('p', 'muted small', `工具 ${call.name ?? '未知'}`));
  section.append(textNode('p', 'muted',
    '运行时不在会话数据里持久化工具的入参 schema，因此这里无法显示。' +
    '这不是抓取失败——dsh 的 Trajectory 对同样缺失的数据也显示 "Schema unavailable"。'));
  body.append(section);
}

function prettyJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ flow */

async function loadSessions() {
  const payload = await api('/api/sessions?limit=300');
  state.sessions = payload.sessions ?? [];
  renderSessions();
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.selected = null;
  closeInspector();
  revealAncestors(sessionId);
  renderSessions();
  await loadOverview();
}

let loadingDepth = 0;
function setLoading(on) {
  loadingDepth = Math.max(0, loadingDepth + (on ? 1 : -1));
  el('main').dataset.loading = loadingDepth > 0 ? 'true' : 'false';
}

async function loadOverview() {
  setLoading(true);
  try {
    return await loadOverviewInner();
  } finally {
    setLoading(false);
  }
}

async function loadOverviewInner() {
  const query = state.sessionId ? `?id=${encodeURIComponent(state.sessionId)}` : '';
  const payload = await api(`/api/overview${query}`);
  if (!payload.session) {
    el('session-title').textContent = '没有可用会话';
    el('session-meta').textContent = '';
    el('stats').textContent = '';
    el('stream').textContent = '';
    el('overview').textContent = '';
    return;
  }
  state.sessionId = payload.session.sessionId;
  state.tasks = payload.tasks ?? [];
  state.turns = new Map((payload.turns ?? []).map((turn) => [turn.turnId, turn]));
  state.turnOrder = (payload.turns ?? []).map((turn) => turn.turnId);

  // The header and the sidebar highlight must agree with what is on screen, so the
  // selected session is force-included in the list even when the fetch limit, the
  // search box or an agent filter would have excluded it.
  if (!state.sessions.some((session) => session.sessionId === state.sessionId)) {
    const raw = await api(`/api/sessions?limit=1&id=${encodeURIComponent(state.sessionId)}`).catch(() => null);
    const extra = raw?.sessions?.find((session) => session.sessionId === state.sessionId);
    if (extra) state.sessions.unshift(extra);
  }

  renderStats(payload.stats);
  renderCapability(payload.agent);
  revealAncestors(state.sessionId);
  renderSessions();
  scrollSelectedIntoView();

  // The axis needs the whole session; the stream needs only its first page. Fetch
  // them together so the first paint has both.
  const [, timeline] = await Promise.all([
    refreshEvents(),
    api(`/api/timeline?id=${encodeURIComponent(state.sessionId)}`)
      .then((page) => page.points ?? [])
      .catch(() => []),
  ]);
  renderOverview(timeline, state.tasks);
}

/**
 * Fetch one page of records from the server and append it.
 *
 * The stream used to request 1000 records with full content on every switch — up to
 * 6 MB for a large session — to render the first 150. Now only what will be shown is
 * fetched, and the rest arrives as the reader scrolls.
 */
async function loadEvents({ reset = false } = {}) {
  if (reset) {
    state.events = [];
    state.streamRows = [];
    state.filteredRows = null;
    state.renderedRows = 0;
    state.lastTurn = undefined;
    state.nextOffset = 0;
    state.eventsTotal = 0;
  }
  if (state.loadingEvents || state.nextOffset === null) return false;
  state.loadingEvents = true;
  try {
    const detail = state.detailLevel === 'full' ? '&detailLevel=full' : '';
    const payload = await api(
      `/api/events?id=${encodeURIComponent(state.sessionId)}&offset=${state.nextOffset}&limit=${EVENT_PAGE}${detail}`);
    const incoming = payload.events ?? [];
    for (const event of incoming) {
      state.events.push(event);
      state.streamRows.push({ kind: 'message', event });
      for (const [position, call] of (event.toolCalls ?? []).entries()) {
        state.streamRows.push({ kind: 'tool', event, call, position });
      }
    }
    state.nextOffset = payload.nextOffset ?? null;
    state.eventsTotal = payload.total ?? state.events.length;
    state.eventsSource = payload.source ?? 'sqlite';
    state.filteredRows = null;
    return incoming.length > 0;
  } finally {
    state.loadingEvents = false;
  }
}

async function refreshEvents() {
  await loadEvents({ reset: true });
  renderStream();
  if (state.selected) renderInspector();
  if (state.eventsSource === 'jsonl') {
    banner('该会话未进入 SQLite 投影，已回退到 messages.jsonl。计时与任务关联可能缺失。');
  }
}

/**
 * Bring a record into view wherever it sits in the session: keep asking the server
 * for pages until it is loaded, then keep rendering until it is in the DOM.
 */
async function locateRow(rowId, { silent = false } = {}) {
  let guard = 0;
  while (guard < 60) {
    guard += 1;
    const event = state.events.find((item) => item.rowId === rowId);
    if (event) {
      // A timeline INPUT/MODEL block refers to a record, never to a tool call.
      openInspector({ kind: 'message', eventIndex: event.index });
      return scrollRowIntoView(rowId);
    }
    if (state.nextOffset === null) break;
    await loadEvents();
  }
  if (!silent) banner('未能定位到该记录。');
  return false;
}

async function locateToolCall(toolCallId, { silent = false } = {}) {
  let guard = 0;
  while (guard < 60) {
    guard += 1;
    for (const event of state.events) {
      const position = (event.toolCalls ?? []).findIndex((call) => call.id === toolCallId);
      if (position >= 0) {
        openInspector({ kind: 'tool', eventIndex: event.index, position });
        return scrollRowIntoView(`call:${toolCallId}`);
      }
    }
    if (state.nextOffset === null) break;
    await loadEvents();
  }
  if (!silent) banner('未能在已加载的记录中找到该工具调用。');
  return false;
}

/** Render further batches until the wanted row is in the DOM, then scroll to it. */
function scrollRowIntoView(key) {
  const selector = typeof key === 'string' && key.startsWith('call:')
    ? `[data-tool-call-id="${CSS.escape(key.slice(5))}"]`
    : `[data-row-id="${CSS.escape(String(key))}"]`;
  for (let guard = 0; guard < 60; guard += 1) {
    const node = el('stream').querySelector(selector);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateStreamCount();
      return true;
    }
    if ((state.renderedRows ?? 0) >= (state.filteredRows?.length ?? 0)) break;
    appendStreamRows();
  }
  updateStreamCount();
  return false;
}

/** Options come from the data: sub-agent presets differ per install. */
async function loadAgents() {
  const select = el('agent-select');
  try {
    const payload = await api('/api/agents');
    const current = select.value;
    select.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部';
    select.append(all);
    for (const agent of payload.agents ?? []) {
      const option = document.createElement('option');
      option.value = agent.name;
      option.textContent = `${agent.name} (${agent.count})`;
      select.append(option);
    }
    select.value = current;
  } catch {
    /* the filter stays at 全部 */
  }
}

function debounce(fn, wait = 140) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ------------------------------------------------------------------- wire */

function wire() {
  bindTimelineControls();

  el('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderSessions();
  });

  el('search').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !state.search.trim()) return;
    try {
      const payload = await api(`/api/search?q=${encodeURIComponent(state.search.trim())}&limit=100`);
      if (payload.sessions?.length) {
        state.sessions = payload.sessions;
        state.collapsed.clear();
        writeCollapsed();
        renderSessions();
      }
    } catch (error) {
      banner(`搜索失败：${error.message}`);
    }
  });

  el('agent-select').addEventListener('change', (event) => {
    state.agentFilter = event.target.value;
    renderSessions();
  });

  el('collapse-all').addEventListener('click', () => {
    const keys = [...new Set(visibleSessions().map((session) => session.groupKey ?? `path:${session.workspaceDir ?? ''}`))];
    const allCollapsed = keys.length > 0 && keys.every((key) => state.collapsed.has(key));
    for (const key of keys) {
      if (allCollapsed) state.collapsed.delete(key);
      else state.collapsed.add(key);
    }
    writeCollapsed();
    renderSessions();
  });

  el('stream').parentElement.addEventListener('click', (event) => {
    const button = event.target.closest('.chip[data-filter]');
    if (!button) return;
    for (const chip of el('stream').parentElement.querySelectorAll('.chip[data-filter]')) {
      chip.classList.toggle('is-on', chip === button);
    }
    state.rowFilter = button.dataset.filter ?? 'all';
    renderStream();
  });

  // Loading the next batch as the reader approaches the bottom keeps the initial
  // paint small without hiding anything.
  el('stream').addEventListener('scroll', async () => {
    const host = el('stream');
    if (state.loadingMore) return;
    if (host.scrollTop + host.clientHeight < host.scrollHeight - 320) return;
    state.loadingMore = true;
    try {
      // Render what is already loaded first, and only then ask the server for more,
      // so scrolling stays responsive while a large session streams in.
      if ((state.renderedRows ?? 0) < (state.filteredRows?.length ?? 0)) {
        appendStreamRows();
      } else if (state.nextOffset !== null && !state.textQuery && !state.turnQuery) {
        await loadEvents();
        appendStreamRows();
      }
      updateStreamCount();
    } finally {
      state.loadingMore = false;
    }
  });

  const debouncedFilters = debounce(() => {
    renderStream();
  });
  el('turn-jump').addEventListener('input', (event) => {
    state.turnQuery = event.target.value.trim();
    debouncedFilters();
  });
  el('text-filter').addEventListener('input', (event) => {
    state.textQuery = event.target.value.trim();
    debouncedFilters();
  });

  el('failure-jump').addEventListener('click', () => {
    const button = el('stream').parentElement.querySelector('.chip[data-filter="failed"]');
    if (button && !button.classList.contains('is-on')) button.click();
    const first = el('stream').querySelector('.srow-tool.is-fail');
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // The first failure may sit beyond the rendered batch; load until it appears.
      let guard = 0;
      while (guard < 40 && !el('stream').querySelector('.srow-tool.is-fail')
        && (state.renderedRows ?? 0) < (state.filteredRows?.length ?? 0)) {
        appendStreamRows();
        guard += 1;
      }
      el('stream').querySelector('.srow-tool.is-fail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateStreamCount();
    }
  });

  el('ins-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.ins-tab');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    renderInspector();
  });

  el('full-detail').addEventListener('change', async (event) => {
    state.detailLevel = event.target.checked ? 'full' : 'summary';
    try {
      await refreshEvents();
    } catch (error) {
      banner(`加载失败：${error.message}`);
    }
  });

  el('reload').addEventListener('click', () => {
    loadOverview().catch((error) => banner(`刷新失败：${error.message}`));
  });

  el('theme-toggle').addEventListener('click', toggleTheme);

  el('ins-close').addEventListener('click', closeInspector);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeInspector();
  });
}

async function boot() {
  applyTheme(readTheme());
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
