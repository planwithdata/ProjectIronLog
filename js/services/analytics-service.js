/**
 * analytics-service.js — Turns the log into chart-ready series.
 *
 * The maths lives in `js/engine/analytics.js` (pure, tested); this module only
 * knows where the data comes from and which window the user has selected.
 */

import { today } from '../core/format.js';
import * as sessionService from './session-service.js';
import * as programService from './program-service.js';
import * as bodyService from './body-service.js';
import { estimate1rm } from '../engine/one-rep-max.js';
import {
  rollingAverage, trendPerWeek, byWeek, fillWeeks, withinDays,
  summarise, niceBounds, weekStart,
} from '../engine/analytics.js';

export { summarise, niceBounds, trendPerWeek };

/** The range filter's options. `days: null` means everything. */
export const RANGES = [
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '1y',  label: '1 year',  days: 365 },
  { key: 'all', label: 'All',     days: null },
];

export function rangeByKey(key) {
  return RANGES.find((range) => range.key === key) ?? RANGES[1];
}

/* --- Body weight -------------------------------------------------------- */

/**
 * Daily weigh-ins plus a 7-day rolling average.
 *
 * Both series, not just the average: the daily points show whether the trend
 * is trustworthy or whether it is being carried by three readings. The average
 * is what should be read, so it gets slot 1 and the daily points recede.
 */
export function weightTrend(days = 90, endKey = today()) {
  const all = bodyService.getWeightSeries();
  // The rolling average is computed over the full history *before* windowing,
  // so the first visible point already has a full window behind it rather than
  // ramping up from nothing at the left edge of the chart.
  const smoothedAll = rollingAverage(all, 7, 2);

  return {
    daily: withinDays(all, days, endKey),
    average: withinDays(smoothedAll, days, endKey),
    trend: trendPerWeek(withinDays(smoothedAll, days, endKey)),
    monthlyAverage: rollingAverage(all, 30, 3),
  };
}

/* --- Body composition --------------------------------------------------- */

/**
 * One series per scale metric, as small multiples.
 *
 * These are deliberately *not* combined into one chart: weight is in kg, body
 * fat in percent, BMR in kilocalories. Putting them on one plot would need two
 * or more y-axes, and a dual-axis chart invents a correlation that is not in
 * the data. One metric, one axis, one card.
 */
export function compositionSeries(days = 90, endKey = today()) {
  return bodyService.COMPOSITION_FIELDS
    .map((field) => {
      const full = bodyService.getSeries(field.key);
      const points = withinDays(full, days, endKey);
      return { field, points, stats: summarise(points) };
    })
    .filter((entry) => entry.points.length > 0);
}

/* --- Strength ----------------------------------------------------------- */

/**
 * Exercises that have at least one loaded, completed set — chart candidates.
 *
 * Sorted most-logged first, then compounds ahead of isolation work: the first
 * entry becomes the default selection, and "how is my incline press moving" is
 * a more useful opening question than "how is my lateral raise moving".
 */
export function exercisesWithHistory() {
  const rank = { compound: 0, isolation: 1, core: 2 };

  return programService
    .getAllExercises()
    .map((exercise) => ({
      exercise,
      sessions: sessionService.getExerciseHistory(exercise.id, Infinity).length,
    }))
    .filter((entry) => entry.sessions > 0)
    .sort((a, b) =>
      b.sessions - a.sessions
      || (rank[a.exercise.category] ?? 3) - (rank[b.exercise.category] ?? 3)
      || a.exercise.name.localeCompare(b.exercise.name));
}

/**
 * Strength progress for one exercise: estimated 1RM and top-set load.
 *
 * Both are in kilograms, so they share one axis honestly. Estimated 1RM is the
 * series that matters — it is the only one that registers progress made by
 * adding reps rather than plates, which is most of what double progression
 * produces between load increases.
 */
export function strengthSeries(exerciseId, days = 365, endKey = today()) {
  const exercise = programService.getExercise(exerciseId);
  const history = sessionService.getExerciseHistory(exerciseId, Infinity);

  const e1rm = [];
  const topSet = [];

  // History is newest-first; charts read oldest-first.
  for (const performance of [...history].reverse()) {
    let best1rm = 0;
    let bestLoad = 0;

    for (const set of performance.sets) {
      const load = set.weightKg ?? 0;
      const reps = set.reps ?? 0;
      if (!reps) continue;
      best1rm = Math.max(best1rm, estimate1rm(load, reps));
      bestLoad = Math.max(bestLoad, load);
    }

    if (best1rm > 0) e1rm.push({ date: performance.date, value: round1(best1rm) });
    if (bestLoad > 0) topSet.push({ date: performance.date, value: bestLoad });
  }

  return {
    exercise,
    e1rm: withinDays(e1rm, days, endKey),
    topSet: withinDays(topSet, days, endKey),
    stats: summarise(withinDays(e1rm, days, endKey)),
  };
}

/* --- Volume ------------------------------------------------------------- */

/**
 * Total load moved per week.
 *
 * Weeks with no training are filled in as zero rather than closed up, so a
 * missed week reads as a missed week instead of the line simply continuing.
 */
export function volumeByWeek(days = 90, endKey = today()) {
  const sessions = windowedSessions(days, endKey).map((session) => ({
    date: session.date,
    volume: sessionService.getSessionVolume(session),
  }));

  const weeks = byWeek(sessions, (group) =>
    round1(group.reduce((sum, item) => sum + item.volume, 0))
  );

  return fillWeeks(weeks);
}

/** Sets completed per week. */
export function setsByWeek(days = 90, endKey = today()) {
  const sessions = windowedSessions(days, endKey).map((session) => ({
    date: session.date,
    sets: sessionService.getSessionCompletion(session).done,
  }));

  return fillWeeks(byWeek(sessions, (group) =>
    group.reduce((sum, item) => sum + item.sets, 0)
  ));
}

/**
 * Volume attributed to muscle groups.
 *
 * Attribution rule: **the whole of a set's volume is credited to each of the
 * exercise's primary muscles, and none to the secondaries.** Splitting a
 * fraction across secondaries would invent precision the data does not have —
 * nothing in the program says how much of a row is lats versus mid back. The
 * result is therefore a comparison of *emphasis* between groups, not a
 * physiological total, and the card says so.
 */
export function volumeByMuscle(days = 90, endKey = today()) {
  const totals = new Map();

  for (const session of windowedSessions(days, endKey)) {
    for (const entry of session.entries) {
      const exercise = programService.getExercise(entry.exerciseId);
      if (!exercise) continue;

      const multiplier = exercise.loadType === 'per-hand' ? 2 : 1;
      let volume = 0;
      for (const set of entry.sets) {
        if (!set.completed || !set.reps) continue;
        volume += (set.weightKg ?? 0) * set.reps * multiplier;
      }
      if (volume <= 0) continue;

      const muscles = exercise.primaryMuscles?.length
        ? exercise.primaryMuscles
        : ['Other'];
      for (const muscle of muscles) {
        totals.set(muscle, (totals.get(muscle) ?? 0) + volume);
      }
    }
  }

  return [...totals.entries()]
    .map(([muscle, volume]) => ({ label: muscle, value: round1(volume) }))
    .sort((a, b) => b.value - a.value);
}

/* --- Consistency -------------------------------------------------------- */

/**
 * Weekly completion: sessions done over training days scheduled.
 *
 * The current week is reported against the days scheduled *so far*, matching
 * the Home page, so a Wednesday glance is not graded against Sunday.
 */
export function consistencyByWeek(days = 90, endKey = today()) {
  const scheduledPerWeek = programService.getTrainingDays().length;
  if (!scheduledPerWeek) return [];

  const sessions = windowedSessions(days, endKey);
  const currentWeek = weekStart(endKey);

  const weeks = byWeek(sessions.map((s) => ({ date: s.date, dayId: s.dayId })), (group) => {
    const distinctDays = new Set(group.map((item) => item.dayId)).size;
    return distinctDays;
  });

  return fillWeeks(weeks).map((week) => {
    // Only the in-flight week is prorated; past weeks are judged in full.
    const denominator = week.date === currentWeek
      ? Math.max(1, programService.getTrainingDays()
          .filter((day) => day.weekday <= isoWeekdayOf(endKey)).length)
      : scheduledPerWeek;

    return {
      ...week,
      done: week.value,
      scheduled: denominator,
      value: Math.min(100, Math.round((week.value / denominator) * 100)),
    };
  });
}

/** Sessions completed inside the window. */
function windowedSessions(days, endKey) {
  const all = sessionService.getCompletedSessions();
  if (!days) return [...all].reverse();
  const wrapped = all.map((session) => ({ date: session.date, session }));
  return withinDays(wrapped, days, endKey).map((item) => item.session);
}

function isoWeekdayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  const jsDay = new Date(y, m - 1, d, 12).getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/* --- Headline totals ---------------------------------------------------- */

/** The numbers for the stat row at the top of Progress. */
export function overview(days = 90, endKey = today()) {
  const sessions = windowedSessions(days, endKey);
  const volume = sessions.reduce((sum, s) => sum + sessionService.getSessionVolume(s), 0);
  const sets = sessions.reduce((sum, s) => sum + sessionService.getSessionCompletion(s).done, 0);
  const consistency = consistencyByWeek(days, endKey);
  const meanConsistency = consistency.length
    ? Math.round(consistency.reduce((sum, w) => sum + w.value, 0) / consistency.length)
    : 0;

  return {
    sessions: sessions.length,
    sets,
    volumeKg: round1(volume),
    consistencyPercent: meanConsistency,
    streakWeeks: sessionService.getWeeklyStreak(endKey),
  };
}
