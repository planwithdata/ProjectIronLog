/**
 * tools/test-real-data.mjs — The engine, run over the actual training log.
 *
 *     node --test tools/test-real-data.mjs
 *
 * The other engine tests use fixtures shaped like real data. This one uses the
 * real data: it reads `ironlog-backup-*.json` and `data/workouts.json` from the
 * repo root and drives `progression.recommend`, `insights.exerciseInsight` and
 * `context.markDiscontinuities` over every exercise in the log.
 *
 * It exists because every bug this build fixes was invisible in a fixture and
 * obvious in the log. A 72 kg flat dumbbell bench set logged among 55 kg sets;
 * a rope pushdown reading 9.1, then 20, then 50; an incline press planned at
 * 40 kg and performed at 45. A test suite that never reads the file those came
 * from can pass while the app is wrong.
 *
 * The assertions are therefore about *shape and sanity*, not about specific
 * figures the next session would change: no recommendation may exceed what was
 * lifted by more than one increment, no machine change may be reported as
 * strength, and no exercise may be told to load a weight it has not held.
 *
 * It skips cleanly when no backup file is present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  recommend, repeatableLoad, workingWeight, incrementFor, ACTIONS,
} from '../js/engine/progression.js';
import { exerciseInsight, STATUS, scorecard, adherence } from '../js/engine/insights.js';
import { contextKey } from '../js/engine/context.js';
import { normalizeEntry } from '../js/engine/set-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The newest backup in the repo root, or null. */
function loadBackup() {
  const files = readdirSync(ROOT)
    .filter((name) => /^ironlog-backup.*\.json$/i.test(name))
    .sort();
  if (!files.length) return null;
  const file = files[files.length - 1];
  return { file, payload: JSON.parse(readFileSync(join(ROOT, file), 'utf8')) };
}

const backup = loadBackup();
const program = JSON.parse(readFileSync(join(ROOT, 'data', 'workouts.json'), 'utf8'));

const exercises = new Map();
for (const day of program.days) {
  for (const exercise of day.exercises) exercises.set(exercise.id, exercise);
}
for (const exercise of program.retiredExercises ?? []) exercises.set(exercise.id, exercise);
for (const exercise of program.substituteExercises ?? []) exercises.set(exercise.id, exercise);

/**
 * Rebuild what `session-service.getExerciseHistory` would return, from a
 * backup, without booting the storage layer.
 *
 * Newest session first, completed working sets only — the same contract the
 * engine is written against.
 */
function historyFor(exerciseId) {
  const sessions = [...(backup?.payload?.data?.sessions ?? [])]
    .filter((session) => session.status === 'completed')
    .sort((a, b) => b.date.localeCompare(a.date));

  const out = [];
  for (const session of sessions) {
    const raw = session.entries.find((item) => item.exerciseId === exerciseId);
    if (!raw) continue;
    const entry = normalizeEntry(raw);
    const done = (entry.sets ?? []).filter((set) => set.completed && (set.reps ?? 0) > 0);
    if (!done.length) continue;

    out.push({
      date: session.date,
      week: session.week,
      waveWeek: session.waveWeek,
      isDeload: Boolean(session.isDeload),
      targetWeightKg: entry.targetWeightKg ?? null,
      sets: done,
      contextKey: contextKey(entry),
      context: entry.context ?? null,
      substitution: entry.substitution ?? null,
      painLimited: false,
      incomplete: (exercises.get(exerciseId)?.sets ?? 0) > done.length,
      legacy: entry.setModel === 'legacy',
    });
  }
  return out;
}

/** Every exercise id that appears in the log. */
function loggedIds() {
  const ids = new Set();
  for (const session of backup?.payload?.data?.sessions ?? []) {
    for (const entry of session.entries) ids.add(entry.exerciseId);
  }
  return [...ids].filter((id) => exercises.has(id));
}

const SKIP = backup ? false : 'no ironlog-backup-*.json in the repo root';

/* --- The specific regressions the brief reported ------------------------ */

test('flat dumbbell bench is no longer prescribed the 72 kg probe', { skip: SKIP }, () => {
  const exercise = exercises.get('flat-dumbbell-bench-press');
  const history = historyFor('flat-dumbbell-bench-press');
  assert.ok(history.length, 'the log has flat bench history');

  // The session that caused it: 55 / 55 / 72.
  const probeSession = history.find((entry) =>
    entry.sets.some((set) => set.weightKg === 72));
  assert.ok(probeSession, 'the 72 kg set is still in the log, untouched');
  assert.equal(repeatableLoad(probeSession), 55, 'read as 55 kg of repeatable work');
  assert.equal(workingWeight(probeSession), 72, 'and still reported as a 72 kg top set');

  // What the engine would have prescribed for the session after it.
  const asOfProbe = history.slice(history.indexOf(probeSession));
  const then = recommend(exercise, asOfProbe, { setCount: exercise.sets });
  assert.ok(then.weightKg <= 57.5, `prescribed ${then.weightKg} kg, not the 72 kg probe`);

  // And what it prescribes today.
  const now = recommend(exercise, history, { setCount: exercise.sets });
  assert.ok(now.weightKg <= 57.5, `today's prescription is ${now.weightKg} kg`);
  assert.notEqual(now.action, ACTIONS.DELOAD_STALL, 'and it is not a false stall');
});

test('the incline Smith press keeps both the 40 kg plan and the 45 kg performance',
  { skip: SKIP }, () => {
    const exercise = exercises.get('incline-smith-machine-press');
    const history = historyFor('incline-smith-machine-press');
    const plan = recommend(exercise, history, { setCount: exercise.sets });

    const deviated = history.find((entry) =>
      entry.targetWeightKg !== null && repeatableLoad(entry) !== entry.targetWeightKg);
    assert.ok(deviated, 'the log contains a session performed off plan');

    assert.equal(plan.previous.targetWeightKg, history[0].targetWeightKg,
      'the plan is carried through');
    assert.equal(plan.previous.weightKg, repeatableLoad(history[0]),
      'so is what was actually performed');
    assert.ok(plan.weightKg >= repeatableLoad(history[0]),
      'and today builds on the performance, not on the stale plan');
  });

test('every cable machine change is flagged, never read as strength', { skip: SKIP }, () => {
  // The four movements whose loads jump by more than any increment allows.
  const changed = ['low-to-high-cable-fly', 'rope-triceps-pushdown',
                   'overhead-rope-extension', 'straight-arm-pulldown'];

  for (const id of changed) {
    const insight = exerciseInsight(exercises.get(id), historyFor(id));
    assert.ok(insight, `${id} has history`);
    assert.ok(insight.breaks.length > 0, `${id}: the scale change is detected`);
    assert.notEqual(insight.status, STATUS.PROGRESSING,
      `${id}: a machine change is not reported as progress`);
  }
});

test('a genuine pin-sized increase is not flagged as a machine change', { skip: SKIP }, () => {
  // 13.6 -> 15.9 kg is 30 lb to 35 lb on the same stack; 18.1 -> 20.4 is 40 to
  // 45. Both are training, and flagging them would make the feature useless.
  for (const id of ['face-pull', 'one-arm-cable-row']) {
    const insight = exerciseInsight(exercises.get(id), historyFor(id));
    assert.equal(insight.breaks.length, 0, `${id}: a single pin is not a new machine`);
  }
});

test('the Pallof press is two sets, held rather than progressed', { skip: SKIP }, () => {
  const exercise = exercises.get('pallof-press');
  assert.equal(exercise.sets, 2, 'two sets, as asked');
  assert.equal(exercise.progression.mode, 'maintain');
  assert.ok(exercise.tempo, 'and it states its own tempo');

  const plan = recommend(exercise, historyFor('pallof-press'), { setCount: exercise.sets });
  assert.equal(plan.action, ACTIONS.MAINTAIN);
  assert.equal(plan.perSetReps.length, 2, 'two sets prescribed');
  assert.equal(plan.stalledSessions, 0, 'and it can never stall');
});

/* --- Sanity across the whole log ---------------------------------------- */

test('no recommendation asks for a load that was never held', { skip: SKIP }, () => {
  for (const id of loggedIds()) {
    const exercise = exercises.get(id);
    const history = historyFor(id);
    if (!history.length) continue;

    const plan = recommend(exercise, history, { setCount: exercise.sets });
    if (plan.weightKg === null) continue;

    const repeatable = repeatableLoad(history[0]);
    if (repeatable === null) continue;

    // A prescription may exceed the last repeatable load by at most one
    // increment — that is what an earned advance is. Anything more means a
    // probe or another machine's reading has leaked into the anchor.
    const ceiling = repeatable + incrementFor(exercise) + 0.01;
    assert.ok(
      plan.weightKg <= ceiling,
      `${id}: prescribed ${plan.weightKg} kg from a repeatable ${repeatable} kg `
      + `(ceiling ${ceiling.toFixed(2)}, action ${plan.action})`
    );
  }
});

test('every prescription names as many sets as the program asks for', { skip: SKIP }, () => {
  for (const id of loggedIds()) {
    const exercise = exercises.get(id);
    const plan = recommend(exercise, historyFor(id), { setCount: exercise.sets });
    assert.equal(plan.perSetReps.length, exercise.sets, `${id}: one rep target per set`);
  }
});

test('every rep target sits inside the exercise\'s prescribed range', { skip: SKIP }, () => {
  for (const id of loggedIds()) {
    const exercise = exercises.get(id);
    const plan = recommend(exercise, historyFor(id), { setCount: exercise.sets });
    for (const reps of plan.perSetReps) {
      assert.ok(
        reps >= exercise.reps.min && reps <= exercise.reps.max,
        `${id}: target ${reps} is outside ${exercise.reps.min}-${exercise.reps.max}`
      );
    }
  }
});

test('every exercise in the log produces a readable insight', { skip: SKIP }, () => {
  const insights = loggedIds()
    .map((id) => exerciseInsight(exercises.get(id), historyFor(id)))
    .filter(Boolean);

  assert.ok(insights.length >= 30, `read ${insights.length} exercises`);

  for (const insight of insights) {
    assert.ok(Object.values(STATUS).includes(insight.status), `${insight.name}: known status`);
    assert.ok(insight.statusDetail.length > 20, `${insight.name}: says something`);
    assert.ok(insight.comparableSessions <= insight.sessions,
      `${insight.name}: cannot compare more sessions than exist`);
    assert.ok(insight.series.length === insight.sessions,
      `${insight.name}: every session is on the chart, breaks included`);
  }

  const board = scorecard(insights);
  const total = board.progressing.length + board.holding.length + board.attention.length
    + board.scaleChanged.length + board.maintained.length + board.tooNew.length;
  assert.equal(total, insights.length, 'every exercise lands in exactly one pile');
});

test('adherence reports the sessions that ran off plan', { skip: SKIP }, () => {
  const rows = adherence(
    loggedIds().map((id) => exerciseInsight(exercises.get(id), historyFor(id))).filter(Boolean)
  );
  assert.ok(rows.length > 0, 'the log contains deviations from plan');
  for (const row of rows) {
    assert.ok(row.verdict.length > 10, `${row.name}: the row says what the bias means`);
    assert.equal(row.above + row.below, row.deviations, 'every deviation has a direction');
  }
});
