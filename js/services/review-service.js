/**
 * review-service.js — Gathers the figures a two-week review needs and runs
 * them through the review engine.
 *
 * The split matters: everything judgemental lives in `js/engine/review.js`,
 * which is pure and tested. This module only fetches and shapes.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { today, addDays, daysBetween } from '../core/format.js';
import * as sessionService from './session-service.js';
import * as programService from './program-service.js';
import * as bodyService from './body-service.js';
import * as prService from './pr-service.js';
import * as notesService from './notes-service.js';
import { recovery, measurements, photos } from './logs-service.js';
import { buildReview } from '../engine/review.js';
import { estimate1rm } from '../engine/one-rep-max.js';

/**
 * Collect every figure for the period ending `endKey`.
 * @param {number} [days]
 * @returns {object} the input bundle the engine expects, plus context
 */
export function gather(days = 14, endKey = today()) {
  const startKey = addDays(endKey, -(days - 1));
  const priorStart = addDays(startKey, -days);
  const priorEnd = addDays(startKey, -1);

  return {
    period: { start: startKey, end: endKey, days },
    weight: weightBundle(startKey, endKey, days),
    bodyFat: bodyFatBundle(startKey, endKey),
    adherence: adherenceBundle(startKey, endKey, days),
    strength: strengthBundle(startKey, endKey, priorStart, priorEnd),
    volume: volumeBundle(startKey, endKey, priorStart, priorEnd),
    records: { records: recordsIn(startKey, endKey).length },
    recovery: recoveryBundle(startKey, endKey),
  };
}

/** Build the full review object for a period. */
export function generate(days = 14, endKey = today()) {
  const input = gather(days, endKey);
  const review = buildReview(input);

  // Context the engine has no business judging, but a report needs.
  return {
    ...review,
    input,
    sessions: sessionsIn(input.period.start, endKey),
    recordsSet: recordsIn(input.period.start, endKey),
    measurements: measurements.between(input.period.start, endKey),
    photoSets: photos.dates().filter((date) => date >= input.period.start && date <= endKey),
    notes: notesService.getNotes(),
    generatedAt: new Date().toISOString(),
  };
}

/* --- Saved reviews ------------------------------------------------------- */

export function getSaved() {
  return [...db.read(COLLECTIONS.REVIEWS)].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Store a review.
 *
 * Only the findings and the recommendation are kept, not the raw bundle: the
 * figures can always be recomputed from the log, whereas *what was concluded
 * at the time* is the thing that cannot. Keeping it small also means the
 * review history never threatens the storage quota.
 */
export async function save(review) {
  return db.insert(COLLECTIONS.REVIEWS, {
    date: review.period.end,
    periodStart: review.period.start,
    periodDays: review.period.days,
    headline: review.headline,
    findings: review.findings,
    recommendation: review.recommendation,
  });
}

export async function remove(id) {
  return db.removeById(COLLECTIONS.REVIEWS, id);
}

/** Days until the next review is due, from the last saved one. */
export function dueIn(endKey = today()) {
  return programService.getReviewCountdown(endKey);
}

/* --- Bundles ------------------------------------------------------------ */

/**
 * Body weight for the period, comparing its first week with its last.
 *
 * Both windows sit *inside* the period. An earlier version anchored the start
 * average to a 7-day window ending on the period's first day, which meant it
 * needed a week of readings from before the review began — so the very first
 * fortnight of logging could never report a change, purely because of where
 * the window fell. Comparing week one with the final week needs no history
 * outside the period and is what "changed over this period" actually means.
 *
 * The rate is then computed over the gap between those two windows, not over
 * the whole period: their centres are `days - 7` apart, and dividing by the
 * full period would understate the trend.
 */
function weightBundle(startKey, endKey, days) {
  const profile = db.read(COLLECTIONS.PROFILE);

  const firstWeekEnd = addDays(startKey, 6);
  const startAvg = bodyService.getAverageWeight(7, firstWeekEnd);
  const endAvg = bodyService.getAverageWeight(7, endKey);

  let perWeek = null;
  if (startAvg && endAvg) {
    const span = Math.max(1, days - 7);
    perWeek = ((endAvg.average - startAvg.average) / span) * 7;
  }

  // With under two weeks of readings the two windows overlap, so a
  // window-to-window comparison says nothing. Fall back to the lean bulk rate,
  // which is computed on rolling averages and degrades more gracefully.
  if (perWeek === null) {
    perWeek = bodyService.getLeanBulkRate(endKey)?.kgPerWeek ?? null;
  }

  return {
    startAvg: startAvg?.average ?? null,
    endAvg: endAvg?.average ?? null,
    perWeek,
    goalKg: profile.goalWeightKg ?? null,
    readings: bodyService.getWeightEntries()
      .filter((entry) => entry.date >= startKey && entry.date <= endKey).length,
  };
}

function bodyFatBundle(startKey, endKey) {
  const series = bodyService.getSeries('bodyFatPercent');
  const before = [...series].reverse().find((point) => point.date <= startKey);
  const after = [...series].reverse().find((point) => point.date <= endKey);

  return {
    startPercent: before?.value ?? null,
    // Only report a change if the two readings are genuinely different points.
    endPercent: after && before && after.date !== before.date ? after.value : null,
  };
}

function adherenceBundle(startKey, endKey, days) {
  const trainingDays = programService.getTrainingDays().length;
  const weeks = days / 7;
  const scheduled = Math.round(trainingDays * weeks);
  const done = sessionsIn(startKey, endKey).length;
  return { done, scheduled: Math.max(scheduled, done) };
}

/**
 * Which lifts improved, held or regressed.
 *
 * Compared on best estimated 1RM in the period against the previous period,
 * because that is the only measure that registers progress made by adding reps
 * — which is most of what double progression produces between load increases.
 * Deload sessions are excluded so the scheduled dip is not read as regression.
 */
function strengthBundle(startKey, endKey, priorStart, priorEnd) {
  let improved = 0;
  let held = 0;
  let regressed = 0;
  const advancing = [];
  const stalled = [];

  for (const exercise of programService.getAllExercises()) {
    const history = sessionService
      .getExerciseHistory(exercise.id, Infinity)
      .filter((performance) => !performance.isDeload);

    const best = (from, to) => {
      let top = 0;
      for (const performance of history) {
        if (performance.date < from || performance.date > to) continue;
        for (const set of performance.sets) {
          top = Math.max(top, estimate1rm(set.weightKg ?? 0, set.reps ?? 0));
        }
      }
      return top;
    };

    const current = best(startKey, endKey);
    const previous = best(priorStart, priorEnd);

    if (!current || !previous) continue;   // needs both periods to compare

    // A 1% band absorbs rounding in the 1RM estimate; below that it is noise.
    if (current > previous * 1.01) { improved += 1; advancing.push(exercise.name); }
    else if (current < previous * 0.99) { regressed += 1; stalled.push(exercise.name); }
    else { held += 1; stalled.push(exercise.name); }
  }

  return {
    improved,
    held,
    regressed,
    tracked: improved + held + regressed,
    advancing,
    stalled,
  };
}

function volumeBundle(startKey, endKey, priorStart, priorEnd) {
  const sum = (from, to) => sessionsIn(from, to)
    .reduce((total, session) => total + sessionService.getSessionVolume(session), 0);

  const currentKg = sum(startKey, endKey);
  const previousKg = sum(priorStart, priorEnd);

  return { currentKg, previousKg: previousKg || null };
}

function recoveryBundle(startKey, endKey) {
  const entries = recovery.between(startKey, endKey);
  return {
    entries: entries.length,
    meanSleepHours: recovery.meanBetween('sleepHours', startKey, endKey),
    meanSoreness: recovery.meanBetween('soreness', startKey, endKey),
    meanEnergy: recovery.meanBetween('energy', startKey, endKey),
  };
}

/* --- Helpers ------------------------------------------------------------ */

function sessionsIn(startKey, endKey) {
  return sessionService.getCompletedSessions()
    .filter((session) => session.date >= startKey && session.date <= endKey)
    .reverse();
}

function recordsIn(startKey, endKey) {
  return prService.getRecordFeed()
    .filter((record) => record.date >= startKey && record.date <= endKey);
}
