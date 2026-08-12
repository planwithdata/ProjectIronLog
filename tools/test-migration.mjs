/**
 * tools/test-migration.mjs — The schema migrations, proven lossless.
 *
 *     node --test tools/test-migration.mjs
 *
 * This is the one test in the suite that guards data that already exists on a
 * phone. Everything else can be re-derived; a session lost here is a session
 * that was actually trained and is now gone.
 *
 * It runs the *real* migration through the real `db.init()`. In Node,
 * `storage-adapter` finds no `window`, falls back to its in-memory map and logs
 * a warning — which is exactly the seam this test needs: seed the map, boot the
 * database, inspect what came out.
 *
 * Re-importing `db.js` with a cache-busting query gives a fresh module (fresh
 * `ready` flag, fresh cache) while `storage-adapter.js` stays cached and keeps
 * its data. That models closing and reopening the app on the same device.
 *
 * If `ironlog-backup-*.json` is present in the repo root it is used as a
 * fixture as well, so the assertions run against real training data and not
 * only against something shaped like it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { storage } from '../js/services/storage-adapter.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = new URL('../js/services/db.js', import.meta.url).href;

let bootCount = 0;

/** Boot a fresh db module against the shared storage. */
async function boot() {
  bootCount += 1;
  const db = await import(`${DB_URL}?boot=${bootCount}`);
  await db.init();
  return db;
}

/** Replace storage contents with a v1 database. */
async function seedV1(data) {
  await storage.clear();
  await storage.remove('__premigration');
  for (const [key, value] of Object.entries(data)) {
    await storage.set(key, value);
  }
}

/* --- Fixtures ----------------------------------------------------------- */

/** A minimal but realistic v1 database. */
function v1Fixture() {
  return {
    meta: { schemaVersion: 1, createdAt: '2026-08-05T17:12:20.982Z', lastOpenedAt: '2026-08-12T11:24:41.529Z' },
    settings: {
      theme: 'dark', units: 'kg', restTimerAutoStart: true, restTimerSound: true,
      haptics: true, reviewIntervalDays: 14, firstDayOfWeek: 1,
    },
    profile: { name: '', heightCm: 177.8, goalWeightKg: 85, programStartDate: '2026-08-06' },
    sessions: [
      {
        id: 'session-1',
        dayId: 'thursday-legs',
        date: '2026-08-06',
        status: 'completed',
        startedAt: '2026-08-06T05:00:00.000Z',
        completedAt: '2026-08-06T06:08:58.000Z',
        durationSeconds: 4138,
        week: 1, waveWeek: 1, isDeload: false,
        createdAt: '2026-08-06T05:00:00.000Z',
        updatedAt: '2026-08-06T06:08:58.000Z',
        entries: [
          {
            exerciseId: 'back-squat',
            targetWeightKg: null,
            targetReps: [6, 6, 6, 6],
            plannedAction: 'start',
            planReason: 'Pick a weight where the last 1-2 reps are hard.',
            notes: '',
            sets: [
              { weightKg: 150, reps: 12, completed: true, rpe: null },
              { weightKg: 180, reps: 10, completed: true, rpe: null },
              { weightKg: 200, reps: 8, completed: true, rpe: null },
              { weightKg: 220, reps: 6, completed: true, rpe: null },
            ],
          },
          {
            // The pain-limited, half-finished case: null loads, zero reps,
            // incomplete flags. All of it has to survive verbatim.
            exerciseId: 'pull-ups',
            targetWeightKg: null,
            targetReps: [6, 6, 6, 6],
            plannedAction: 'start',
            planReason: '',
            notes: 'elbow',
            sets: [
              { weightKg: null, reps: 6, completed: true, rpe: null },
              { weightKg: null, reps: 6, completed: true, rpe: null },
              { weightKg: 0, reps: 0, completed: false, rpe: null },
              { weightKg: null, reps: 0, completed: false, rpe: null },
            ],
          },
        ],
      },
      {
        id: 'session-2',
        dayId: 'tuesday-chest',
        date: '2026-08-11',
        status: 'in-progress',
        startedAt: '2026-08-11T05:00:00.000Z',
        completedAt: null,
        week: 1, waveWeek: 1, isDeload: false,
        entries: [
          {
            exerciseId: 'incline-dumbbell-press',
            targetWeightKg: 55,
            targetReps: [6, 6, 6, 6],
            sets: [{ weightKg: 55, reps: 6, completed: true, rpe: 8 }],
            notes: '',
          },
        ],
      },
    ],
    bodyWeight: [{ id: 'w1', date: '2026-08-06', weightKg: 77.4, note: '', createdAt: '2026-08-06T02:00:00.000Z' }],
    bodyComp: [{ id: 'c1', date: '2026-08-06', weightKg: 77.4, bodyFatPercent: 14.6 }],
    measurements: [{ id: 'm1', date: '2026-08-06', chestCm: 104 }],
    photos: [{ id: 'p1', date: '2026-08-06', pose: 'front' }],
    coachNotes: [{ id: 'n1', date: '2026-08-07', text: 'Slow the eccentric.', pinned: true }],
    recovery: [{ id: 'r1', date: '2026-08-06', sleepHours: 7.5, soreness: 2 }],
    personalRecords: {},
    reviews: [],
  };
}

/** The user's real export, if it is sitting in the repo root. */
function realBackup() {
  const file = readdirSync(ROOT).find(
    (name) => /^ironlog-backup.*\.json$/i.test(name)
  );
  if (!file) return null;
  const payload = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  return { file, payload };
}

/* --- Helpers ------------------------------------------------------------ */

/**
 * Ids the v2 -> v3 migration relabels. Kept here rather than imported so the
 * test states its own expectation: if db.js changes the mapping, these tests
 * should fail rather than agree with it.
 */
const RENAMED = { 'back-squat': 'hack-squat' };

/** What an exercise id should read as after every migration has run. */
const renamed = (id) => RENAMED[id] ?? id;

/** Every set in a database, flattened, in document order. */
function allSets(sessions) {
  const out = [];
  for (const session of sessions) {
    for (const entry of session.entries ?? []) {
      for (const [index, set] of (entry.sets ?? []).entries()) {
        out.push({ session: session.id, exercise: entry.exerciseId, index, set });
      }
    }
  }
  return out;
}

/** The fields a set carried in v1. Nothing here may change. */
function v1SetFields(set) {
  return {
    weightKg: set.weightKg ?? null,
    reps: set.reps ?? null,
    completed: Boolean(set.completed),
    rpe: set.rpe ?? null,
  };
}

/* --- The migration ------------------------------------------------------ */

test('v1 -> v2 preserves every logged set exactly', async () => {
  const before = v1Fixture();
  await seedV1(before);

  const db = await boot();
  const after = db.read('sessions');

  assert.equal(after.length, before.sessions.length, 'session count is unchanged');

  const beforeSets = allSets(before.sessions);
  const afterSets = allSets(after);
  assert.equal(afterSets.length, beforeSets.length, 'set count is unchanged');

  for (const [index, expected] of beforeSets.entries()) {
    const actual = afterSets[index];
    assert.equal(actual.session, expected.session, 'sets stay in their session');
    assert.equal(actual.exercise, renamed(expected.exercise),
      'sets stay on their exercise, allowing for the v3 relabel');
    assert.equal(actual.index, expected.index, 'set ordering is unchanged');
    assert.deepEqual(
      v1SetFields(actual.set),
      v1SetFields(expected.set),
      `set ${index} kept its values`
    );
  }
});

test('v1 -> v2 preserves session and entry metadata', async () => {
  const before = v1Fixture();
  await seedV1(before);
  const db = await boot();
  const after = db.read('sessions');

  for (const [index, original] of before.sessions.entries()) {
    const migrated = after[index];
    for (const key of ['id', 'dayId', 'date', 'status', 'startedAt', 'completedAt',
                        'durationSeconds', 'week', 'waveWeek', 'isDeload', 'createdAt']) {
      assert.deepEqual(migrated[key], original[key], `session.${key} is unchanged`);
    }
    for (const [entryIndex, entry] of original.entries.entries()) {
      const migratedEntry = migrated.entries[entryIndex];
      for (const key of ['targetWeightKg', 'targetReps', 'plannedAction',
                          'planReason', 'notes']) {
        assert.deepEqual(migratedEntry[key], entry[key], `entry.${key} is unchanged`);
      }
      // The one field v3 may rewrite, and only to the documented mapping.
      assert.equal(migratedEntry.exerciseId, renamed(entry.exerciseId),
        'entry.exerciseId is unchanged unless it is a documented relabel');
    }
  }
});

test('v1 -> v2 marks history legacy rather than guessing warm-ups', async () => {
  await seedV1(v1Fixture());
  const db = await boot();

  for (const session of db.read('sessions')) {
    for (const entry of session.entries) {
      assert.equal(entry.setModel, 'legacy', 'every migrated entry is marked legacy');
      assert.deepEqual(entry.warmupSets, [], 'no set was reclassified as a warm-up');
      assert.deepEqual(entry.intensitySets, [], 'no set was reclassified as intensity work');
      assert.equal(entry.pain, null);
      assert.equal(entry.difficulty, null);
      for (const set of entry.sets) {
        assert.equal(set.kind, 'legacy', 'every migrated set is tagged legacy');
      }
    }
  }
});

test('v1 -> v2 leaves every other collection untouched', async () => {
  const before = v1Fixture();
  await seedV1(before);
  const db = await boot();

  for (const collection of ['profile', 'bodyWeight', 'bodyComp', 'measurements',
                             'photos', 'coachNotes', 'recovery', 'personalRecords', 'reviews']) {
    assert.deepEqual(db.read(collection), before[collection], `${collection} is unchanged`);
  }

  // Settings gains nothing: the new switches live in trainingPrefs.
  assert.deepEqual(db.read('settings'), before.settings, 'settings is unchanged');
});

test('v1 -> v2 seeds Training Preferences with the documented conventions', async () => {
  await seedV1(v1Fixture());
  const db = await boot();
  const prefs = db.read('trainingPrefs');

  assert.equal(prefs.dumbbellDisplay, 'per-hand');
  assert.equal(prefs.barbellDisplay, 'plates');
  assert.equal(prefs.machineLoadHandling, 'raw');
  assert.equal(prefs.dumbbellIncrementBasis, 'per-hand');
  assert.equal(prefs.dropSetsAffectProgression, false, 'drop sets must never drive progression');
  assert.equal(prefs.pushupsCountAsVolume, false);
  assert.equal(prefs.pullUpMode, 'pain-aware');
  assert.equal(prefs.abWheelProgression, 'difficulty');
  assert.equal(prefs.morningWeightReminder, true);
});

test('the schema version is bumped and recorded', async () => {
  await seedV1(v1Fixture());
  const db = await boot();
  assert.equal(db.read('meta').schemaVersion, 3);
  assert.equal(db.SCHEMA_VERSION, 3);
});

/* --- v2 -> v3: the mislogged squat -------------------------------------- */

test('v2 -> v3 relabels back-squat entries as hack-squat', async () => {
  await seedV1(v1Fixture());
  const db = await boot();

  const entries = db.read('sessions')[0].entries;
  assert.equal(entries[0].exerciseId, 'hack-squat', 'the entry now points at the right lift');
  assert.equal(
    entries.some((entry) => entry.exerciseId === 'back-squat'), false,
    'no back-squat entry is left behind'
  );
});

test('v2 -> v3 moves the loads across untouched', async () => {
  const before = v1Fixture();
  await seedV1(before);
  const db = await boot();

  const original = before.sessions[0].entries[0];
  const migrated = db.read('sessions')[0].entries[0];

  assert.deepEqual(
    migrated.sets.map(({ weightKg, reps, completed, rpe }) => ({ weightKg, reps, completed, rpe })),
    original.sets.map(({ weightKg, reps, completed, rpe }) => ({ weightKg, reps, completed, rpe })),
    'every load, rep, tick and RPE survives the relabel'
  );
  assert.equal(migrated.setModel, 'legacy', 'and it is still unclassified week-one history');
  assert.equal(migrated.planReason, original.planReason);
});

test('v2 -> v3 relabels a coach note scoped to the old id', async () => {
  const fixture = v1Fixture();
  fixture.coachNotes.push({ id: 'n2', date: '2026-08-07', text: 'Depth.', exerciseId: 'back-squat' });
  fixture.coachNotes.push({ id: 'n3', date: '2026-08-07', text: 'Elbows.', exerciseId: 'pull-ups' });
  await seedV1(fixture);

  const notes = (await boot()).read('coachNotes');
  assert.equal(notes.find((note) => note.id === 'n2').exerciseId, 'hack-squat');
  assert.equal(notes.find((note) => note.id === 'n3').exerciseId, 'pull-ups', 'others untouched');
  assert.equal(notes.find((note) => note.id === 'n1').text, 'Slow the eccentric.');
});

test('v2 -> v3 declines rather than duplicating when both ids are present', async () => {
  const fixture = v1Fixture();
  fixture.sessions[0].entries.push({
    exerciseId: 'hack-squat',
    targetWeightKg: 180,
    targetReps: [8, 8, 8, 7],
    notes: 'started under the new program',
    sets: [{ weightKg: 180, reps: 8, completed: true, rpe: null }],
  });
  await seedV1(fixture);

  const entries = (await boot()).read('sessions')[0].entries;
  const ids = entries.map((entry) => entry.exerciseId);
  assert.equal(new Set(ids).size, ids.length, 'no session ends up with a duplicated exercise');
  assert.ok(ids.includes('back-squat'), 'the older entry is left where it is');
  assert.equal(entries[0].sets[0].weightKg, 150, 'and keeps its data');
});

test('re-running v2 -> v3 over relabelled data changes nothing', async () => {
  await seedV1(v1Fixture());
  const first = await boot();
  const afterFirst = JSON.parse(JSON.stringify(first.read('sessions')));

  await first.write('meta', { ...first.read('meta'), schemaVersion: 2 });

  const second = await boot();
  assert.deepEqual(second.read('sessions'), afterFirst, 'a second pass is a no-op');
});

test('the whole week of real history moves to hack-squat', async (t) => {
  const real = realBackup();
  if (!real) return t.skip('no ironlog-backup-*.json in the repo root');

  await storage.clear();
  await storage.remove('__premigration');
  const db = await boot();
  await db.importAll(real.payload);

  const sessions = db.read('sessions');
  const squat = sessions
    .flatMap((session) => session.entries)
    .filter((entry) => entry.exerciseId === 'hack-squat');

  assert.equal(squat.length, 1, 'week one logged it once');
  assert.deepEqual(squat[0].sets.map((set) => set.weightKg), [150, 180, 200, 220]);
  assert.deepEqual(squat[0].sets.map((set) => set.reps), [12, 10, 8, 6]);
  assert.equal(
    sessions.flatMap((s) => s.entries).some((e) => e.exerciseId === 'back-squat'), false,
    'nothing is left pointing at the retired id'
  );
});

/* --- The parachute ------------------------------------------------------ */

test('a pre-migration snapshot is written before anything is changed', async () => {
  const before = v1Fixture();
  await seedV1(before);
  const db = await boot();

  const snapshot = await db.getPreMigrationSnapshot();
  assert.ok(snapshot, 'a snapshot exists');
  assert.equal(snapshot.schemaVersion, 1, 'it records the version it captured');
  assert.ok(snapshot.capturedAt, 'it is timestamped');
  assert.ok(db.read('meta').preMigrationBackupAt, 'meta points at it');

  // It must hold the *original* shape, not the migrated one.
  const snapshotEntry = snapshot.data.sessions[0].entries[0];
  assert.equal(snapshotEntry.setModel, undefined, 'the snapshot predates setModel');
  assert.equal(snapshotEntry.sets[0].kind, undefined, 'the snapshot predates set kinds');
  assert.deepEqual(snapshot.data.sessions, before.sessions, 'the snapshot is verbatim v1');
});

test('the parachute is never overwritten by a later boot', async () => {
  await seedV1(v1Fixture());
  const first = await boot();
  const original = await first.getPreMigrationSnapshot();

  // Force another upgrade pass over already-migrated data.
  const meta = first.read('meta');
  await first.write('meta', { ...meta, schemaVersion: 1 });

  const second = await boot();
  const kept = await second.getPreMigrationSnapshot();

  assert.equal(kept.capturedAt, original.capturedAt, 'the original capture is kept');
  assert.equal(
    kept.data.sessions[0].entries[0].setModel,
    undefined,
    'the parachute still holds pre-migration data, not a migrated copy'
  );
});

/* --- Idempotency -------------------------------------------------------- */

test('re-running the migration over migrated data changes nothing', async () => {
  await seedV1(v1Fixture());
  const first = await boot();
  const afterFirst = JSON.parse(JSON.stringify(first.read('sessions')));

  // Pretend the version marker was lost, so the upgrade runs a second time
  // across entries that are already on the v2 model.
  await first.write('meta', { ...first.read('meta'), schemaVersion: 1 });

  const second = await boot();
  assert.deepEqual(second.read('sessions'), afterFirst, 'a second pass is a no-op');

  for (const session of second.read('sessions')) {
    for (const entry of session.entries) {
      assert.equal(entry.setModel, 'legacy', 'legacy stays legacy, not re-legacied');
    }
  }
});

test('booting an already-current database runs no migration', async () => {
  await seedV1(v1Fixture());
  const first = await boot();
  const before = JSON.parse(JSON.stringify(first.read('sessions')));

  const second = await boot();
  assert.deepEqual(second.read('sessions'), before);
  assert.equal(second.read('meta').schemaVersion, 3);
});

/* --- Edge cases --------------------------------------------------------- */

test('a fresh install needs no migration and no parachute', async () => {
  await storage.clear();
  await storage.remove('__premigration');

  const db = await boot();
  assert.equal(db.read('meta').schemaVersion, 3);
  assert.deepEqual(db.read('sessions'), []);
  assert.equal(await db.getPreMigrationSnapshot(), null, 'nothing to parachute on day one');
  assert.equal(db.read('meta').preMigrationBackupAt, null);
});

test('sessions with no meta record are still treated as v1', async () => {
  const fixture = v1Fixture();
  await seedV1(fixture);
  await storage.remove('meta');           // meta lost; sessions survive

  const db = await boot();
  const entry = db.read('sessions')[0].entries[0];
  assert.equal(entry.setModel, 'legacy', 'the safety net caught it');
  assert.equal(db.read('meta').schemaVersion, 3);
});

test('an entry with no sets array survives', async () => {
  const fixture = v1Fixture();
  fixture.sessions[0].entries.push({ exerciseId: 'leg-press', notes: 'skipped' });
  await seedV1(fixture);

  const db = await boot();
  const entry = db.read('sessions')[0].entries.at(-1);
  assert.deepEqual(entry.sets, []);
  assert.equal(entry.setModel, 'legacy');
  assert.equal(entry.notes, 'skipped');
});

/* --- Backup compatibility ----------------------------------------------- */

test('a v1 backup imported into a current database is migrated on the way in', async () => {
  await storage.clear();
  await storage.remove('__premigration');
  const db = await boot();

  const fixture = v1Fixture();
  await db.importAll({
    app: 'Project IronLog',
    schemaVersion: 1,
    exportedAt: '2026-08-12T11:25:32.616Z',
    data: fixture,
  });

  const sessions = db.read('sessions');
  assert.equal(sessions.length, 2, 'both sessions restored');
  assert.equal(sessions[0].entries[0].setModel, 'legacy', 'restored history is classified');
  assert.equal(sessions[0].entries[0].sets[0].weightKg, 150, 'loads survive the round trip');
  assert.equal(db.read('meta').schemaVersion, 3);
  assert.deepEqual(db.read('bodyWeight'), fixture.bodyWeight);
});

test('an export round-trips without loss', async () => {
  await seedV1(v1Fixture());
  const db = await boot();

  const exported = JSON.parse(JSON.stringify(db.exportAll()));
  assert.equal(exported.schemaVersion, 3);

  const sessionsBefore = JSON.parse(JSON.stringify(db.read('sessions')));
  await db.importAll(exported);

  assert.deepEqual(db.read('sessions'), sessionsBefore, 'sessions survive export + import');
  assert.deepEqual(db.read('trainingPrefs'), exported.data.trainingPrefs);
});

/* --- The real thing ----------------------------------------------------- */

const real = realBackup();

test('the real backup migrates losslessly', { skip: real ? false : 'no backup file in the repo root' }, async () => {
  await seedV1(real.payload.data);
  const db = await boot();

  const before = real.payload.data.sessions;
  const after = db.read('sessions');

  assert.equal(after.length, before.length, `all ${before.length} real sessions survive`);

  const beforeSets = allSets(before);
  const afterSets = allSets(after);
  assert.equal(afterSets.length, beforeSets.length, `all ${beforeSets.length} real sets survive`);

  for (const [index, expected] of beforeSets.entries()) {
    assert.deepEqual(
      v1SetFields(afterSets[index].set),
      v1SetFields(expected.set),
      `real set ${index} (${expected.exercise}) kept its values`
    );
  }

  for (const collection of ['profile', 'bodyWeight', 'bodyComp', 'measurements',
                             'photos', 'coachNotes', 'recovery', 'reviews']) {
    assert.deepEqual(
      db.read(collection),
      real.payload.data[collection],
      `real ${collection} is untouched`
    );
  }

  const snapshot = await db.getPreMigrationSnapshot();
  assert.deepEqual(snapshot.data.sessions, before, 'the parachute holds the real v1 sessions');
});
