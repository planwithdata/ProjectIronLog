/**
 * tools/test-flow.mjs — The service layer, driven end to end in Node.
 *
 *     node --test tools/test-flow.mjs
 *
 * `tools/test.mjs` covers the engine in isolation and `tools/e2e.html` covers
 * the services in a real browser. This sits between them: it runs the real
 * services against the real `data/workouts.json` and the in-memory storage
 * adapter, with no browser and no build step, so the flows this build changed
 * can be asserted in CI rather than clicked through by hand.
 *
 * Two seams make it possible:
 *
 *   - `services/storage-adapter.js` finds no `window` in Node and falls back to
 *     an in-memory map. That is a deliberate seam, already relied on by
 *     `tools/test-migration.mjs`.
 *   - `services/program-service.js` loads the program with `fetch`, which in
 *     Node cannot read a `file:` URL. So `fetch` is stubbed here to read from
 *     disk. It is stubbed rather than the service being changed, because the
 *     browser path is the one that has to stay correct.
 *
 * What it proves is the part that no unit test can: that starting a session
 * writes the prescription the engine computed, that logging sets and tagging a
 * machine change what the *next* session is offered, and that a backup taken
 * afterwards restores to the same thing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* --- Stubs -------------------------------------------------------------- */

/**
 * Serve `data/workouts.json` to `program-service.load()`.
 *
 * Node's fetch rejects a `file:` URL outright, so the stub matches on the path
 * and reads from disk. Anything else falls through to the real fetch, so a
 * future service that genuinely calls out over the network fails loudly here
 * rather than being silently mocked.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const href = String(input?.href ?? input);
  if (href.includes('recovery-backup.json')) {
    return new Response(readFileSync(join(ROOT, 'data', 'recovery-backup.json'), 'utf8'));
  }
  if (href.includes('workouts.json')) {
    const body = readFileSync(join(ROOT, 'data', 'workouts.json'), 'utf8');
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input);
};

const { storage } = await import('../js/services/storage-adapter.js');
const db = await import('../js/services/db.js');
const programService = await import('../js/services/program-service.js');
const sessionService = await import('../js/services/session-service.js');
const prService = await import('../js/services/pr-service.js');
const analytics = await import('../js/services/analytics-service.js');
const { ACTIONS, repeatableLoad } = await import('../js/engine/progression.js');
const { STATUS } = await import('../js/engine/insights.js');

await programService.load();

/* --- Fixtures ----------------------------------------------------------- */

/** A clean database, with the program's start date already set. */
async function freshDb(startDate = '2026-08-06') {
  await storage.clear();
  await storage.remove('__premigration');
  await db.init();
  await db.reset();
  await db.write(db.COLLECTIONS.PROFILE, {
    ...db.read(db.COLLECTIONS.PROFILE),
    programStartDate: startDate,
  });
  analytics.resetInsights();
}

/** Log every working set of an exercise at one load and rep count, then finish. */
async function logSession(dayId, dayKey, plan) {
  const session = await sessionService.startSession(dayId, dayKey);

  for (const [exerciseId, spec] of Object.entries(plan)) {
    const entry = sessionService.getSessionById(session.id)
      .entries.find((item) => item.exerciseId === exerciseId);
    if (!entry) throw new Error(`${exerciseId} is not part of ${dayId}`);

    if (spec.context) await sessionService.setEntryContext(session.id, exerciseId, spec.context);
    if (spec.substitute) await sessionService.substituteEntry(session.id, exerciseId, spec.substitute);

    for (const [index, reps] of spec.reps.entries()) {
      const weightKg = Array.isArray(spec.weightKg) ? spec.weightKg[index] : spec.weightKg;
      await sessionService.updateSet(session.id, exerciseId, index, {
        weightKg, reps, completed: true,
      });
      if (spec.top?.includes(index)) {
        await sessionService.setTopSet(session.id, exerciseId, index, true);
      }
    }
  }

  await sessionService.completeSession(session.id);
  analytics.resetInsights();
  return session.id;
}

/** The load and rep targets the app would offer for one exercise today. */
function offered(exerciseId, dayKey) {
  const exercise = programService.getExercise(exerciseId);
  return sessionService.getRecommendation(exercise, dayKey);
}

/* --- Starting a session ------------------------------------------------- */

test('a session freezes the prescription it was started with', async () => {
  await freshDb();
  const session = await sessionService.startSession('tuesday-chest', '2026-08-11');

  const entry = session.entries.find((item) => item.exerciseId === 'flat-dumbbell-bench-press');
  assert.ok(entry, 'the chest day includes flat bench');
  assert.equal(entry.plannedAction, ACTIONS.START, 'first ever session');
  assert.equal(entry.sets.length, 3, 'three working sets, as prescribed');
  assert.ok('context' in entry && 'substitution' in entry, 'the v4 fields are present');

  await sessionService.abandonSession(session.id);
});

test('the Pallof press is offered as two maintained sets', async () => {
  await freshDb();
  const session = await sessionService.startSession('tuesday-chest', '2026-08-11');
  const entry = session.entries.find((item) => item.exerciseId === 'pallof-press');

  assert.equal(entry.sets.length, 2, 'two sets, not three');
  assert.equal(entry.plannedAction, ACTIONS.MAINTAIN);
  assert.match(entry.planReason, /Quality work/);

  await sessionService.abandonSession(session.id);
});

/* --- The flat-bench regression, through the real services --------------- */

test('a heavier top set does not become next session\'s target', async () => {
  await freshDb();

  // Week one: three clean sets at 55 kg.
  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: 55, reps: [8, 8, 8] },
  });

  // Week two: two at 55 and one heavier probe at 72, marked as a top set.
  await logSession('tuesday-chest', '2026-08-18', {
    'flat-dumbbell-bench-press': { weightKg: [55, 55, 72], reps: [9, 8, 5], top: [2] },
  });

  const plan = offered('flat-dumbbell-bench-press', '2026-08-25');
  assert.equal(plan.weightKg, 55, 'built on the load actually repeated');
  assert.equal(plan.previous.topWeightKg, 72, 'and the probe is still on the record');
  assert.notEqual(plan.action, ACTIONS.ADVANCE);
});

test('an unmarked heavier set is still read as a probe', async () => {
  await freshDb();

  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: 55, reps: [8, 8, 8] },
  });
  // Nothing marked this time — the median is what protects the untagged case.
  await logSession('tuesday-chest', '2026-08-18', {
    'flat-dumbbell-bench-press': { weightKg: [55, 55, 72], reps: [9, 8, 5] },
  });

  const plan = offered('flat-dumbbell-bench-press', '2026-08-25');
  assert.equal(plan.weightKg, 55);
});

test('three clean sets at the top of the range still earn the load', async () => {
  await freshDb();

  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: 55, reps: [10, 10, 10] },
  });

  const plan = offered('flat-dumbbell-bench-press', '2026-08-18');
  assert.equal(plan.action, ACTIONS.ADVANCE);
  // A dumbbell pair: the program's "+2 kg" is per hand, so 4 kg of stored total.
  assert.equal(plan.weightKg, 59);
});

/* --- Machine context ---------------------------------------------------- */

test('tagging a machine keeps its loads in their own series', async () => {
  await freshDb();

  const stackA = { label: 'Corner stack', attachment: 'rope' };
  const stackB = { label: 'Window stack', attachment: 'rope' };

  await logSession('tuesday-chest', '2026-08-11', {
    'rope-triceps-pushdown': { weightKg: 9.1, reps: [12, 12, 11], context: stackA },
  });
  await logSession('tuesday-chest', '2026-08-18', {
    'rope-triceps-pushdown': { weightKg: 9.1, reps: [12, 12, 12], context: stackA },
  });

  // Same machine: ordinary double progression, and the increase is earned.
  const sameMachine = offered('rope-triceps-pushdown', '2026-08-25');
  assert.equal(sameMachine.action, ACTIONS.ADVANCE);
  assert.equal(sameMachine.weightKg, 10.1);

  // A different machine reading 20 for the same effort. Not a strength change.
  await logSession('tuesday-chest', '2026-08-25', {
    'rope-triceps-pushdown': { weightKg: 20, reps: [12, 12, 12], context: stackB },
  });

  const plan = offered('rope-triceps-pushdown', '2026-09-01');
  assert.equal(plan.weightKg, 20, 'works from the machine last used');
  assert.equal(plan.action, ACTIONS.RE_ANCHOR, 'and refuses to compare across the change');
  assert.equal(plan.previous.contextChanged, true);
  assert.match(plan.reason, /different machine or attachment/);
  assert.equal(plan.stalledSessions, 0, 'no stall is carried across the break');

  const insight = analytics.getInsight('rope-triceps-pushdown');
  assert.equal(insight.status, STATUS.SCALE_CHANGE, 'and the trend refuses to read across it');
  assert.equal(insight.breaks.length, 1);
});

test('machines are remembered so the tag is one tap next time', async () => {
  await freshDb();
  await logSession('tuesday-chest', '2026-08-11', {
    'rope-triceps-pushdown': {
      weightKg: 9.1, reps: [12, 12, 11],
      context: { label: 'Corner stack', attachment: 'rope' },
    },
  });

  const known = sessionService.getKnownContexts('rope-triceps-pushdown');
  assert.equal(known.length, 1);
  assert.equal(known[0].label, 'Corner stack');
  assert.equal(known[0].machineId, 'corner-stack', 'slugged for comparison');

  // And the next session pre-fills it, so tagging costs nothing in the normal
  // case of using the same machine again.
  const session = await sessionService.startSession('tuesday-chest', '2026-08-18');
  const entry = session.entries.find((item) => item.exerciseId === 'rope-triceps-pushdown');
  assert.equal(entry.context?.label, 'Corner stack');
  await sessionService.abandonSession(session.id);
});

/* --- Substitution ------------------------------------------------------- */

test('a substituted movement counts as done, with its own load history', async () => {
  await freshDb();

  await logSession('tuesday-chest', '2026-08-11', {
    'rope-triceps-pushdown': { weightKg: 9.1, reps: [12, 12, 11] },
  });
  await logSession('tuesday-chest', '2026-08-18', {
    'rope-triceps-pushdown': {
      weightKg: 25, reps: [12, 11, 10], substitute: 'bar-triceps-pushdown',
    },
  });

  const session = sessionService.getCompletedSessions()
    .find((item) => item.date === '2026-08-18');

  // The slot is complete: this is a performed exercise, not a skipped one.
  // Checked on the entry rather than the session, since these fixtures log one
  // exercise out of a nine-exercise chest day.
  const slot = session.entries.find((item) => item.exerciseId === 'rope-triceps-pushdown');
  assert.equal(slot.sets.filter((set) => set.completed).length, slot.sets.length,
    'every prescribed set of the slot is logged');
  assert.equal(slot.exerciseId, 'rope-triceps-pushdown',
    'and the entry still points at the planned movement');

  const summary = sessionService.getSessionSummary(session.id);
  assert.equal(summary.substitutions.length, 1);
  assert.equal(summary.substitutions[0].performedName, 'Bar triceps pushdown');
  assert.equal(summary.substitutions[0].comparableLoad, false);

  // The substitute has its own history, found under its own id.
  const barHistory = sessionService.getExerciseHistory('bar-triceps-pushdown', 10);
  assert.equal(barHistory.length, 1);
  assert.equal(repeatableLoad(barHistory[0]), 25);

  // And the planned movement's history knows it was substituted, so the 25 kg
  // bar reading is never compared with the 9.1 kg rope reading.
  const ropeHistory = sessionService.getExerciseHistory('rope-triceps-pushdown', 10);
  assert.equal(ropeHistory[0].substituted, true);
  assert.notEqual(ropeHistory[0].contextKey, ropeHistory[1].contextKey);
});

test('an unlisted substitution is refused rather than invented', async () => {
  await freshDb();
  const session = await sessionService.startSession('tuesday-chest', '2026-08-11');
  await assert.rejects(
    () => sessionService.substituteEntry(session.id, 'rope-triceps-pushdown', 'hack-squat'),
    /not a substitution this exercise offers/
  );
  await sessionService.abandonSession(session.id);
});

/* --- Any day's workout on any day --------------------------------------- */

test('a missed Tuesday can be trained on Wednesday and is recorded as such', async () => {
  await freshDb();

  // Tuesday Chest, performed on Wednesday the 12th.
  const sessionId = await logSession('tuesday-chest', '2026-08-12', {
    'flat-dumbbell-bench-press': { weightKg: 55, reps: [8, 8, 8] },
  });

  const session = sessionService.getSessionById(sessionId);
  const schedule = sessionService.getSchedule(session);

  assert.equal(session.dayId, 'tuesday-chest', 'it is still Tuesday\'s workout');
  assert.equal(session.date, '2026-08-12', 'performed on Wednesday');
  assert.equal(schedule.status, 'late');
  assert.equal(schedule.offsetDays, 1);
  assert.equal(schedule.label, '1 day late');
  assert.equal(schedule.scheduledDate, '2026-08-11', 'and it knows which day it was for');
  assert.equal(sessionService.isOffSchedule(session), true);

  // The week still counts it as done, which is the whole point.
  const week = sessionService.getWeekCompletion('2026-08-12');
  assert.ok(week.done >= 1, 'the session counts towards the week');
  assert.equal(week.offSchedule, 1, 'and is reported as moved rather than missed');
  assert.equal(
    week.outstanding.some((item) => item.day.id === 'tuesday-chest'), false,
    'Tuesday is no longer outstanding'
  );
});

test('the schedule reading is derived, so old sessions get one too', async () => {
  await freshDb();
  const sessionId = await logSession('sunday-posterior-chain', '2026-08-09', {
    'romanian-deadlift': { weightKg: 80, reps: [8, 8, 8, 8] },
  });

  // Strip the frozen copy, as a session logged before the field existed has.
  const session = sessionService.getSessionById(sessionId);
  await db.replaceById(db.COLLECTIONS.SESSIONS, sessionId, { schedule: undefined });

  const recomputed = sessionService.getSchedule(sessionService.getSessionById(sessionId));
  assert.equal(recomputed.status, 'on-day', 'Sunday\'s workout, trained on a Sunday');
  assert.equal(recomputed.offsetDays, 0);
  void session;
});

test('Sunday trained on Monday reads as one day late, not six days early', async () => {
  await freshDb();
  const fit = programService.getScheduleFit('sunday-posterior-chain', '2026-08-10');
  assert.equal(fit.offsetDays, 1);
  assert.equal(fit.status, 'late');
});

test('every training day is offerable today, with its schedule fit', async () => {
  await freshDb();
  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: 55, reps: [8, 8, 8] },
  });

  const options = sessionService.getStartableDays('2026-08-13');
  assert.equal(options.length, programService.getTrainingDays().length, 'nothing is hidden');

  const chest = options.find((item) => item.day.id === 'tuesday-chest');
  assert.equal(chest.doneThisWeek, true);
  assert.equal(chest.lastDate, '2026-08-11');

  const back = options.find((item) => item.day.id === 'wednesday-back-biceps');
  assert.equal(back.overdueThisWeek, true, 'Wednesday has passed and was not done');
  assert.equal(back.fit.label, '1 day late');
});

/* --- Planned against performed ----------------------------------------- */

test('a load performed off plan keeps both figures', async () => {
  await freshDb();

  await logSession('saturday-upper', '2026-08-08', {
    'incline-smith-machine-press': { weightKg: 40, reps: [8, 8, 8, 7] },
  });
  // Prescribed 40, performed 45 on every set.
  await logSession('saturday-upper', '2026-08-15', {
    'incline-smith-machine-press': { weightKg: 45, reps: [8, 8, 7, 6] },
  });

  const session = sessionService.getCompletedSessions()
    .find((item) => item.date === '2026-08-15');
  const entry = session.entries.find((item) => item.exerciseId === 'incline-smith-machine-press');

  assert.equal(entry.targetWeightKg, 40, 'the plan is stored');
  assert.equal(repeatableLoad({ sets: entry.sets }), 45, 'and so is the performance');

  const plan = offered('incline-smith-machine-press', '2026-08-22');
  assert.equal(plan.weightKg, 45, 'today builds on what was performed');
  assert.match(plan.reason, /planned at 40 kg and performed at 45 kg/);

  const adherence = analytics.getAdherence()
    .find((row) => row.exerciseId === 'incline-smith-machine-press');
  assert.ok(adherence, 'and the deviation is reported');
  assert.equal(adherence.above, 1);
});

/* --- Records ------------------------------------------------------------ */

test('the headline record is the load repeated, not the load touched', async () => {
  await freshDb();
  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: [55, 55, 72], reps: [9, 8, 5], top: [2] },
  });

  const records = prService.getRecordsFor('flat-dumbbell-bench-press');
  assert.equal(records.working.value, 55, 'the working record is the repeated load');
  assert.equal(records.weight.value, 72, 'the heaviest single set is still recorded');
  assert.equal(records.working.unverified, false);
});

test('a record set across a machine change is reported but flagged', async () => {
  await freshDb();
  await logSession('tuesday-chest', '2026-08-11', {
    'rope-triceps-pushdown': { weightKg: 9.1, reps: [12, 12, 11] },
  });
  await logSession('tuesday-chest', '2026-08-18', {
    'rope-triceps-pushdown': { weightKg: 40, reps: [12, 12, 12] },
  });

  const records = prService.getRecordsFor('rope-triceps-pushdown');
  assert.equal(records.working.value, 40, 'the set was performed, so it is on the record');
  assert.equal(records.working.unverified, true, 'and it is not presented as a personal best');
  assert.match(records.working.caveat, /different machine/);

  // Home leads with a verified record or none at all.
  const latest = prService.getLatestRecord();
  if (latest) assert.equal(latest.unverified, false);
});

/* --- Backup and restore ------------------------------------------------- */

test('a backup taken after all of this restores to exactly the same thing', async () => {
  await freshDb();

  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: [55, 55, 72], reps: [9, 8, 5], top: [2] },
    'rope-triceps-pushdown': {
      weightKg: 9.1, reps: [12, 12, 11],
      context: { label: 'Corner stack', attachment: 'rope' },
    },
  });
  await logSession('tuesday-chest', '2026-08-19', {
    'flat-dumbbell-bench-press': { weightKg: 55, reps: [9, 9, 9] },
    'rope-triceps-pushdown': {
      weightKg: 25, reps: [12, 11, 10], substitute: 'bar-triceps-pushdown',
    },
  });

  const exported = JSON.parse(JSON.stringify(db.exportAll()));
  assert.equal(exported.schemaVersion, db.SCHEMA_VERSION);

  const before = JSON.parse(JSON.stringify(db.read(db.COLLECTIONS.SESSIONS)));
  const planBefore = offered('flat-dumbbell-bench-press', '2026-08-26');

  await db.reset();
  assert.equal(db.read(db.COLLECTIONS.SESSIONS).length, 0, 'wiped');

  await db.importAll(exported);
  analytics.resetInsights();

  assert.deepEqual(db.read(db.COLLECTIONS.SESSIONS), before, 'every session comes back intact');

  // The point of the whole exercise: the app makes the same decision afterwards.
  const planAfter = offered('flat-dumbbell-bench-press', '2026-08-26');
  assert.deepEqual(planAfter, planBefore, 'and the same recommendation');

  const restored = sessionService.getCompletedSessions()
    .find((item) => item.date === '2026-08-19');
  const entry = restored.entries.find((item) => item.exerciseId === 'rope-triceps-pushdown');
  assert.equal(entry.substitution.performedId, 'bar-triceps-pushdown', 'substitutions survive');

  const first = sessionService.getCompletedSessions()
    .find((item) => item.date === '2026-08-11');
  const tagged = first.entries.find((item) => item.exerciseId === 'rope-triceps-pushdown');
  assert.equal(tagged.context.label, 'Corner stack', 'machine tags survive');

  const bench = first.entries.find((item) => item.exerciseId === 'flat-dumbbell-bench-press');
  assert.equal(bench.sets[2].kind, 'top', 'top-set markings survive');
});

test('the real backup file restores into this build', async () => {
  const payload = (() => {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'ironlog-backup-2026-09-02.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  if (!payload) return;

  await freshDb();
  await db.importAll(payload);
  analytics.resetInsights();

  const sessions = db.read(db.COLLECTIONS.SESSIONS);
  assert.equal(sessions.length, payload.data.sessions.length, 'every session arrives');
  assert.equal(db.read(db.COLLECTIONS.META).schemaVersion, db.SCHEMA_VERSION, 'migrated forward');

  // Every entry gained the v4 fields, and nothing else changed.
  for (const [index, session] of sessions.entries()) {
    const original = payload.data.sessions[index];
    for (const [entryIndex, entry] of session.entries.entries()) {
      assert.ok('context' in entry && 'substitution' in entry, 'v4 fields present');
      assert.deepEqual(
        entry.sets, original.entries[entryIndex].sets,
        `${session.date} ${entry.exerciseId}: sets untouched`
      );
    }
  }

  // And the app can now read it: a recommendation for every logged exercise,
  // and no prescription above what was actually repeated plus one increment.
  const insights = analytics.allInsights();
  assert.ok(insights.length >= 30, `read ${insights.length} exercises`);

  const bench = analytics.getInsight('flat-dumbbell-bench-press');
  assert.ok(bench, 'the flat bench reads');
  assert.equal(bench.current.workingLoadKg, 55, 'at 55 kg, not 72');

  const exported = db.exportAll();
  assert.equal(exported.data.sessions.length, payload.data.sessions.length,
    'and it can be backed up again');
});

/* --- Exports -----------------------------------------------------------
   A CSV whose header and rows have drifted apart is worse than no export:
   every column after the drift is silently mislabelled, and a spreadsheet
   gives no hint that it happened. So the widths are asserted rather than
   eyeballed, on a log that exercises every new column.
   ====================================================================== */

test('every CSV row has exactly as many columns as its header', async () => {
  const csv = await import('../js/reports/csv.js');

  await freshDb();
  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: [55, 55, 72], reps: [9, 8, 5], top: [2] },
    'rope-triceps-pushdown': {
      weightKg: 9.1, reps: [12, 12, 11],
      context: { label: 'Corner stack', attachment: 'rope' },
    },
  });
  // A different day's workout, trained late, with a substitution — so the
  // schedule and substitution columns are populated rather than blank.
  await logSession('wednesday-back-biceps', '2026-08-14', {
    'wide-grip-lat-pulldown': {
      weightKg: 93, reps: [10, 9, 8], substitute: 'neutral-grip-lat-pulldown',
    },
  });

  for (const [name, build] of [['sets', csv.setsCsv], ['sessions', csv.sessionsCsv]]) {
    const rows = build().replace(/^\uFEFF/, '').trim().split('\r\n')
      // A quoted field may contain a comma; none of these datasets produce one,
      // and asserting that is part of the point.
      .map((line) => line.split(','));

    assert.ok(rows.length > 1, `${name}.csv has rows`);
    const width = rows[0].length;
    for (const [index, row] of rows.entries()) {
      assert.equal(row.length, width,
        `${name}.csv row ${index} has ${row.length} columns, header has ${width}`);
    }
  }
});

test('the sets export marks a probe as `top`, so working sets can be filtered', async () => {
  const csv = await import('../js/reports/csv.js');

  await freshDb();
  await logSession('tuesday-chest', '2026-08-11', {
    'flat-dumbbell-bench-press': { weightKg: [55, 55, 72], reps: [9, 8, 5], top: [2] },
  });

  const lines = csv.setsCsv().replace(/^\uFEFF/, '').trim().split('\r\n');
  const header = lines[0].split(',');
  const kindAt = header.indexOf('set_kind');
  const weightAt = header.indexOf('weight_kg');
  assert.ok(kindAt >= 0 && weightAt >= 0, 'the columns exist');

  const bench = lines.slice(1)
    .map((line) => line.split(','))
    .filter((row) => row.includes('Flat Dumbbell Bench Press'));

  const working = bench.filter((row) => row[kindAt] === 'working').map((row) => row[weightAt]);
  const top = bench.filter((row) => row[kindAt] === 'top').map((row) => row[weightAt]);

  assert.deepEqual(working, ['55', '55'], 'the working sets are the repeated load');
  assert.deepEqual(top, ['72'], 'and the probe is exported under its own kind');
});

test('the two-week review reads a machine change as unreadable, not as a gain', async () => {
  const reviewService = await import('../js/services/review-service.js');

  await freshDb();
  await logSession('tuesday-chest', '2026-08-04', {
    'rope-triceps-pushdown': { weightKg: 9.1, reps: [12, 12, 11] },
  });
  await logSession('tuesday-chest', '2026-08-25', {
    'rope-triceps-pushdown': { weightKg: 40, reps: [12, 12, 12] },
  });

  // A 30-day window, so both sessions fall inside the period being reviewed.
  const strength = reviewService.gather(30, '2026-09-01').strength;

  assert.ok(strength.scaleChanged.includes('Rope Triceps Pushdown'),
    'named as not comparable');
  assert.equal(strength.advancing.includes('Rope Triceps Pushdown'), false,
    'and never reported as advancing');
});


test('a moved workout keeps its occurrence across weeks and backups', async () => {
  await freshDb('2026-08-01');
  const before = programService.getScheduleCompletion('2026-08-10', '2026-08-16').scheduled;
  await programService.changeSchedule('tuesday-chest', '2026-08-11', '2026-08-17');
  assert.equal(programService.getScheduleCompletion('2026-08-10', '2026-08-16').scheduled, before - 1);
  const id = await logSession('tuesday-chest', '2026-08-17', { 'flat-dumbbell-bench-press': { weightKg: 40, reps: [8, 8, 8] } });
  assert.equal(sessionService.getSessionById(id).schedule.scheduledDate, '2026-08-11');
  assert.equal(programService.getScheduleCompletion('2026-08-17', '2026-08-17').done, 1);
  const snapshot = structuredClone(db.exportAll());
  await db.importAll(snapshot);
  assert.deepEqual(db.exportAll().data.sessions, snapshot.data.sessions);
  assert.deepEqual(programService.getScheduleChanges(), snapshot.data.profile.scheduleChanges);
  await programService.changeSchedule('tuesday-chest', '2026-08-18', null, 'skipped');
  assert.equal(programService.getScheduleCompletion('2026-08-18', '2026-08-18').scheduled, 0);
});

test('manual deloads preserve normal working loads and actual intensity overrides the schedule', async () => {
  await freshDb('2026-08-01');
  await logSession('tuesday-chest', '2026-08-11', { 'flat-dumbbell-bench-press': { weightKg: 40, reps: [7, 7, 7] } });
  await programService.setDeloadPlan('start', '2026-08-18');
  const id = await logSession('tuesday-chest', '2026-08-18', { 'flat-dumbbell-bench-press': { weightKg: 26, reps: [6, 6] } });
  assert.equal(sessionService.getSessionById(id).isDeload, true);
  await programService.setDeloadPlan('skip', '2026-08-25');
  assert.equal(offered('flat-dumbbell-bench-press', '2026-08-25').weightKg, 40);
  await programService.setDeloadPlan('postpone', '2026-08-29');
  assert.equal(programService.getTrainingWeek('2026-08-29').isDeload, false);
  assert.equal(programService.getTrainingWeek('2026-09-05').isDeload, true);
  const normal = await sessionService.startSession('tuesday-chest', '2026-08-29');
  assert.equal(normal.scheduledDeload, true);
  assert.equal(normal.isDeload, false);
});

test('editing an old workout preserves completion time and duration', async () => {
  await freshDb();
  const id = await logSession('tuesday-chest', '2026-08-11', { 'flat-dumbbell-bench-press': { weightKg: 40, reps: [8, 8, 8] } });
  await db.replaceById(db.COLLECTIONS.SESSIONS, id, { startedAt: '2026-08-11T10:00:00Z', completedAt: '2026-08-11T11:00:00Z', durationSeconds: 3600 });
  await sessionService.reopenSession(id);
  const edited = await sessionService.completeSession(id);
  assert.equal(edited.durationSeconds, 3600);
  assert.equal(edited.completedAt, '2026-08-11T11:00:00Z');
});


test('October 12 backup restores every collection, with 42 completed workouts and one unfinished workout', {
  skip: !existsSync(join(ROOT, 'ironlog-backup-2026-10-12.json')),
}, async () => {
  await freshDb();
  const backup = JSON.parse(readFileSync(join(ROOT, 'ironlog-backup-2026-10-12.json'), 'utf8'));
  await db.importAll(structuredClone(backup));
  assert.equal(sessionService.getSessions().length, 43);
  assert.equal(sessionService.getCompletedSessions().length, 42);
  assert.equal(sessionService.getActiveSession().date, '2026-10-12');
  for (const [collection, records] of Object.entries(backup.data)) {
    assert.deepEqual(db.read(collection), records, `${collection} is restored unchanged`);
    assert.deepEqual(await storage.get(collection), records, `${collection} is persisted in full`);
  }
  const review = await import('../js/services/review-service.js');
  assert.equal(review.generate(90, '2026-10-13').sessions.length, 42);
});


test('bundled JSON seeds an empty app, preserves newer records, and recovers missing history idempotently', async () => {
  const { restoreBundledBackup } = await import('../js/services/backup-service.js');
  const backup = JSON.parse(readFileSync(join(ROOT, 'data', 'recovery-backup.json'), 'utf8'));
  await freshDb();
  const restored = await restoreBundledBackup({ onlyIfEmpty: true });
  assert.equal(restored.total, 43);
  for (const [collection, records] of Object.entries(backup.data)) {
    assert.deepEqual(db.read(collection), records);
    assert.deepEqual(await storage.get(collection), records);
  }
  const edited = { ...backup.data.sessions[0], date: '2026-10-13', notes: 'Keep my newer edit' };
  await db.write(db.COLLECTIONS.SESSIONS, [edited]);
  assert.equal(await restoreBundledBackup({ onlyIfEmpty: true }), null);
  assert.equal(sessionService.getSessions().length, 1);
  assert.equal((await restoreBundledBackup()).added, 42);
  assert.deepEqual(sessionService.getSessionById(edited.id), edited);
  assert.equal((await restoreBundledBackup()).added, 0);
  await db.reset();
  await db.update(db.COLLECTIONS.META, (meta) => ({ ...meta, bundledRecoveryDismissed: true }));
  assert.equal(await restoreBundledBackup({ onlyIfEmpty: true }), null);
  assert.equal(sessionService.getSessions().length, 0);
});


test('exercise charts break across scale changes and exclude future history', async () => {
  await freshDb();
  await logSession('tuesday-chest', '2026-08-11', { 'rope-triceps-pushdown': { weightKg: 10, reps: [12, 12, 12], context: { machineId: 'a', label: 'A' } } });
  await logSession('tuesday-chest', '2026-08-18', { 'rope-triceps-pushdown': { weightKg: 50, reps: [12, 12, 12], context: { machineId: 'b', label: 'B' } } });
  const chart = analytics.exerciseProgression('rope-triceps-pushdown', null, '2026-08-18');
  assert.equal(chart.sessions, 2);
  assert.ok(chart.charts.every((metric) => metric.points[1].breakBefore));
  assert.equal(analytics.exerciseProgression('rope-triceps-pushdown', null, '2026-08-11').sessions, 1);
});

test('exercise charts retain bodyweight reps, same-day sessions, and deload markers', async () => {
  await freshDb();
  const first = await logSession('tuesday-chest', '2026-08-11', { 'flat-dumbbell-bench-press': { weightKg: 0, reps: [8, 7, 6] } });
  await logSession('tuesday-chest', '2026-08-11', { 'flat-dumbbell-bench-press': { weightKg: 0, reps: [9, 8, 7] } });
  await sessionService.setSessionIntensity(first, true);
  const data = analytics.exerciseProgression('flat-dumbbell-bench-press', 14, '2026-08-18');
  assert.equal(data.sessions, 2);
  assert.equal(data.charts.some((metric) => metric.key === 'e1rm'), false);
  const reps = data.charts.find((metric) => metric.key === 'reps').points;
  assert.deepEqual(reps.map((p) => p.value).sort(), [7, 8]);
  assert.equal(new Set(reps.map((p) => p.key)).size, 2);
  assert.equal(reps.filter((p) => p.excluded).length, 1);
  assert.equal(analytics.exerciseProgression('flat-dumbbell-bench-press', 1, '2026-08-18').sessions, 0);
});


test('October recovery spans the wave reset, moved Legs and a v4 restart', async () => {
  await freshDb('2026-09-10');
  assert.equal(programService.getTrainingWeek('2026-10-15').waveWeek, 1);
  await programService.setDeloadPlan('start', '2026-10-13', '2026-10-19');
  await programService.changeSchedule('thursday-legs', '2026-10-15', '2026-10-16');
  for (const date of ['2026-10-13', '2026-10-15', '2026-10-16', '2026-10-19']) {
    assert.equal(programService.getTrainingWeek(date).isDeload, true);
  }
  assert.equal(programService.getTrainingWeek('2026-10-20').isDeload, false);
  const backup = structuredClone(db.exportAll());
  assert.equal(backup.schemaVersion, 4);
  await db.reset();
  await db.importAll(backup);
  await db.init();
  const session = await sessionService.startSession('thursday-legs', '2026-10-16');
  assert.equal(session.plannedDeload, true);
  assert.equal(session.waveWeek, 1);
  assert.equal(session.schedule.scheduledDate, '2026-10-15');
  for (const entry of session.entries) {
    const exercise = programService.getExercise(entry.exerciseId);
    if (programService.isWarmupOnly(exercise)) continue;
    assert.equal(entry.sets.length, programService.deloadSets(exercise.sets));
    assert.match(entry.planReason, /3?4 reps in reserve/);
  }
  await programService.setDeloadPlan('extend', '2026-10-16');
  assert.equal(programService.getTrainingWeek('2026-10-26').isDeload, true);
  await programService.setDeloadPlan('end', '2026-10-17');
  assert.equal(programService.getTrainingWeek('2026-10-17').isDeload, false);
  assert.equal(programService.getTrainingWeek('2026-10-26').isDeload, false);
  await assert.rejects(programService.setDeloadPlan('start', '2026-02-30'));
  await assert.rejects(programService.setDeloadPlan('oops'));
});

test('reviewed October classifications retain results and recover the normal baseline', async () => {
  await freshDb('2026-09-10');
  const normal = await logSession('tuesday-chest', '2026-10-10', {
    'flat-dumbbell-bench-press': { weightKg: 40, reps: [7, 7, 7] },
  });
  const reduced = await logSession('tuesday-chest', '2026-10-13', {
    'flat-dumbbell-bench-press': { weightKg: 26, reps: [6, 6] },
  });
  const before = structuredClone(sessionService.getSessions());
  assert.equal(sessionService.getSessionById(normal).isDeload, true);
  await programService.setDeloadPlan('start', '2026-10-13', '2026-10-19');
  assert.deepEqual(sessionService.getSessions(), before, 'planning alone never classifies history');
  for (const item of sessionService.getOctoberDeloadCorrections()) {
    await sessionService.setSessionIntensity(item.session.id, item.isDeload);
  }
  for (const original of before) {
    const updated = sessionService.getSessionById(original.id);
    for (const key of Object.keys(original)) {
      if (['isDeload', 'actualDeload', 'updatedAt'].includes(key)) continue;
      assert.deepEqual(updated[key], original[key], key);
    }
    assert.equal(updated.originalIsDeload, original.isDeload);
  }
  assert.equal(sessionService.getSessionById(normal).actualDeload, false);
  assert.equal(sessionService.getSessionById(reduced).actualDeload, true);
  assert.ok(offered('flat-dumbbell-bench-press', '2026-10-16').weightKg <= 28);
  assert.equal(offered('flat-dumbbell-bench-press', '2026-10-20').weightKg, 40);
  const backup = structuredClone(db.exportAll());
  await db.reset();
  await db.importAll(backup);
  assert.deepEqual(db.exportAll().data.sessions, backup.data.sessions);
  assert.equal(offered('flat-dumbbell-bench-press', '2026-10-20').weightKg, 40);
});

test('an unlogged open workout can adopt recovery, but performed sets cannot be replaced', async () => {
  await freshDb('2026-09-10');
  await logSession('tuesday-chest', '2026-10-06', {
    'flat-dumbbell-bench-press': { weightKg: 40, reps: [7, 7, 7] },
  });
  const session = await sessionService.startSession('tuesday-chest', '2026-10-16');
  await programService.setDeloadPlan('start', '2026-10-13', '2026-10-19');
  await sessionService.refreshUnloggedPrescription(session.id);
  const entry = sessionService.getSessionById(session.id).entries.find(item => item.exerciseId === 'flat-dumbbell-bench-press');
  assert.ok(entry.targetWeightKg >= 24 && entry.targetWeightKg <= 28);
  assert.equal(entry.sets.length, 2);
  await sessionService.updateSet(session.id, entry.exerciseId, 0, { weightKg: 40, reps: 7, completed: true });
  const before = structuredClone(sessionService.getSessionById(session.id).entries);
  await assert.rejects(sessionService.refreshUnloggedPrescription(session.id));
  await sessionService.setSessionIntensity(session.id, false);
  await sessionService.completeSession(session.id);
  assert.deepEqual(sessionService.getSessionById(session.id).entries, before);
  assert.equal(sessionService.getSessionById(session.id).plannedDeload, true);
  assert.equal(sessionService.getSessionById(session.id).isDeload, false);
});
