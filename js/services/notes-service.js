/**
 * notes-service.js — Coach notes.
 *
 * These are the instructions that actually change how a session is run
 * ("replace the high-to-low fly", "bulk until 79 kg"), so they surface in
 * three places: Home, the Workout page, and every generated report. A note
 * can be pinned to keep it visible, scoped to a day or an exercise so it
 * appears where it is relevant, and archived once it has been acted on.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { today } from '../core/format.js';

/** Categories, used for filtering and for grouping inside reports. */
export const NOTE_CATEGORIES = [
  { key: 'exercise',   label: 'Exercise change' },
  { key: 'nutrition',  label: 'Nutrition' },
  { key: 'technique',  label: 'Technique' },
  { key: 'programming', label: 'Programming' },
  { key: 'recovery',   label: 'Recovery' },
  { key: 'general',    label: 'General' },
];

/** All notes, newest first. */
export function getNotes({ includeArchived = false } = {}) {
  const notes = db.read(COLLECTIONS.COACH_NOTES);
  return notes
    .filter((note) => includeArchived || !note.archived)
    .sort((a, b) => {
      // Pinned notes float, then most recent first.
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
      return b.date.localeCompare(a.date);
    });
}

/**
 * Notes to show on Home: pinned first, capped so the card stays glanceable.
 */
export function getHighlightNotes(limit = 3) {
  return getNotes().slice(0, limit);
}

/** Notes relevant to a given day or exercise, plus any unscoped notes. */
export function getNotesFor({ dayId = null, exerciseId = null } = {}) {
  return getNotes().filter((note) => {
    if (note.exerciseId) return note.exerciseId === exerciseId;
    if (note.dayId) return note.dayId === dayId;
    return true;
  });
}

/**
 * Add a note.
 * @param {object} input
 * @param {string} input.text        the advice, as received
 * @param {string} [input.category]  one of NOTE_CATEGORIES keys
 * @param {string} [input.source]    where it came from, e.g. "ChatGPT"
 * @param {string} [input.dayId]     scope to a training day
 * @param {string} [input.exerciseId] scope to an exercise
 * @param {boolean} [input.pinned]
 * @param {string} [input.date]      defaults to today
 */
export async function addNote(input) {
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('A note needs some text.');

  return db.insert(COLLECTIONS.COACH_NOTES, {
    text,
    category: input.category ?? 'general',
    source: input.source ?? 'Coach',
    dayId: input.dayId ?? null,
    exerciseId: input.exerciseId ?? null,
    pinned: Boolean(input.pinned),
    archived: false,
    date: input.date ?? today(),
  });
}

export async function updateNote(id, patch) {
  return db.replaceById(COLLECTIONS.COACH_NOTES, id, patch);
}

export async function deleteNote(id) {
  return db.removeById(COLLECTIONS.COACH_NOTES, id);
}

export async function togglePinned(id) {
  const note = db.read(COLLECTIONS.COACH_NOTES).find((entry) => entry.id === id);
  if (!note) return null;
  return updateNote(id, { pinned: !note.pinned });
}

/**
 * Archive rather than delete. Notes are a record of what was advised and
 * when; a report covering an earlier period should still be able to cite one
 * that no longer applies today.
 */
export async function setArchived(id, archived = true) {
  return updateNote(id, { archived });
}

export function countActive() {
  return getNotes().length;
}
