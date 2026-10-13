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
import { volumeMultiplier } from '../engine/loading.js';
import { normalizeEntry, entryVolume } from '../engine/set-model.js';
import { explainBreak } from '../engine/context.js';
import {
  rollingAverage, trendPerWeek, byWeek, fillWeeks, withinDays,
  summarise, niceBounds, weekStart,
} from '../engine/analytics.js';
import {
  exerciseInsight, scorecard, driverMix, muscleProgress, meaningfulRecords,
  byWaveWeek, deloadResponse, adherence, consistency,
  STATUS, STATUS_LABELS, DRIVER, DRIVER_LABELS,
} from '../engine/insights.js';

export { summarise, niceBounds, trendPerWeek };
export { STATUS, STATUS_LABELS, DRIVER, DRIVER_LABELS, explainBreak };

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
 * Strength progress for one exercise: estimated 1RM, working load and top set.
 *
 * Three series rather than two, and the middle one is the addition that
 * matters. **Working load** is the load actually repeated across the sets —
 * what the next session is built on — while **top set** is the heaviest single
 * thing lifted that day. They were the same number until a probe was logged
 * among the working sets, and on the flat dumbbell bench they now differ by
 * 17 kg. Drawing only the top set is what made a one-off 72 kg set look like
 * the new normal.
 *
 * All three are in kilograms, so they share one axis honestly. Estimated 1RM
 * remains the series to read: it is the only one that registers progress made
 * by adding reps rather than plates, which is most of what double progression
 * produces between load increases.
 *
 * `breaks` carries the sessions where the load scale changed. The chart draws
 * those as gaps rather than as a line, because a continuous line across a
 * machine change is a picture of a strength gain that did not happen.
 */
export function strengthSeries(exerciseId, days = 365, endKey = today()) {
  const exercise = programService.getExercise(exerciseId);
  const insight = getInsight(exerciseId);

  if (!insight) {
    return {
      exercise, insight: null,
      e1rm: [], workingLoad: [], workingLoadPrior: [], topSet: [],
      breaks: [], stats: null,
    };
  }

  const pick = (field) => withinDays(
    insight.series
      .filter((point) => point[field] !== null && point[field] > 0)
      .map((point) => ({ date: point.date, value: round1(point[field]) })),
    days, endKey
  );

  const e1rm = pick('e1rmKg');

  // The working load, split at the newest **scale** break so the chart never
  // draws one continuous line across a change of machine.
  //
  // Split on a scale break specifically, not on the start of the trend window.
  // Those are different boundaries and conflating them put a series labelled
  // "Before the scale change" on the Bulgarian split squat, which is a dumbbell
  // movement that has never had one — its trend window merely starts later,
  // because week one is unclassified. A caveat that is not true is worse than
  // no caveat.
  const lastBreak = insight.series.reduce(
    (found, point, index) =>
      (point.contextChanged || point.discontinuous ? index : found),
    -1
  );

  const loadPoints = (predicate) => withinDays(
    insight.series
      .map((point, index) => ({ point, index }))
      .filter(({ point, index }) => predicate(index) && point.workingLoadKg > 0)
      .map(({ point }) => ({ date: point.date, value: round1(point.workingLoadKg) })),
    days, endKey
  );

  return {
    exercise,
    insight,
    e1rm,
    // Everything on the current scale. With no break that is the whole history,
    // as one line.
    workingLoad: loadPoints((index) => index >= lastBreak),
    // Everything before it: real training, on a scale that no longer applies.
    // Stops *short* of the break rather than running through it, so the two
    // runs do not visually join, and the caller draws it as unlinked points —
    // see `pointsOnly` in components/chart-card.js. Empty when there was no
    // break at all.
    workingLoadPrior: lastBreak > 0 ? loadPoints((index) => index < lastBreak) : [],
    topSet: pick('topLoadKg'),
    breaks: insight.breaks.map((point) => ({
      date: point.date,
      reason: point.contextChanged ? 'context' : 'discontinuity',
      note: explainBreak(point, { exerciseName: exercise?.name ?? 'this movement' }),
    })),
    stats: summarise(e1rm),
  };
}

/* --- Insights ----------------------------------------------------------
   The interpretive layer. `engine/insights.js` does the reading; this only
   feeds it and caches the result for one render pass, because the Progress
   page asks for the same exercise's insight from four different cards.
   ====================================================================== */

let insightCache = new Map();

/** Drop the memo. Called on any data change, and at the top of a render. */
export function resetInsights() {
  insightCache = new Map();
}

/** The full reading for one exercise, or null when it has never been logged. */
export function getInsight(exerciseId) {
  if (insightCache.has(exerciseId)) return insightCache.get(exerciseId);

  const exercise = programService.getExercise(exerciseId);
  const insight = exercise
    ? exerciseInsight(exercise, sessionService.getExerciseHistory(exerciseId, Infinity))
    : null;

  insightCache.set(exerciseId, insight);
  return insight;
}

/**
 * Every exercise with history, read.
 *
 * Includes retired and substitute movements: a lift dropped from the split can
 * still be the clearest example of what the last month did, and a substitute
 * that has been performed three times has a trend of its own.
 */
export function allInsights() {
  return [
    ...programService.getAllExercises(),
    ...programService.getRetiredExercises(),
    ...programService.getSubstituteExercises(),
  ]
    .map((exercise) => getInsight(exercise.id))
    .filter(Boolean);
}

/** Exercises sorted into progressing / holding / needs-attention piles. */
export function getScorecard() {
  return scorecard(allInsights());
}

/** Load versus reps, across the program. */
export function getDriverMix() {
  return driverMix(allInsights());
}

/** Progression rolled up by primary muscle group. */
export function getMuscleProgress() {
  return muscleProgress(allInsights());
}

/** The records worth beating, for one exercise. */
export function getMeaningfulRecords(exerciseId) {
  return meaningfulRecords(getInsight(exerciseId));
}

/** Every meaningful record set in the last `days` days, newest first. */
export function getRecentMeaningfulRecords(days = 21, endKey = today()) {
  const cutoff = shiftDays(endKey, -days);
  const out = [];

  for (const insight of allInsights()) {
    for (const record of meaningfulRecords(insight)) {
      if (record.date < cutoff) continue;
      out.push({ ...record, exerciseId: insight.exerciseId, exerciseName: insight.name });
    }
  }

  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * How the wave's weeks compare with each other.
 *
 * Volume and sets per wave week, so week 1 of every cycle lands in one bar. The
 * plan is four loading weeks and a deload; this is the chart that shows whether
 * that is what is happening.
 */
export function waveWeekProgress() {
  const sessions = sessionService.getCompletedSessions();

  const volume = byWaveWeek(sessions, (group) =>
    round1(group.reduce((sum, session) => sum + sessionService.getSessionVolume(session), 0)
      / group.length));

  const sets = byWaveWeek(sessions, (group) =>
    Math.round(group.reduce((sum, session) =>
      sum + sessionService.getSessionCompletion(session).done, 0) / group.length));

  return { volume, sets };
}

/** What happened in the session after each deload. Empty until one has. */
export function getDeloadResponse() {
  return deloadResponse(allInsights());
}

/** Where the app's prescriptions and the actual sessions disagree. */
export function getAdherence() {
  return adherence(allInsights());
}

/**
 * Training consistency, counting a late session as done rather than missed.
 * The schedule reading comes from session-service, which derives it for old
 * sessions as well as new ones.
 */
export function getConsistency(days = 90, endKey = today()) {
  return consistency(windowedSessions(days, endKey).map((session) => ({
    date: session.date,
    schedule: sessionService.getSchedule(session),
  })));
}

/**
 * The headline reading, in one sentence each.
 *
 * Assembled here rather than in the page so the wording lives next to the
 * numbers it describes, and so it can say "not yet" instead of printing a
 * confident sentence about two data points.
 */
export function headlines(days = 90, endKey = today()) {
  const insights = allInsights();
  const board = scorecard(insights);
  const mix = driverMix(insights);
  const readable = insights.filter((item) => item.comparableSessions >= 2);

  // Counted by the same judgement the scorecard uses, not by a second rule of
  // its own. A separate estimated-1RM threshold here reported "14 of 33 up"
  // above a list of 22 exercises headed "Progressing", and both numbers were
  // defensible in isolation — which is exactly the problem.
  const improving = readable.filter((item) => item.status === STATUS.PROGRESSING);
  const median = readable.length
    ? medianOf(readable.map((item) => item.e1rm.ratio ?? 1))
    : null;

  return {
    // "Am I getting stronger?" — answered by counting lifts, not by averaging
    // percentages across a squat and a lateral raise.
    strength: readable.length < 2
      ? { verdict: 'unknown', text: 'Not enough comparable sessions yet to say. Two per exercise is the minimum.' }
      : {
        verdict: improving.length > readable.length / 2 ? 'yes' : (improving.length ? 'mixed' : 'no'),
        text: `${improving.length} of ${readable.length} readable lifts are up`
          + `${median !== null ? `, median ${signedPercent(median - 1)}` : ''}.`,
        improving: improving.length,
        readable: readable.length,
        medianRatio: median,
      },
    driver: mix.total
      ? {
        text: `${mix.counts[DRIVER.REPS]} lifts progressing on reps, ${mix.counts[DRIVER.LOAD]} on load, `
          + `${mix.counts[DRIVER.BOTH]} on both.`,
        mix,
      }
      : null,
    attention: board.attention.slice(0, 3),
    scaleChanged: board.scaleChanged.length,
    consistency: getConsistency(days, endKey),
  };
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function signedPercent(ratio) {
  const percent = Math.round((ratio ?? 0) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

function shiftDays(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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

/**
 * Working-set volume per week, split by the kind of work that produced it.
 *
 * The three figures are never summed into one. A fortnight where warm-up volume
 * doubled and working volume fell is a meaningfully different fortnight from
 * one where the total happened to hold, and a single number cannot say which
 * happened. See `engine/set-model.entryVolume`.
 */
export function volumeSplitByWeek(days = 90, endKey = today()) {
  const sessions = windowedSessions(days, endKey).map((session) => ({
    date: session.date,
    split: sessionService.getSessionVolumeBreakdown(session),
  }));

  const forKind = (kind) => fillWeeks(byWeek(sessions, (group) =>
    round1(group.reduce((sum, item) => sum + item.split[kind], 0))));

  return {
    working: forKind('workingKg'),
    warmup: forKind('warmupKg'),
    intensity: forKind('intensityKg'),
  };
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

      // Working sets only, and each load counted once — see
      // engine/loading.volumeMultiplier and session-service.getSessionVolume.
      const volume = entryVolume(normalizeEntry(entry), volumeMultiplier(exercise)).workingKg;
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

/** Shared chart data for Progress and PDF; never includes history after the report end. */
export function exerciseProgression(exerciseId, days = 90, endKey = today()) {
  const exercise = programService.getExercise(exerciseId);
  const history = sessionService.getExerciseHistory(exerciseId, Infinity)
    .filter((item) => item.date <= endKey && !item.substituted);
  const insight = exercise ? exerciseInsight(exercise, history) : null;
  const points = withinDays(insight?.series ?? [], days, endKey);
  const timed = exercise?.reps?.unit === 'seconds' || /sec|second/i.test(exercise?.reps?.label ?? '');
  const specs = [
    { key: 'load', label: 'Repeatable working load', unit: 'kg', read: (p) => p.workingLoadKg },
    { key: 'reps', label: timed ? 'Mean hold at working load' : 'Mean reps at working load', unit: timed ? 'sec' : 'reps', read: (p) => p.setsAtLoad ? p.repsAtLoad / p.setsAtLoad : null },
    { key: 'sets', label: 'Sets at working load', unit: 'sets', read: (p) => p.setsAtLoad },
    ...(!timed && points.some((p) => p.e1rmKg > 0) ? [{ key: 'e1rm', label: 'Working-set estimated 1RM', unit: 'kg', read: (p) => p.e1rmKg || null }] : []),
  ];
  const charts = specs.map(({ read, ...spec }) => ({ ...spec,
    points: points.map((p, index) => {
      const prior = points[index - 1];
      const excluded = p.isDeload || p.painLimited || p.incomplete;
      const priorExcluded = prior && (prior.isDeload || prior.painLimited || prior.incomplete);
      return { date: p.date, key: `${p.date}|${String(index).padStart(5, '0')}`,
        value: read(p), excluded: Boolean(excluded),
        breakBefore: index === 0 || p.comparable === false || Boolean(excluded || priorExcluded)
          || (spec.key === 'reps' && prior?.workingLoadKg !== p.workingLoadKg),
      };
    }),
  }));
  return { exercise, charts, sessions: points.length,
    note: 'Dots show logged work. Orange dots are deload, pain-limited or incomplete sessions, not progression evidence. Lines break at comparison changes; rep lines also break when load changes. Warm-ups and intensity sets are excluded. Zero load means no added weight.',
  };
}

export function progressionExercises() {
  return [...programService.getAllExercises(), ...programService.getRetiredExercises(), ...programService.getSubstituteExercises()]
    .filter((exercise, index, all) => all.findIndex((item) => item.id === exercise.id) === index)
    .filter((exercise) => !programService.isWarmupOnly(exercise))
    .sort((a, b) => a.name.localeCompare(b.name));
}
