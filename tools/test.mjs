/**
 * tools/test.mjs — Tests for the pure engine modules.
 *
 * Run with Node's built-in test runner, no dependencies:
 *
 *     node --test tools/test.mjs
 *     node tools/test.mjs          (same thing; the runner auto-detects)
 *
 * Only genuinely pure logic is tested here. The progression engine is the one
 * place in this app where a quiet mistake would corrupt years of training
 * decisions, so it gets assertions rather than a glance at the screen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recommend,
  nextRepTargets,
  countStalledSessions,
  earnedAdvance,
  repRange,
  incrementFor,
  programIncrement,
  workingWeight,
  ACTIONS,
} from '../js/engine/progression.js';

import { estimate1rm, loadForReps } from '../js/engine/one-rep-max.js';

import {
  rollingAverage, trendPerWeek, byWeek, fillWeeks, withinDays,
  summarise, niceBounds, weekStart, shiftDay, daysApart,
} from '../js/engine/analytics.js';

/* --- Fixtures ----------------------------------------------------------- */

/**
 * An exercise shaped like a workouts.json entry.
 *
 * A dumbbell movement, so its stored loads are the total of both dumbbells and
 * its increment is applied on a per-hand basis: the program's "+2.5 kg" means
 * the next pair up, which is 5 kg of stored total. Tests that care about a
 * single-implement increment override `equipment` and `loadEntry`.
 */
function exercise(overrides = {}) {
  return {
    id: 'incline-dumbbell-press',
    name: 'Incline Dumbbell Press',
    equipment: 'dumbbell',
    loadType: 'per-hand',
    loadEntry: 'total-both',
    sets: 4,
    reps: { min: 6, max: 8, perSide: false, label: '6-8' },
    rest: { seconds: 150 },
    progression: { mode: 'weight', increment: { min: 2.5, max: 5 } },
    ...overrides,
  };
}

/** A past performance, as session-service returns it. */
function performance(weightKg, reps, { date = '2026-08-01', isDeload = false } = {}) {
  return {
    date,
    isDeload,
    sets: reps.map((count) => ({ weightKg, reps: count, completed: true })),
  };
}

/* --- The brief's worked example ----------------------------------------- */

test("the brief's worked example: 6-8 range at 27.5 kg, logged 8/8/7/6", () => {
  const result = recommend(exercise(), [performance(27.5, [8, 8, 7, 6])]);

  assert.equal(result.action, ACTIONS.HOLD, 'should hold, not advance');
  assert.equal(result.weightKg, 27.5, 'should stay at 27.5 kg');
  assert.deepEqual(result.perSetReps, [8, 8, 8, 7], 'should target 8/8/8/7');
});

/* --- Rep targets -------------------------------------------------------- */

test('nextRepTargets adds one rep to every set below the top of the range', () => {
  const range = { min: 6, max: 8 };
  assert.deepEqual(nextRepTargets([6, 6, 6, 6], 4, range), [7, 7, 7, 7]);
  assert.deepEqual(nextRepTargets([8, 7, 7, 6], 4, range), [8, 8, 8, 7]);
  assert.deepEqual(nextRepTargets([8, 8, 8, 8], 4, range), [8, 8, 8, 8]);
});

test('nextRepTargets never exceeds the top of the range', () => {
  // A set logged above the prescribed range must not push the target higher.
  assert.deepEqual(nextRepTargets([10, 9], 2, { min: 6, max: 8 }), [8, 8]);
});

test('nextRepTargets starts unlogged sets at the bottom of the range', () => {
  // Set count grew (coming out of a deload), or a set was skipped. The two
  // logged sets still get their +1; the two new ones start at the bottom
  // rather than inheriting a neighbour's number.
  assert.deepEqual(nextRepTargets([7, 7], 4, { min: 6, max: 8 }), [8, 8, 6, 6]);
});

test('a fixed rep prescription holds steady', () => {
  // Face Pull is prescribed a flat 15, not a range. It is a cable movement, so
  // its stored load is the raw stack value and the increment is not scaled.
  const facePull = exercise({
    id: 'face-pull',
    equipment: 'cable',
    loadType: 'total',
    loadEntry: 'machine',
    sets: 3,
    reps: { min: 15, max: 15, label: '15' },
    progression: { mode: 'weight', increment: { min: 1, max: 2 } },
  });
  const result = recommend(facePull, [performance(20, [15, 15, 15])]);
  assert.equal(result.action, ACTIONS.ADVANCE, 'flat 15 across all sets earns the increase');
  assert.equal(result.weightKg, 21, 'adds the 1 kg bottom-of-range increment');
});

/* --- Advancing ---------------------------------------------------------- */

test('all sets at the top of the range advances the load and resets reps', () => {
  const result = recommend(exercise(), [performance(30, [8, 8, 8, 8])]);
  assert.equal(result.action, ACTIONS.ADVANCE);
  // 30 kg of stored total is 15 kg per hand. The +2.5 kg increment is per hand,
  // so the next rung is 17.5 per hand — 35 kg of total. Adding 2.5 to the total
  // would prescribe 16.25 kg dumbbells, which do not exist.
  assert.equal(result.weightKg, 35, 'advances by one dumbbell pair, not half of one');
  assert.deepEqual(result.perSetReps, [6, 6, 6, 6], 'drops back to the bottom of the range');
});

test('the increment defaults to the bottom of the range, not the top', () => {
  // The source document is explicit: '+X kg' is a ceiling, not a schedule.
  assert.equal(programIncrement(exercise()), 2.5, 'the program figure is unscaled');
  assert.equal(
    programIncrement(exercise({ progression: { increment: { min: 1, max: 2 } } })),
    1
  );
});

test('a dumbbell increment is applied per hand, a machine increment as logged', () => {
  // The whole point of the load-entry model: the same "+2.5 kg" in the program
  // document means different things on a dumbbell rack and on a cable stack.
  assert.equal(incrementFor(exercise()), 5, 'dumbbell pair: +2.5 per hand = +5 total');
  assert.equal(
    incrementFor(exercise({ equipment: 'cable', loadEntry: 'machine' })),
    2.5,
    'machine: the stack moves by the figure as written'
  );
  assert.equal(
    incrementFor(exercise({ equipment: 'barbell', loadEntry: 'plates' })),
    2.5,
    'barbell: plates move by the figure as written'
  );
  // Opting out returns to a literal reading of the program document.
  assert.equal(
    incrementFor(exercise(), { dumbbellIncrementBasis: 'total' }),
    2.5,
    'the basis is a preference, not a hardcoded rule'
  );
});

test('hitting the top on only some sets is a hold', () => {
  const result = recommend(exercise(), [performance(30, [8, 8, 8, 7])]);
  assert.equal(result.action, ACTIONS.HOLD);
  assert.equal(result.weightKg, 30);
});

test('logging fewer sets than prescribed is a hold, not an advance', () => {
  // Three sets at the top of the range does not earn a four-set prescription.
  const result = recommend(exercise(), [performance(30, [8, 8, 8])]);
  assert.equal(result.action, ACTIONS.HOLD);
});

/* --- First session ------------------------------------------------------ */

test('no history asks the user to choose a weight', () => {
  const result = recommend(exercise(), []);
  assert.equal(result.action, ACTIONS.START);
  assert.equal(result.weightKg, null, 'must not invent a starting weight');
  assert.deepEqual(result.perSetReps, [6, 6, 6, 6]);
  assert.match(result.reason, /genuinely hard/);
});

/* --- Bodyweight, reps first --------------------------------------------- */

test('a reps-first lift below the top of the range adds reps, not load', () => {
  const pullUps = exercise({
    id: 'pull-ups',
    equipment: 'bodyweight',
    loadType: 'bodyweight-plus-added',
    loadEntry: 'bodyweight-plus-added',
    sets: 4,
    reps: { min: 6, max: 10, label: '6-10' },
    progression: { mode: 'reps-first', increment: { min: 2.5, max: 5 } },
  });

  const result = recommend(pullUps, [performance(0, [8, 7, 6, 6])]);
  assert.equal(result.action, ACTIONS.REPS_FIRST);
  assert.deepEqual(result.perSetReps, [9, 8, 7, 7]);
  assert.match(result.reason, /No added load/);
});

test('a reps-first lift at the top of the range graduates to added load', () => {
  const pullUps = exercise({
    id: 'pull-ups',
    equipment: 'bodyweight',
    loadType: 'bodyweight-plus-added',
    loadEntry: 'bodyweight-plus-added',
    sets: 4,
    reps: { min: 6, max: 10, label: '6-10' },
    progression: { mode: 'reps-first', increment: { min: 2.5, max: 5 } },
  });

  const result = recommend(pullUps, [performance(0, [10, 10, 10, 10])]);
  assert.equal(result.action, ACTIONS.ADVANCE);
  assert.equal(result.weightKg, 2.5, 'starts added load at one increment');
  assert.deepEqual(result.perSetReps, [6, 6, 6, 6]);
  assert.match(result.reason, /belt or vest/);
});

/* --- Stalling ----------------------------------------------------------- */

test('three sessions without improvement drops the load about 10%', () => {
  const history = [
    performance(40, [7, 7, 6, 6], { date: '2026-08-01' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-25' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-18' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-11' }),
  ];

  const result = recommend(exercise(), history);
  assert.equal(result.action, ACTIONS.DELOAD_STALL);
  assert.equal(result.weightKg, 35, '40 kg * 0.9 = 36, nearest 2.5 kg step is 35');
  assert.equal(result.stalledSessions, 3);
});

test('two flat sessions is not yet a stall', () => {
  // Three identical sessions give two flat session-to-session comparisons;
  // the fourth improved, which is where the count stops.
  const history = [
    performance(40, [7, 7, 6, 6], { date: '2026-08-01' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-25' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-18' }),
    performance(40, [6, 6, 6, 6], { date: '2026-07-11' }),
  ];
  const result = recommend(exercise(), history);
  assert.equal(result.action, ACTIONS.HOLD, 'holds rather than dropping the load');
  assert.equal(result.stalledSessions, 2);
});

test('one extra rep anywhere counts as progress and clears the stall', () => {
  const history = [
    performance(40, [7, 7, 7, 6], { date: '2026-08-01' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-25' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-18' }),
    performance(40, [7, 7, 6, 6], { date: '2026-07-11' }),
  ];
  const result = recommend(exercise(), history);
  assert.equal(result.action, ACTIONS.HOLD);
  assert.equal(result.stalledSessions, 0);
});

test('countStalledSessions treats added weight as progress', () => {
  const history = [
    performance(42.5, [6, 6, 6, 6]),
    performance(40, [8, 8, 8, 8]),
  ];
  // Fewer total reps, but heavier — that is the point of the whole scheme.
  assert.equal(countStalledSessions(history, { min: 6, max: 8 }, 4), 0);
});

/* --- Deload week -------------------------------------------------------- */

test('deload week cuts the load to about 65%', () => {
  const result = recommend(
    exercise(),
    [performance(40, [8, 8, 8, 8])],
    { isDeload: true, setCount: 2 }
  );
  assert.equal(result.action, ACTIONS.DELOAD_WAVE);
  assert.equal(result.weightKg, 25, '40 * 0.65 = 26, rounded to the 2.5 kg step');
  assert.deepEqual(result.perSetReps, [6, 6], 'honours the reduced set count');
});

test('a deload session is ignored when judging the next real session', () => {
  // Otherwise the reduced deload load would become the new baseline and the
  // whole program would ratchet downwards every fifth week.
  const history = [
    performance(26, [6, 6], { date: '2026-08-01', isDeload: true }),
    performance(40, [8, 8, 8, 8], { date: '2026-07-25' }),
  ];
  const result = recommend(exercise(), history);
  assert.equal(result.action, ACTIONS.ADVANCE);
  assert.equal(result.weightKg, 45, 'advances from the 40 kg working set, one pair up');
});

/* --- Working weight ----------------------------------------------------- */

test('workingWeight takes the heaviest completed set', () => {
  assert.equal(workingWeight({
    sets: [
      { weightKg: 20, reps: 8, completed: true },
      { weightKg: 25, reps: 8, completed: true },
      { weightKg: 22.5, reps: 7, completed: true },
    ],
  }), 25);
});

test('workingWeight ignores sets that were not completed', () => {
  assert.equal(workingWeight({
    sets: [
      { weightKg: 20, reps: 8, completed: true },
      { weightKg: 60, reps: null, completed: false },
    ],
  }), 20);
});

test('workingWeight is null for unloaded bodyweight work', () => {
  assert.equal(workingWeight({
    sets: [{ weightKg: null, reps: 10, completed: true }],
  }), null);
});

/* --- earnedAdvance ----------------------------------------------------- */

test('earnedAdvance fires only when every prescribed set hits the top', () => {
  const ex = exercise();
  const top = [8, 8, 8, 8].map((reps) => ({ weightKg: 30, reps, completed: true }));
  const short = [8, 8, 8, 7].map((reps) => ({ weightKg: 30, reps, completed: true }));

  assert.equal(earnedAdvance(ex, top), true);
  assert.equal(earnedAdvance(ex, short), false);
});

test('earnedAdvance ignores unticked sets', () => {
  const ex = exercise();
  const sets = [
    { weightKg: 30, reps: 8, completed: true },
    { weightKg: 30, reps: 8, completed: true },
    { weightKg: 30, reps: 8, completed: true },
    { weightKg: 30, reps: 8, completed: false },
  ];
  assert.equal(earnedAdvance(ex, sets), false);
});

/* --- Rep range parsing -------------------------------------------------- */

test('repRange handles both ranges and fixed prescriptions', () => {
  assert.deepEqual(repRange(exercise()), { min: 6, max: 8, label: '6-8', fixed: false });
  assert.deepEqual(
    repRange(exercise({ reps: { min: 15, max: 15 } })),
    { min: 15, max: 15, label: '15', fixed: true }
  );
});

/* --- Estimated 1RM ----------------------------------------------------- */

test('estimate1rm returns the load itself at one rep', () => {
  assert.equal(estimate1rm(100, 1), 100);
});

test('estimate1rm follows Epley', () => {
  // 100 kg x 10 -> 100 * (1 + 10/30) = 133.33
  assert.equal(Math.round(estimate1rm(100, 10) * 100) / 100, 133.33);
});

test('estimate1rm is zero without a load or reps', () => {
  assert.equal(estimate1rm(0, 8), 0);
  assert.equal(estimate1rm(50, 0), 0);
});

test('loadForReps inverts estimate1rm', () => {
  const oneRepMax = estimate1rm(100, 8);
  assert.equal(Math.round(loadForReps(oneRepMax, 8) * 100) / 100, 100);
});

/* --- Analytics: dates --------------------------------------------------- */

test('weekStart returns the Monday of the containing week', () => {
  // 2026-08-05 is a Wednesday.
  assert.equal(weekStart('2026-08-05'), '2026-08-03');
  assert.equal(weekStart('2026-08-03'), '2026-08-03', 'Monday maps to itself');
  assert.equal(weekStart('2026-08-09'), '2026-08-03', 'Sunday belongs to the week that began Monday');
});

test('shiftDay and daysApart cross month and year boundaries', () => {
  assert.equal(shiftDay('2026-08-31', 1), '2026-09-01');
  assert.equal(shiftDay('2027-01-01', -1), '2026-12-31');
  assert.equal(daysApart('2026-08-01', '2026-09-01'), 31);
  assert.equal(daysApart('2026-09-01', '2026-08-01'), -31);
});

/* --- Analytics: rolling average ---------------------------------------- */

test('rollingAverage windows by calendar days, not by sample count', () => {
  // Two readings a week apart, then one the next day. A 7-day window must not
  // include the reading from 8 days earlier.
  const series = [
    { date: '2026-08-01', value: 100 },
    { date: '2026-08-09', value: 80 },
    { date: '2026-08-10', value: 82 },
  ];
  const smoothed = rollingAverage(series, 7, 2);
  assert.equal(smoothed.length, 1, 'only the last point has two readings inside 7 days');
  assert.equal(smoothed[0].date, '2026-08-10');
  assert.equal(smoothed[0].value, 81, 'mean of 80 and 82 — the 100 is out of window');
});

test('rollingAverage respects minSamples', () => {
  const series = [{ date: '2026-08-01', value: 70 }];
  assert.equal(rollingAverage(series, 7, 2).length, 0, 'one reading is not an average');
  assert.equal(rollingAverage(series, 7, 1).length, 1);
});

test('rollingAverage smooths a noisy weight series', () => {
  const series = [
    { date: '2026-08-01', value: 76.0 },
    { date: '2026-08-02', value: 77.0 },
    { date: '2026-08-03', value: 76.5 },
  ];
  const smoothed = rollingAverage(series, 7, 2);
  assert.equal(smoothed.length, 2);
  assert.equal(smoothed[1].value, 76.5, 'mean of all three');
  assert.equal(smoothed[1].count, 3);
});

/* --- Analytics: trend -------------------------------------------------- */

test('trendPerWeek reports over the actual span, not an assumed week', () => {
  const smoothed = [
    { date: '2026-08-01', value: 76 },
    { date: '2026-08-15', value: 77 },
  ];
  const trend = trendPerWeek(smoothed);
  assert.equal(trend.days, 14);
  assert.equal(trend.perWeek, 0.5, '1 kg over 14 days is 0.5 kg/week');
});

test('trendPerWeek needs two points', () => {
  assert.equal(trendPerWeek([{ date: '2026-08-01', value: 76 }]), null);
  assert.equal(trendPerWeek([]), null);
});

/* --- Analytics: bucketing --------------------------------------------- */

test('byWeek groups into Monday-start weeks', () => {
  const items = [
    { date: '2026-08-04', v: 1 },   // Tue
    { date: '2026-08-06', v: 2 },   // Thu
    { date: '2026-08-11', v: 4 },   // next Tue
  ];
  const weeks = byWeek(items, (group) => group.reduce((s, i) => s + i.v, 0));
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].date, '2026-08-03');
  assert.equal(weeks[0].value, 3);
  assert.equal(weeks[1].date, '2026-08-10');
  assert.equal(weeks[1].value, 4);
});

test('fillWeeks inserts missing weeks as zero rather than closing the gap', () => {
  const weeks = [
    { date: '2026-08-03', value: 100, count: 1, label: '3 Aug' },
    { date: '2026-08-24', value: 120, count: 1, label: '24 Aug' },
  ];
  const filled = fillWeeks(weeks);
  assert.equal(filled.length, 4, 'three weeks between, inclusive');
  assert.deepEqual(filled.map((w) => w.value), [100, 0, 0, 120]);
  assert.deepEqual(filled.map((w) => w.date),
    ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24']);
});

test('withinDays keeps an inclusive window ending at endKey', () => {
  const series = [
    { date: '2026-07-01', value: 1 },
    { date: '2026-08-01', value: 2 },
    { date: '2026-08-05', value: 3 },
  ];
  assert.deepEqual(withinDays(series, 30, '2026-08-05').map((p) => p.value), [2, 3]);
  assert.deepEqual(withinDays(series, null, '2026-08-05').map((p) => p.value), [1, 2, 3]);
});

/* --- Analytics: summary and bounds ------------------------------------ */

test('summarise reports the range and the change', () => {
  const stats = summarise([
    { date: '2026-08-01', value: 76 },
    { date: '2026-08-02', value: 78 },
    { date: '2026-08-03', value: 77 },
  ]);
  assert.equal(stats.min, 76);
  assert.equal(stats.max, 78);
  assert.equal(stats.first, 76);
  assert.equal(stats.last, 77);
  assert.equal(stats.change, 1);
  assert.equal(stats.count, 3);
});

test('niceBounds does not force a line axis to zero', () => {
  // A 2 kg move inside a 76-78 band must not be flattened by a zero baseline.
  const bounds = niceBounds([
    { date: '2026-08-01', value: 76 },
    { date: '2026-08-02', value: 78 },
  ]);
  assert.ok(bounds.min > 70, `expected a tight lower bound, got ${bounds.min}`);
  assert.ok(bounds.min < 76 && bounds.max > 78, 'bounds pad the data on both sides');
});

test('niceBounds widens a flat series to a usable span', () => {
  const bounds = niceBounds([
    { date: '2026-08-01', value: 76 },
    { date: '2026-08-02', value: 76 },
  ], { minSpan: 2 });
  assert.ok(bounds.max - bounds.min >= 2, 'a flat line still gets a readable axis');
});

test('summarise and niceBounds tolerate an empty series', () => {
  assert.equal(summarise([]), null);
  assert.deepEqual(niceBounds([]), { min: 0, max: 1 });
});
