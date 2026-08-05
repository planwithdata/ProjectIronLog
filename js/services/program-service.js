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

/** Look up an exercise across every day. */
export function getExercise(exerciseId) {
  return exerciseIndex.get(exerciseId)?.exercise ?? null;
}

/** The day an exercise belongs to. */
export function getExerciseDay(exerciseId) {
  return exerciseIndex.get(exerciseId)?.day ?? null;
}

export function getAllExercises() {
  return [...exerciseIndex.values()].map(({ exercise }) => exercise);
}

/** Total working sets prescribed for a day. */
export function countSets(day) {
  return (day?.exercises ?? []).reduce((sum, exercise) => sum + exercise.sets, 0);
}

/** Program-wide progression rules, for display and for the engine. */
export function getProgressionRules() {
  return getProgram().progression;
}

export function getUnits() {
  return getProgram().program?.units ?? 'kg';
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
