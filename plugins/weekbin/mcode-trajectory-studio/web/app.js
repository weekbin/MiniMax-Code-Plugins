/**
 * Trajectory Studio client.
 *
 * Talks only to the local panel's own /api/* routes. Every request carries the
 * custom client header the server requires, so a foreign page cannot read data.
 */

const API_HEADER = { 'x-trajectory-client': '1' };
const MAX_RENDERED_RECORDS = 800;
const MAX_BARS = 500;

const state = {
  sessions: [],
  sessionId: null,
  overview: null,
  events: [],
  detailLevel: 'summary',
  agentFilter: '',
  eventFilter: 'all',
  turnQuery: '',
  selectedIndex: null,
  search: '',
  axis: null,
  view: { start: 0, end: 1 },
};

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ fetch */

async function api(pathname) {
  const response = await fetch(pathname, { headers: API_HEADER, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
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
  if (message) setTimeout(() => { node.hidden = true; }, 8000);
}

/* ---------------------------------------------------------------- sidebar */

function renderSessions() {
  const list = el('session-list');
  list.textContent = '';
  const term = state.search.trim().toLowerCase();
  const rows = state.sessions.filter((session) => {
    if (state.agentFilter && session.agent !== state.agentFilter) return false;
    if (!term) return true;
    return `${session.title ?? ''} ${session.sessionId} ${session.workspaceDir ?? ''}`.toLowerCase().includes(term);
  });
  if (rows.length === 0) {
    list.append(textNode('li', 'muted small', '  没有匹配的会话'));
    return;
  }
  for (const session of rows) {
    const item = document.createElement('button');
    item.className = 'session-item';
    item.type = 'button';
    if (session.sessionId === state.sessionId) item.setAttribute('aria-current', 'true');
    item.append(textNode('span', 's-title', session.title || '(无标题)'));
    item.append(textNode('span', 's-meta',
      `${session.agent ?? '?'} · ${session.sessionKind} · ${fmtAge(session.updatedAtMs)} · ${shortId(session.sessionId)}`));
    item.addEventListener('click', () => selectSession(session.sessionId));
    const li = document.createElement('li');
    li.append(item);
    list.append(li);
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

  const sources = (stats.sources || [])
    .map((entry) => `${entry.source}:${entry.count}`)
    .join('  ');
  el('session-meta').textContent =
    `${shortId(stats.sessionId)} · ${stats.agent ?? '?'} · ${stats.sessionKind} · 来源 ${sources || '—'} · ${stats.workspaceDir ?? ''}`;
  el('session-title').textContent = stats.title || '(无标题)';
}

/* --------------------------------------------------------------- overview */

/**
 * The overview projects each record onto a shared time axis. Sessions routinely
 * span hours while individual requests last milliseconds, so the axis carries a
 * zoomable view window: wheel zooms around the cursor, dragging pans, and a
 * double click resets to the full extent.
 */
function buildSpans(events) {
  const timed = events.filter((event) => Number.isFinite(event.createdAtMs));
  if (timed.length === 0) return null;
  const spans = timed.map((event) => {
    const duration = event.requestDurationMs ?? 0;
    const end = event.createdAtMs;
    return { event, start: duration > 0 ? end - duration : end, end, duration };
  });
  const min = Math.min(...spans.map((span) => span.start));
  const max = Math.max(...spans.map((span) => span.end));
  return { spans, min, max: Math.max(max, min + 1) };
}

function renderOverview(events) {
  const host = el('overview');
  host.textContent = '';
  const built = buildSpans(events);
  state.axis = built;
  state.view = { start: 0, end: 1 };
  if (!built) {
    host.append(textNode('p', 'muted small', '没有可用的时间戳。'));
    el('overview-hint').textContent = '';
    return;
  }
  drawOverview();
}

function drawOverview() {
  const host = el('overview');
  const built = state.axis;
  if (!built) return;
  host.textContent = '';

  const { spans, min, max } = built;
  const total = max - min;
  const view = state.view;
  const viewStartMs = min + total * view.start;
  const viewEndMs = min + total * view.end;
  const viewSpan = Math.max(1, viewEndMs - viewStartMs);
  const pctOf = (value) => ((value - viewStartMs) / viewSpan) * 100;
  const win = (value) => value >= viewStartMs && value <= viewEndMs;

  const ruler = textNode('div', 'ov-ruler');
  const ticks = 6;
  for (let index = 0; index <= ticks; index += 1) {
    const at = viewStartMs + (viewSpan * index) / ticks;
    const tick = textNode('div', 'ov-tick', fmtClock(at));
    tick.style.left = `${(index / ticks) * 100}%`;
    ruler.append(tick);
  }
  host.append(ruler);

  const visible = spans.filter((span) => win(span.end) || win(span.start) || (span.start < viewStartMs && span.end > viewEndMs));
  const drawn = visible.slice(-MAX_BARS);

  for (const span of drawn) {
    const clippedStart = Math.max(span.start, viewStartMs);
    const clippedEnd = Math.min(span.end, viewEndMs);
    const row = textNode('div', 'ov-row');
    const bar = textNode('div', `ov-bar${span.event.role === 'user' ? ' is-user' : ''}`);
    bar.style.left = `${pctOf(clippedStart)}%`;
    bar.style.width = `${Math.max(0, pctOf(clippedEnd) - pctOf(clippedStart))}%`;
    if (span.event.toolCalls?.some((call) => call.status !== null && call.status !== 2)) bar.classList.add('is-err');

    if (span.duration > 0 && span.event.role !== 'user') {
      const thinking = Math.min(span.event.thinkingDurationMs ?? 0, span.duration);
      if (thinking > 0) {
        const segment = textNode('i', 'ov-seg think');
        segment.style.width = `${(thinking / span.duration) * 100}%`;
        bar.append(segment);
      }
      const output = span.duration - thinking;
      if (output > 0) {
        const segment = textNode('i', 'ov-seg out');
        segment.style.width = `${(output / span.duration) * 100}%`;
        bar.append(segment);
      }
    }

    const duration = span.duration > 0 ? ` · ${fmtMs(span.duration)}` : '';
    bar.title = `#${span.event.index} ${span.event.role}${duration} · ${fmtClock(span.end)}`;
    bar.addEventListener('click', (event) => {
      event.stopPropagation();
      openInspector(span.event.index);
    });
    row.append(bar);
    host.append(row);
  }

  if (drawn.length === 0) {
    host.append(textNode('p', 'muted small', '当前时间窗内没有记录，滚轮缩小或双击重置。'));
  }

  const zoomed = view.end - view.start < 0.999;
  el('overview-hint').textContent =
    `${spans.length} 条时间记录 · 全跨度 ${fmtMs(total)} · 窗口 ${fmtMs(viewSpan)}` +
    (zoomed ? ' · 已缩放（双击重置）' : ' · 滚轮缩放，拖拽平移') +
    (visible.length > MAX_BARS ? ` · 窗口内 ${visible.length} 条，仅绘制最近 ${MAX_BARS} 条` : '');
}

function bindOverviewControls() {
  const host = el('overview');
  let drag = null;

  host.addEventListener('wheel', (event) => {
    if (!state.axis) return;
    event.preventDefault();
    const rect = host.getBoundingClientRect();
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
    const rect = host.getBoundingClientRect();
    const delta = (event.clientX - drag.x) / rect.width;
    const width = drag.view.end - drag.view.start;
    let start = drag.view.start - delta * width;
    start = Math.min(Math.max(0, start), 1 - width);
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
  const rendered = rows.slice(0, MAX_RENDERED_RECORDS);

  for (const event of rendered) {
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
    const preview = event.content ?? null;
    if (preview) {
      body.append(textNode('div', 'rec-text', preview.slice(0, 240)));
    } else if (event.contentLength) {
      body.append(textNode('div', 'rec-text dim', `（${event.contentLength} 字符，勾选"显示正文"查看）`));
    } else if (event.kind) {
      body.append(textNode('div', 'rec-text dim', `${event.kind}`));
    } else {
      body.append(textNode('div', 'rec-text dim', '（无正文）'));
    }

    const toolRow = textNode('div', 'rec-tools');
    if (event.hasThinking) toolRow.append(textNode('span', 'tool-tag is-think', '思考'));
    for (const call of (event.toolCalls ?? []).slice(0, 8)) {
      const bad = call.status !== null && call.status !== 2;
      toolRow.append(textNode('span', `tool-tag${bad ? ' is-fail' : ''}`, call.name ?? 'tool'));
    }
    if ((event.toolCalls?.length ?? 0) > 8) {
      toolRow.append(textNode('span', 'tool-tag', `+${event.toolCalls.length - 8}`));
    }
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
      `仅渲染前 ${MAX_RENDERED_RECORDS} 条。请用上方筛选或 turn ID 缩小范围。`));
  }
}

/* ------------------------------------------------------------------ tasks */

function renderTasks(tasks) {
  const wrap = el('tasks-wrap');
  const host = el('tasks');
  host.textContent = '';
  if (!tasks || tasks.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  el('task-count').textContent = `${tasks.length} 个`;
  for (const task of tasks) {
    const row = textNode('div', `task${task.status === 'failed' ? ' is-fail' : task.status === 'succeeded' ? ' is-ok' : ''}`);
    row.append(textNode('span', 't-kind', `${task.kind} ${task.task_id.slice(0, 20)}`));
    row.append(textNode('span', 't-status', task.status));
    row.append(textNode('span', 't-dur', fmtMs(task.duration_ms)));
    host.append(row);
  }
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

  const inspector = el('inspector');
  inspector.setAttribute('data-open', 'true');
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
  statRow(dt, '完成状态', event.requestDurationMs ? '已落定' : '无计时（进行中或不适用）');
  timing.append(dt);
  if (event.requestDurationMs) {
    const total = event.requestDurationMs || 1;
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
    const metaSection = textNode('section', 'ins-section');
    metaSection.append(textNode('h4', '', '压缩元数据'));
    const pre = textNode('pre', 'block', JSON.stringify(event.metadata, null, 2));
    metaSection.append(pre);
    body.append(metaSection);
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
      const dtl = document.createElement('dl');
      dtl.className = 'kv';
      statRow(dtl, '名称', call.name);
      statRow(dtl, 'call_id', call.id);
      statRow(dtl, '状态', call.status === 2 ? '成功' : call.status === null ? '未知（summary 模式）' : `状态码 ${call.status}`);
      section.append(dtl);
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
    const note = textNode('p', 'muted small', '勾选顶部的"显示正文"可加载入参、结果与完整文本。');
    body.append(note);
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
  const payload = await api('/api/sessions?limit=200');
  state.sessions = payload.sessions ?? [];
  renderSessions();
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.selectedIndex = null;
  closeInspector();
  renderSessions();
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
  renderOverview(state.events);
  renderRecords();
  if (payload.source === 'jsonl') {
    banner('该会话未进入 SQLite 投影，已回退到 messages.jsonl。计时字段可能缺失。');
  }
}

/* ------------------------------------------------------------------- wire */

function wire() {
  bindOverviewControls();

  el('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderSessions();
  });

  el('session-filters').addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    for (const chip of el('session-filters').querySelectorAll('.chip')) chip.classList.toggle('is-on', chip === button);
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

  el('search').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !state.search.trim()) return;
    try {
      const payload = await api(`/api/search?q=${encodeURIComponent(state.search.trim())}&limit=100`);
      if (payload.sessions?.length) {
        state.sessions = payload.sessions;
        renderSessions();
      }
    } catch (error) {
      banner(`搜索失败：${error.message}`);
    }
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
