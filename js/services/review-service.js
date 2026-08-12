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
import * as settingsService from './settings-service.js';
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
    setTypes: setTypeBundle(startKey, endKey),
    pain: painBundle(startKey, endKey),
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
    goalKg: settingsService.getGoalWeightKg(),
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
  const painExcluded = [];

  for (const exercise of programService.getAllExercises()) {
    // A warm-up-only movement has no working sets and therefore no strength
    // trend to report.
    if (programService.isWarmupOnly(exercise)) continue;

    const all = sessionService
      .getExerciseHistory(exercise.id, Infinity)
      .filter((performance) => !performance.isDeload);

    // Pain-limited sessions are held out of the comparison rather than counted
    // as a regression. A session cut short because an elbow hurt is not
    // evidence of lost strength, and reporting it as such would push the
    // recommendation ladder toward "add calories" for no reason.
    const history = all.filter((performance) => !performance.painLimited);
    const excludedInPeriod = all.some((performance) =>
      performance.painLimited && performance.date >= startKey && performance.date <= endKey);
    if (excludedInPeriod) painExcluded.push(exercise.name);

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
    painExcluded,
  };
}

/**
 * Working-set volume for the period against the one before it.
 *
 * Working sets only, on both sides. Warm-up and intensity volume are reported by
 * `setTypeBundle` and are deliberately not folded in here: a period-on-period
 * comparison that mixes them cannot distinguish "I trained harder" from "I added
 * a ramp set to the squat".
 */
function volumeBundle(startKey, endKey, priorStart, priorEnd) {
  const sum = (from, to) => sessionsIn(from, to)
    .reduce((total, session) => total + sessionService.getSessionVolume(session), 0);

  const currentKg = sum(startKey, endKey);
  const previousKg = sum(priorStart, priorEnd);

  return { currentKg, previousKg: previousKg || null };
}

/**
 * The period's work, split by the kind of set that produced it.
 *
 * Counts drop-set *sequences* rather than stages, so a three-rung drop set
 * reports as one piece of intensity work and not as three extra sets.
 */
function setTypeBundle(startKey, endKey) {
  const totals = {
    workingSets: 0,
    warmupSets: 0,
    dropSequences: 0,
    failureSets: 0,
    unclassifiedSets: 0,
    workingVolumeKg: 0,
    warmupVolumeKg: 0,
    intensityVolumeKg: 0,
    intensityExercises: [],
  };

  const withIntensity = new Set();

  for (const session of sessionsIn(startKey, endKey)) {
    const counts = sessionService.getSessionSetCounts(session);
    const volume = sessionService.getSessionVolumeBreakdown(session);

    totals.workingSets += counts.workingDone;
    totals.unclassifiedSets += counts.legacyDone;
    totals.warmupSets += counts.warmupDone;
    totals.dropSequences += counts.dropSequences;
    totals.failureSets += counts.failureSets;
    totals.workingVolumeKg += volume.workingKg;
    totals.warmupVolumeKg += volume.warmupKg;
    totals.intensityVolumeKg += volume.intensityKg;

    for (const entry of session.entries) {
      if ((entry.intensitySets ?? []).length) {
        withIntensity.add(
          programService.getExercise(entry.exerciseId)?.name ?? entry.exerciseId
        );
      }
    }
  }

  // Unclassified legacy sets are counted as working sets by the engine, so the
  // headline figure has to include them or it will not match what progression
  // actually read. The separate count is what keeps that visible.
  totals.workingSets += totals.unclassifiedSets;
  totals.intensityExercises = [...withIntensity];

  return totals;
}

/**
 * Discomfort logged in the period.
 *
 * Aggregated for reporting only. Nothing here is interpreted as a cause or a
 * diagnosis — it counts what was recorded and where.
 */
function painBundle(startKey, endKey) {
  const logs = sessionService.getPainLogsBetween(startKey, endKey);
  if (!logs.length) {
    return { count: 0, exercises: [], locations: [], maxScore: 0, stoppedCount: 0 };
  }

  return {
    count: logs.length,
    exercises: [...new Set(logs.map((log) => log.exerciseName))],
    locations: [...new Set(logs.map((log) => log.location).filter(Boolean))],
    maxScore: Math.max(...logs.map((log) => Number(log.score) || 0)),
    stoppedCount: logs.filter((log) => log.action === 'stopped' || log.action === 'skipped').length,
    logs,
  };
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
