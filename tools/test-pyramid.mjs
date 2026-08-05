/**
 * tools/test-pyramid.mjs — Tests for pyramid (ramped) set prescriptions.
 *
 *     node --test tools/
 *
 * Some prescriptions ramp the load across sets rather than repeating one
 * weight — Cable Lateral Raise is 10/15/20 kg for 12/10/8 reps. Double
 * progression still applies, but per rung: each set has its own load and its
 * own rep target, and the ladder only moves up once every rung is earned.
 *
 * These tests pin that behaviour because the failure mode is silent: flattening
 * a ladder into a single weight and rep range loses the prescription without
 * anything visibly breaking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recommend, earnedAdvance, ACTIONS } from '../js/engine/progression.js';

/** The Cable Lateral Raise as it appears in workouts.json. */
function ladder(overrides = {}) {
  return {
    id: 'cable-lateral-raise',
    name: 'Cable Lateral Raise',
    equipment: 'cable',
    loadType: 'total',
    sets: 3,
    reps: { min: 8, max: 12, perSide: true, label: '12/10/8' },
    setPlan: [
      { weightKg: 10, reps: 12 },
      { weightKg: 15, reps: 10 },
      { weightKg: 20, reps: 8 },
    ],
    rest: { seconds: 60 },
    progression: { mode: 'weight', increment: { min: 1, max: 2 } },
    ...overrides,
  };
}

/** A logged performance: pairs of [weight, reps], in set order. */
function performance(pairs, { date = '2026-08-01', isDeload = false } = {}) {
  return {
    date,
    isDeload,
    sets: pairs.map(([weightKg, reps]) => ({ weightKg, reps, completed: true })),
  };
}

/* --- First session ------------------------------------------------------- */

test('a ladder starts from its prescribed rungs, not a single weight', () => {
  const result = recommend(ladder(), []);

  assert.equal(result.action, ACTIONS.START);
  assert.equal(result.isPyramid, true);
  assert.deepEqual(result.perSetWeights, [10, 15, 20]);
  assert.deepEqual(result.perSetReps, [12, 10, 8]);
  // The headline figure is the heaviest rung — what the card shows as "target".
  assert.equal(result.weightKg, 20);
  assert.match(result.reason, /10 kg x 12, 15 kg x 10, 20 kg x 8/);
});

/* --- Holding ------------------------------------------------------------- */

test('missing one rung holds the whole ladder', () => {
  // Top rung short by one rep.
  const result = recommend(ladder(), [performance([[10, 12], [15, 10], [20, 7]])]);

  assert.equal(result.action, ACTIONS.HOLD);
  assert.deepEqual(result.perSetWeights, [10, 15, 20], 'loads unchanged');
  assert.deepEqual(result.perSetReps, [12, 10, 8], 'met rungs keep their target');
});

test('a rung below target gets one more rep, capped at its own target', () => {
  const result = recommend(ladder(), [performance([[10, 10], [15, 8], [20, 6]])]);

  assert.equal(result.action, ACTIONS.HOLD);
  // Each rung climbs toward its OWN target, not a shared range top.
  assert.deepEqual(result.perSetReps, [11, 9, 7]);
});

/* --- Advancing ----------------------------------------------------------- */

test('every rung at target advances the whole ladder by one increment', () => {
  const result = recommend(ladder(), [performance([[10, 12], [15, 10], [20, 8]])]);

  assert.equal(result.action, ACTIONS.ADVANCE);
  assert.deepEqual(result.perSetWeights, [11, 16, 21], 'each rung gains 1 kg');
  assert.deepEqual(result.perSetReps, [12, 10, 8], 'targets stay put');
  assert.equal(result.weightKg, 21);
});

test('the ladder progresses from what was lifted, not the original plan', () => {
  // Two sessions on: the rungs have already moved to 12/17/22.
  const result = recommend(ladder(), [performance([[12, 12], [17, 10], [22, 8]])]);

  assert.equal(result.action, ACTIONS.ADVANCE);
  assert.deepEqual(result.perSetWeights, [13, 18, 23],
    'must not reset to the JSON values');
});

test('a held ladder also carries forward the lifted loads', () => {
  const result = recommend(ladder(), [performance([[12, 12], [17, 10], [22, 6]])]);

  assert.equal(result.action, ACTIONS.HOLD);
  assert.deepEqual(result.perSetWeights, [12, 17, 22]);
});

/* --- Deload -------------------------------------------------------------- */

test('a deload week scales every rung, not just the top one', () => {
  const result = recommend(
    ladder(),
    [performance([[10, 12], [15, 10], [20, 8]])],
    { isDeload: true, setCount: 2 }
  );

  assert.equal(result.action, ACTIONS.DELOAD_WAVE);
  // 10 * 0.65 = 6.5 -> 7 at a 1 kg step; 15 * 0.65 = 9.75 -> 10.
  assert.deepEqual(result.perSetWeights, [7, 10], 'reduced and set count honoured');
});

test('a deload session does not become the ladder baseline', () => {
  const history = [
    performance([[7, 12], [10, 10]], { date: '2026-08-01', isDeload: true }),
    performance([[10, 12], [15, 10], [20, 8]], { date: '2026-07-25' }),
  ];
  const result = recommend(ladder(), history);

  assert.equal(result.action, ACTIONS.ADVANCE);
  assert.deepEqual(result.perSetWeights, [11, 16, 21],
    'advances from the real working ladder, not the deload');
});

/* --- earnedAdvance ------------------------------------------------------- */

test('earnedAdvance judges a ladder rung by rung', () => {
  const exercise = ladder();

  const allMet = [[10, 12], [15, 10], [20, 8]]
    .map(([weightKg, reps]) => ({ weightKg, reps, completed: true }));
  assert.equal(earnedAdvance(exercise, allMet), true);

  const topShort = [[10, 12], [15, 10], [20, 7]]
    .map(([weightKg, reps]) => ({ weightKg, reps, completed: true }));
  assert.equal(earnedAdvance(exercise, topShort), false,
    'the heavy rung is not judged against the easy rung target');

  // The middle rung's 10 reps would clear the top rung's target of 8 — a
  // flattened comparison would wrongly pass this.
  const middleShort = [[10, 12], [15, 9], [20, 8]]
    .map(([weightKg, reps]) => ({ weightKg, reps, completed: true }));
  assert.equal(earnedAdvance(exercise, middleShort), false);
});

test('earnedAdvance still requires every prescribed set', () => {
  const exercise = ladder();
  const twoOfThree = [[10, 12], [15, 10]]
    .map(([weightKg, reps]) => ({ weightKg, reps, completed: true }));
  assert.equal(earnedAdvance(exercise, twoOfThree), false);
});

/* --- Non-ladder exercises are untouched --------------------------------- */

test('an exercise without a setPlan keeps the uniform-set behaviour', () => {
  const uniform = ladder({ setPlan: undefined });
  const result = recommend(uniform, [performance([[12, 12], [12, 11], [12, 10]])]);

  assert.equal(result.isPyramid, undefined, 'not treated as a ladder');
  assert.equal(result.perSetWeights, undefined);
  assert.equal(result.weightKg, 12);
});
