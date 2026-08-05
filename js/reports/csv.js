/**
 * csv.js — CSV export.
 *
 * One file per dataset rather than one wide sheet: a spreadsheet of workout
 * sets and a spreadsheet of weigh-ins have nothing in common but a date, and
 * jamming them together makes both harder to use.
 *
 * Escaping follows RFC 4180 — quote anything containing a comma, quote or
 * newline, and double any embedded quotes. Exercise names and notes are free
 * text, so this is not optional.
 */

import { COMPOSITION_FIELDS } from '../services/body-service.js';
import * as sessionService from '../services/session-service.js';
import * as programService from '../services/program-service.js';
import * as bodyService from '../services/body-service.js';
import * as prService from '../services/pr-service.js';
import { recovery, measurements, RECOVERY_FIELDS, MEASUREMENT_FIELDS } from '../services/logs-service.js';
import * as notesService from '../services/notes-service.js';

/** Quote a single field per RFC 4180. */
function cell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Rows to a CSV string.
 * Prefixed with a UTF-8 BOM: without it Excel on Windows misreads accented
 * characters in exercise names and notes.
 */
export function toCsv(rows) {
  const body = rows.map((row) => row.map(cell).join(',')).join('\r\n');
  return `﻿${body}\r\n`;
}

/* --- Datasets ----------------------------------------------------------- */

/**
 * Every logged set, one row each — the long format a spreadsheet or an
 * analysis tool actually wants.
 */
export function setsCsv() {
  const rows = [[
    'date', 'day', 'week', 'deload', 'exercise', 'equipment', 'category',
    'set', 'weight_kg', 'reps', 'completed', 'rpe',
    'target_weight_kg', 'target_reps', 'est_1rm_kg',
  ]];

  for (const session of [...sessionService.getCompletedSessions()].reverse()) {
    const day = programService.getDayById(session.dayId);
    for (const entry of session.entries) {
      const exercise = programService.getExercise(entry.exerciseId);
      entry.sets.forEach((set, index) => {
        rows.push([
          session.date,
          day?.label ?? session.dayId,
          session.week,
          session.isDeload ? 'yes' : 'no',
          exercise?.name ?? entry.exerciseId,
          exercise?.equipment ?? '',
          exercise?.category ?? '',
          index + 1,
          set.weightKg ?? '',
          set.reps ?? '',
          set.completed ? 'yes' : 'no',
          set.rpe ?? '',
          entry.targetWeightKg ?? '',
          entry.targetReps?.[index] ?? '',
          set.completed && set.weightKg && set.reps
            ? round(prService.estimate1rm(set.weightKg, set.reps), 2)
            : '',
        ]);
      });
    }
  }

  return toCsv(rows);
}

/** One row per session, with its totals. */
export function sessionsCsv() {
  const rows = [[
    'date', 'day', 'week', 'deload', 'sets_done', 'sets_prescribed',
    'completion_percent', 'volume_kg', 'duration_seconds',
  ]];

  for (const session of [...sessionService.getCompletedSessions()].reverse()) {
    const day = programService.getDayById(session.dayId);
    const completion = sessionService.getSessionCompletion(session);
    rows.push([
      session.date,
      day?.label ?? session.dayId,
      session.week,
      session.isDeload ? 'yes' : 'no',
      completion.done,
      completion.total,
      completion.percent,
      round(sessionService.getSessionVolume(session), 1),
      session.durationSeconds ?? '',
    ]);
  }

  return toCsv(rows);
}

/** Weigh-ins and every scale metric, joined on the date. */
export function bodyCsv() {
  const composition = new Map(
    bodyService.getCompositionEntries().map((entry) => [entry.date, entry])
  );
  const dates = [...new Set([
    ...bodyService.getWeightEntries().map((entry) => entry.date),
    ...composition.keys(),
  ])].sort();

  const rows = [['date', 'weight_kg', ...COMPOSITION_FIELDS.map((field) => field.key), 'note']];

  for (const date of dates) {
    const weigh = bodyService.getWeightOn(date);
    const reading = composition.get(date);
    rows.push([
      date,
      weigh?.weightKg ?? reading?.weightKg ?? '',
      ...COMPOSITION_FIELDS.map((field) => reading?.[field.key] ?? ''),
      reading?.note ?? weigh?.note ?? '',
    ]);
  }

  return toCsv(rows);
}

export function recoveryCsv() {
  const rows = [['date', ...RECOVERY_FIELDS.map((field) => field.key), 'note']];
  for (const entry of recovery.all()) {
    rows.push([entry.date, ...RECOVERY_FIELDS.map((field) => entry[field.key] ?? ''), entry.note ?? '']);
  }
  return toCsv(rows);
}

export function measurementsCsv() {
  const rows = [['date', ...MEASUREMENT_FIELDS.map((field) => field.key), 'note']];
  for (const entry of measurements.all()) {
    rows.push([entry.date, ...MEASUREMENT_FIELDS.map((field) => entry[field.key] ?? ''), entry.note ?? '']);
  }
  return toCsv(rows);
}

export function recordsCsv() {
  const rows = [['exercise', 'kind', 'value', 'weight_kg', 'reps', 'date']];
  for (const record of prService.getRecordFeed()) {
    rows.push([
      record.exerciseName,
      record.kind,
      round(record.value, 2),
      record.weightKg ?? '',
      record.reps ?? '',
      record.date,
    ]);
  }
  return toCsv(rows);
}

export function notesCsv() {
  const rows = [['date', 'category', 'source', 'day', 'exercise', 'pinned', 'archived', 'text']];
  for (const note of notesService.getNotes({ includeArchived: true })) {
    rows.push([
      note.date,
      note.category,
      note.source,
      note.dayId ? programService.getDayById(note.dayId)?.label ?? note.dayId : '',
      note.exerciseId ? programService.getExercise(note.exerciseId)?.name ?? note.exerciseId : '',
      note.pinned ? 'yes' : 'no',
      note.archived ? 'yes' : 'no',
      note.text,
    ]);
  }
  return toCsv(rows);
}

/** Everything on offer, for the export list. */
export const DATASETS = [
  { key: 'sets',         label: 'Every logged set',   build: setsCsv,         describe: 'One row per set, with targets and estimated 1RM' },
  { key: 'sessions',     label: 'Session summaries',  build: sessionsCsv,     describe: 'One row per workout, with volume and completion' },
  { key: 'body',         label: 'Body metrics',       build: bodyCsv,         describe: 'Weigh-ins and all ten scale metrics' },
  { key: 'recovery',     label: 'Recovery logs',      build: recoveryCsv,     describe: 'Sleep, soreness, energy and stress' },
  { key: 'measurements', label: 'Measurements',       build: measurementsCsv, describe: 'Tape measurements in centimetres' },
  { key: 'records',      label: 'Personal records',   build: recordsCsv,      describe: 'Weight, reps, estimated 1RM and volume records' },
  { key: 'notes',        label: 'Coach notes',        build: notesCsv,        describe: 'Every note, including archived ones' },
];

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}
