/**
 * Shared client state and the constants every surface is bounded by.
 *
 * Leaf module — imports nothing, so anything in `js/` may import it without a
 * cycle. The single `state` object is mutated in place by the surfaces; readers
 * never hold a copy.
 */

const API_HEADER = { 'x-trajectory-client': '1' };

/** Timeline lane packing. */
const MAX_LANE_ROWS = 8;
const LANE_ROW_PX = 17;
/** Stream rows rendered per batch. The rest load as the reader scrolls. */
const STREAM_PAGE = 150;
/** Records fetched per request. Only what will be rendered is fetched. */
const EVENT_PAGE = 200;
const MAX_STREAM_ROWS = 6000;

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
  collapsed: new Set(),
  expanded: new Set(),
  tab: 'summary',
  // Stream is cached and paged: rows are rebuilt only when the session's events
  // change, and only STREAM_PAGE of them enter the DOM at a time.
  streamRows: [],
  filteredRows: null,
  renderedRows: 0,
  lastTurn: undefined,
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

export { API_HEADER, MAX_LANE_ROWS, LANE_ROW_PX, STREAM_PAGE, EVENT_PAGE, MAX_STREAM_ROWS, state, el };
