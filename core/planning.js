/**
 * Tempo planning core — periods, scheduling, and the backlog board model.
 *
 * Pure functions only: no DOM, no storage, no clock (callers pass `today` /
 * `nowIso`). Loaded by index.html as a plain <script> (global TempoPlanning)
 * and by the MCP server via require(), so every UI shares the same rules.
 *
 * Item scheduling model (stored on backlog items):
 *   weekOf               'YYYY-MM-DD' Monday — week-level plan (legacy field, kept)
 *   planUnit, planStart  'month'|'quarter'|'year' + period start date — coarser plan
 *   completedAt          ISO timestamp — done (archivedAt is also set)
 *   archivedAt           ISO timestamp — out of the active board (done or shelved)
 * At most one plan is set: a week plan clears planUnit/planStart and vice versa.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TempoPlanning = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNITS = ['week', 'month', 'quarter', 'year'];
  const UNIT_NAME = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const COLUMNS = ['backlog', 'plan', 'done'];

  // ── Dates ('YYYY-MM-DD', local calendar) ────────────────────────────────────

  const pad = (n) => String(n).padStart(2, '0');
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parse(s) { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d, 12); }
  function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function addMonths(s, n) { const d = parse(s); d.setDate(1); d.setMonth(d.getMonth() + n); return ymd(d); }
  /** Local calendar date of an ISO timestamp (completedAt etc. are stored in UTC). */
  function localDate(iso) { return iso ? ymd(new Date(iso)) : null; }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }

  // ── Periods ─────────────────────────────────────────────────────────────────

  function periodStart(unit, dateStr) {
    const d = parse(dateStr);
    if (unit === 'week') { const dow = d.getDay(); return addDays(dateStr, dow === 0 ? -6 : 1 - dow); }
    if (unit === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
    if (unit === 'quarter') return `${d.getFullYear()}-${pad(Math.floor(d.getMonth() / 3) * 3 + 1)}-01`;
    if (unit === 'year') return `${d.getFullYear()}-01-01`;
    throw new Error(`Unknown period unit: ${unit}`);
  }
  /** Start of the period `n` periods after the one starting at `start`. */
  function shiftPeriod(unit, start, n) {
    if (unit === 'week') return addDays(start, 7 * n);
    return addMonths(start, n * { month: 1, quarter: 3, year: 12 }[unit]);
  }
  /** Inclusive last day of the period. */
  function periodEnd(unit, start) { return addDays(shiftPeriod(unit, start, 1), -1); }
  function period(unit, start) { return { unit, start, end: periodEnd(unit, start) }; }
  function contains(p, dateStr) { return !!dateStr && dateStr >= p.start && dateStr <= p.end; }

  function periodLabel(unit, start) {
    const d = parse(start), y = d.getFullYear();
    if (unit === 'week') return `Week of ${MONTHS[d.getMonth()]} ${d.getDate()}`;
    if (unit === 'month') return `${MONTHS_LONG[d.getMonth()]} ${y}`;
    if (unit === 'quarter') return `Q${Math.floor(d.getMonth() / 3) + 1} ${y}`;
    return String(y);
  }
  /** Column heading relative to today: "This Week", "Next Month", else the label. */
  function periodTitle(unit, start, today) {
    const offset = periodOffset(unit, start, today);
    if (offset === 0) return `This ${UNIT_NAME[unit]}`;
    if (offset === 1) return `Next ${UNIT_NAME[unit]}`;
    if (offset === -1) return `Last ${UNIT_NAME[unit]}`;
    return periodLabel(unit, start);
  }
  /** Whole periods from today's period to the one starting at `start`. */
  function periodOffset(unit, start, today) {
    const cur = periodStart(unit, today);
    if (unit === 'week') return Math.round(daysBetween(cur, start) / 7);
    const a = parse(cur), b = parse(start);
    const months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
    return Math.round(months / { month: 1, quarter: 3, year: 12 }[unit]);
  }
  /** Compact chip text for an item's plan, e.g. "Wk Sep 14", "Oct", "Q4", "2027". */
  function planChip(plan, today) {
    if (!plan) return '';
    const d = parse(plan.start), y = d.getFullYear();
    const yr = y !== parse(today).getFullYear() ? ` '${String(y).slice(2)}` : '';
    if (plan.unit === 'week') return `Wk ${MONTHS[d.getMonth()]} ${d.getDate()}${yr}`;
    if (plan.unit === 'month') return `${MONTHS[d.getMonth()]}${yr}`;
    if (plan.unit === 'quarter') return `Q${Math.floor(d.getMonth() / 3) + 1}${yr}`;
    return String(y);
  }

  // ── Item scheduling ─────────────────────────────────────────────────────────

  /** The item's plan as a period, or null when unscheduled. */
  function itemPlan(item) {
    if (item.planUnit && item.planUnit !== 'week' && item.planStart) return period(item.planUnit, item.planStart);
    if (item.weekOf) return period('week', periodStart('week', item.weekOf));
    return null;
  }
  function isDone(item) { return !!item.completedAt; }
  function isActive(item) { return !item.archivedAt; }

  function withPlan(item, unit, dateInPeriod, nowIso) {
    const start = periodStart(unit, dateInPeriod);
    const week = unit === 'week';
    return { ...item, weekOf: week ? start : null, planUnit: week ? null : unit, planStart: week ? null : start, lastTouchedAt: nowIso };
  }
  function withoutPlan(item, nowIso) {
    return { ...item, weekOf: null, planUnit: null, planStart: null, lastTouchedAt: nowIso };
  }
  function nextRecurDate(fromStr, freq) {
    if (freq === 'daily') return addDays(fromStr, 1);
    if (freq === 'weekly') return addDays(fromStr, 7);
    if (freq === 'biweekly') return addDays(fromStr, 14);
    if (freq === 'monthly') { const d = parse(fromStr); d.setMonth(d.getMonth() + 1); return ymd(d); }
    return fromStr;
  }
  /**
   * Mark done. Returns { done, next } — `next` is the fresh unscheduled copy
   * for recurring items (caller supplies its id), otherwise null.
   */
  function completeItem(item, nowIso, newId) {
    const done = { ...item, archivedAt: nowIso, completedAt: nowIso, lastTouchedAt: nowIso };
    const freq = item.recurFrequency || item.recurFreq;
    const next = item.recurring && freq
      ? withoutPlan({ ...item, id: newId, archivedAt: null, completedAt: null,
          dueDate: item.dueDate ? nextRecurDate(item.dueDate, freq) : null, createdAt: nowIso }, nowIso)
      : null;
    return { done, next };
  }
  /** Back onto the board; planned into `view` when given, else unscheduled. */
  function reopenItem(item, nowIso, view) {
    const open = { ...item, archivedAt: null, completedAt: null };
    return view ? withPlan(open, view.unit, view.start, nowIso) : withoutPlan(open, nowIso);
  }
  /** Board move: 'backlog' | 'plan' | 'done'. Returns { item, next }. */
  function moveItem(item, column, view, nowIso, newId) {
    if (column === 'done') {
      if (isDone(item)) return { item, next: null };
      const { done, next } = completeItem(item, nowIso, newId);
      return { item: done, next };
    }
    const open = isActive(item) ? item : { ...item, archivedAt: null, completedAt: null };
    if (column === 'plan') return { item: withPlan(open, view.unit, view.start, nowIso), next: null };
    return { item: withoutPlan(open, nowIso), next: null };
  }

  // ── Urgency / ordering ──────────────────────────────────────────────────────

  function daysUntil(dateStr, today) { return dateStr ? daysBetween(today, dateStr) : null; }
  function ageDays(item, nowIso) {
    const ref = item.lastTouchedAt || item.createdAt;
    return ref ? Math.floor((Date.parse(nowIso) - Date.parse(ref)) / 86400000) : 0;
  }
  function isOverdue(item, today) { const d = daysUntil(item.dueDate, today); return d !== null && d < 0; }
  function needsAttention(item, today) { return isActive(item) && (!!item.urgent || isOverdue(item, today)); }
  /** Lower sorts first: overdue, urgent, due within a week, then priority. */
  function sortScore(item, today, nowIso) {
    const d = daysUntil(item.dueDate, today);
    if (d !== null && d < 0) return d - 1000;
    if (item.urgent) return -100;
    if (d !== null && d <= 7) return d;
    const pri = { high: 10, medium: 20, low: 30 }[item.priority] || 20;
    return pri + (ageDays(item, nowIso) > 30 ? -1 : 0);
  }

  // ── Board ───────────────────────────────────────────────────────────────────

  /**
   * Which column an item belongs in when viewing period `view`.
   * Returns { column, carried } — column null means it isn't on this board
   * (planned for another period, or archived without being completed there).
   *  - done:    completed within the view period
   *  - plan:    planned within the view period; or, when the view is the
   *             current period, planned for an earlier one and still open (carried)
   *  - backlog: unscheduled, or planned for a coarser period that spans the view
   */
  function classify(item, view, today) {
    if (!isActive(item)) return { column: isDone(item) && contains(view, localDate(item.completedAt)) ? 'done' : null, carried: false };
    const plan = itemPlan(item);
    if (!plan) return { column: 'backlog', carried: false };
    if (plan.start >= view.start && plan.end <= view.end) return { column: 'plan', carried: false };
    if (plan.end < view.start) return contains(view, today) ? { column: 'plan', carried: true } : { column: null, carried: false };
    if (plan.start <= view.start && plan.end >= view.end) return { column: 'backlog', carried: false };
    return { column: null, carried: false };
  }

  /**
   * Build the swimlane board: one lane per client (in client order, "No client"
   * last), each split into project sub-lanes, each with backlog/plan/done cells.
   * `items` should already be filtered for visibility. Cards are
   * { item, carried, attention, plan, chip, projectName } so renderers need no rules.
   * Each lane also has `cells` — its cards across all projects, sorted.
   * `includeEmpty` adds lanes/sub-lanes for clients and projects with no cards.
   */
  function buildBoard({ items, clients, projects, unit, anchor, today, nowIso, includeEmpty = false }) {
    const view = period(unit, periodStart(unit, anchor || today));
    const projById = new Map(projects.map((p) => [p.id, p]));
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const lanes = new Map();
    const totals = { backlog: 0, plan: 0, done: 0 };
    let later = 0, attention = 0;

    const laneFor = (clientId) => {
      const key = clientById.has(clientId) ? clientId : '__none__';
      if (!lanes.has(key)) {
        const c = clientById.get(key) || null;
        lanes.set(key, { key, client: c, name: c ? c.name : 'No client', color: c ? c.color : null,
          counts: { backlog: 0, plan: 0, done: 0 }, attention: 0, subs: new Map() });
      }
      return lanes.get(key);
    };
    const subFor = (lane, projectId) => {
      const p = projById.get(projectId) || null;
      const key = p ? p.id : '__none__';
      if (!lane.subs.has(key)) lane.subs.set(key, { key, project: p, name: p ? p.name : 'No project',
        counts: { backlog: 0, plan: 0, done: 0 }, cells: { backlog: [], plan: [], done: [] } });
      return lane.subs.get(key);
    };

    // Seed every client and its projects so the board mirrors the client structure.
    if (includeEmpty) {
      for (const c of clients) laneFor(c.id);
      for (const p of projects) if (lanes.has(p.clientId)) subFor(lanes.get(p.clientId), p.id);
    }

    for (const item of items) {
      const { column, carried } = classify(item, view, today);
      if (!column) { if (isActive(item) && itemPlan(item) && itemPlan(item).start > view.end) later++; continue; }
      const plan = itemPlan(item);
      const att = column !== 'done' && needsAttention(item, today);
      const lane = laneFor(item.clientId);
      const sub = subFor(lane, item.projectId);
      // Chip only when the plan differs from the column's own period.
      const chip = plan && !(plan.unit === unit && plan.start === view.start) && column !== 'done' ? planChip(plan, today) : '';
      sub.cells[column].push({ item, carried, attention: att, plan, chip, projectName: sub.project ? sub.project.name : null });
      sub.counts[column]++; lane.counts[column]++; totals[column]++;
      if (att) { lane.attention++; attention++; }
    }

    const byScore = (a, b) => sortScore(a.item, today, nowIso) - sortScore(b.item, today, nowIso);
    const byDone = (a, b) => String(b.item.completedAt).localeCompare(String(a.item.completedAt));
    const clientIdx = new Map(clients.map((c, i) => [c.id, i]));
    const projIdx = new Map(projects.map((p, i) => [p.id, i]));
    const order = (idx) => (a, b) => (idx.has(a.key) ? idx.get(a.key) : 1e9) - (idx.has(b.key) ? idx.get(b.key) : 1e9);

    const laneList = [...lanes.values()].sort(order(clientIdx)).map((lane) => {
      const subs = [...lane.subs.values()].sort(order(projIdx));
      subs.forEach((s) => { s.cells.backlog.sort(byScore); s.cells.plan.sort(byScore); s.cells.done.sort(byDone); });
      const total = lane.counts.backlog + lane.counts.plan + lane.counts.done;
      // Lane-level cells (all projects merged) for the collapsed at-a-glance view.
      const merged = (col, cmp) => subs.flatMap((s) => s.cells[col]).sort(cmp);
      const cells = { backlog: merged('backlog', byScore), plan: merged('plan', byScore), done: merged('done', byDone) };
      return { ...lane, subs, total, cells };
    });

    return {
      view: { ...view, label: periodLabel(unit, view.start), title: periodTitle(unit, view.start, today),
        isCurrent: contains(view, today), offset: periodOffset(unit, view.start, today) },
      totals, later, attention, lanes: laneList,
    };
  }

  // ── Time against backlog items ──────────────────────────────────────────────

  /** Total logged hours per backlog item id (entries carry backlogItemId). */
  function hoursByItem(entries) {
    const out = {};
    for (const e of entries) if (e.backlogItemId) out[e.backlogItemId] = (out[e.backlogItemId] || 0) + (+e.hours || 0);
    return out;
  }

  /**
   * Backlog items to offer when logging time for a client: open items only,
   * filtered by project (if chosen) and by a title substring. Ranked: this
   * week's plan (incl. carried), then backlog by urgency.
   */
  function timeSuggestions({ items, clientId, projectId, query, today, nowIso, limit = 8 }) {
    const week = period('week', periodStart('week', today));
    const q = (query || '').trim().toLowerCase();
    const rank = { plan: 0, backlog: 1 };
    return items
      .filter((i) => isActive(i) && i.clientId === clientId && (!projectId || i.projectId === projectId))
      .filter((i) => !q || String(i.title).toLowerCase().includes(q))
      .map((i) => ({ item: i, column: classify(i, week, today).column === 'plan' ? 'plan' : 'backlog' }))
      .sort((a, b) => rank[a.column] - rank[b.column] || sortScore(a.item, today, nowIso) - sortScore(b.item, today, nowIso))
      .slice(0, limit);
  }

  return {
    UNITS, UNIT_NAME, COLUMNS,
    hoursByItem, timeSuggestions,
    ymd, parse, addDays, localDate,
    periodStart, periodEnd, shiftPeriod, period, contains, periodLabel, periodTitle, periodOffset, planChip,
    itemPlan, isDone, isActive, withPlan, withoutPlan, nextRecurDate, completeItem, reopenItem, moveItem,
    daysUntil, ageDays, isOverdue, needsAttention, sortScore,
    classify, buildBoard,
  };
});
