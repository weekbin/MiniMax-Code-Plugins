/**
 * Trajectory Studio client.
 *
 * Talks only to the local panel's own /api/* routes, always with the custom client
 * header the server requires, so a foreign page cannot read local session data.
 */

const API_HEADER = { 'x-trajectory-client': '1' };
const MAX_RENDERED_RECORDS = 600;
const MAX_LANE_ROWS = 8;
const LANE_ROW_PX = 17;

const state = {
  sessions: [],
  sessionId: null,
  overview: null,
  events: [],
  tasks: [],
  detailLevel: 'full',
  agentFilter: '',
  eventFilter: 'all',
  turnQuery: '',
  selectedIndex: null,
  search: '',
  axis: null,
  view: { start: 0, end: 1 },
  collapsed: readCollapsed(),
  openTask: null,
  taskOutput: new Map(),
};

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ fetch */

async function api(pathname) {
  const response = await fetch(pathname, { headers: API_HEADER, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

/* -------------------------------------------------- collapsed group state */

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('trajectory.collapsedWorkspaces') || '[]'));
  } catch {
    return new Set();
  }
}

function writeCollapsed() {
  try {
    localStorage.setItem('trajectory.collapsedWorkspaces', JSON.stringify([...state.collapsed]));
  } catch {
    /* storage is optional */
  }
}

/* ---------------------------------------------------------------- helpers */

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

/** Collapse the home prefix and keep only the tail of long workspace paths. */
function shortWorkspace(dir) {
  if (!dir) return '(无工作区)';
  let value = dir;
  if (/^\/home\/[^/]+/.test(value)) value = `~${value.replace(/^\/home\/[^/]+/, '')}`;
  const parts = value.split('/').filter(Boolean);
  return parts.length <= 3 ? value : `…/${parts.slice(-3).join('/')}`;
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function banner(message) {
  const node = el('banner');
  node.textContent = message;
  node.hidden = !message;
  if (message) setTimeout(() => { node.hidden = true; }, 9000);
}

/* ---------------------------------------------------------------- sidebar */

function visibleSessions() {
  const term = state.search.trim().toLowerCase();
  return state.sessions.filter((session) => {
    if (state.agentFilter && session.agent !== state.agentFilter) return false;
    if (!term) return true;
    return `${session.title ?? ''} ${session.sessionId} ${session.workspaceDir ?? ''}`.toLowerCase().includes(term);
  });
}

function renderSessions() {
  const host = el('session-groups');
  host.textContent = '';
  const rows = visibleSessions();
  if (rows.length === 0) {
    host.append(textNode('p', 'muted small', '  没有匹配的会话'));
    return;
  }

  // Group by workspace, keeping the most recently updated group first.
  const groups = new Map();
  for (const session of rows) {
    const key = session.workspaceDir || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.max(...b[1].map((s) => s.updatedAtMs ?? 0)) - Math.max(...a[1].map((s) => s.updatedAtMs ?? 0)),
  );

  for (const [dir, sessions] of ordered) {
    const collapsed = state.collapsed.has(dir);
    const section = textNode('section', `ws-group${collapsed ? ' is-collapsed' : ''}`);

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'ws-head';
    head.title = dir || '(无工作区)';
    head.append(textNode('span', 'ws-caret', collapsed ? '▸' : '▾'));
    head.append(textNode('span', 'ws-name', shortWorkspace(dir)));
    head.append(textNode('span', 'ws-count', String(sessions.length)));
    head.addEventListener('click', () => {
      if (state.collapsed.has(dir)) state.collapsed.delete(dir);
      else state.collapsed.add(dir);
      writeCollapsed();
      renderSessions();
    });
    section.append(head);

    if (!collapsed) {
      const list = document.createElement('ul');
      list.className = 'ws-sessions';
      for (const session of sessions) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `session-item s-${session.sessionKind ?? 'unknown'}`;
        if (session.sessionId === state.sessionId) item.setAttribute('aria-current', 'true');
        item.append(textNode('span', 's-title', session.title || '(无标题)'));
        const badges = textNode('span', 's-badges');
        badges.append(textNode('span', 's-agent', session.agent ?? '?'));
        if (session.parentSessionId) badges.append(textNode('span', 's-child', '子'));
        badges.append(textNode('span', 's-kind', session.sessionKind ?? ''));
        badges.append(textNode('span', 's-age', fmtAge(session.updatedAtMs)));
        item.append(badges);
        item.addEventListener('click', () => selectSession(session.sessionId));
        const li = document.createElement('li');
        li.append(item);
        list.append(li);
      }
      section.append(list);
    }
    host.append(section);
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
    ['工具耗时', fmtMs(stats.toolMs), `${stats.backgroundTasks} 个后台任务`, false],
    ['解码耗时', fmtMs(stats.decodeMs), '近似：LLM − 思考', false],
    ['TTFT', '不可用', 'mcode 不落盘', true],
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
    `${shortWorkspace(stats.workspaceDir)}${stats.children ? ` · ${stats.children} 个子会话` : ''}`;
  el('session-title').textContent = stats.title || '(无标题)';
}

/* -------------------------------------------------------------- timeline -- */

/**
 * The timeline is the dsh-style narrative: three lanes (INPUT, MODEL, TOOL)
 * sharing one time axis, rather than one row per record. Overlapping blocks
 * within a lane are stacked greedily into sub-rows.
 */
function buildAxis(events, tasks) {
  const timed = events.filter((event) => Number.isFinite(event.createdAtMs));
  if (timed.length === 0) return null;

  const inputItems = [];
  const modelItems = [];
  const toolItems = [];

  for (const event of timed) {
    if (event.role === 'user') {
      inputItems.push({ start: event.createdAtMs, end: event.createdAtMs + 1, event, kind: 'input' });
      continue;
    }
    const duration = event.requestDurationMs;
    if (duration && duration > 0) {
      modelItems.push({
        start: event.createdAtMs - duration,
        end: event.createdAtMs,
        duration,
        event,
        thinking: Math.min(event.thinkingDurationMs ?? 0, duration),
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
      kind: 'task',
      failed: task.status === 'failed',
      running: task.status === 'running',
    });
  }

  // Gaps between a finished record and the next model call are time the model was
  // not running: tool execution plus scheduling. They are drawn faintly and
  // labelled as derived so they are never mistaken for measured tool spans.
  const ordered = [...timed].sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const gapStart = current.createdAtMs;
    const gapEnd = next.createdAtMs - (next.requestDurationMs ?? 0);
    if (gapEnd - gapStart > 250) {
      toolItems.push({ start: gapStart, end: gapEnd, kind: 'wait', derived: true });
    }
  }

  const all = [...inputItems, ...modelItems, ...toolItems];
  const min = Math.min(...all.map((item) => item.start));
  const max = Math.max(...all.map((item) => item.end));
  return { inputItems, modelItems, toolItems, min, max: Math.max(max, min + 1) };
}

/** Greedy interval packing: place each item in the first free lane sub-row. */
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

function renderOverview(events, tasks) {
  state.axis = buildAxis(events, tasks);
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

  /* ---- ruler ---- */
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

  /* ---- lanes ---- */
  const lanes = [
    { key: 'input', label: 'INPUT', items: axis.inputItems, render: renderInputBlock },
    { key: 'model', label: 'MODEL', items: axis.modelItems, render: renderModelBlock },
    { key: 'tool', label: 'TOOL', items: axis.toolItems, render: renderToolBlock },
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
      const left = pctOf(start);
      const width = Math.max(0, pctOf(end) - left);
      const block = lane.render(item, width);
      block.style.left = `${left}%`;
      block.style.width = `${width}%`;
      block.style.top = `${item.row * LANE_ROW_PX}px`;
      track.append(block);
    }

    if (visible.length === 0) track.append(textNode('p', 'ov-empty muted small', '该通道在当前时间窗内无记录'));
    grid.append(track);
    host.append(grid);
  }

  const zoomed = view.end - view.start < 0.999;
  el('overview-hint').textContent =
    `INPUT ${axis.inputItems.length} · MODEL ${axis.modelItems.length} · TOOL ${axis.toolItems.length}` +
    ` · 全跨度 ${fmtMs(total)} · 窗口 ${fmtMs(viewSpan)}` +
    (zoomed ? ' · 已缩放（双击重置）' : ' · 滚轮缩放，拖拽平移');
}

function renderInputBlock(item, width) {
  const block = textNode('div', 'ov-block ov-input');
  block.style.minWidth = '4px';
  block.title = `INPUT #${item.event.index} · ${fmtClock(item.event.createdAtMs)} · ${item.event.contentLength ?? 0} 字符`;
  block.addEventListener('click', (event) => {
    event.stopPropagation();
    openInspector(item.event.index);
  });
  return block;
}

function renderModelBlock(item) {
  const block = textNode('div', `ov-block ov-model${item.event.kind ? ' is-compaction' : ''}`);
  if (item.event.toolCalls?.some((call) => call.status !== null && call.status !== 2)) block.classList.add('is-err');
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
  block.title = `MODEL #${item.event.index} · ${fmtMs(item.duration)}（思考 ${fmtMs(item.thinking)}）· ${fmtClock(item.event.createdAtMs)}`;
  block.addEventListener('click', (event) => {
    event.stopPropagation();
    openInspector(item.event.index);
  });
  return block;
}

function renderToolBlock(item) {
  if (item.kind === 'wait') {
    const block = textNode('div', 'ov-block ov-wait');
    block.title = `等待 / 工具执行（推导自记录间隔）· ${fmtMs(item.end - item.start)}`;
    return block;
  }
  const block = textNode('div', `ov-block ov-tool${item.failed ? ' is-err' : ''}${item.running ? ' is-running' : ''}`);
  const task = item.task;
  block.title = `${task.kind} · ${task.status} · ${fmtMs(item.end - item.start)}${task.description ? `\n${task.description.slice(0, 160)}` : ''}`;
  if (task.kind === 'subagent') block.classList.add('is-subagent');
  block.addEventListener('click', (event) => {
    event.stopPropagation();
    revealTask(task.taskId);
  });
  return block;
}

function bindTimelineControls() {
  const host = el('overview');
  let drag = null;

  host.addEventListener('wheel', (event) => {
    if (!state.axis || event.target.closest('.ov-lane-track') === null) return;
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
    const track = host.querySelector('.ov-lane-track');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const delta = (event.clientX - drag.x) / rect.width;
    const width = drag.view.end - drag.view.start;
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

/* ---------------------------------------------------------------- records */

function eventMatchesFilter(event) {
  switch (state.eventFilter) {
    case 'assistant': return event.role === 'assistant';
    case 'user': return event.role === 'user';
    case 'tools': return (event.toolCallCount ?? 0) > 0;
    case 'thinking': return Boolean(event.hasThinking);
    case 'failed': return Boolean(event.toolCalls?.some((call) => call.status !== null && call.status !== 2));
    case 'compaction': return Boolean(event.kind);
    default: return true;
  }
}

function visibleEvents() {
  return state.events.filter((event) => {
    if (!eventMatchesFilter(event)) return false;
    if (state.turnQuery && !String(event.turnId ?? '').includes(state.turnQuery)) return false;
    return true;
  });
}

function renderRecords() {
  const host = el('records');
  host.textContent = '';
  const rows = visibleEvents();
  el('record-count').textContent = rows.length === state.events.length
    ? `${rows.length} 条`
    : `${rows.length} / ${state.events.length} 条`;

  if (rows.length === 0) {
    host.append(textNode('p', 'muted small', '没有匹配的记录。'));
    return;
  }

  let currentTurn = null;
  for (const event of rows.slice(0, MAX_RENDERED_RECORDS)) {
    if (event.turnId !== currentTurn) {
      currentTurn = event.turnId;
      const turnEvents = state.events.filter((item) => item.turnId === currentTurn);
      const turnMs = turnEvents.reduce((sum, item) => sum + (item.requestDurationMs ?? 0), 0);
      const turnTokens = turnEvents.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0);
      const head = textNode('div', 'turn-head');
      head.append(textNode('span', 'th-id', currentTurn ? String(currentTurn) : '(无轮次)'));
      head.append(textNode('span', '', `${turnEvents.length} 条`));
      const agg = textNode('div', 'th-agg');
      agg.append(textNode('span', '', `LLM ${fmtMs(turnMs)}`));
      agg.append(textNode('span', '', `out ${fmtTokens(turnTokens)} tok`));
      head.append(agg);
      host.append(head);
    }

    const failed = Boolean(event.toolCalls?.some((call) => call.status !== null && call.status !== 2));
    const row = textNode('div', `rec${failed ? ' is-err' : ''}${event.kind ? ' is-compaction' : ''}`);
    if (event.index === state.selectedIndex) row.setAttribute('aria-selected', 'true');

    const tags = textNode('div', 'rec-tags');
    tags.append(textNode('span', 'rec-role', event.role ?? '—'));
    tags.append(textNode('span', 'rec-src', event.source ?? ''));
    row.append(tags);

    const body = textNode('div', 'rec-body');
    // An empty string is "no text", not "some text"; fall through to thinking, then
    // to the tool-call list, so every row carries something readable.
    const text = typeof event.content === 'string' ? event.content.trim() : '';
    const thinking = typeof event.thinking === 'string' ? event.thinking.trim() : '';
    const toolNames = (event.toolCalls ?? []).map((call) => call.name).filter(Boolean);
    let preview = text;
    let prefix = '';
    if (!preview && thinking) {
      preview = thinking;
      prefix = '[思考] ';
    }
    if (!preview && toolNames.length) preview = `[调用] ${toolNames.join(', ')}`;
    if (preview) {
      const line = textNode('div', 'rec-text', prefix + preview.replace(/\s+/g, ' ').trim());
      line.title = (prefix + preview).slice(0, 600);
      body.append(line);
    } else if (event.kind) {
      body.append(textNode('div', 'rec-text dim', event.kind));
    } else {
      body.append(textNode('div', 'rec-text dim', '（空记录）'));
    }

    const toolRow = textNode('div', 'rec-tools');
    if (event.hasThinking) toolRow.append(textNode('span', 'tool-tag is-think', '思考'));
    for (const call of (event.toolCalls ?? []).slice(0, 8)) {
      const bad = call.status !== null && call.status !== 2;
      toolRow.append(textNode('span', `tool-tag${bad ? ' is-fail' : ''}`, call.name ?? 'tool'));
    }
    if ((event.toolCalls?.length ?? 0) > 8) toolRow.append(textNode('span', 'tool-tag', `+${event.toolCalls.length - 8}`));
    if (toolRow.childElementCount) body.append(toolRow);
    row.append(body);

    const timing = textNode('div', 'rec-ms');
    if (event.requestDurationMs) timing.append(textNode('div', '', fmtMs(event.requestDurationMs)));
    if (event.thinkingDurationMs) timing.append(textNode('div', 'ms-think', `思 ${fmtMs(event.thinkingDurationMs)}`));
    if (event.usage?.outputTokens) timing.append(textNode('div', 'ms-tok', `${fmtTokens(event.usage.outputTokens)} tok`));
    row.append(timing);

    row.addEventListener('click', () => openInspector(event.index));
    host.append(row);
  }

  if (rows.length > MAX_RENDERED_RECORDS) {
    host.append(textNode('p', 'muted small',
      `仅渲染前 ${MAX_RENDERED_RECORDS} 条。请用筛选或 turn ID 缩小范围。`));
  }
}

/* ------------------------------------------------------------------ tasks */

function taskStatusClass(status) {
  if (status === 'failed') return ' is-fail';
  if (status === 'succeeded') return ' is-ok';
  if (status === 'running') return ' is-running';
  return '';
}

function renderTasks(tasks) {
  const wrap = el('tasks-wrap');
  const host = el('tasks');
  host.textContent = '';
  state.tasks = tasks ?? [];
  if (state.tasks.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const failed = state.tasks.filter((task) => task.status === 'failed').length;
  const subs = state.tasks.filter((task) => task.kind === 'subagent').length;
  el('task-count').textContent = `${state.tasks.length} 个 · 子代理 ${subs}${failed ? ` · 失败 ${failed}` : ''}`;

  for (const task of state.tasks) {
    const card = textNode('div', `task${taskStatusClass(task.status)}`);
    card.dataset.taskId = task.taskId;
    if (task.taskId === state.openTask) card.classList.add('is-open');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'task-head';
    head.append(textNode('span', 't-caret', task.taskId === state.openTask ? '▾' : '▸'));
    head.append(textNode('span', `t-kind t-${task.kind}`, task.kind === 'subagent' ? `subagent·${task.agentName ?? '?'}` : task.kind));
    head.append(textNode('span', 't-desc', task.description || '(无描述)'));
    head.append(textNode('span', 't-status', task.status));
    head.append(textNode('span', 't-dur', fmtMs(task.durationMs)));
    head.addEventListener('click', () => toggleTask(task.taskId));
    card.append(head);

    if (task.taskId === state.openTask) card.append(buildTaskBody(task));
    host.append(card);
  }
}

function buildTaskBody(task) {
  const body = textNode('div', 'task-body');

  const dt = document.createElement('dl');
  dt.className = 'kv';
  const add = (key, value) => {
    if (value === null || value === undefined || value === '') return;
    dt.append(textNode('dt', '', key));
    dt.append(textNode('dd', '', String(value)));
  };
  add('任务 ID', task.taskId);
  add('开始', fmtClock(task.startedAtMs ?? task.createdAtMs));
  add('结束', task.endedAtMs ? fmtClock(task.endedAtMs) : '（进行中）');
  add('耗时', fmtMs(task.durationMs));
  add('所属轮次', task.parentTurnId);
  add('执行模式', task.executionMode);
  add('子代理', task.agentName);
  add('工具调用 ID', task.toolCallId);
  add('子会话', task.childSessionId);
  body.append(dt);

  if (task.command && task.command !== task.description) {
    body.append(textNode('h4', '', '命令'));
    body.append(textNode('pre', 'block', task.command));
  }

  const actions = textNode('div', 'task-actions');
  if (task.hasOutput) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small-btn';
    button.textContent = state.taskOutput.has(task.taskId) ? '收起输出' : '查看输出';
    button.addEventListener('click', () => toggleTaskOutput(task.taskId));
    actions.append(button);
  }
  if (task.childSessionId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small-btn';
    button.textContent = '打开子会话轨迹 →';
    button.addEventListener('click', () => selectSession(task.childSessionId));
    actions.append(button);
  }
  if (task.toolCallId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small-btn';
    button.textContent = '定位调用记录';
    button.addEventListener('click', () => {
      const found = state.events.find((event) => event.toolCalls?.some((call) => call.id === task.toolCallId));
      if (found) openInspector(found.index);
      else banner('未在当前已加载记录中找到该工具调用。');
    });
    actions.append(button);
  }
  if (actions.childElementCount) body.append(actions);

  if (state.taskOutput.has(task.taskId)) {
    const output = state.taskOutput.get(task.taskId);
    body.append(textNode('h4', '', output.available ? `输出${output.truncated ? `（尾部，共 ${output.bytes} 字节）` : `（${output.bytes} 字节）`}` : '输出'));
    body.append(textNode('pre', 'block task-output', output.available ? output.text : '（输出文件不存在）'));
  }

  return body;
}

function toggleTask(taskId) {
  state.openTask = state.openTask === taskId ? null : taskId;
  renderTasks(state.tasks);
}

async function toggleTaskOutput(taskId) {
  if (state.taskOutput.has(taskId)) {
    state.taskOutput.delete(taskId);
    renderTasks(state.tasks);
    return;
  }
  try {
    const output = await api(`/api/task-output?taskId=${encodeURIComponent(taskId)}&maxBytes=16384`);
    state.taskOutput.set(taskId, output);
    state.openTask = taskId;
    renderTasks(state.tasks);
  } catch (error) {
    banner(`读取任务输出失败：${error.message}`);
  }
}

/** Open the task card for a timeline block, scrolling it into view. */
function revealTask(taskId) {
  state.openTask = taskId;
  renderTasks(state.tasks);
  const card = el('tasks').querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* -------------------------------------------------------------- inspector */

function statRow(list, key, value) {
  list.append(textNode('dt', '', key));
  list.append(textNode('dd', '', value === null || value === undefined ? '—' : String(value)));
}

function openInspector(index) {
  const event = state.events.find((item) => item.index === index);
  if (!event) return;
  state.selectedIndex = index;
  renderRecords();

  el('inspector').setAttribute('data-open', 'true');
  document.body.dataset.inspector = 'true';
  el('ins-title').textContent = `记录 #${event.index}`;

  const body = el('ins-body');
  body.textContent = '';

  const timing = textNode('section', 'ins-section');
  timing.append(textNode('h4', '', '计时'));
  const dt = document.createElement('dl');
  dt.className = 'kv';
  statRow(dt, '时间', fmtClock(event.createdAtMs));
  statRow(dt, '请求耗时', fmtMs(event.requestDurationMs));
  statRow(dt, '思考耗时', fmtMs(event.thinkingDurationMs));
  if (event.requestDurationMs && event.thinkingDurationMs !== null) {
    statRow(dt, '输出耗时(近似)', fmtMs(Math.max(0, event.requestDurationMs - event.thinkingDurationMs)));
  }
  statRow(dt, 'finish_reason', event.finishReason);
  timing.append(dt);
  if (event.requestDurationMs) {
    const total = event.requestDurationMs;
    const thinking = Math.min(event.thinkingDurationMs ?? 0, total);
    const bars = textNode('div', 'bars');
    const thinkBar = textNode('i');
    thinkBar.style.width = `${(thinking / total) * 100}%`;
    thinkBar.style.background = 'var(--think)';
    const outBar = textNode('i');
    outBar.style.width = `${((total - thinking) / total) * 100}%`;
    outBar.style.background = 'var(--out)';
    bars.append(thinkBar, outBar);
    timing.append(bars);
  }
  body.append(timing);

  const meta = textNode('section', 'ins-section');
  meta.append(textNode('h4', '', '元数据'));
  const md = document.createElement('dl');
  md.className = 'kv';
  statRow(md, 'turn_id', event.turnId);
  statRow(md, 'role', event.role);
  statRow(md, 'source', event.source);
  statRow(md, 'kind', event.kind);
  statRow(md, 'msg_id', event.msgId);
  statRow(md, '内容长度', event.contentLength);
  meta.append(md);
  body.append(meta);

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
    ctx.append(textNode('h4', '', `上下文分解 · 已用 ${fmtTokens(event.contextUsage.usedTokens)}${event.contextUsage.totalCountSource ? ` (${event.contextUsage.totalCountSource})` : ''}`));
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

  if (event.thinking) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '思考'));
    section.append(textNode('pre', 'block', event.thinking));
    body.append(section);
  }

  if (event.content) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '正文'));
    section.append(textNode('pre', 'block', event.content));
    body.append(section);
  }

  if (event.toolCalls?.length) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', `工具调用 (${event.toolCalls.length})`));
    for (const call of event.toolCalls) {
      const dl = document.createElement('dl');
      dl.className = 'kv';
      statRow(dl, '名称', call.name);
      statRow(dl, 'call_id', call.id);
      statRow(dl, '状态', call.status === 2 ? '成功' : call.status === null ? '未知' : `状态码 ${call.status}`);
      section.append(dl);
      if (call.args !== undefined && call.args !== null) {
        section.append(textNode('h4', '', '入参'));
        section.append(textNode('pre', 'block', typeof call.args === 'string' ? call.args : JSON.stringify(call.args, null, 2)));
      }
      if (call.result !== undefined && call.result !== null) {
        section.append(textNode('h4', '', '结果'));
        section.append(textNode('pre', 'block', typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)));
      }
    }
    body.append(section);
  }

  if (state.detailLevel !== 'full') {
    body.append(textNode('p', 'muted small', '勾选顶部的"显示正文"可加载完整文本与工具入参。'));
  }
}

function closeInspector() {
  el('inspector').setAttribute('data-open', 'false');
  document.body.dataset.inspector = 'false';
  state.selectedIndex = null;
  renderRecords();
}

/* ------------------------------------------------------------------ flow */

async function loadSessions() {
  const payload = await api('/api/sessions?limit=300');
  state.sessions = payload.sessions ?? [];
  renderSessions();
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.selectedIndex = null;
  state.openTask = null;
  closeInspector();
  await loadOverview();
}

async function loadOverview() {
  const query = state.sessionId ? `?id=${encodeURIComponent(state.sessionId)}` : '';
  const payload = await api(`/api/overview${query}`);
  if (!payload.session) {
    el('session-title').textContent = '没有可用会话';
    el('session-meta').textContent = '';
    el('stats').textContent = '';
    el('records').textContent = '';
    el('overview').textContent = '';
    return;
  }
  state.sessionId = payload.session.sessionId;
  state.overview = payload;
  renderStats(payload.stats);
  renderSessions();
  await refreshEvents();
  renderTasks(payload.tasks);
}

async function refreshEvents() {
  const detail = state.detailLevel === 'full' ? '&detailLevel=full' : '';
  const payload = await api(`/api/events?id=${encodeURIComponent(state.sessionId)}&limit=1000${detail}`);
  state.events = payload.events ?? [];
  renderOverview(state.events, state.tasks);
  renderRecords();
  if (payload.source === 'jsonl') {
    banner('该会话未进入 SQLite 投影，已回退到 messages.jsonl。计时字段可能缺失。');
  }
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

  el('collapse-all').addEventListener('click', () => {
    const dirs = [...new Set(visibleSessions().map((session) => session.workspaceDir || ''))];
    const allCollapsed = dirs.length > 0 && dirs.every((dir) => state.collapsed.has(dir));
    for (const dir of dirs) {
      if (allCollapsed) state.collapsed.delete(dir);
      else state.collapsed.add(dir);
    }
    writeCollapsed();
    renderSessions();
  });

  el('session-filters').addEventListener('click', (event) => {
    const button = event.target.closest('.chip[data-agent]');
    if (!button) return;
    for (const chip of el('session-filters').querySelectorAll('.chip[data-agent]')) {
      chip.classList.toggle('is-on', chip === button);
    }
    state.agentFilter = button.dataset.agent ?? '';
    renderSessions();
  });

  el('event-filters').addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    for (const chip of el('event-filters').querySelectorAll('.chip')) chip.classList.toggle('is-on', chip === button);
    state.eventFilter = button.dataset.filter ?? 'all';
    renderRecords();
  });

  el('turn-jump').addEventListener('input', (event) => {
    state.turnQuery = event.target.value.trim();
    renderRecords();
  });

  el('full-detail').addEventListener('change', async (event) => {
    state.detailLevel = event.target.checked ? 'full' : 'summary';
    try {
      await refreshEvents();
      if (state.selectedIndex !== null) openInspector(state.selectedIndex);
    } catch (error) {
      banner(`加载失败：${error.message}`);
    }
  });

  el('reload').addEventListener('click', () => {
    loadOverview().catch((error) => banner(`刷新失败：${error.message}`));
  });

  el('ins-close').addEventListener('click', closeInspector);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeInspector();
  });
}

async function boot() {
  wire();
  closeInspector();
  try {
    const meta = await api('/api/meta');
    el('source-line').textContent = meta.sqliteAvailable
      ? `只读 SQLite · FTS ${meta.ftsAvailable ? '可用' : '不可用'}`
      : 'SQLite 不可用 · 回退 JSONL';
    if (!meta.sqliteAvailable) banner('SQLite 投影不可读，已回退到 messages.jsonl，计时字段会缺失。');
    for (const warning of meta.warnings ?? []) banner(warning);
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
