/**
 * logs-service.js — Recovery logs, tape measurements and progress photos.
 *
 * These three are all "a dated record with a few numeric fields", so they share
 * one factory rather than three near-identical CRUD modules. Each exported
 * namespace declares its own fields; the storage behaviour is written once.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { today } from '../core/format.js';
import * as photoStore from './photo-store.js';

/* --- Shared factory ----------------------------------------------------- */

/**
 * Build a service for a dated-record collection.
 *
 * @param {string} collection
 * @param {Array<{key: string, label: string, unit: string, decimals: number, min?: number, max?: number}>} fields
 * @param {object} [options]
 * @param {boolean} [options.onePerDay]  a second entry for a day replaces the first
 */
function datedLog(collection, fields, { onePerDay = true } = {}) {
  const byKey = new Map(fields.map((field) => [field.key, field]));

  /** Oldest first. */
  const all = () =>
    [...db.read(collection)].sort((a, b) => a.date.localeCompare(b.date));

  const latest = () => {
    const entries = all();
    return entries.length ? entries[entries.length - 1] : null;
  };

  /**
   * Keep only recognised, numeric, in-range fields. An unknown key from a
   * hand-edited backup must not silently become part of the schema, and a
   * fat-fingered 700 kg body weight should be refused rather than stored and
   * then quietly wrecking every average.
   */
  const clean = (input) => {
    const record = {};
    let populated = 0;

    for (const [key, raw] of Object.entries(input)) {
      const field = byKey.get(key);
      if (!field) continue;
      if (raw === null || raw === undefined || raw === '') continue;

      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (field.min !== undefined && value < field.min) continue;
      if (field.max !== undefined && value > field.max) continue;

      record[key] = value;
      populated += 1;
    }

    return { record, populated };
  };

  return {
    fields,
    all,
    latest,

    on(dayKey) {
      return db.read(collection).find((entry) => entry.date === dayKey) ?? null;
    },

    /** The most recent non-empty value for one field, with its date. */
    latestField(key) {
      const entries = all();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const value = entries[i][key];
        if (value !== null && value !== undefined && value !== '') {
          return { value, date: entries[i].date };
        }
      }
      return null;
    },

    /** A `{date, value}` series for one field, ready to chart. */
    series(key) {
      return all()
        .filter((entry) => entry[key] !== null && entry[key] !== undefined)
        .map((entry) => ({ date: entry.date, value: entry[key] }));
    },

    /** Mean of one field over the entries between two dates, inclusive. */
    meanBetween(key, startKey, endKey) {
      const values = all()
        .filter((entry) => entry.date >= startKey && entry.date <= endKey)
        .map((entry) => entry[key])
        .filter((value) => value !== null && value !== undefined && Number.isFinite(value));
      if (!values.length) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    },

    between(startKey, endKey) {
      return all().filter((entry) => entry.date >= startKey && entry.date <= endKey);
    },

    async log(input, dayKey = today(), note = '') {
      const { record, populated } = clean(input);
      if (!populated) throw new Error('Enter at least one value.');
      if (note) record.note = String(note).slice(0, 500);

      if (onePerDay) {
        const existing = db.read(collection).find((entry) => entry.date === dayKey);
        if (existing) return db.replaceById(collection, existing.id, record);
      }

      return db.insert(collection, { date: dayKey, ...record });
    },

    async update(id, patch) {
      const { record } = clean(patch);
      if (patch.note !== undefined) record.note = String(patch.note).slice(0, 500);
      return db.replaceById(collection, id, record);
    },

    async remove(id) {
      return db.removeById(collection, id);
    },

    count() {
      return db.read(collection).length;
    },
  };
}

/* --- Recovery ----------------------------------------------------------- */

/**
 * Sleep in hours, plus three 1–5 self-reports.
 *
 * 1–5 rather than 1–10: a five-point scale is one someone will actually fill
 * in honestly every day, and the difference between a 6 and a 7 out of 10 is
 * not information.
 */
export const RECOVERY_FIELDS = [
  { key: 'sleepHours', label: 'Sleep',    unit: 'h',   decimals: 1, min: 0,  max: 16 },
  { key: 'soreness',   label: 'Soreness', unit: '/5',  decimals: 0, min: 1,  max: 5 },
  { key: 'energy',     label: 'Energy',   unit: '/5',  decimals: 0, min: 1,  max: 5 },
  { key: 'stress',     label: 'Stress',   unit: '/5',  decimals: 0, min: 1,  max: 5 },
];

export const recovery = datedLog(COLLECTIONS.RECOVERY, RECOVERY_FIELDS);

/* --- Measurements ------------------------------------------------------- */

/** Tape measurements in centimetres. Bounds reject obvious typos. */
export const MEASUREMENT_FIELDS = [
  { key: 'neck',       label: 'Neck',        unit: 'cm', decimals: 1, min: 20, max: 70 },
  { key: 'shoulders',  label: 'Shoulders',   unit: 'cm', decimals: 1, min: 70, max: 200 },
  { key: 'chest',      label: 'Chest',       unit: 'cm', decimals: 1, min: 60, max: 180 },
  { key: 'waist',      label: 'Waist',       unit: 'cm', decimals: 1, min: 50, max: 180 },
  { key: 'hips',       label: 'Hips',        unit: 'cm', decimals: 1, min: 60, max: 180 },
  { key: 'leftArm',    label: 'Left arm',    unit: 'cm', decimals: 1, min: 15, max: 70 },
  { key: 'rightArm',   label: 'Right arm',   unit: 'cm', decimals: 1, min: 15, max: 70 },
  { key: 'leftThigh',  label: 'Left thigh',  unit: 'cm', decimals: 1, min: 25, max: 100 },
  { key: 'rightThigh', label: 'Right thigh', unit: 'cm', decimals: 1, min: 25, max: 100 },
  { key: 'leftCalf',   label: 'Left calf',   unit: 'cm', decimals: 1, min: 20, max: 70 },
  { key: 'rightCalf',  label: 'Right calf',  unit: 'cm', decimals: 1, min: 20, max: 70 },
];

export const measurements = datedLog(COLLECTIONS.MEASUREMENTS, MEASUREMENT_FIELDS);

/* --- Progress photos ---------------------------------------------------- */

/** The five angles the program asks for. Order drives the UI. */
export const PHOTO_CATEGORIES = [
  { key: 'front-relaxed', label: 'Front relaxed' },
  { key: 'front-flexed',  label: 'Front flexed' },
  { key: 'side',          label: 'Side' },
  { key: 'back-relaxed',  label: 'Back relaxed' },
  { key: 'back-flexed',   label: 'Back flexed' },
];

export const photos = {
  CATEGORIES: PHOTO_CATEGORIES,

  /** Metadata for every photo, newest first. */
  all() {
    return [...db.read(COLLECTIONS.PHOTOS)].sort((a, b) => b.date.localeCompare(a.date));
  },

  /** Distinct dates that have at least one photo, newest first. */
  dates() {
    return [...new Set(this.all().map((photo) => photo.date))];
  },

  /** All photos taken on one date, in category order. */
  onDate(dayKey) {
    const order = new Map(PHOTO_CATEGORIES.map((category, index) => [category.key, index]));
    return db.read(COLLECTIONS.PHOTOS)
      .filter((photo) => photo.date === dayKey)
      .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99));
  },

  find(dayKey, category) {
    return db.read(COLLECTIONS.PHOTOS)
      .find((photo) => photo.date === dayKey && photo.category === category) ?? null;
  },

  /**
   * Import a photo: downscale, store the blob in IndexedDB, keep the metadata
   * in the normal collection. One photo per date per category — re-importing
   * replaces, so a bad shot can simply be retaken.
   */
  async add(file, { category, date = today(), note = '' }) {
    if (!PHOTO_CATEGORIES.some((entry) => entry.key === category)) {
      throw new Error(`Unknown photo category "${category}".`);
    }

    const prepared = await photoStore.prepareImage(file);
    const existing = this.find(date, category);
    const id = existing?.id ?? db.newId();

    // Blob first: if this fails on quota, no dangling metadata is left behind.
    await photoStore.putBlob(id, prepared.blob);

    const meta = {
      id,
      date,
      category,
      width: prepared.width,
      height: prepared.height,
      bytes: prepared.bytes,
      note: String(note).slice(0, 300),
    };

    if (existing) return db.replaceById(COLLECTIONS.PHOTOS, id, meta);
    return db.insert(COLLECTIONS.PHOTOS, meta);
  },

  /** An object URL for a photo. The caller must revoke it. */
  url(id) {
    return photoStore.getObjectUrl(id);
  },

  async remove(id) {
    // Blob first again: an orphaned blob is invisible, orphaned metadata shows
    // up as a broken image.
    try {
      await photoStore.deleteBlob(id);
    } catch (error) {
      console.warn('[photos] could not delete the image data:', error);
    }
    return db.removeById(COLLECTIONS.PHOTOS, id);
  },

  /** Total bytes of stored photos, from the metadata. */
  totalBytes() {
    return this.all().reduce((sum, photo) => sum + (photo.bytes ?? 0), 0);
  },

  count() {
    return db.read(COLLECTIONS.PHOTOS).length;
  },

  /**
   * How complete the most recent photo set is, and whether another is due.
   * The program asks for a set every two weeks.
   */
  status(dayKey = today(), intervalDays = 14) {
    const dates = this.dates();
    if (!dates.length) {
      return { lastDate: null, daysSince: null, due: true, complete: 0, total: PHOTO_CATEGORIES.length };
    }
    const lastDate = dates[0];
    const taken = this.onDate(lastDate).length;
    const daysSince = Math.round(
      (new Date(`${dayKey}T12:00:00`) - new Date(`${lastDate}T12:00:00`)) / 86400000
    );
    return {
      lastDate,
      daysSince,
      due: daysSince >= intervalDays,
      complete: taken,
      total: PHOTO_CATEGORIES.length,
    };
  },
};
