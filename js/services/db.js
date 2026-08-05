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

/** Current schema version. Bump when a migration is added below. */
export const SCHEMA_VERSION = 1;

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
};

const DEFAULTS = {
  [COLLECTIONS.META]: () => ({
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
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
};

const ALL = Object.values(COLLECTIONS);

/** Hydrated cache: collection name -> value. */
const cache = new Map();
let ready = false;

/**
 * Forward-only migrations. `MIGRATIONS[n]` upgrades a database at version `n`
 * to version `n + 1` and receives a plain `{ collection: value }` snapshot,
 * which it mutates in place.
 *
 * Version 1 is the initial schema, so there is nothing to migrate yet. The
 * runner exists from day one because retrofitting one onto data that is
 * already on a phone is how personal apps lose their history.
 */
const MIGRATIONS = [
  // index 0: v0 -> v1 (fresh install; nothing to do)
  (snapshot) => snapshot,
];

/* --- Lifecycle ---------------------------------------------------------- */

/** Hydrate the cache and run migrations. Must be awaited before any read. */
export async function init() {
  if (ready) return;

  await Promise.all(
    ALL.map(async (collection) => {
      const stored = await storage.get(collection);
      cache.set(collection, stored ?? DEFAULTS[collection]());
    })
  );

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
