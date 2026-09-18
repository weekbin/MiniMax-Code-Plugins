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
const MAX_RENDERED_ROWS = 1200;
const MAX_LANE_ROWS = 8;
const LANE_ROW_PX = 17;

const state = {
  sessions: [],
  sessionId: null,
  events: [],
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
  view: { start: 0, end: 1 },
  collapsed: readCollapsed(),
  tab: 'summary',
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

function workspaceTail(dir) {
  if (!dir) return '';
  const parts = dir.split('/').filter(Boolean);
  return parts.length <= 2 ? dir : parts.slice(-2).join('/');
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

function renderSessions() {
  const host = el('session-groups');
  host.textContent = '';
  const rows = visibleSessions();
  if (rows.length === 0) {
    host.append(textNode('p', 'muted small', '  没有匹配的会话'));
    return;
  }

  // Group by repository (worktrees merged), falling back to path when not in a git tree.
  const groups = new Map();
  for (const session of rows) {
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

    const dirs = new Set(group.sessions.map((session) => session.workspaceDir).filter(Boolean));
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'ws-head';
    head.title = `${group.label}\n${[...dirs].join('\n')}`;
    head.append(textNode('span', 'ws-caret', collapsed ? '▸' : '▾'));
    head.append(textNode('span', `ws-kind ws-kind-${group.kind}`, group.kind === 'git' ? 'git' : 'dir'));
    head.append(textNode('span', 'ws-name', group.label));
    const meta = textNode('span', 'ws-meta');
    if (group.kind === 'git' && dirs.size > 1) meta.append(textNode('span', 'ws-worktrees', `${dirs.size} 工作区`));
    meta.append(textNode('span', 'ws-count', String(group.sessions.length)));
    head.append(meta);
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
      for (const session of group.sessions) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `session-item s-${session.sessionKind ?? 'unknown'}`;
        if (session.sessionId === state.sessionId) item.setAttribute('aria-current', 'true');
        item.append(textNode('span', 's-title', session.title || '(无标题)'));
        const badges = textNode('span', 's-badges');
        badges.append(textNode('span', 's-agent', session.agent ?? '?'));
        if (session.parentSessionId) badges.append(textNode('span', 's-child', '子'));
        if (session.branch) badges.append(textNode('span', 's-branch', session.branch));
        badges.append(textNode('span', 's-age', fmtAge(session.updatedAtMs)));
        item.append(badges);
        if (dirs.size > 1 && session.workspaceDir) {
          item.append(textNode('span', 's-dir', workspaceTail(session.workspaceDir)));
        }
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

function buildAxis(events, tasks) {
  const timed = events.filter((event) => Number.isFinite(event.createdAtMs));
  if (timed.length === 0) return null;

  const inputItems = [];
  const modelItems = [];
  const toolItems = [];

  for (const event of timed) {
    if (event.role === 'user') {
      inputItems.push({
        start: event.createdAtMs,
        end: event.createdAtMs + 1,
        event,
        injected: event.inputKind === 'injected',
      });
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
      measured: true,
      failed: task.status === 'failed',
      running: task.status === 'running',
    });
  }

  // Gaps between a finished record and the next model call are time the model was
  // not running. Labelled as derived because only task-backed calls are measured.
  const ordered = [...timed].sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const gapStart = current.createdAtMs;
    const gapEnd = next.createdAtMs - (next.requestDurationMs ?? 0);
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
        ? `${item.task.kind} · ${item.task.status} · ${fmtMs(item.end - item.start)}\n${item.task.description ?? ''}`
        : lane.key === 'tool'
          ? `等待 / 工具执行（推导自记录间隔）· ${fmtMs(item.end - item.start)}`
          : lane.key === 'input'
            ? `INPUT #${item.event.index} · ${item.injected ? '注入上下文' : '人类输入'} · ${fmtClock(item.event.createdAtMs)}`
            : `MODEL #${item.event.index} · ${fmtMs(item.duration)}（思考 ${fmtMs(item.thinking)}）`;

      block.addEventListener('click', (event) => {
        event.stopPropagation();
        if (lane.key === 'tool' && item.task?.toolCallId) {
          focusToolCall(item.task.toolCallId);
        } else if (item.event) {
          openInspector({ kind: 'message', eventIndex: item.event.index });
        }
      });
      track.append(block);
    }
    if (visible.length === 0) track.append(textNode('p', 'ov-empty muted small', '该通道在当前时间窗内无记录'));
    grid.append(track);
    host.append(grid);
  }

  const zoomed = view.end - view.start < 0.999;
  el('overview-hint').textContent =
    `INPUT（人类 ${axis.inputItems.filter((item) => !item.injected).length} / 注入 ${axis.inputItems.filter((item) => item.injected).length}）` +
    ` · MODEL ${axis.modelItems.length}` +
    ` · TOOLS（实测 ${axis.toolItems.filter((item) => item.measured).length} / 推导 ${axis.toolItems.filter((item) => item.derived).length}）` +
    ` · 全跨度 ${fmtMs(total)} · 窗口 ${fmtMs(viewSpan)}` +
    (zoomed ? ' · 已缩放（双击重置）' : ' · 滚轮缩放，拖拽平移');
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

function rowMatchesFilter(row) {
  switch (state.rowFilter) {
    case 'human': return row.kind === 'message' && row.event.role === 'user' && row.event.inputKind === 'human';
    case 'injected': return row.kind === 'message' && row.event.inputKind === 'injected';
    case 'tools': return row.kind === 'tool';
    case 'failed': return row.kind === 'tool' && toolFailed(row.call);
    default: return true;
  }
}

function rowMatchesText(row) {
  if (!state.textQuery) return true;
  const needle = state.textQuery.toLowerCase();
  const haystack = row.kind === 'tool'
    ? [row.call.name, row.call.description, row.call.args, row.call.result].filter(Boolean).join(' ')
    : [row.event.content, row.event.thinking, row.event.originType, row.event.turnId].filter(Boolean).join(' ');
  return String(haystack).toLowerCase().includes(needle);
}

function renderStream() {
  const host = el('stream');
  host.textContent = '';
  const all = buildStream(state.events);
  const rows = all.filter((row) => rowMatchesFilter(row) && rowMatchesText(row)
    && (!state.turnQuery || String(row.event.turnId ?? '').includes(state.turnQuery)));

  el('record-count').textContent = rows.length === all.length
    ? `${all.length} 行`
    : `${rows.length} / ${all.length} 行`;

  if (rows.length === 0) {
    host.append(textNode('p', 'muted small', '没有匹配的条目。'));
    return;
  }

  let currentTurn = null;
  for (const row of rows.slice(0, MAX_RENDERED_ROWS)) {
    if (row.event.turnId !== currentTurn) {
      currentTurn = row.event.turnId;
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
    host.append(row.kind === 'tool' ? renderToolRow(row) : renderMessageRow(row));
  }

  if (rows.length > MAX_RENDERED_ROWS) {
    host.append(textNode('p', 'muted small', `仅渲染前 ${MAX_RENDERED_ROWS} 行。请用筛选缩小范围。`));
  }
}

function markSelected(node, isTool, position) {
  const selected = state.selected;
  if (!selected || selected.eventIndex !== undefined) {
    if (!selected) return;
    if (node.dataset.eventIndex === String(selected.eventIndex) && !isTool) node.setAttribute('aria-selected', 'true');
    return;
  }
  if (node.dataset.eventIndex === String(selected.eventIndex) && node.dataset.position === String(position)) {
    node.setAttribute('aria-selected', 'true');
  }
}

function renderMessageRow(row) {
  const event = row.event;
  const injected = event.inputKind === 'injected';
  const node = textNode('div', `srow srow-message${injected ? ' is-injected' : ''}${event.role === 'user' ? ' is-user' : ''}`);
  node.dataset.eventIndex = String(event.index);
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

  const flags = textNode('div', 'srow-flags');
  if (event.hasThinking && text) flags.append(textNode('span', 'tool-tag is-think', '思考'));
  if (event.kind === 'compaction') flags.append(textNode('span', 'tool-tag is-compact', '压缩'));
  if (event.kind === 'compaction_failed') flags.append(textNode('span', 'tool-tag is-fail', '压缩失败'));
  if (flags.childElementCount) body.append(flags);
  node.append(body);

  const meta = textNode('div', 'srow-meta');
  if (event.requestDurationMs) meta.append(textNode('div', '', fmtMs(event.requestDurationMs)));
  if (event.thinkingDurationMs) meta.append(textNode('div', 'is-think', `思 ${fmtMs(event.thinkingDurationMs)}`));
  if (event.usage?.outputTokens) meta.append(textNode('div', 'is-dim', `${fmtTokens(event.usage.outputTokens)} tok`));
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
  node.dataset.toolCallId = call.id ?? '';
  markSelected(node, true, position);

  const badge = textNode('div', 'srow-badge');
  badge.append(textNode('span', 'badge badge-tool', 'TOOL'));
  node.append(badge);

  const body = textNode('div', 'srow-body');
  const head = textNode('div', 'srow-tool-head');
  head.append(textNode('span', 'tool-name', call.name ?? 'tool'));
  const payload = payloadPreview(call.args) || call.description;
  if (payload) {
    head.append(textNode('span', 'tool-arrow', '▸'));
    const payloadNode = textNode('span', 'tool-payload', oneLine(payload, 150));
    payloadNode.title = typeof call.args === 'string' ? call.args.slice(0, 2000) : '';
    head.append(payloadNode);
  }
  if (parsed.text) {
    head.append(textNode('span', 'tool-arrow', '⇉'));
    const resultNode = textNode('span', `tool-result${parsed.failed ? ' is-fail' : ''}`, oneLine(parsed.text, 160));
    resultNode.title = parsed.text.slice(0, 2000);
    head.append(resultNode);
  }
  body.append(head);

  if (parsed.signal) {
    body.append(textNode('span', `sig sig-${parsed.severity}`, `⚠ ${parsed.signal}`));
  }
  node.append(body);

  const meta = textNode('div', 'srow-meta');
  if (call.durationMs !== null) meta.append(textNode('div', '', fmtMs(call.durationMs)));
  else meta.append(textNode('div', 'is-dim', '—'));
  if (call.agentName) meta.append(textNode('div', 'is-sub', `↳ ${call.agentName}`));
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
  renderStream();
  el('inspector').setAttribute('data-open', 'true');
  document.body.dataset.inspector = 'true';
  renderInspector();
}

function closeInspector() {
  el('inspector').setAttribute('data-open', 'false');
  document.body.dataset.inspector = 'false';
  state.selected = null;
  renderStream();
}

function focusToolCall(toolCallId) {
  for (const event of state.events) {
    const position = (event.toolCalls ?? []).findIndex((call) => call.id === toolCallId);
    if (position >= 0) {
      openInspector({ kind: 'tool', eventIndex: event.index, position });
      const node = el('stream').querySelector(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
  }
  banner('未在当前已加载记录中找到该工具调用。');
  return false;
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
  else if (state.tab === 'payload') renderPayloadTab(body, event, call);
  else if (state.tab === 'result') renderResultTab(body, event, call);
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
    section.append(bars);
  }
  body.append(section);
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
  await loadOverview();
}

async function loadOverview() {
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
  renderStats(payload.stats);
  renderCapability(payload.agent);
  renderSessions();
  await refreshEvents();
}

async function refreshEvents() {
  const detail = state.detailLevel === 'full' ? '&detailLevel=full' : '';
  const payload = await api(`/api/events?id=${encodeURIComponent(state.sessionId)}&limit=1000${detail}`);
  state.events = payload.events ?? [];
  renderOverview(state.events, state.tasks);
  renderStream();
  if (state.selected) renderInspector();
  if (payload.source === 'jsonl') {
    banner('该会话未进入 SQLite 投影，已回退到 messages.jsonl。计时与任务关联可能缺失。');
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
    const keys = [...new Set(visibleSessions().map((session) => session.groupKey ?? `path:${session.workspaceDir ?? ''}`))];
    const allCollapsed = keys.length > 0 && keys.every((key) => state.collapsed.has(key));
    for (const key of keys) {
      if (allCollapsed) state.collapsed.delete(key);
      else state.collapsed.add(key);
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

  el('stream').parentElement.addEventListener('click', (event) => {
    const button = event.target.closest('.chip[data-filter]');
    if (!button) return;
    for (const chip of el('stream').parentElement.querySelectorAll('.chip[data-filter]')) {
      chip.classList.toggle('is-on', chip === button);
    }
    state.rowFilter = button.dataset.filter ?? 'all';
    renderStream();
  });

  el('turn-jump').addEventListener('input', (event) => {
    state.turnQuery = event.target.value.trim();
    renderStream();
  });

  el('text-filter').addEventListener('input', (event) => {
    state.textQuery = event.target.value.trim();
    renderStream();
  });

  el('failure-jump').addEventListener('click', () => {
    const button = el('stream').parentElement.querySelector('.chip[data-filter="failed"]');
    if (button) button.click();
    const first = el('stream').querySelector('.srow-tool.is-fail');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  el('ins-close').addEventListener('click', closeInspector);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeInspector();
  });
}

async function boot() {
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
