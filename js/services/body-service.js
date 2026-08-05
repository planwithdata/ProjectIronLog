/**
 * body-service.js — Body weight and body composition.
 *
 * Storage is always metric (kg, cm). The display unit is a *view* concern
 * handled by format.displayWeight, so toggling kg/lb in Settings never
 * rewrites a single stored reading — and a backup restored on a device with
 * the other unit selected still reads correctly.
 *
 * One weigh-in per calendar day: logging again the same day replaces the
 * earlier entry rather than adding a second point, because the metric that
 * matters is the morning weight, not an average of the day's readings.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { today, daysBetween, addDays } from '../core/format.js';

/** Fields captured by a smart-scale reading. Order drives the UI. */
export const COMPOSITION_FIELDS = [
  { key: 'weightKg',       label: 'Weight',          unit: 'kg',     decimals: 1 },
  { key: 'bmi',            label: 'BMI',             unit: '',       decimals: 1 },
  { key: 'bodyFatPercent', label: 'Body Fat',        unit: '%',      decimals: 1 },
  { key: 'muscleMassKg',   label: 'Muscle Mass',     unit: 'kg',     decimals: 1 },
  { key: 'skeletalMuscleKg', label: 'Skeletal Muscle', unit: 'kg',   decimals: 1 },
  { key: 'visceralFat',    label: 'Visceral Fat',    unit: '',       decimals: 0 },
  { key: 'waterPercent',   label: 'Water',           unit: '%',      decimals: 1 },
  { key: 'proteinPercent', label: 'Protein',         unit: '%',      decimals: 1 },
  { key: 'boneMassKg',     label: 'Bone Mass',       unit: 'kg',     decimals: 1 },
  { key: 'bmr',            label: 'BMR',             unit: 'kcal',   decimals: 0 },
];

/* --- Body weight -------------------------------------------------------- */

/** All weigh-ins, oldest first. */
export function getWeightEntries() {
  return [...db.read(COLLECTIONS.BODY_WEIGHT)].sort((a, b) => a.date.localeCompare(b.date));
}

/** The most recent weigh-in, or null. */
export function getLatestWeight() {
  const entries = getWeightEntries();
  return entries.length ? entries[entries.length - 1] : null;
}

export function getWeightOn(dayKey) {
  return db.read(COLLECTIONS.BODY_WEIGHT).find((entry) => entry.date === dayKey) ?? null;
}

/**
 * Record a morning weigh-in, replacing any entry already stored for that day.
 * @param {number} weightKg
 * @param {string} [dayKey]  defaults to today
 * @param {string} [note]
 */
export async function logWeight(weightKg, dayKey = today(), note = '') {
  const value = Number(weightKg);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Enter a body weight greater than zero.');
  }

  const entries = db.read(COLLECTIONS.BODY_WEIGHT);
  const existing = entries.find((entry) => entry.date === dayKey);

  if (existing) {
    return db.replaceById(COLLECTIONS.BODY_WEIGHT, existing.id, { weightKg: value, note });
  }
  return db.insert(COLLECTIONS.BODY_WEIGHT, { date: dayKey, weightKg: value, note });
}

export async function deleteWeight(id) {
  return db.removeById(COLLECTIONS.BODY_WEIGHT, id);
}

/**
 * Mean weight over the `days` calendar days ending at `endKey`.
 * Averaging is what makes a lean bulk readable — daily weight swings ±1 kg
 * on water alone, which is larger than a week's actual gain.
 *
 * @returns {{average: number, count: number}|null} null when no data in range
 */
export function getAverageWeight(days, endKey = today()) {
  const startKey = addDays(endKey, -(days - 1));
  const inRange = getWeightEntries().filter(
    (entry) => entry.date >= startKey && entry.date <= endKey
  );
  if (!inRange.length) return null;
  const sum = inRange.reduce((total, entry) => total + entry.weightKg, 0);
  return { average: sum / inRange.length, count: inRange.length };
}

export function getWeeklyAverage(endKey = today())  { return getAverageWeight(7, endKey); }
export function getMonthlyAverage(endKey = today()) { return getAverageWeight(30, endKey); }

/**
 * Lean bulk rate: kg gained per week, comparing the current 7-day average
 * with the 7-day average one week earlier. Comparing averages rather than
 * single readings is what stops a bad night's sleep looking like a trend.
 *
 * @returns {{kgPerWeek: number, verdict: 'slow'|'ideal'|'fast', current: number, previous: number}|null}
 */
export function getLeanBulkRate(endKey = today()) {
  const current = getAverageWeight(7, endKey);
  const previous = getAverageWeight(7, addDays(endKey, -7));
  if (!current || !previous) return null;

  const kgPerWeek = current.average - previous.average;

  // A lean bulk sits near 0.25–0.5 kg/week for a trained lifter: enough to
  // add tissue, slow enough that most of it is not fat.
  let verdict = 'ideal';
  if (kgPerWeek < 0.15) verdict = 'slow';
  else if (kgPerWeek > 0.6) verdict = 'fast';

  return { kgPerWeek, verdict, current: current.average, previous: previous.average };
}

/** Change in weight over a window, using raw endpoints. */
export function getWeightChange(days, endKey = today()) {
  const entries = getWeightEntries();
  if (entries.length < 2) return null;
  const startKey = addDays(endKey, -days);
  const before = [...entries].reverse().find((entry) => entry.date <= startKey);
  const latest = entries[entries.length - 1];
  if (!before || before.id === latest.id) return null;
  return {
    deltaKg: latest.weightKg - before.weightKg,
    fromDate: before.date,
    toDate: latest.date,
    days: daysBetween(before.date, latest.date),
  };
}

/* --- Body composition --------------------------------------------------- */

/** All scale readings, oldest first. */
export function getCompositionEntries() {
  return [...db.read(COLLECTIONS.BODY_COMP)].sort((a, b) => a.date.localeCompare(b.date));
}

export function getLatestComposition() {
  const entries = getCompositionEntries();
  return entries.length ? entries[entries.length - 1] : null;
}

/** The most recent non-null value for one composition field. */
export function getLatestField(key) {
  const entries = getCompositionEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const value = entries[i][key];
    if (value !== null && value !== undefined && value !== '') {
      return { value, date: entries[i].date };
    }
  }
  return null;
}

/**
 * Store a scale reading. Every reading is kept — the prompt calls for a full
 * history, and these are small records.
 *
 * Only recognised, numeric fields are persisted, so a stray key from a future
 * import cannot quietly become part of the schema.
 */
export async function logComposition(reading, dayKey = today()) {
  const record = { date: dayKey };
  let populated = 0;

  for (const field of COMPOSITION_FIELDS) {
    const raw = reading[field.key];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    record[field.key] = value;
    populated += 1;
  }

  if (!populated) throw new Error('Enter at least one measurement.');
  if (reading.note) record.note = String(reading.note);

  const stored = await db.insert(COLLECTIONS.BODY_COMP, record);

  // A scale reading includes body weight; keep the weight series in step so
  // the two views can never disagree.
  if (record.weightKg) await logWeight(record.weightKg, dayKey);

  return stored;
}

export async function deleteComposition(id) {
  return db.removeById(COLLECTIONS.BODY_COMP, id);
}

/** A `{ date, value }` series for one field, ready to chart. */
export function getSeries(key) {
  return getCompositionEntries()
    .filter((entry) => entry[key] !== null && entry[key] !== undefined)
    .map((entry) => ({ date: entry.date, value: entry[key] }));
}

/** Weight series from the weigh-in log, ready to chart. */
export function getWeightSeries() {
  return getWeightEntries().map((entry) => ({ date: entry.date, value: entry.weightKg }));
}

/** BMI from the stored height, when the user has entered one. */
export function computeBmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const metres = heightCm / 100;
  return weightKg / (metres * metres);
}
