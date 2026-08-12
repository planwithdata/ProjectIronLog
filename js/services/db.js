/**
 * db.js — Repository layer over the storage adapter.
 *
 * Responsibilities
 * ----------------
 *   1. Own the list of collections and their default shapes.
 *   2. Hold a hydrated in-memory cache, so pages can read synchronously and
 *      render in one frame. Writes are async and go straight through.
 *   3. Run forward-only schema migrations at startup.
 *   4. Provide whole-database export / import / reset for the backup feature.
 *
 * Read/write split
 * ----------------
 * `read()` is synchronous against the cache; `write()` is async against the
 * adapter and updates the cache first. Reads never block a render, and a
 * failed write surfaces as a rejected promise the caller can report — while
 * the cache holds the user's input rather than silently discarding it.
 */

import { storage } from './storage-adapter.js';
import { EVENTS, emit } from '../core/events.js';
import { SET_KIND } from '../engine/set-model.js';

/** Current schema version. Bump when a migration is added below. */
export const SCHEMA_VERSION = 3;

/**
 * Reserved storage key holding a verbatim copy of the database as it was
 * immediately before the first schema upgrade ran on this device.
 *
 * Not a collection: it is deliberately outside `COLLECTIONS` so it is never
 * exported, never imported, and never migrated — it is a parachute, and a
 * parachute that gets repacked by the thing it protects against is not one.
 */
export const PRE_MIGRATION_KEY = '__premigration';

/**
 * Every collection the app persists, with its default value.
 * Adding a feature means adding a line here — never a stray key elsewhere.
 */
export const COLLECTIONS = {
  META:         'meta',           // { schemaVersion, createdAt, lastOpenedAt }
  SETTINGS:     'settings',       // { theme, units, ... }
  PROFILE:      'profile',        // { name, heightCm, goalWeightKg, programStartDate }
  SESSIONS:     'sessions',       // completed + in-progress workout sessions
  BODY_WEIGHT:  'bodyWeight',     // daily morning weigh-ins
  BODY_COMP:    'bodyComp',       // scale readings (fat %, muscle, water, ...)
  MEASUREMENTS: 'measurements',   // tape measurements
  PHOTOS:       'photos',         // progress photos (data URLs)
  COACH_NOTES:  'coachNotes',     // coaching advice entries
  RECOVERY:     'recovery',       // sleep / soreness / energy logs
  PERSONAL_RECORDS: 'personalRecords', // derived PR cache, keyed by exercise
  REVIEWS:      'reviews',        // generated two-week reviews
  TRAINING:     'trainingPrefs',  // how this user trains — see engine/set-model.js
};

const DEFAULTS = {
  [COLLECTIONS.META]: () => ({
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
    /** Set by markBackupTaken(); surfaced in Settings as "Last backup". */
    lastBackupAt: null,
    /** When the v1 parachute was written, or null if there was never a v1. */
    preMigrationBackupAt: null,
    /** Guards the morning weigh-in prompt to once per calendar day. */
    lastMorningPromptDate: null,
  }),
  [COLLECTIONS.SETTINGS]: () => ({
    theme: 'dark',            // 'dark' | 'light' | 'system'
    units: 'kg',              // 'kg' | 'lb' — display only; storage stays kg
    restTimerAutoStart: true,
    restTimerSound: true,
    haptics: true,
    reviewIntervalDays: 14,
    firstDayOfWeek: 1,        // ISO: Monday
  }),
  [COLLECTIONS.PROFILE]: () => ({
    name: '',
    heightCm: null,
    goalWeightKg: null,
    programStartDate: null,   // set on the first completed workout
  }),
  [COLLECTIONS.SESSIONS]:          () => [],
  [COLLECTIONS.BODY_WEIGHT]:       () => [],
  [COLLECTIONS.BODY_COMP]:         () => [],
  [COLLECTIONS.MEASUREMENTS]:      () => [],
  [COLLECTIONS.PHOTOS]:            () => [],
  [COLLECTIONS.COACH_NOTES]:       () => [],
  [COLLECTIONS.RECOVERY]:          () => [],
  [COLLECTIONS.PERSONAL_RECORDS]:  () => ({}),
  [COLLECTIONS.REVIEWS]:           () => [],
  [COLLECTIONS.TRAINING]:          () => defaultTrainingPrefs(),
};

/**
 * Training Preferences — how this user actually trains.
 *
 * These are *conventions, not corrections*. They are stored rather than
 * hardcoded so a future change of habit is a toggle rather than a patch, and
 * so the app can never quietly decide it knows better.
 */
export function defaultTrainingPrefs() {
  return {
    /* Reminders */
    morningWeightReminder: true,

    /* Set model */
    separateWarmupSets: true,
    separateWorkingSets: true,
    defaultWarmupSets: 3,

    /* Intensity techniques */
    dropSetsAllowed: true,
    failureTechniques: 'optional',      // 'optional' | 'off'
    dropSetsAffectProgression: false,   // must stay false for the engine to be honest

    /* Chest day */
    pushupsBeforeChest: true,
    pushupsCountAsVolume: false,

    /* Exercise-specific handling */
    pullUpMode: 'pain-aware',           // 'pain-aware' | 'standard'
    abWheelProgression: 'difficulty',   // 'difficulty' | 'load'

    /* Load display conventions — see engine/loading.js */
    dumbbellDisplay: 'per-hand',        // stored total of both, shown per hand
    barbellDisplay: 'plates',           // stored plates only, bar excluded
    machineLoadHandling: 'raw',         // never normalised between machines
    dumbbellIncrementBasis: 'per-hand', // +2.5 kg/hand = +5 kg of stored total
  };
}

const ALL = Object.values(COLLECTIONS);

/** Hydrated cache: collection name -> value. */
const cache = new Map();
let ready = false;

/**
 * Forward-only migrations. `MIGRATIONS[n]` upgrades a database at version `n`
 * to version `n + 1` and receives a plain `{ collection: value }` snapshot,
 * which it mutates in place.
 *
 * The runner existed from day one because retrofitting one onto data that is
 * already on a phone is how personal apps lose their history. This is the
 * migration it was built for.
 */
const MIGRATIONS = [
  // index 0: v0 -> v1 (fresh install; nothing to do)
  (snapshot) => snapshot,
  // index 1: v1 -> v2 (warm-up / working / intensity set model)
  migrateV1ToV2,
  // index 2: v2 -> v3 (week one's squats were hack squats, logged as back squats)
  migrateV2ToV3,
];

/**
 * v1 -> v2: separate warm-up, working and intensity work.
 *
 * **Strictly additive.** Not one weight, rep count, completion flag, RPE, date,
 * note or ordering is altered. Every existing set stays exactly where it is, in
 * `entry.sets`, and is tagged `kind: 'legacy'`; the entry is marked
 * `setModel: 'legacy'`.
 *
 * Why nothing is reclassified
 * ---------------------------
 * The real week-one data is, on almost every exercise, a rising-weight
 * falling-rep ladder — 150x12, 180x10, 200x8, 220x6 on the squat. That *looks*
 * like three ramp sets and a working set. It also looks exactly like a pyramid,
 * or like working up to a top single. The app cannot tell which, and the
 * difference decides what the progression engine does next.
 *
 * So it does not guess. Legacy sets keep feeding progression, because they are
 * the only record of what was lifted and throwing them away would be worse than
 * a coarse reading of them. They are labelled "unclassified" everywhere they
 * surface, and History offers a manual per-set reclassification control for
 * whenever the user wants to tell the app what those sets actually were.
 */
function migrateV1ToV2(snapshot) {
  const sessions = snapshot[COLLECTIONS.SESSIONS];
  if (Array.isArray(sessions)) {
    snapshot[COLLECTIONS.SESSIONS] = sessions.map(upgradeSessionToV2);
  }

  // A v1 database has no trainingPrefs key at all. `init()` has already put the
  // defaults in the cache; make sure an empty or partial object still ends up
  // complete rather than missing keys the UI reads.
  snapshot[COLLECTIONS.TRAINING] = {
    ...defaultTrainingPrefs(),
    ...(isPlainObject(snapshot[COLLECTIONS.TRAINING]) ? snapshot[COLLECTIONS.TRAINING] : {}),
  };

  return snapshot;
}

function upgradeSessionToV2(session) {
  if (!session || !Array.isArray(session.entries)) return session;
  return { ...session, entries: session.entries.map(upgradeEntryToV2) };
}

function upgradeEntryToV2(entry) {
  if (!entry || typeof entry !== 'object') return entry;

  // Idempotent. Re-running the migration — or importing a backup that has
  // already been through it — must be a no-op, not a second pass that relabels
  // classified sets as legacy.
  if (entry.setModel === 'v2' || entry.setModel === 'legacy') return entry;

  const sets = Array.isArray(entry.sets) ? entry.sets : [];

  return {
    ...entry,
    setModel: 'legacy',
    sets: sets.map((set) =>
      (set && typeof set === 'object' && set.kind)
        ? set
        : { ...set, kind: SET_KIND.LEGACY }),
    warmupSets: Array.isArray(entry.warmupSets) ? entry.warmupSets : [],
    intensitySets: Array.isArray(entry.intensitySets) ? entry.intensitySets : [],
    pain: entry.pain ?? null,
    difficulty: entry.difficulty ?? null,
  };
}

/**
 * Exercise ids that were logged against the wrong movement, and what they
 * should have said. Data rather than code, so the *reason* for each one can be
 * written next to it and a future correction is a line rather than a function.
 */
const V3_EXERCISE_RENAMES = {
  // Rish trained hack squats in week one and logged them under Back Squat,
  // which was the movement occupying the Thursday slot at the time. The numbers
  // (150 / 180 / 200 / 220) were always readings off a hack squat sled; they
  // were merely filed under a barbell.
  'back-squat': 'hack-squat',
};

/**
 * v2 -> v3: point mislogged entries at the movement that was actually trained.
 *
 * **A relabel, not a recalculation.** Not one weight, rep count, completion
 * flag, RPE, kind, date, note or ordering is touched — only the `exerciseId`
 * an entry points at. What changes downstream is only what that id *means*:
 * `150` stops being labelled `+150 kg plates · est. total 170 kg` and starts
 * reading as the raw machine value it always was, and the week's history
 * attaches to Hack Squat, where the progression engine can use it.
 *
 * Applied to every collection that stores an exercise id — sessions, coach
 * notes, the derived PR cache. Not to `reviews`: a generated review is a dated
 * snapshot of what the app said at the time, and editing one after the fact
 * would make it a record of nothing.
 *
 * Idempotent, and refuses to collide. An entry already pointing at the new id
 * is left alone; and if a session somehow holds *both* ids, the old one is left
 * exactly where it is rather than merged into a duplicate the rest of the app
 * would silently mis-read (`entries.find` returns one of two). That case cannot
 * arise from Rish's data, but a migration that corrupts on a surprise is worse
 * than one that declines and says so.
 */
function migrateV2ToV3(snapshot) {
  const sessions = snapshot[COLLECTIONS.SESSIONS];
  if (Array.isArray(sessions)) {
    snapshot[COLLECTIONS.SESSIONS] = sessions.map(renameSessionExercises);
  }

  const notes = snapshot[COLLECTIONS.COACH_NOTES];
  if (Array.isArray(notes)) {
    snapshot[COLLECTIONS.COACH_NOTES] = notes.map((note) => {
      const renamed = note?.exerciseId ? V3_EXERCISE_RENAMES[note.exerciseId] : null;
      return renamed ? { ...note, exerciseId: renamed } : note;
    });
  }

  const records = snapshot[COLLECTIONS.PERSONAL_RECORDS];
  if (isPlainObject(records)) {
    snapshot[COLLECTIONS.PERSONAL_RECORDS] = Object.fromEntries(
      Object.entries(records).map(([id, value]) => {
        const renamed = V3_EXERCISE_RENAMES[id];
        // Never overwrite a record the new id already holds.
        return [renamed && !(renamed in records) ? renamed : id, value];
      })
    );
  }

  return snapshot;
}

function renameSessionExercises(session) {
  if (!session || !Array.isArray(session.entries)) return session;

  const present = new Set(session.entries.map((entry) => entry?.exerciseId));
  let changed = false;

  const entries = session.entries.map((entry) => {
    const renamed = entry?.exerciseId ? V3_EXERCISE_RENAMES[entry.exerciseId] : null;
    if (!renamed) return entry;

    if (present.has(renamed)) {
      console.warn(
        `[db] session ${session.id} holds both "${entry.exerciseId}" and "${renamed}"; ` +
        'leaving the older entry alone rather than creating a duplicate.'
      );
      return entry;
    }

    changed = true;
    return { ...entry, exerciseId: renamed };
  });

  return changed ? { ...session, entries } : session;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* --- Lifecycle ---------------------------------------------------------- */

/** Hydrate the cache and run migrations. Must be awaited before any read. */
export async function init() {
  if (ready) return;

  let metaWasStored = false;

  await Promise.all(
    ALL.map(async (collection) => {
      const stored = await storage.get(collection);
      if (collection === COLLECTIONS.META) metaWasStored = stored !== null && stored !== undefined;
      cache.set(collection, stored ?? DEFAULTS[collection]());
    })
  );

  // Safety net for a database with data but no meta key: the default meta
  // claims the current schema version, which would skip every migration and
  // leave real sessions unclassified forever. Anything holding sessions without
  // a meta record can only have come from v1.
  if (!metaWasStored && (cache.get(COLLECTIONS.SESSIONS) ?? []).length > 0) {
    console.warn('[db] sessions present with no meta record; treating as schema v1.');
    cache.get(COLLECTIONS.META).schemaVersion = 1;
  }

  await runMigrations();

  const meta = cache.get(COLLECTIONS.META);
  meta.lastOpenedAt = new Date().toISOString();
  await storage.set(COLLECTIONS.META, meta);

  ready = true;
}

export function isReady() {
  return ready;
}

async function runMigrations() {
  const meta = cache.get(COLLECTIONS.META);
  let from = Number(meta.schemaVersion ?? 0);

  if (from > SCHEMA_VERSION) {
    // Data written by a newer build of the app. Refuse to downgrade rather
    // than risk mangling it — the user can update the installed PWA.
    console.warn(
      `[db] stored schema v${from} is newer than this build (v${SCHEMA_VERSION}); ` +
      'leaving data untouched.'
    );
    return;
  }

  // Parachute first, and only for a database that actually holds something. A
  // fresh install at v0 has nothing to lose; anything at v1 or above does.
  if (from >= 1 && from < SCHEMA_VERSION) {
    await writePreMigrationSnapshot(from);
  }

  while (from < SCHEMA_VERSION) {
    const migrate = MIGRATIONS[from];
    if (typeof migrate === 'function') {
      const snapshot = Object.fromEntries(cache);
      try {
        migrate(snapshot);
        for (const [key, value] of Object.entries(snapshot)) cache.set(key, value);
      } catch (error) {
        console.error(`[db] migration v${from} -> v${from + 1} failed:`, error);
        throw error;
      }
    }
    from += 1;
  }

  if (meta.schemaVersion !== SCHEMA_VERSION) {
    meta.schemaVersion = SCHEMA_VERSION;
    await persistAll();
  }
}

/**
 * Copy the database verbatim to the reserved parachute key, once, before the
 * first schema upgrade touches it.
 *
 * Never overwritten: the first snapshot is the only one that captures the
 * pre-upgrade state, so a later run must not replace it with data that has
 * already been migrated.
 *
 * A failure here does not stop the migration. The v1 -> v2 upgrade is additive
 * and idempotent, so refusing to start the app over a missing parachute would
 * trade a small risk for a certain outage. It is recorded instead, and Settings
 * says so.
 */
async function writePreMigrationSnapshot(fromVersion) {
  const meta = cache.get(COLLECTIONS.META);

  try {
    const existing = await storage.get(PRE_MIGRATION_KEY);
    if (existing) {
      console.info('[db] pre-migration snapshot already present; keeping the original.');
      return;
    }

    await storage.set(PRE_MIGRATION_KEY, {
      app: 'Project IronLog',
      kind: 'pre-migration snapshot',
      schemaVersion: fromVersion,
      capturedAt: new Date().toISOString(),
      data: Object.fromEntries(ALL.map((collection) => [collection, cache.get(collection)])),
    });

    meta.preMigrationBackupAt = new Date().toISOString();
    console.info(`[db] wrote a pre-migration snapshot of schema v${fromVersion}.`);
  } catch (error) {
    console.error('[db] could not write the pre-migration snapshot:', error);
    meta.preMigrationBackupFailed = true;
  }
}

/** The parachute, for the Settings download row. Null when there is none. */
export async function getPreMigrationSnapshot() {
  try {
    return await storage.get(PRE_MIGRATION_KEY);
  } catch (error) {
    console.error('[db] could not read the pre-migration snapshot:', error);
    return null;
  }
}

/**
 * Discard the parachute. Offered in Settings only once a fresh backup has been
 * taken, and never called automatically — reclaiming a few kilobytes is not
 * worth deciding on the user's behalf that the old copy is no longer wanted.
 */
export async function clearPreMigrationSnapshot() {
  await storage.remove(PRE_MIGRATION_KEY);
  await update(COLLECTIONS.META, (meta) => ({ ...meta, preMigrationBackupAt: null }));
}

/* --- Reads and writes -------------------------------------------------- */

/**
 * Synchronous read from the cache.
 * Returns the live object — callers must not mutate it in place; use
 * `write()` with a new value, or `update()`.
 */
export function read(collection) {
  if (!ready) {
    throw new Error(`[db] read("${collection}") before init(); await db.init() first.`);
  }
  if (!(collection in DEFAULTS)) {
    throw new Error(`[db] unknown collection "${collection}"`);
  }
  return cache.get(collection);
}

/** Persist a new value for a collection. */
export async function write(collection, value) {
  if (!(collection in DEFAULTS)) {
    throw new Error(`[db] unknown collection "${collection}"`);
  }
  cache.set(collection, value);
  await storage.set(collection, value);
  emit(EVENTS.DATA_CHANGED, { collection });
  return value;
}

/**
 * Read-modify-write in one step.
 * `mutator` receives the current value and returns the next one (or mutates
 * and returns nothing, for arrays and plain objects).
 */
export async function update(collection, mutator) {
  const current = read(collection);
  const next = mutator(current);
  return write(collection, next === undefined ? current : next);
}

/** Append an item to an array collection, returning the stored item. */
export async function insert(collection, item) {
  const list = read(collection);
  if (!Array.isArray(list)) {
    throw new Error(`[db] insert() requires an array collection; "${collection}" is not`);
  }
  const record = { id: item.id ?? newId(), createdAt: new Date().toISOString(), ...item };
  await write(collection, [...list, record]);
  return record;
}

/** Replace an item by id in an array collection. Returns the merged item. */
export async function replaceById(collection, id, patch) {
  const list = read(collection);
  let merged = null;
  const next = list.map((entry) => {
    if (entry.id !== id) return entry;
    merged = { ...entry, ...patch, updatedAt: new Date().toISOString() };
    return merged;
  });
  if (!merged) return null;
  await write(collection, next);
  return merged;
}

/** Remove an item by id from an array collection. */
export async function removeById(collection, id) {
  const list = read(collection);
  const next = list.filter((entry) => entry.id !== id);
  if (next.length === list.length) return false;
  await write(collection, next);
  return true;
}

async function persistAll() {
  await Promise.all(ALL.map((collection) => storage.set(collection, cache.get(collection))));
}

/* --- Backup / restore -------------------------------------------------- */

/** A complete, portable snapshot of the database. */
export function exportAll() {
  return {
    app: 'Project IronLog',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: Object.fromEntries(ALL.map((collection) => [collection, cache.get(collection)])),
  };
}

/**
 * Record that a backup was successfully taken.
 *
 * Called by the caller that actually delivered the file, not by `exportAll()`:
 * building the JSON is not the same as it reaching the user's disk, and a
 * "Last backup" date for a download that failed would be a lie in the one place
 * the user has to be able to trust.
 */
export async function markBackupTaken(at = new Date().toISOString()) {
  await update(COLLECTIONS.META, (meta) => ({ ...meta, lastBackupAt: at }));
  return at;
}

/** When the last backup was taken, or null. */
export function getLastBackupAt() {
  return read(COLLECTIONS.META).lastBackupAt ?? null;
}

/**
 * Validate and import a snapshot produced by `exportAll()`.
 * Unknown collections are ignored; missing ones fall back to defaults, so a
 * backup taken from an older build still restores cleanly.
 *
 * @throws {Error} when the payload is not a recognisable IronLog backup
 */
export async function importAll(payload) {
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') {
    throw new Error('This file is not an IronLog backup.');
  }

  const incomingVersion = Number(payload.schemaVersion ?? 0);
  if (incomingVersion > SCHEMA_VERSION) {
    throw new Error(
      `This backup was made by a newer version of IronLog (schema v${incomingVersion}). ` +
      'Update the app, then restore again.'
    );
  }

  for (const collection of ALL) {
    const incoming = payload.data[collection];
    const fallback = DEFAULTS[collection]();
    // Type must match the collection's shape, or we take the default rather
    // than let a malformed backup poison the cache.
    const sameShape = Array.isArray(fallback)
      ? Array.isArray(incoming)
      : incoming && typeof incoming === 'object' && !Array.isArray(incoming);
    cache.set(collection, sameShape ? incoming : fallback);
  }

  const meta = cache.get(COLLECTIONS.META);
  meta.schemaVersion = incomingVersion || SCHEMA_VERSION;
  await runMigrations();
  await persistAll();

  emit(EVENTS.DATA_RESTORED, {});
  emit(EVENTS.DATA_CHANGED, { collection: '*' });
}

/** Wipe every IronLog key and return to defaults. */
export async function reset() {
  await storage.clear();
  for (const collection of ALL) cache.set(collection, DEFAULTS[collection]());
  await persistAll();
  emit(EVENTS.DATA_RESET, {});
  emit(EVENTS.DATA_CHANGED, { collection: '*' });
}

/* --- Utilities --------------------------------------------------------- */

/**
 * Collision-resistant id. `crypto.randomUUID` is available in every browser
 * that can install this PWA, but the fallback keeps the app working in an
 * insecure context (plain-HTTP local testing).
 */
export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Approximate bytes used, for the Settings storage readout. */
export function usageBytes() {
  return storage.usageBytes();
}

/** Whether data is actually persisting (false in Safari Private Browsing). */
export function isPersistent() {
  return storage.isAvailable();
}
