/**
 * pr-service.js — Personal record detection.
 *
 * PRs are *derived*, never authored: they are computed from the session log
 * so they can never drift out of step with it, and so deleting a mislogged
 * session correctly removes the record it created.
 *
 * Four kinds are tracked, because "strongest" means different things:
 *   weight  — heaviest load for a single completed set
 *   reps    — most reps at or above the previous best load
 *   e1rm    — best estimated one-rep max (Epley), the fairest cross-rep
 *             comparison and the one that catches progress made by adding
 *             reps rather than plates
 *   volume  — most load moved in one session for that exercise
 *
 * Session 3 builds the full badge UI on top of this; Home only needs the
 * most recent record.
 */

import * as sessionService from './session-service.js';
import * as programService from './program-service.js';
import { estimate1rm } from '../engine/one-rep-max.js';

export { estimate1rm };

export const PR_KINDS = {
  WEIGHT: 'weight',
  REPS:   'reps',
  E1RM:   'e1rm',
  VOLUME: 'volume',
};

export const PR_LABELS = {
  [PR_KINDS.WEIGHT]: 'Heaviest weight',
  [PR_KINDS.REPS]:   'Most reps',
  [PR_KINDS.E1RM]:   'Estimated 1RM',
  [PR_KINDS.VOLUME]: 'Volume',
};

/**
 * Best records for one exercise across all completed sessions.
 * Returns null when the exercise has never been logged with load.
 */
export function getRecordsFor(exerciseId) {
  const history = sessionService.getExerciseHistory(exerciseId, Infinity);
  if (!history.length) return null;

  const exercise = programService.getExercise(exerciseId);
  const multiplier = exercise?.loadType === 'per-hand' ? 2 : 1;

  let weight = null;
  let reps = null;
  let e1rm = null;
  let volume = null;

  // History is newest-first; walk oldest-first so that ties keep the earliest
  // date — a record belongs to the session that first achieved it.
  for (const performance of [...history].reverse()) {
    let sessionVolume = 0;

    for (const set of performance.sets) {
      const load = set.weightKg ?? 0;
      const setReps = set.reps ?? 0;
      if (!setReps) continue;

      sessionVolume += load * setReps * multiplier;

      if (load > 0 && (!weight || load > weight.value)) {
        weight = { value: load, reps: setReps, date: performance.date, sessionId: performance.sessionId };
      }

      if (!reps || setReps > reps.value) {
        reps = { value: setReps, weightKg: load, date: performance.date, sessionId: performance.sessionId };
      }

      const estimated = estimate1rm(load, setReps);
      if (estimated > 0 && (!e1rm || estimated > e1rm.value)) {
        e1rm = {
          value: estimated,
          weightKg: load,
          reps: setReps,
          date: performance.date,
          sessionId: performance.sessionId,
        };
      }
    }

    if (sessionVolume > 0 && (!volume || sessionVolume > volume.value)) {
      volume = { value: sessionVolume, date: performance.date, sessionId: performance.sessionId };
    }
  }

  if (!weight && !reps && !e1rm && !volume) return null;

  return { exerciseId, name: exercise?.name ?? exerciseId, weight, reps, e1rm, volume };
}

/** Records for every exercise in the program that has history. */
export function getAllRecords() {
  return programService
    .getAllExercises()
    .map((exercise) => getRecordsFor(exercise.id))
    .filter(Boolean);
}

/**
 * Every record as a flat, date-sorted list — newest first.
 * Used for the PR feed and for "Latest PR" on Home.
 */
export function getRecordFeed() {
  const feed = [];

  for (const record of getAllRecords()) {
    for (const kind of Object.values(PR_KINDS)) {
      const entry = record[kind];
      if (!entry) continue;
      feed.push({
        kind,
        label: PR_LABELS[kind],
        exerciseId: record.exerciseId,
        exerciseName: record.name,
        date: entry.date,
        sessionId: entry.sessionId,
        value: entry.value,
        reps: entry.reps ?? null,
        weightKg: entry.weightKg ?? null,
      });
    }
  }

  return feed.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * The single most recent personal record.
 *
 * A session usually sets several records at once, so a plain "newest" pick
 * would be whichever exercise happened to sort first — effectively random.
 * Two tie-breaks make it deterministic and meaningful: prefer estimated 1RM,
 * because it captures "I got stronger" rather than "I did more sets", and
 * among those prefer the heaviest, so the headline record is the biggest lift
 * of the day rather than an incidental one.
 */
export function getLatestRecord() {
  const feed = getRecordFeed();
  if (!feed.length) return null;

  const newestDate = feed[0].date;
  const sameDay = feed.filter((entry) => entry.date === newestDate);
  const priority = [PR_KINDS.E1RM, PR_KINDS.WEIGHT, PR_KINDS.REPS, PR_KINDS.VOLUME];

  for (const kind of priority) {
    const matches = sameDay
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => b.value - a.value);
    if (matches.length) return matches[0];
  }
  return sameDay[0];
}

/**
 * Records that a specific session set.
 *
 * Because records are derived from the whole log rather than stored, this is
 * simply the feed filtered by session — which means it stays correct if that
 * session is later edited or deleted.
 */
export function getRecordsSetIn(sessionId) {
  return getRecordFeed().filter((entry) => entry.sessionId === sessionId);
}

/** Records set within the last `days` days. */
export function getRecentRecords(days = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  return getRecordFeed().filter((entry) => entry.date > cutoffKey);
}

/** How a PR reads in one line: "42.5 kg × 8". */
export function describeRecord(record) {
  if (!record) return '—';
  const round = (value) => String(Number(Number(value).toFixed(1)));

  switch (record.kind) {
    case PR_KINDS.WEIGHT:
      return `${round(record.value)} kg × ${record.reps}`;
    case PR_KINDS.REPS:
      return record.weightKg
        ? `${record.value} reps @ ${round(record.weightKg)} kg`
        : `${record.value} reps`;
    case PR_KINDS.E1RM:
      return `${round(record.value)} kg est. 1RM`;
    case PR_KINDS.VOLUME:
      return `${round(record.value)} kg total`;
    default:
      return round(record.value);
  }
}
