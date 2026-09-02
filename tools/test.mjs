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
  repeatableLoad,
  repsAtLoad,
  baselineWeight,
  ACTIONS,
} from '../js/engine/progression.js';

import {
  contextKey, compareLoads, markDiscontinuities, segments, DEFAULT_CONTEXT,
} from '../js/engine/context.js';

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

/* --- Baseline set override ---------------------------------------------
   The other half of "which weight do we carry forward". Sets logged as a ramp
   put a one-off probe at the top, and `workingWeight` would prescribe that
   probe for every set of the next session. `baselineSetIndex` nominates the
   set to build on instead. See js/config.WORKING_SET_REBASELINE.
   ====================================================================== */

/** A ramped session: one load per set, as Rish logged Week 1. */
function ramp(weights, reps, { date = '2026-08-01' } = {}) {
  return {
    date,
    isDeload: false,
    sets: weights.map((weightKg, index) => ({
      weightKg,
      reps: reps[index],
      completed: true,
    })),
  };
}

test('baselineWeight defaults to the repeatable load, not the heaviest set', () => {
  // A week-one ramp logged as working sets. The heaviest set was a probe; the
  // load that would survive four sets is the second rung.
  assert.equal(baselineWeight(ramp([150, 180, 200, 220], [12, 10, 8, 6])), 180);
  assert.equal(workingWeight(ramp([150, 180, 200, 220], [12, 10, 8, 6])), 220,
    'the heaviest set is still reported as such');
});

test('baselineWeight reads the nominated set, 1-based', () => {
  const entry = ramp([150, 180, 200, 220], [12, 10, 8, 6]);
  assert.equal(baselineWeight(entry, 1), 150);
  assert.equal(baselineWeight(entry, 2), 180);
  assert.equal(baselineWeight(entry, 4), 220);
});

test('baselineWeight takes the nominated set even when a later one is lighter', () => {
  // Logged 36/57/50: set 2 is the heaviest here, and the rule still says set 2.
  assert.equal(baselineWeight(ramp([36, 57, 50], [12, 7, 10]), 2), 57);
});

test('baselineWeight counts completed sets only, in logged order', () => {
  const entry = {
    date: '2026-08-01',
    sets: [
      { weightKg: 11.3, reps: 12, completed: true },
      { weightKg: 15.9, reps: 4, completed: false },   // abandoned, skipped
      { weightKg: 13.6, reps: 10, completed: true },
    ],
  };
  assert.equal(baselineWeight(entry, 2), 13.6);
});

test('baselineWeight falls back to the repeatable load when the index cannot answer', () => {
  const short = ramp([40], [8]);
  assert.equal(baselineWeight(short, 2), 40, 'fewer sets than the index');

  const bodyweight = { date: '2026-08-01', sets: [
    { weightKg: null, reps: 6, completed: true },
    { weightKg: null, reps: 6, completed: true },
  ] };
  assert.equal(baselineWeight(bodyweight, 2), null, 'nothing loaded to read');

  assert.equal(baselineWeight(ramp([20, 25], [8, 8]), 0), 20, 'index 0 is not a set');
});

test('a ramp logged as working sets prescribes the repeatable rung by default', () => {
  const squat = exercise({
    id: 'hack-squat', equipment: 'machine', loadEntry: 'machine', sets: 4,
  });
  const week1 = [ramp([150, 180, 200, 220], [12, 10, 8, 6])];

  const asLogged = recommend(squat, week1, { setCount: 4 });
  assert.equal(asLogged.action, ACTIONS.HOLD);
  assert.equal(asLogged.weightKg, 180, 'the second rung, with no dated override needed');
  assert.match(asLogged.reason, /load you actually repeated/, 'the card says why');
  assert.equal(asLogged.previous.topWeightKg, 220, 'what was lifted is still reported');

  // The explicit override still works, and now agrees with the default.
  const rebased = recommend(squat, week1, { setCount: 4, baselineSetIndex: 2 });
  assert.equal(rebased.weightKg, 180);
  assert.match(rebased.reason, /working set 2/, 'an explicit override names the set');
});

test('one set at the repeatable load does not earn an advance', () => {
  // 40/50/55 at 8/8/8 is a ramp shape: only one set was performed at 50, so 50
  // has not been held for three sets and 55 was never held twice at all.
  const press = exercise({ sets: 3 });
  const result = recommend(press, [ramp([40, 50, 55], [8, 8, 8])], { setCount: 3 });

  assert.equal(result.action, ACTIONS.HOLD, 'not an advance on one qualifying set');
  assert.equal(result.weightKg, 50, 'held at the repeatable load');
  assert.match(result.reason, /1 of 3 sets/, 'and it says why it is not earned');
});

test('the override is a no-op on sets that were already flat', () => {
  const flat = [performance(27.5, [8, 8, 7, 6])];
  const plain = recommend(exercise(), flat);
  const rebased = recommend(exercise(), flat, { baselineSetIndex: 2 });

  assert.deepEqual(rebased, plain, 'same prescription, and no note bolted on');
});

test('the override leaves rep targets and stall detection alone', () => {
  const history = [
    ramp([150, 180, 200], [8, 8, 7], { date: '2026-08-01' }),
    ramp([150, 180, 200], [8, 8, 7], { date: '2026-07-25' }),
    ramp([150, 180, 200], [8, 8, 7], { date: '2026-07-18' }),
    ramp([150, 180, 200], [8, 8, 7], { date: '2026-07-11' }),
  ];
  const squat = exercise({ equipment: 'barbell', loadEntry: 'plates', sets: 3 });

  const plain = recommend(squat, history, { setCount: 3 });
  const rebased = recommend(squat, history, { setCount: 3, baselineSetIndex: 2 });

  assert.equal(plain.action, ACTIONS.DELOAD_STALL, 'four flat sessions is a stall');
  assert.equal(rebased.action, plain.action, 'the override does not hide a stall');
  assert.equal(rebased.stalledSessions, plain.stalledSessions);
  assert.deepEqual(rebased.perSetReps, plain.perSetReps);
  // 180 x 0.9 = 162, rounded to the 2.5 kg step. Off 200 it would be 180.
  assert.equal(rebased.weightKg, 162.5, '10% off the 180 kg baseline, not off 200');
});

/* --- Repeatable load vs heaviest set -----------------------------------
   The bug this section exists for: a single 72 kg flat dumbbell bench set
   logged among 55 kg working sets became the prescription for all three sets of
   the following week, at a load that had never been held twice.
   ====================================================================== */

test('repeatableLoad reads the load at least half the sets were performed at', () => {
  assert.equal(repeatableLoad(performance(55, [8, 8, 8])), 55, 'uniform sets');
  assert.equal(repeatableLoad(ramp([55, 55, 72], [9, 8, 5])), 55, 'two working sets and a probe');
  assert.equal(repeatableLoad(ramp([150, 180, 200, 220], [12, 10, 8, 6])), 180, 'a ramp');
  assert.equal(repeatableLoad(ramp([45, 55], [12, 5])), 45, 'neither load repeated');
  assert.equal(repeatableLoad({ sets: [] }), null, 'nothing logged');

  const bodyweight = { sets: [{ weightKg: null, reps: 8, completed: true }] };
  assert.equal(repeatableLoad(bodyweight), null, 'bodyweight work carries no load');
});

test('a set marked as a top set is excluded outright', () => {
  const entry = {
    sets: [
      { weightKg: 55, reps: 9, completed: true, kind: 'working' },
      { weightKg: 55, reps: 8, completed: true, kind: 'working' },
      { weightKg: 55, reps: 8, completed: true, kind: 'working' },
      { weightKg: 72, reps: 5, completed: true, kind: 'top' },
    ],
  };
  assert.equal(repeatableLoad(entry), 55, 'the probe does not vote');
  assert.equal(workingWeight(entry), 72, 'but it is still the heaviest set lifted');
});

test('every set marked as a top set still yields a prescription', () => {
  const entry = {
    sets: [
      { weightKg: 60, reps: 5, completed: true, kind: 'top' },
      { weightKg: 70, reps: 3, completed: true, kind: 'top' },
    ],
  };
  assert.equal(repeatableLoad(entry), 60, 'falls back rather than returning nothing');
});

test("the real flat-bench regression: 55/55/72 prescribes 55, not 72", () => {
  const bench = exercise({
    id: 'flat-dumbbell-bench-press', sets: 3,
    reps: { min: 8, max: 10, label: '8-10' },
    progression: { mode: 'weight', increment: { min: 2, max: 2.5 } },
  });

  const result = recommend(bench, [
    ramp([55, 55, 72], [9, 8, 5], { date: '2026-08-25' }),
    performance(55, [8, 6, 6], { date: '2026-08-18' }),
  ], { setCount: 3 });

  assert.equal(result.action, ACTIONS.HOLD);
  assert.equal(result.weightKg, 55, 'the load actually repeated');
  assert.deepEqual(result.perSetReps, [10, 9, 8],
    'set three gets the weakest reading at 55, not the 5 reps done at 72');
  assert.equal(result.previous.topWeightKg, 72, 'the probe is still on the record');
});

test('reps performed at another load cannot set a target for this one', () => {
  assert.deepEqual(repsAtLoad(ramp([55, 55, 72], [9, 8, 5]), 55), [9, 8, null]);
  assert.deepEqual(repsAtLoad(ramp([72, 55, 55], [5, 9, 8]), 55), [null, 9, 8]);
});

test('a top set placed first does not block an earned advance', () => {
  // Worked up to a probe, then three clean sets at the working load.
  const press = exercise({ sets: 3, reps: { min: 6, max: 8, label: '6-8' } });
  const result = recommend(press, [ramp([70, 55, 55, 55], [4, 8, 8, 8])], { setCount: 3 });

  assert.equal(result.action, ACTIONS.ADVANCE, 'three sets at 55 hit the top of the range');
  assert.equal(result.weightKg, 60, '55 + the 5 kg stored step');
});

test('one strong set does not carry a session: 12/8/8 is not 12/12/12', () => {
  const curl = exercise({
    id: 'hammer-curl', sets: 3, reps: { min: 10, max: 12, label: '10-12' },
    progression: { mode: 'weight', increment: { min: 1, max: 2 } },
  });

  const uneven = recommend(curl, [performance(25, [12, 8, 8])], { setCount: 3 });
  const even = recommend(curl, [performance(25, [12, 12, 12])], { setCount: 3 });

  assert.equal(uneven.action, ACTIONS.HOLD, '12/8/8 holds');
  // 8 + 1 is still below the prescribed 10, so those sets target the bottom of
  // the range rather than a number the program never asked for.
  assert.deepEqual(uneven.perSetReps, [12, 10, 10]);
  assert.match(uneven.reason, /12\/8\/8/, 'the reason names the spread');
  assert.equal(even.action, ACTIONS.ADVANCE, '12/12/12 earns the load');
});

test('planned and performed loads are both reported, not merged', () => {
  const press = exercise({ id: 'incline-smith-machine-press', equipment: 'smith-machine',
    loadEntry: 'plates', sets: 4 });

  const performed = { ...performance(45, [8, 8, 7, 6], { date: '2026-08-29' }), targetWeightKg: 40 };
  const result = recommend(press, [performed], { setCount: 4 });

  assert.equal(result.previous.targetWeightKg, 40, 'the plan survives');
  assert.equal(result.previous.weightKg, 45, 'so does what was actually done');
  assert.deepEqual(result.previous.deviation, { plannedKg: 40, performedKg: 45, deltaKg: 5 });
  assert.equal(result.weightKg, 45, 'today builds on the performance');
  assert.match(result.reason, /planned at 40 kg and performed at 45 kg/);
});

test('no deviation is reported when the plan was followed', () => {
  const press = exercise({ sets: 3 });
  const followed = { ...performance(50, [7, 7, 7], { date: '2026-08-29' }), targetWeightKg: 50 };
  const result = recommend(press, [followed], { setCount: 3 });

  assert.equal(result.previous.deviation, null);
  assert.doesNotMatch(result.reason, /planned at/);
});

/* --- Load scales that are not comparable -------------------------------- */

test('compareLoads separates a machine change from a programmed increment', () => {
  assert.equal(compareLoads(4.5, 10).discontinuous, true, 'a different cable stack');
  assert.equal(compareLoads(9.1, 20).discontinuous, true);
  assert.equal(compareLoads(20, 50).discontinuous, true);
  assert.equal(compareLoads(18.1, 40).discontinuous, true);

  assert.equal(compareLoads(13.6, 15.9).discontinuous, false, '30 lb to 35 lb is training');
  assert.equal(compareLoads(4.5, 5.5).discontinuous, false, 'small load, small absolute step');
  assert.equal(compareLoads(180, 182.5).discontinuous, false);
  assert.equal(compareLoads(57, 57).discontinuous, false);
  assert.equal(compareLoads(null, 20).discontinuous, false, 'nothing to compare against');
});

test('a cable load that doubles is re-anchored, not treated as progress', () => {
  const fly = exercise({
    id: 'low-to-high-cable-fly', equipment: 'cable', loadType: 'per-hand',
    loadEntry: 'machine', sets: 3, reps: { min: 12, max: 15, label: '12-15' },
    progression: { mode: 'weight', increment: { min: 1, max: 2 } },
  });

  const result = recommend(fly, [
    performance(10, [15, 15, 15], { date: '2026-09-01' }),
    performance(4.5, [14, 14, 13], { date: '2026-08-25' }),
    performance(4.5, [13, 13, 12], { date: '2026-08-18' }),
  ], { setCount: 3 });

  assert.equal(result.action, ACTIONS.RE_ANCHOR, 'not an advance off a scale change');
  assert.equal(result.weightKg, 10, 'works from the reading actually logged');
  assert.equal(result.previous.discontinuous, true);
  assert.match(result.reason, /different machine/);
});

test('the same jump on dumbbells is read as training, because 10 kg is 10 kg', () => {
  const raise = exercise({
    id: 'dumbbell-lateral-raise', equipment: 'dumbbell', loadEntry: 'total-both',
    sets: 3, reps: { min: 12, max: 15, label: '12-15' },
    progression: { mode: 'weight', increment: { min: 1, max: 2 } },
  });

  const result = recommend(raise, [
    performance(20, [15, 15, 15], { date: '2026-09-01' }),
    performance(14, [13, 13, 12], { date: '2026-08-25' }),
  ], { setCount: 3 });

  assert.equal(result.action, ACTIONS.ADVANCE, 'a dumbbell reading is a mass, not a scale');
});

test('no stall is counted across a load scale change', () => {
  const pushdown = exercise({
    id: 'rope-triceps-pushdown', equipment: 'cable', loadEntry: 'machine',
    sets: 3, reps: { min: 10, max: 12, label: '10-12' },
    progression: { mode: 'weight', increment: { min: 1, max: 2 } },
  });

  // Three flat sessions, then a machine change. Without the break the flat run
  // would deload the new machine's load by 10% for sins committed on another.
  const result = recommend(pushdown, [
    performance(50, [10, 10, 10], { date: '2026-09-01' }),
    performance(9.1, [11, 11, 11], { date: '2026-08-25' }),
    performance(9.1, [11, 11, 11], { date: '2026-08-18' }),
    performance(9.1, [11, 11, 11], { date: '2026-08-11' }),
  ], { setCount: 3 });

  assert.notEqual(result.action, ACTIONS.DELOAD_STALL);
  assert.equal(result.stalledSessions, 0);
});

test('a declared context with no history says so instead of guessing', () => {
  const pushdown = exercise({
    id: 'rope-triceps-pushdown', equipment: 'cable', loadEntry: 'machine', sets: 3,
    reps: { min: 10, max: 12, label: '10-12' },
  });
  const history = [{
    ...performance(9.1, [11, 11, 11], { date: '2026-08-25' }),
    context: { machineId: 'stack-a', label: 'Stack A', attachment: 'rope' },
  }];

  const result = recommend(pushdown, history, {
    setCount: 3,
    contextKey: contextKey({ context: { machineId: 'stack-b', attachment: 'rope' } }),
  });

  assert.equal(result.action, ACTIONS.RE_ANCHOR);
  assert.match(result.reason, /First session logged on this machine/);
});

test('contextKey folds case and spacing, and separates attachments', () => {
  assert.equal(contextKey(null), DEFAULT_CONTEXT);
  assert.equal(contextKey({}), DEFAULT_CONTEXT);
  assert.equal(
    contextKey({ context: { machineId: 'Stack A', attachment: 'Rope' } }),
    contextKey({ context: { machineId: 'stack  a', attachment: 'rope' } })
  );
  assert.notEqual(
    contextKey({ context: { machineId: 'stack-a', attachment: 'rope' } }),
    contextKey({ context: { machineId: 'stack-a', attachment: 'bar' } })
  );
  assert.notEqual(
    contextKey({ substitution: { performedId: 'bar-triceps-pushdown', comparableLoad: false } }),
    DEFAULT_CONTEXT
  );
});

test('markDiscontinuities and segments break the series where the scale changed', () => {
  const marked = markDiscontinuities([
    { date: '2026-08-11', loadKg: 9.1 },
    { date: '2026-08-18', loadKg: 9.1 },
    { date: '2026-08-25', loadKg: 20 },
    { date: '2026-09-01', loadKg: 21 },
  ]);

  assert.deepEqual(marked.map((point) => point.discontinuous), [false, false, true, false]);
  assert.deepEqual(segments(marked).map((run) => run.points.length), [2, 2]);
});

test('detection is off for movements whose numbers are a mass', () => {
  const marked = markDiscontinuities(
    [{ date: '2026-08-01', loadKg: 20 }, { date: '2026-08-08', loadKg: 45 }],
    { machineScaled: false }
  );
  assert.equal(marked[1].discontinuous, false);
  assert.equal(marked[1].comparable, true);
});

/* --- Maintained work ---------------------------------------------------- */

test('a maintained movement holds its load and never advances', () => {
  const pallof = exercise({
    id: 'pallof-press', equipment: 'cable', loadType: 'total', loadEntry: 'machine',
    sets: 2, reps: { min: 12, max: 12, perSide: true, label: '12/side' },
    progression: { mode: 'maintain', increment: { min: 1, max: 2 } },
  });

  const result = recommend(pallof, [performance(15, [12, 12], { date: '2026-09-01' })], {
    setCount: 2,
  });

  assert.equal(result.action, ACTIONS.MAINTAIN);
  assert.equal(result.weightKg, 15, 'holds the load it was logged at');
  assert.deepEqual(result.perSetReps, [12, 12]);
  assert.match(result.reason, /Not a progression lift/);
  assert.equal(result.stalledSessions, 0);
});

test('a maintained movement never earns an advance, even at the top of its range', () => {
  const pallof = exercise({
    id: 'pallof-press', loadEntry: 'machine', sets: 2,
    reps: { min: 12, max: 12, label: '12/side' },
    progression: { mode: 'maintain', increment: { min: 1, max: 2 } },
  });
  const done = [
    { weightKg: 15, reps: 12, completed: true },
    { weightKg: 15, reps: 12, completed: true },
  ];
  assert.equal(earnedAdvance(pallof, done), false);
});

test('a maintained movement never stall-deloads', () => {
  const pallof = exercise({
    id: 'pallof-press', loadEntry: 'machine', sets: 2,
    reps: { min: 12, max: 12, label: '12/side' },
    progression: { mode: 'maintain', increment: { min: 1, max: 2 } },
  });
  const flat = ['2026-09-01', '2026-08-25', '2026-08-18', '2026-08-11']
    .map((date) => performance(15, [12, 12], { date }));

  assert.equal(recommend(pallof, flat, { setCount: 2 }).action, ACTIONS.MAINTAIN);
});

test('a maintained movement still respects the deload week', () => {
  const pallof = exercise({
    id: 'pallof-press', loadEntry: 'machine', sets: 2,
    reps: { min: 12, max: 12, label: '12/side' },
    progression: { mode: 'maintain', increment: { min: 1, max: 2 } },
  });
  const result = recommend(pallof, [performance(20, [12, 12])], { setCount: 2, isDeload: true });
  assert.equal(result.weightKg, 13, '20 kg at ~65%, rounded to the 1 kg step');
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
