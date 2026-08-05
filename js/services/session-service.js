/**
 * session-service.js — Workout sessions: the log of what was actually lifted.
 *
 * Data model
 * ----------
 *   session = {
 *     id, dayId, date,                    // date is a local YYYY-MM-DD key
 *     status: 'in-progress' | 'completed',
 *     startedAt, completedAt,             // ISO instants, for duration
 *     week, waveWeek, isDeload,           // wave position, frozen at start
 *     entries: [{
 *       exerciseId,                       // links back to workouts.json
 *       targetWeightKg, targetReps,       // what the engine prescribed
 *       sets: [{ weightKg, reps, completed, rpe }],
 *       notes,
 *     }],
 *   }
 *
 * A session stores exercise *ids*, never names or prescriptions by value, so
 * that replacing workouts.json cannot orphan history. It does keep the
 * target it was given, because a report needs to say what was asked for as
 * well as what was done.
 *
 * At most one session is 'in-progress' at a time: starting a workout while
 * another is open resumes the open one instead of creating a duplicate.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { EVENTS, emit } from '../core/events.js';
import { today, isoWeekday, addDays, daysBetween } from '../core/format.js';
import * as programService from './program-service.js';
import * as settingsService from './settings-service.js';

/* --- Reads -------------------------------------------------------------- */

/** Every session, newest first. */
export function getSessions() {
  return [...db.read(COLLECTIONS.SESSIONS)].sort((a, b) => b.date.localeCompare(a.date));
}

/** Completed sessions only, newest first. */
export function getCompletedSessions() {
  return getSessions().filter((session) => session.status === 'completed');
}

/** The open session, if the user is mid-workout. */
export function getActiveSession() {
  return db.read(COLLECTIONS.SESSIONS).find((session) => session.status === 'in-progress') ?? null;
}

export function getSessionById(id) {
  return db.read(COLLECTIONS.SESSIONS).find((session) => session.id === id) ?? null;
}

export function getLastCompletedSession() {
  const completed = getCompletedSessions();
  return completed.length ? completed[0] : null;
}

/** The most recent completed session for a given training day. */
export function getLastSessionForDay(dayId) {
  return getCompletedSessions().find((session) => session.dayId === dayId) ?? null;
}

/**
 * The last completed sets for one exercise, newest session first.
 * This is what the Workout page shows as "Last workout", and what the
 * progression engine will read in Session 2.
 */
export function getExerciseHistory(exerciseId, limit = 10) {
  const history = [];
  for (const session of getCompletedSessions()) {
    const entry = session.entries.find((item) => item.exerciseId === exerciseId);
    if (!entry) continue;
    const workingSets = entry.sets.filter((set) => set.completed);
    if (!workingSets.length) continue;
    history.push({
      sessionId: session.id,
      date: session.date,
      week: session.week,
      isDeload: session.isDeload,
      targetWeightKg: entry.targetWeightKg ?? null,
      sets: workingSets,
      notes: entry.notes ?? '',
    });
    if (history.length >= limit) break;
  }
  return history;
}

/** The single most recent completed performance of an exercise. */
export function getLastPerformance(exerciseId) {
  return getExerciseHistory(exerciseId, 1)[0] ?? null;
}

/* --- Session lifecycle -------------------------------------------------- */

/**
 * Start (or resume) a session for a training day.
 * Resuming matters on a phone: Safari will discard the tab mid-workout, and
 * a half-logged session must still be there afterwards.
 */
export async function startSession(dayId, dayKey = today()) {
  const open = getActiveSession();
  if (open) return open;

  const day = programService.getDayById(dayId);
  if (!day) throw new Error(`Unknown training day "${dayId}".`);
  if (day.type !== 'training') throw new Error(`"${day.label}" is not a training day.`);

  const wave = programService.getTrainingWeek(dayKey);

  const session = await db.insert(COLLECTIONS.SESSIONS, {
    dayId,
    date: dayKey,
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    completedAt: null,
    week: wave.week,
    waveWeek: wave.waveWeek,
    isDeload: wave.isDeload,
    entries: day.exercises.map((exercise) => ({
      exerciseId: exercise.id,
      targetWeightKg: null,
      targetReps: null,
      sets: buildSetSlots(exercise, wave.isDeload),
      notes: '',
    })),
  });

  emit(EVENTS.WORKOUT_STARTED, { sessionId: session.id, dayId });
  return session;
}

/**
 * Empty set slots for an exercise, honouring the deload set reduction so a
 * deload week does not show four rows the user is meant to skip.
 */
function buildSetSlots(exercise, isDeload) {
  const count = isDeload ? programService.deloadSets(exercise.sets) : exercise.sets;
  return Array.from({ length: count }, () => ({
    weightKg: null,
    reps: null,
    completed: false,
    rpe: null,
  }));
}

/** Patch one entry of an in-progress session. */
export async function updateEntry(sessionId, exerciseId, patch) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');

  const entries = session.entries.map((entry) =>
    entry.exerciseId === exerciseId ? { ...entry, ...patch } : entry
  );

  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, { entries });
}

/** Patch a single set within an entry. */
export async function updateSet(sessionId, exerciseId, setIndex, patch) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');

  const entries = session.entries.map((entry) => {
    if (entry.exerciseId !== exerciseId) return entry;
    const sets = entry.sets.map((set, index) =>
      index === setIndex ? { ...set, ...patch } : set
    );
    return { ...entry, sets };
  });

  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, { entries });
}

/**
 * Finish a session. Sets the program start date on the very first completed
 * workout, which is what anchors the training-week counter.
 */
export async function completeSession(sessionId) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');

  const completedAt = new Date().toISOString();
  const durationSeconds = session.startedAt
    ? Math.max(0, Math.round((new Date(completedAt) - new Date(session.startedAt)) / 1000))
    : null;

  const updated = await db.replaceById(COLLECTIONS.SESSIONS, sessionId, {
    status: 'completed',
    completedAt,
    durationSeconds,
  });

  await settingsService.ensureProgramStart(session.date);
  emit(EVENTS.WORKOUT_COMPLETED, { sessionId, dayId: session.dayId });
  return updated;
}

/** Discard an in-progress session. */
export async function abandonSession(sessionId) {
  return db.removeById(COLLECTIONS.SESSIONS, sessionId);
}

export async function deleteSession(sessionId) {
  return db.removeById(COLLECTIONS.SESSIONS, sessionId);
}

/* --- Derived statistics ------------------------------------------------- */

/**
 * How much of a session was completed, as sets done over sets prescribed.
 * @returns {{done: number, total: number, percent: number}}
 */
export function getSessionCompletion(session) {
  let done = 0;
  let total = 0;
  for (const entry of session.entries) {
    total += entry.sets.length;
    done += entry.sets.filter((set) => set.completed).length;
  }
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Total load moved in a session, in kg-reps.
 *
 * Dumbbell work is logged per hand, so its volume is doubled — otherwise a
 * 30 kg dumbbell press would appear to be half the work of a 60 kg barbell
 * press at the same reps. Bodyweight movements count only the *added* load,
 * because body weight is tracked separately and would otherwise swamp the
 * trend every time the user gained a kilo.
 */
export function getSessionVolume(session) {
  let volume = 0;
  for (const entry of session.entries) {
    const exercise = programService.getExercise(entry.exerciseId);
    const multiplier = exercise?.loadType === 'per-hand' ? 2 : 1;
    for (const set of entry.sets) {
      if (!set.completed || !set.reps) continue;
      volume += (set.weightKg ?? 0) * set.reps * multiplier;
    }
  }
  return volume;
}

/**
 * Completion across the current training week.
 *
 * The denominator is the number of training days *scheduled so far this
 * week*, not all five. On a Wednesday, 2 of 2 is 100% — grading against
 * sessions that have not come round yet would make every mid-week glance
 * look like a failure.
 */
export function getWeekCompletion(dayKey = today()) {
  const weekday = isoWeekday(dayKey);
  const monday = addDays(dayKey, -(weekday - 1));

  const scheduled = programService
    .getTrainingDays()
    .filter((day) => day.weekday <= weekday);

  const completedDayIds = new Set(
    getCompletedSessions()
      .filter((session) => session.date >= monday && session.date <= dayKey)
      .map((session) => session.dayId)
  );

  const done = scheduled.filter((day) => completedDayIds.has(day.id)).length;
  const total = scheduled.length;

  return {
    done,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
    weekStart: monday,
    scheduledThisWeek: programService.getTrainingDays().length,
  };
}

/**
 * Consecutive-week streak: weeks, counting back from the current one, in
 * which every scheduled training day was completed. The current week counts
 * only once it is finished, so a streak can never be lost mid-week.
 */
export function getWeeklyStreak(dayKey = today()) {
  const trainingDays = programService.getTrainingDays();
  if (!trainingDays.length) return 0;

  const weekday = isoWeekday(dayKey);
  let cursor = addDays(dayKey, -(weekday - 1));  // Monday of the current week
  let streak = 0;

  // Only judge the current week if its last training day has passed.
  const lastTrainingWeekday = Math.max(...trainingDays.map((day) => day.weekday));
  if (weekday < lastTrainingWeekday) cursor = addDays(cursor, -7);

  for (let i = 0; i < 260; i += 1) {   // hard stop at five years
    const weekEnd = addDays(cursor, 6);
    const completedDayIds = new Set(
      getCompletedSessions()
        .filter((session) => session.date >= cursor && session.date <= weekEnd)
        .map((session) => session.dayId)
    );
    const complete = trainingDays.every((day) => completedDayIds.has(day.id));
    if (!complete) break;
    streak += 1;
    cursor = addDays(cursor, -7);
  }

  return streak;
}

/** Sessions completed in the last `days` days. */
export function getRecentSessions(days = 14, dayKey = today()) {
  const from = addDays(dayKey, -days);
  return getCompletedSessions().filter((session) => session.date > from);
}

/** Days since the last completed workout, or null if there are none. */
export function getDaysSinceLastWorkout(dayKey = today()) {
  const last = getLastCompletedSession();
  return last ? daysBetween(last.date, dayKey) : null;
}
