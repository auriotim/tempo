// Run: node core/planning.test.js
const assert = require('node:assert/strict');
const P = require('./planning.js');

const today = '2026-09-19'; // Saturday
const now = '2026-09-19T18:00:00.000Z';

// Periods
assert.equal(P.periodStart('week', today), '2026-09-14');
assert.equal(P.periodStart('week', '2026-09-20'), '2026-09-14'); // Sunday belongs to the prior Monday
assert.equal(P.periodStart('month', today), '2026-09-01');
assert.equal(P.periodStart('quarter', today), '2026-07-01');
assert.equal(P.periodStart('year', today), '2026-01-01');
assert.equal(P.periodEnd('quarter', '2026-07-01'), '2026-09-30');
assert.equal(P.periodEnd('month', '2028-02-01'), '2028-02-29');
assert.equal(P.shiftPeriod('quarter', '2026-10-01', 1), '2027-01-01');
assert.equal(P.shiftPeriod('month', '2026-01-01', -1), '2025-12-01');
assert.equal(P.periodTitle('week', '2026-09-21', today), 'Next Week');
assert.equal(P.periodTitle('quarter', '2026-07-01', today), 'This Quarter');
assert.equal(P.periodTitle('month', '2026-11-01', today), 'November 2026');
assert.equal(P.planChip({ unit: 'quarter', start: '2027-01-01' }, today), "Q1 '27");

// Scheduling round-trip
const base = { id: 'a', title: 'x', clientId: 'c1', archivedAt: null, weekOf: null };
const m = P.withPlan(base, 'month', '2026-09-19', now);
assert.deepEqual([m.weekOf, m.planUnit, m.planStart], [null, 'month', '2026-09-01']);
const w = P.withPlan(m, 'week', '2026-09-17', now);
assert.deepEqual([w.weekOf, w.planUnit, w.planStart], ['2026-09-14', null, null]);

// Classification
const wk = P.period('week', '2026-09-14');
const mo = P.period('month', '2026-09-01');
assert.equal(P.classify(base, wk, today).column, 'backlog');
assert.equal(P.classify(w, wk, today).column, 'plan');
assert.equal(P.classify(w, mo, today).column, 'plan');            // week inside month
assert.equal(P.classify(m, wk, today).column, 'backlog');         // coarser plan shows in backlog
const past = { ...base, weekOf: '2026-08-03' };
assert.deepEqual(P.classify(past, wk, today), { column: 'plan', carried: true });
assert.equal(P.classify(past, P.period('week', '2026-09-21'), today).column, null); // not carried into future views
const future = P.withPlan(base, 'week', '2026-09-28', now);
assert.equal(P.classify(future, wk, today).column, null);
const { done, next } = P.completeItem({ ...w, recurring: true, recurFrequency: 'weekly', dueDate: '2026-09-18' }, now, 'b');
assert.equal(P.classify(done, wk, today).column, 'done');
assert.equal(P.classify(done, P.period('week', '2026-09-21'), today).column, null);
assert.deepEqual([next.id, next.weekOf, next.dueDate, next.archivedAt], ['b', null, '2026-09-25', null]);
assert.equal(P.classify({ ...base, archivedAt: now }, wk, today).column, null); // shelved, not done

// Board
const board = P.buildBoard({
  items: [w, past, m, done, { ...base, id: 'u', clientId: 'ghost', projectId: 'gone', urgent: true }],
  clients: [{ id: 'c1', name: 'Sesame' }],
  projects: [],
  unit: 'week', today, nowIso: now,
});
assert.deepEqual(board.totals, { backlog: 2, plan: 2, done: 1 });
assert.equal(board.lanes[0].name, 'Sesame');
assert.equal(board.lanes[1].name, 'No client');
assert.equal(board.lanes[1].subs[0].name, 'No project');
assert.equal(board.attention, 1);
assert.deepEqual(board.lanes[0].cells.plan.map((c) => [c.item.weekOf, c.projectName]).sort(), [['2026-08-03', null], ['2026-09-14', null]]);
assert.equal(board.lanes[0].cells.plan.length + board.lanes[0].cells.backlog.length + board.lanes[0].cells.done.length, board.lanes[0].total);
assert.equal(board.view.title, 'This Week');

const seeded = P.buildBoard({
  items: [], unit: 'month', today, nowIso: now, includeEmpty: true,
  clients: [{ id: 'c1', name: 'Sesame' }, { id: 'c2', name: 'URWay' }],
  projects: [{ id: 'p2', clientId: 'c2', name: 'Lab' }, { id: 'p1', clientId: 'c1', name: 'General' }],
});
assert.deepEqual(seeded.lanes.map((l) => [l.name, l.total, l.subs.map((s) => s.name).join()]), [['Sesame', 0, 'General'], ['URWay', 0, 'Lab']]);
assert.equal(seeded.view.title, 'This Month');

// Time against backlog items
assert.deepEqual(P.hoursByItem([{ backlogItemId: 'x', hours: 1.5 }, { backlogItemId: 'x', hours: 0.5 }, { hours: 3 }]), { x: 2 });
const sugg = P.timeSuggestions({
  items: [
    { id: 's1', title: 'Backlog thing', clientId: 'c1', archivedAt: null },
    { id: 's2', title: 'Planned thing', clientId: 'c1', archivedAt: null, weekOf: '2026-09-14' },
    { id: 's3', title: 'Done thing', clientId: 'c1', archivedAt: now, completedAt: now },
    { id: 's4', title: 'Old done', clientId: 'c1', archivedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:00Z' },
    { id: 's5', title: 'Other client', clientId: 'c2', archivedAt: null },
    { id: 's6', title: 'Shelved', clientId: 'c1', archivedAt: now },
  ],
  clientId: 'c1', today, nowIso: now,
});
assert.deepEqual(sugg.map((s) => s.item.id), ['s2', 's1', 's3']);
assert.deepEqual(P.timeSuggestions({ items: [{ id: 'a', title: 'Alpha', clientId: 'c1', archivedAt: null }], clientId: 'c1', query: 'LPH', today, nowIso: now }).length, 1);

console.log('planning core: all tests pass');
