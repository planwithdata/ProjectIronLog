/**
 * program-service.js — Reads the training program from /data/workouts.json.
 *
 * The program is *reference data*, not user data: it is fetched, never
 * written. Dropping in a new `workouts.json` replaces the whole program
 * without touching a line of code or a byte of logged history — which is why
 * nothing here is hardcoded and why sessions store the exercise `id` they
 * were logged against.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { isoWeekday, today, daysBetween, addDays } from '../core/format.js';

const PROGRAM_URL = new URL('../../data/workouts.json', import.meta.url);

let program = null;
let exerciseIndex = new Map();   // exerciseId -> { exercise, day }
let retiredIndex = new Map();    // exerciseId -> exercise (no longer prescribed)

/**
 * Fetch and index the program. Called once during boot.
 * @throws {Error} if the program cannot be loaded — the app cannot run
 *                 without it, so failing loudly beats a blank Workout page.
 */
export async function load() {
  if (program) return program;

  const response = await fetch(PROGRAM_URL, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not load the training program (HTTP ${response.status}).`);
  }

  const data = await response.json();
  validate(data);

  program = data;
  exerciseIndex = new Map();
  for (const day of data.days) {
    for (const exercise of day.exercises) {
      exerciseIndex.set(exercise.id, { exercise, day });
    }
  }

  retiredIndex = new Map();
  for (const exercise of data.retiredExercises ?? []) {
    retiredIndex.set(exercise.id, exercise);
  }

  return program;
}

/** Reject a malformed program early, with a message that says what is wrong. */
function validate(data) {
  if (!data || typeof data !== 'object') throw new Error('workouts.json is not an object.');
  if (!Array.isArray(data.days) || data.days.length === 0) {
    throw new Error('workouts.json has no "days" array.');
  }
  for (const day of data.days) {
    if (!day.id) throw new Error('A day in workouts.json is missing "id".');
    if (!Array.isArray(day.exercises)) {
      throw new Error(`Day "${day.id}" is missing an "exercises" array.`);
    }
    for (const exercise of day.exercises) {
      if (!exercise.id || !exercise.name) {
        throw new Error(`An exercise in "${day.id}" is missing "id" or "name".`);
      }
      if (!exercise.reps || typeof exercise.reps.min !== 'number') {
        throw new Error(`Exercise "${exercise.id}" is missing a numeric reps.min.`);
      }
    }
  }

  if (data.retiredExercises !== undefined && !Array.isArray(data.retiredExercises)) {
    throw new Error('workouts.json has a "retiredExercises" that is not an array.');
  }
  for (const exercise of data.retiredExercises ?? []) {
    if (!exercise.id || !exercise.name) {
      throw new Error('A retired exercise in workouts.json is missing "id" or "name".');
    }
  }
}

export function getProgram() {
  if (!program) throw new Error('[program] load() must be awaited before use.');
  return program;
}

export function getDays() {
  return getProgram().days;
}

/** All days that actually involve lifting. */
export function getTrainingDays() {
  return getDays().filter((day) => day.type === 'training');
}

export function getDayById(dayId) {
  return getDays().find((day) => day.id === dayId) ?? null;
}

/** The scheduled day for an ISO weekday (1 = Monday … 7 = Sunday). */
export function getDayByWeekday(weekday) {
  return getDays().find((day) => day.weekday === weekday) ?? null;
}

/** Whatever today's calendar weekday maps to in the split. */
export function getTodayDay(dayKey = today()) {
  return getDayByWeekday(isoWeekday(dayKey));
}

/**
 * Look up an exercise across every day, then across the retired list.
 *
 * The fallback exists because sessions store exercise *ids*: dropping a
 * movement from the split would otherwise turn every session that logged it
 * into a raw slug with no loading convention attached, so "150" on a barbell
 * squat would stop reading as "+150 kg plates". A retired definition is not
 * prescribed anywhere and never appears in a day, but it still knows what its
 * own numbers meant, which is what history and PRs need from it.
 */
export function getExercise(exerciseId) {
  return exerciseIndex.get(exerciseId)?.exercise
    ?? retiredIndex.get(exerciseId)
    ?? null;
}

/** The day an exercise belongs to. Null for a retired movement. */
export function getExerciseDay(exerciseId) {
  return exerciseIndex.get(exerciseId)?.day ?? null;
}

/** Every exercise the program currently prescribes. Excludes retired ones. */
export function getAllExercises() {
  return [...exerciseIndex.values()].map(({ exercise }) => exercise);
}

/** Movements that were dropped from the split but still have history. */
export function getRetiredExercises() {
  return [...retiredIndex.values()];
}

/** Is this id a movement the program no longer prescribes? */
export function isRetired(exerciseId) {
  return retiredIndex.has(exerciseId) && !exerciseIndex.has(exerciseId);
}

/**
 * Total **working** sets prescribed for a day.
 *
 * Pre-workout warm-up movements are excluded. The push-ups before a chest
 * session are real work but they are not chest working sets, and counting them
 * would inflate every set total, every completion percentage and every volume
 * figure that quotes one.
 */
export function countSets(day) {
  return (day?.exercises ?? [])
    .filter((exercise) => !isWarmupOnly(exercise))
    .reduce((sum, exercise) => sum + (exercise.sets ?? 0), 0);
}

/** Exercises that count towards the prescription. */
export function getWorkingExercises(day) {
  return (day?.exercises ?? []).filter((exercise) => !isWarmupOnly(exercise));
}

/** Optional pre-workout warm-up movements, in order. */
export function getWarmupExercises(day) {
  return (day?.exercises ?? []).filter(isWarmupOnly);
}

/**
 * A movement that exists only as a warm-up: it has no working sets, never
 * drives progression, and contributes no hypertrophy volume.
 */
export function isWarmupOnly(exercise) {
  return Boolean(exercise?.warmupOnly) || exercise?.role === 'pre-workout-warmup';
}

/** Does the program prescribe ramp-up sets for this movement? */
export function supportsRamp(exercise) {
  return Boolean(exercise?.warmup?.supported);
}

/** How many ramp-up sets the program suggests, before the user's preference. */
export function rampSetCount(exercise) {
  return Number(exercise?.warmup?.rampSets) || 3;
}

/**
 * Whether drop sets and failure work are offered on this movement.
 *
 * Defaults follow the program's `intensity.defaultAllowedFor`: isolation and
 * core work yes, main compounds no. An explicit flag on the exercise wins. This
 * is a default, not a prohibition — the brief is explicit that failure training
 * is the user's choice, so the UI still offers an override.
 */
export function allowsIntensityTechniques(exercise) {
  if (typeof exercise?.intensityTechniquesAllowed === 'boolean') {
    return exercise.intensityTechniquesAllowed;
  }
  const allowed = getProgram().progression?.intensity?.defaultAllowedFor ?? ['isolation', 'core'];
  return allowed.includes(exercise?.category);
}

/** Pain-aware movements accept fewer reps, an early stop or a substitution. */
export function isPainAware(exercise) {
  return Boolean(exercise?.painAware);
}

/** Substitutions offered when a movement is stopped for discomfort. */
export function getAlternatives(exercise) {
  return Array.isArray(exercise?.alternatives) ? exercise.alternatives : [];
}

/** Program-wide intensity-technique guidance, for display. */
export function getIntensityRules() {
  return getProgram().progression?.intensity ?? null;
}

/** Program-wide warm-up guidance, for display. */
export function getWarmupRules() {
  return getProgram().progression?.warmup ?? null;
}

/** Program-wide progression rules, for display and for the engine. */
export function getProgressionRules() {
  return getProgram().progression;
}

export function getUnits() {
  return getProgram().program?.units ?? 'kg';
}

/**
 * The program's own body-weight goal, used when the profile has none.
 *
 * The goal belongs in the program document — it is part of the plan, not a
 * device preference — but an explicit entry in Settings still wins, so it can
 * be changed without editing JSON.
 */
export function getProgramGoalWeightKg() {
  return getProgram().program?.goals?.bodyWeightKg ?? null;
}

/* --- Training calendar -------------------------------------------------- */

/**
 * Where the user is in the 4-week wave.
 *
 * `programStartDate` is set on the first completed workout rather than on
 * install, so opening the app and not training does not burn Week 1. Until
 * then everything reads as Week 1, Day 1.
 *
 * @returns {{week: number, waveWeek: number, isDeload: boolean, startDate: string|null, dayCount: number}}
 */
export function getTrainingWeek(dayKey = today()) {
  const profile = db.read(COLLECTIONS.PROFILE);
  const startDate = profile.programStartDate;
  const wave = getProgram().program?.wave ?? { loadingWeeks: 4, deloadWeek: 5 };
  const cycleLength = wave.deloadWeek ?? (wave.loadingWeeks + 1);

  if (!startDate) {
    return { week: 1, waveWeek: 1, isDeload: false, startDate: null, dayCount: 0 };
  }

  const dayCount = Math.max(0, daysBetween(startDate, dayKey));
  const week = Math.floor(dayCount / 7) + 1;
  const waveWeek = ((week - 1) % cycleLength) + 1;

  return {
    week,
    waveWeek,
    isDeload: waveWeek === cycleLength,
    startDate,
    dayCount,
  };
}

/**
 * Deload adjustment for a prescribed set count: roughly 40% fewer sets,
 * never below two (the program's own worked example is 4 -> 2, 3 -> 2).
 */
export function deloadSets(sets) {
  const wave = getProgram().program?.wave?.deload;
  const reduction = (wave?.setReductionPercent ?? 40) / 100;
  return Math.max(2, Math.round(sets * (1 - reduction)));
}

/** Countdown to the next two-week review. */
export function getReviewCountdown(dayKey = today()) {
  const settings = db.read(COLLECTIONS.SETTINGS);
  const reviews = db.read(COLLECTIONS.REVIEWS);
  const intervalDays =
    settings.reviewIntervalDays ?? getProgram().program?.review?.everyDays ?? 14;

  // Count from the last review if there is one, otherwise from the program
  // start, otherwise there is nothing to count from yet.
  const lastReviewDate = reviews.length
    ? reviews[reviews.length - 1].date
    : db.read(COLLECTIONS.PROFILE).programStartDate;

  if (!lastReviewDate) {
    return { daysRemaining: null, dueDate: null, intervalDays, lastReviewDate: null };
  }

  const elapsed = daysBetween(lastReviewDate, dayKey);
  const daysRemaining = intervalDays - elapsed;

  return {
    daysRemaining,
    dueDate: addDays(lastReviewDate, intervalDays),
    intervalDays,
    lastReviewDate,
    isOverdue: daysRemaining <= 0,
  };
}
