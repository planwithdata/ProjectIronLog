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
 *     schedule: {                         // planned day vs actual day
 *       status, offsetDays, scheduledWeekday, scheduledDate,
 *     },
 *     entries: [{
 *       exerciseId,                       // the PLANNED slot in workouts.json
 *       targetWeightKg, targetReps,       // what the engine prescribed
 *       setModel: 'v2' | 'legacy',
 *       sets: [{ weightKg, reps, completed, rpe, kind }],   // WORKING SETS
 *       warmupSets: [{ weightKg, reps, completed, kind }],  // ramp-up work
 *       intensitySets: [{ id, type, stages: [...] }],       // drop / failure
 *       pain: null | { score, location, note, action, alternativeId },
 *       difficulty: null | string,
 *       context: null | { machineId, label, attachment, note },
 *       substitution: null | { performedId, label, comparableLoad, note },
 *       notes,
 *     }],
 *   }
 *
 * `dayId` is the workout that was *performed*, and `date` is when. Those two
 * are enough to say where a session sits against the split, so `schedule` is
 * derived rather than authoritative — `getSchedule` recomputes it for any
 * session, including every one logged before the field existed. That is what
 * makes "I missed Tuesday and did chest on Wednesday" a first-class outcome
 * instead of a missed session plus a mystery.
 *
 * `entry.exerciseId` remains the planned slot even when something else was
 * performed; `entry.substitution.performedId` says what that was. Keeping the
 * slot is what preserves adherence — a bar pushdown in the rope pushdown's
 * place is a completed exercise, not a skipped one — and keeping the performed
 * id separate is what stops two incomparable stack readings landing in one
 * load series.
 *
 * A session stores exercise *ids*, never names or prescriptions by value, so
 * that replacing workouts.json cannot orphan history. It does keep the
 * target it was given, because a report needs to say what was asked for as
 * well as what was done.
 *
 * `entry.sets` holds working sets and nothing else. That is the load-bearing
 * decision of the whole set model: it means every existing reader of `sets` —
 * the progression engine, the PR detector, the CSV export — sees working sets
 * by default and cannot accidentally include a ramp-up. See
 * `engine/set-model.js` for the reasoning.
 *
 * At most one session is 'in-progress' at a time: starting a workout while
 * another is open resumes the open one instead of creating a duplicate.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { WORKING_SET_REBASELINE } from '../config.js';
import { EVENTS, emit } from '../core/events.js';
import { today, isoWeekday, addDays, daysBetween } from '../core/format.js';
import * as programService from './program-service.js';
import * as settingsService from './settings-service.js';
import * as trainingPrefs from './training-prefs-service.js';
import { recommend, isEntryComplete, earnedAdvance } from '../engine/progression.js';
import { volumeMultiplier } from '../engine/loading.js';
import {
  SET_KIND,
  INTENSITY_TYPE,
  PAIN_ACTION,
  normalizeEntry,
  workingSets,
  completedWorkingSets,
  warmupSets,
  completedWarmupSets,
  intensitySequences,
  isLegacyEntry,
  isPainLimited,
  composition,
  entryVolume,
  rampSets as buildRampSets,
  repeatableSets,
} from '../engine/set-model.js';
import { contextKey, describeContext } from '../engine/context.js';

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
 * The last completed **working** sets for one exercise, newest session first.
 *
 * This is both what the Workout page shows as "Last session" and what the
 * progression engine reads. Warm-up and intensity work travel alongside it as
 * separate fields so a report can show them, but `sets` — the field the engine
 * consumes — is working sets only.
 *
 * Each performance also carries the two flags the engine needs to be fair:
 *
 *   painLimited  discomfort was logged, or the exercise was cut short for it
 *   incomplete   fewer working sets were completed than were prescribed
 *
 * Neither hides the session. They stop it being read as evidence of getting
 * weaker, which it is not.
 */
export function getExerciseHistory(exerciseId, limit = 10) {
  const history = [];
  const exercise = programService.getExercise(exerciseId);
  const prescribed = exercise?.sets ?? 0;

  for (const session of getCompletedSessions()) {
    const raw = findEntryFor(session, exerciseId);
    if (!raw) continue;
    const entry = normalizeEntry(raw);

    const done = workingSets(entry).filter((set) => set.completed);
    const warmups = completedWarmupSets(entry);
    const intensity = intensitySequences(entry);

    // An entry with no working sets is still worth reporting when it holds
    // warm-up work, intensity work or a pain log — "I tried and stopped" is
    // information. It is skipped only when there is genuinely nothing in it.
    if (!done.length && !warmups.length && !intensity.length && !entry.pain) continue;

    const substitution = entry.substitution ?? null;
    // Asking for the planned slot while a stand-in was performed, or the other
    // way round. Both readings are legitimate and they are not the same
    // question, so each says which one it answered.
    const substituted = Boolean(substitution) && substitution.performedId !== exerciseId;

    history.push({
      sessionId: session.id,
      date: session.date,
      week: session.week,
      waveWeek: session.waveWeek ?? null,
      dayId: session.dayId,
      isDeload: session.isDeload,
      schedule: getSchedule(session),
      targetWeightKg: entry.targetWeightKg ?? null,
      plannedAction: entry.plannedAction ?? null,
      sets: done,
      warmupSets: warmups,
      intensitySets: intensity,
      pain: entry.pain ?? null,
      painLimited: isPainLimited(entry),
      incomplete: prescribed > 0 && done.length < prescribed,
      difficulty: entry.difficulty ?? null,
      legacy: isLegacyEntry(entry),
      notes: entry.notes ?? '',
      // Load-comparison identity. `contextKey` reads both fields, so a machine
      // tag and a substitution both land in it and the engine needs to know
      // about neither individually.
      context: entry.context ?? null,
      contextLabel: describeContext(entry),
      contextKey: contextKey(entry),
      substitution,
      substituted,
      plannedExerciseId: entry.exerciseId,
      performedExerciseId: substitution?.performedId ?? entry.exerciseId,
    });
    if (history.length >= limit) break;
  }
  return history;
}

/**
 * The entry in a session that answers for `exerciseId`.
 *
 * Usually the one filed under that id. The second lookup is for a stand-in: ask
 * for the bar pushdown and you get the rope pushdown's slot on the day the bar
 * was actually used, because that is where that work is recorded. Without it a
 * substitute would have a name and a loading convention but never any history.
 */
function findEntryFor(session, exerciseId) {
  const direct = session.entries.find((item) => item.exerciseId === exerciseId);
  if (direct && !(direct.substitution && direct.substitution.performedId !== exerciseId)) {
    return direct;
  }

  const performed = session.entries.find(
    (item) => item.substitution?.performedId === exerciseId
  );
  return performed ?? direct ?? null;
}

/** The single most recent completed performance of an exercise. */
export function getLastPerformance(exerciseId) {
  return getExerciseHistory(exerciseId, 1)[0] ?? null;
}

/**
 * Which working set the engine should measure the next load from, for a
 * session on `dayKey`. Null means the default — the heaviest completed set.
 *
 * This is the whole of the `WORKING_SET_REBASELINE` correction described in
 * `js/config.js`: a window of `sessions` workouts starting at `fromDate`, after
 * which the rule retires itself without anyone having to remember to remove it.
 *
 * Counted in completed sessions rather than in dates, because the point is a
 * training week — five workouts — not seven days. A week interrupted by
 * illness still gets its five, and a week where two sessions land on one day
 * does not get six.
 *
 * The in-progress session is not counted, since it is not completed yet. So the
 * first workout of the window sees a count of 0 and the sixth sees 5, which is
 * where the window closes.
 */
export function baselineSetIndex(dayKey = today(), rule = WORKING_SET_REBASELINE) {
  if (!rule?.setIndex || !rule.fromDate) return null;
  if (dayKey < rule.fromDate) return null;

  const since = getCompletedSessions()
    .filter((session) => session.date >= rule.fromDate).length;

  return since < rule.sessions ? rule.setIndex : null;
}

/* --- Schedule: planned day vs actual day -------------------------------
   A session knows which workout it was (`dayId`) and when it happened
   (`date`). Everything about being early, late or on time follows from those
   two, so it is derived here rather than trusted from storage — which is what
   makes it correct for the eighteen sessions logged before the idea existed.
   ====================================================================== */

/**
 * Where one session sits against its scheduled day.
 *
 * Prefers the reading frozen at start, because that is what the app told the
 * user at the time, and falls back to recomputing it. The recomputation is the
 * same function, so the two can never disagree except by the program's own
 * weekdays having been edited since — in which case the frozen copy is the
 * honest one.
 */
export function getSchedule(session) {
  if (!session) return null;
  if (session.schedule?.status) return session.schedule;
  return programService.getScheduleFit(session.dayId, session.date);
}

/** Was this workout performed on a day other than the one it is scheduled on? */
export function isOffSchedule(session) {
  const schedule = getSchedule(session);
  return Boolean(schedule) && schedule.status !== programService.SCHEDULE_STATUS.ON_DAY;
}

/**
 * Training days that could be started today, most likely first, each annotated
 * with how it would sit against the schedule and when it was last done.
 *
 * This is what the "do a different workout" picker renders. It lists the whole
 * split rather than only the ones behind: the point of the feature is that any
 * day can be done on any day, and a picker that decides for you which ones are
 * allowed is the problem it was built to fix.
 */
export function getStartableDays(dayKey = today()) {
  return programService.getTrainingDaysFrom(dayKey).map((day) => {
    const last = getLastSessionForDay(day.id);
    const fit = programService.getScheduleFit(day.id, dayKey);
    const doneThisWeek = completedThisWeek(day.id, dayKey);

    return {
      day,
      fit,
      lastDate: last?.date ?? null,
      daysSince: last ? daysBetween(last.date, dayKey) : null,
      doneThisWeek,
      // The one thing worth flagging: its day has passed this week and it has
      // not been done. Not a warning, a shortcut.
      overdueThisWeek: !doneThisWeek && fit.offsetDays > 0,
      exercises: programService.getWorkingExercises(day).length,
    };
  });
}

/** Has this training day already been completed in the ISO week containing `dayKey`? */
export function completedThisWeek(dayId, dayKey = today()) {
  const monday = addDays(dayKey, -(isoWeekday(dayKey) - 1));
  const sunday = addDays(monday, 6);
  return getCompletedSessions().some((session) =>
    session.dayId === dayId && session.date >= monday && session.date <= sunday);
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

  // Any day's workout may be started on any day. What the app owes the user in
  // return is a record of the difference: this session is Tuesday Chest,
  // performed on Wednesday, one day late — not a Wednesday session that has
  // mysteriously grown a bench press.
  const fit = programService.getScheduleFit(dayId, dayKey);
  const schedule = getCompletedSessions().some((item) => item.dayId === dayId && getSchedule(item)?.scheduledDate === fit.scheduledDate)
    ? { ...fit, status: programService.SCHEDULE_STATUS.EXTRA,
        label: programService.describeScheduleFit(programService.SCHEDULE_STATUS.EXTRA, fit.offsetDays) }
    : fit;

  const session = await db.insert(COLLECTIONS.SESSIONS, {
    dayId,
    date: dayKey,
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    completedAt: null,
    week: wave.week,
    waveWeek: wave.waveWeek,
    isDeload: wave.isDeload,
    plannedDeload: wave.isDeload,
    actualDeload: null,
    scheduledDeload: wave.scheduledDeload,
    schedule,
    entries: day.exercises
      // The pre-workout warm-up is a preference, so an entry for it is only
      // created when it is switched on. Turning it off later leaves the
      // sessions that already logged it untouched.
      .filter((exercise) =>
        !programService.isWarmupOnly(exercise) || trainingPrefs.pushupWarmupEnabled())
      .map((exercise) => buildEntry(exercise, wave, dayKey)),
  });

  emit(EVENTS.WORKOUT_STARTED, { sessionId: session.id, dayId });
  return session;
}

/**
 * Build one exercise entry, with the engine's recommendation baked in.
 *
 * The prescription is frozen into the session at start rather than recomputed
 * on each render, for two reasons: a report needs to say what was asked for as
 * well as what was done, and the recommendation must not shift underneath the
 * user as they log earlier sets of the same session.
 */
function buildEntry(exercise, wave, dayKey = today()) {
  const history = getExerciseHistory(exercise.id, Infinity);
  const loadPrefs = trainingPrefs.getLoadPrefs();

  // A warm-up-only movement has no working sets at all, so there is nothing for
  // the engine to prescribe. It gets warm-up rows and an empty working array,
  // which is what keeps it out of every working-set calculation for free.
  if (programService.isWarmupOnly(exercise)) {
    return {
      exerciseId: exercise.id,
      targetWeightKg: null,
      targetReps: [],
      plannedAction: null,
      planReason: exercise.notes ?? '',
      setModel: 'v2',
      sets: [],
      warmupSets: blankWarmupRows(programService.rampSetCount(exercise), exercise.reps?.min ?? null),
      intensitySets: [],
      pain: null,
      difficulty: null,
      context: null,
      substitution: null,
      notes: '',
    };
  }

  const setCount = wave.isDeload
    ? programService.deloadSets(exercise.sets)
    : exercise.sets;

  // Carried forward from the last time this movement was logged, because the
  // machine you used last week is overwhelmingly the one you are about to use
  // again. Pre-filling it is what makes tagging cost nothing in the normal
  // case; it is editable in one tap when the machine is taken.
  const context = programService.supportsLoadContext(exercise)
    ? (history.find((item) => item.context)?.context ?? null)
    : null;

  const plan = recommend(exercise, history, {
    isDeload: wave.isDeload,
    setCount,
    loadPrefs,
    baselineSetIndex: baselineSetIndex(dayKey),
    contextKey: contextKey({ context }),
  });

  return {
    exerciseId: exercise.id,
    targetWeightKg: plan.weightKg,
    targetReps: plan.perSetReps,
    plannedAction: plan.action,
    planReason: plan.reason,
    setModel: 'v2',
    context,
    substitution: null,
    // Each slot is pre-filled with the recommended load and rep target so the
    // common case is one tap on the checkmark, not four fields of typing.
    // A pyramid supplies a load per set; everything else shares one.
    sets: plan.perSetReps.map((reps, index) => ({
      weightKg: plan.perSetWeights ? plan.perSetWeights[index] ?? null : plan.weightKg,
      reps,
      completed: false,
      rpe: null,
      kind: SET_KIND.WORKING,
    })),
    warmupSets: prefilledRamp(exercise, plan),
    intensitySets: [],
    pain: null,
    // Carry the difficulty rung forward: a difficulty-first movement's plan
    // says which rung to work at, and the log has to remember which one it was.
    difficulty: plan.difficulty ?? null,
    notes: '',
  };
}

/**
 * Ramp-up rows for a compound lift, pre-filled from the working weight.
 *
 * Empty for anything the program does not prescribe a ramp for, and empty when
 * the preference is off. On a first-ever session there is no working weight to
 * compute percentages from, so blank rows are offered instead of invented loads.
 */
function prefilledRamp(exercise, plan) {
  if (!trainingPrefs.warmupEnabled()) return [];
  if (!programService.supportsRamp(exercise)) return [];

  const count = Math.min(
    trainingPrefs.warmupSetCount(programService.rampSetCount(exercise)),
    programService.rampSetCount(exercise)
  );

  const step = plan.increment || 2.5;
  const rungs = buildRampSets(plan.weightKg, count, step);
  if (!rungs.length) return blankWarmupRows(count, null);

  return rungs.map((rung) => ({
    weightKg: rung.weightKg,
    reps: rung.reps,
    completed: false,
    kind: SET_KIND.WARMUP,
  }));
}

function blankWarmupRows(count, reps) {
  return Array.from({ length: Math.max(0, count) }, () => ({
    weightKg: null,
    reps,
    completed: false,
    kind: SET_KIND.WARMUP,
  }));
}

/**
 * The engine's current recommendation for an exercise, ignoring any session
 * in progress. Used by the read-only program browser and by reports.
 */
export function getRecommendation(exercise, dayKey = today(), options = {}) {
  const wave = programService.getTrainingWeek(dayKey);
  const setCount = wave.isDeload
    ? programService.deloadSets(exercise.sets)
    : exercise.sets;
  const history = getExerciseHistory(exercise.id, Infinity);

  // Same carry-forward as `buildEntry`, so the browse view and the session it
  // starts show the same load rather than differing by a machine tag.
  const context = options.context
    ?? (programService.supportsLoadContext(exercise)
      ? (history.find((item) => item.context)?.context ?? null)
      : null);

  return recommend(exercise, history, {
    isDeload: wave.isDeload,
    setCount,
    loadPrefs: trainingPrefs.getLoadPrefs(),
    baselineSetIndex: baselineSetIndex(dayKey),
    contextKey: contextKey({ context }),
  });
}

/* --- Load context: which machine these numbers came off ----------------
   The stored number never changes and is never converted. What is recorded
   alongside it is which stack produced it, so the app can compare like with
   like instead of reading a walk across the gym floor as a strength gain.
   ====================================================================== */

/**
 * Tag (or re-tag) the machine and attachment an entry is being performed on.
 *
 * Re-running the recommendation is deliberately *not* done here. The
 * prescription is frozen at the start of a session on purpose — a target that
 * shifts under the user between sets is worse than one that is slightly stale —
 * and the workout screen surfaces the re-anchored suggestion as a prompt rather
 * than silently rewriting the card.
 *
 * @param {object|null} context  { machineId, label, attachment, note }
 */
export async function setEntryContext(sessionId, exerciseId, context) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    context: context === null ? null : {
      machineId: slug(context.machineId ?? context.label),
      label: String(context.label ?? '').slice(0, 60).trim() || null,
      attachment: String(context.attachment ?? '').slice(0, 60).trim() || null,
      note: String(context.note ?? '').slice(0, 200).trim() || null,
    },
  }));
}

export async function clearEntryContext(sessionId, exerciseId) {
  return setEntryContext(sessionId, exerciseId, null);
}

/**
 * Machine tags this exercise has actually been logged against, newest first.
 *
 * Derived from the log rather than kept in a registry: the list of machines in
 * one gym is exactly the list of machines that appear in the history, and a
 * separate table of them would be one more thing to keep in step.
 */
export function getKnownContexts(exerciseId) {
  const seen = new Map();

  for (const session of getCompletedSessions()) {
    for (const entry of session.entries) {
      if (entry.exerciseId !== exerciseId && entry.substitution?.performedId !== exerciseId) continue;
      const context = entry.context;
      if (!context) continue;
      const key = contextKey({ context });
      if (seen.has(key)) continue;
      seen.set(key, { ...context, key, lastUsed: session.date });
    }
  }

  return [...seen.values()];
}

/* --- Substitution ------------------------------------------------------
   Performing a different movement in a planned slot. The slot keeps its
   adherence — this is a completed exercise, not a skipped one — and the
   performed movement keeps its own load series, because a rope and a bar on
   the same stack are two scales.
   ====================================================================== */

/**
 * Record that `substituteId` was performed in `exerciseId`'s slot.
 *
 * `entry.exerciseId` is left pointing at the planned movement. That is the
 * load-bearing choice: it is what keeps the session's completion, its day, its
 * volume and its adherence attached to the program, and it means dropping the
 * substitution later restores the original reading exactly.
 */
export async function substituteEntry(sessionId, exerciseId, substituteId) {
  const exercise = programService.getExercise(exerciseId);
  const option = programService.getSubstitution(exercise, substituteId);
  if (!option) {
    throw new Error('That is not a substitution this exercise offers.');
  }
  const performed = programService.getExercise(substituteId);

  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    substitution: {
      performedId: substituteId,
      label: option.label ?? performed?.name ?? substituteId,
      comparableLoad: programService.substitutionComparesLoad(option),
      note: option.note ?? null,
      loggedAt: new Date().toISOString(),
    },
  }));
}

export async function clearSubstitution(sessionId, exerciseId) {
  return patchEntry(sessionId, exerciseId, (entry) => ({ ...entry, substitution: null }));
}

/**
 * The movement an entry actually trained, which is the substitute where there
 * is one and the planned exercise otherwise. Every read path that wants to know
 * "what was this set *of*" goes through here.
 */
export function performedExercise(entry) {
  const id = entry?.substitution?.performedId ?? entry?.exerciseId;
  return programService.getExercise(id) ?? null;
}

/* --- Top sets -----------------------------------------------------------
   A heavier single taken above the working load. Real training, on the
   record, in the heaviest-weight PR — and kept out of the load the next
   session is built from, because it is a probe rather than a load you repeat.
   ====================================================================== */

/**
 * Mark or unmark one working set as a heavier top set.
 *
 * Toggling this does not move the set, change its load or its reps, or
 * reorder anything: it changes one label, and what that label changes is
 * whether `progression.repeatableLoad` counts the set when deciding what to
 * prescribe next time.
 */
export async function setTopSet(sessionId, exerciseId, setIndex, isTop) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    sets: entry.sets.map((set, index) =>
      (index === setIndex
        ? { ...set, kind: isTop ? SET_KIND.TOP : SET_KIND.WORKING }
        : set)),
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

  const completedAt = session.editingCompletedAt ?? new Date().toISOString();
  const durationSeconds = session.editingCompletedAt ? (session.durationSeconds ?? null) : session.startedAt
    ? Math.max(0, Math.round((new Date(completedAt) - new Date(session.startedAt)) / 1000))
    : null;

  const updated = await db.replaceById(COLLECTIONS.SESSIONS, sessionId, {
    status: 'completed',
    completedAt,
    editingCompletedAt: null,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds <= 6 * 3600 ? durationSeconds : null,
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

/**
 * Re-open a completed session for editing.
 *
 * Kept as an explicit action rather than allowing edits in place: a completed
 * session is what the PR engine and the reports are computed from, so
 * changing it should be a decision, not a slip of the thumb.
 */
export async function reopenSession(sessionId) {
  const open = getActiveSession();
  if (open && open.id !== sessionId) {
    throw new Error('Finish or discard the workout in progress first.');
  }
  const session = getSessionById(sessionId);
  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, {
    status: 'in-progress',
    editingCompletedAt: session.editingCompletedAt ?? session.completedAt,
    completedAt: null,
  });
}

/** Add an extra set to an entry — for the days where one more feels right. */
export async function addSet(sessionId, exerciseId) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');

  const entries = session.entries.map((entry) => {
    if (entry.exerciseId !== exerciseId) return entry;
    const last = [...entry.sets].reverse().find((set) => set.kind !== SET_KIND.TOP)
      ?? entry.sets[entry.sets.length - 1];
    return {
      ...entry,
      sets: [...entry.sets, {
        // Carry the last *working* set's load forward; a new set is almost
        // never a different weight, and an empty field is one more thing to
        // type. A top set is not the load to inherit — it was a probe.
        weightKg: last?.weightKg ?? entry.targetWeightKg ?? null,
        reps: last?.reps ?? null,
        completed: false,
        rpe: null,
        kind: SET_KIND.WORKING,
      }],
    };
  });

  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, { entries });
}

/** Remove a set from an entry. The prescribed sets cannot all be removed. */
export async function removeSet(sessionId, exerciseId, setIndex) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');

  const entries = session.entries.map((entry) => {
    if (entry.exerciseId !== exerciseId) return entry;
    if (entry.sets.length <= 1) return entry;
    return { ...entry, sets: entry.sets.filter((_, index) => index !== setIndex) };
  });

  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, { entries });
}

/* --- Warm-up sets -------------------------------------------------------
   Ramp-up work. Visible in history, excluded from progression, volume and
   completion. Available on any exercise, whether or not the program prescribes
   a ramp for it — the brief asks that the user be able to add one anywhere.
   ====================================================================== */

/** Read-modify-write one entry of a session. */
async function patchEntry(sessionId, exerciseId, mutator) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');

  let touched = false;
  const entries = session.entries.map((raw) => {
    if (raw.exerciseId !== exerciseId) return raw;
    touched = true;
    // `normalizeEntry` preserves `setModel`, so adding a warm-up set to a legacy
    // entry does not promote it to 'v2'. That is deliberate: the new warm-up row
    // is classified, but the sets logged before the upgrade still are not, and
    // claiming otherwise would retroactively invent a classification nobody
    // made. Only `reclassifyLegacySets` promotes an entry, because only there
    // has the user actually said what those sets were.
    return mutator(normalizeEntry(raw));
  });

  if (!touched) throw new Error('That exercise is not part of this session.');
  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, { entries });
}

/** Add one warm-up row, carrying the previous row's load forward. */
export async function addWarmupSet(sessionId, exerciseId) {
  return patchEntry(sessionId, exerciseId, (entry) => {
    const previous = entry.warmupSets[entry.warmupSets.length - 1];
    return {
      ...entry,
      warmupSets: [...entry.warmupSets, {
        weightKg: previous?.weightKg ?? null,
        reps: previous?.reps ?? null,
        completed: false,
        kind: SET_KIND.WARMUP,
      }],
    };
  });
}

export async function updateWarmupSet(sessionId, exerciseId, index, patch) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    warmupSets: entry.warmupSets.map((set, i) =>
      (i === index ? { ...set, ...patch, kind: SET_KIND.WARMUP } : set)),
  }));
}

export async function removeWarmupSet(sessionId, exerciseId, index) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    warmupSets: entry.warmupSets.filter((_, i) => i !== index),
  }));
}

/**
 * Fill the ramp rows from the entry's working weight.
 *
 * Offered as an explicit action rather than done silently on every load change:
 * once the user has typed a ramp load, overwriting it because they nudged the
 * working weight would be the app arguing with them.
 */
export async function suggestWarmup(sessionId, exerciseId) {
  const exercise = programService.getExercise(exerciseId);
  return patchEntry(sessionId, exerciseId, (entry) => {
    const count = Math.max(
      1,
      entry.warmupSets.length || trainingPrefs.warmupSetCount(
        exercise ? programService.rampSetCount(exercise) : 3
      )
    );
    const top = entry.targetWeightKg
      ?? entry.sets.find((set) => set.weightKg)?.weightKg
      ?? null;
    const rungs = buildRampSets(top, count, 2.5);
    if (!rungs.length) return entry;

    return {
      ...entry,
      warmupSets: rungs.map((rung, index) => ({
        ...(entry.warmupSets[index] ?? {}),
        weightKg: rung.weightKg,
        reps: rung.reps,
        completed: entry.warmupSets[index]?.completed ?? false,
        kind: SET_KIND.WARMUP,
      })),
    };
  });
}

/**
 * Reclassify the sets of a legacy entry, by hand.
 *
 * The migration refuses to guess which of week one's rising-weight sets were
 * ramps, because a ramp and a pyramid and working up to a top set all look
 * identical in the data. This is how the user tells it — one decision per set,
 * made deliberately, never inferred.
 *
 * @param {Array<'warmup'|'working'|'top'|'drop'>} kinds  one per set, in order
 */
export async function reclassifyLegacySets(sessionId, exerciseId, kinds) {
  return patchEntry(sessionId, exerciseId, (entry) => {
    const existing = workingSets(entry);
    if (!existing.length) return entry;

    const working = [];
    const warmup = [...warmupSets(entry)];
    const dropped = [];

    existing.forEach((set, index) => {
      const kind = kinds[index] ?? SET_KIND.WORKING;
      if (kind === SET_KIND.WARMUP) {
        warmup.push({ ...set, kind: SET_KIND.WARMUP });
      } else if (kind === SET_KIND.DROP) {
        dropped.push({ ...set, kind: SET_KIND.DROP, toFailure: false });
      } else if (kind === SET_KIND.TOP) {
        // Stays in `sets`, in place: a top set is a working set that happened
        // to be heavier, and moving it would rewrite the order it was done in.
        working.push({ ...set, kind: SET_KIND.TOP });
      } else {
        working.push({ ...set, kind: SET_KIND.WORKING });
      }
    });

    const intensitySets = [...intensitySequences(entry)];
    if (dropped.length) {
      intensitySets.push({
        id: db.newId(),
        type: INTENSITY_TYPE.DROP,
        note: 'Reclassified from an unclassified session',
        stages: dropped,
      });
    }

    return {
      ...entry,
      // Now classified, so it stops being reported as unclassified. The values
      // themselves have not changed — only the label on each one.
      setModel: 'v2',
      sets: working,
      warmupSets: warmup,
      intensitySets,
    };
  });
}

/* --- Intensity techniques ----------------------------------------------
   Drop sets and failure sets. Entirely optional, chosen session by session,
   and structurally incapable of moving a prescribed weight: they live outside
   `entry.sets`, which is the only array the progression engine ever sees.
   ====================================================================== */

/**
 * Attach a drop-set sequence, seeded from the heaviest completed working set.
 *
 * The stages are a starting point only — what is on the rack decides a drop set
 * more than arithmetic does — so every rung is editable and the reps start
 * empty rather than pretending to know how many will come out.
 */
export async function addDropSet(sessionId, exerciseId, { stages = 3 } = {}) {
  return patchEntry(sessionId, exerciseId, (entry) => {
    const heaviest = completedWorkingSets(entry)
      .reduce((top, set) => Math.max(top, set.weightKg ?? 0), 0);

    const seeded = Array.from({ length: stages }, (_, index) => ({
      weightKg: heaviest ? round2(heaviest * (1 - index * 0.2)) : null,
      reps: null,
      completed: false,
      toFailure: index === 0,
      kind: SET_KIND.DROP,
    }));

    return {
      ...entry,
      intensitySets: [...entry.intensitySets, {
        id: db.newId(),
        type: INTENSITY_TYPE.DROP,
        note: '',
        stages: seeded,
      }],
    };
  });
}

/** Attach a single to-failure set. */
export async function addFailureSet(sessionId, exerciseId) {
  return patchEntry(sessionId, exerciseId, (entry) => {
    const heaviest = completedWorkingSets(entry)
      .reduce((top, set) => Math.max(top, set.weightKg ?? 0), 0);

    return {
      ...entry,
      intensitySets: [...entry.intensitySets, {
        id: db.newId(),
        type: INTENSITY_TYPE.FAILURE,
        note: '',
        stages: [{
          weightKg: heaviest || null,
          reps: null,
          completed: false,
          toFailure: true,
          kind: SET_KIND.FAILURE,
        }],
      }],
    };
  });
}

/** Add another rung to an existing drop-set sequence. */
export async function addDropStage(sessionId, exerciseId, sequenceId) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    intensitySets: entry.intensitySets.map((sequence) => {
      if (sequence.id !== sequenceId) return sequence;
      const previous = sequence.stages[sequence.stages.length - 1];
      return {
        ...sequence,
        stages: [...sequence.stages, {
          weightKg: previous?.weightKg ? round2(previous.weightKg * 0.8) : null,
          reps: null,
          completed: false,
          toFailure: false,
          kind: SET_KIND.DROP,
        }],
      };
    }),
  }));
}

export async function updateIntensityStage(sessionId, exerciseId, sequenceId, stageIndex, patch) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    intensitySets: entry.intensitySets.map((sequence) => {
      if (sequence.id !== sequenceId) return sequence;
      return {
        ...sequence,
        stages: sequence.stages.map((stage, index) =>
          (index === stageIndex ? { ...stage, ...patch } : stage)),
      };
    }),
  }));
}

export async function updateIntensitySequence(sessionId, exerciseId, sequenceId, patch) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    intensitySets: entry.intensitySets.map((sequence) =>
      (sequence.id === sequenceId ? { ...sequence, ...patch } : sequence)),
  }));
}

export async function removeIntensitySequence(sessionId, exerciseId, sequenceId) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    intensitySets: entry.intensitySets.filter((sequence) => sequence.id !== sequenceId),
  }));
}

export async function removeDropStage(sessionId, exerciseId, sequenceId, stageIndex) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    intensitySets: entry.intensitySets.map((sequence) => {
      if (sequence.id !== sequenceId) return sequence;
      if (sequence.stages.length <= 1) return sequence;
      return { ...sequence, stages: sequence.stages.filter((_, i) => i !== stageIndex) };
    }),
  }));
}

/* --- Pain and discomfort -----------------------------------------------
   Informational, never diagnostic. Logging pain changes what the engine is
   willing to conclude from a session; it does not change the session.
   ====================================================================== */

/**
 * Record discomfort on one exercise.
 *
 * @param {object} pain
 * @param {number} [pain.score]           0-10, the user's own reading
 * @param {string} [pain.location]        free text
 * @param {string} [pain.note]            free text
 * @param {string} [pain.action]          see PAIN_ACTION
 * @param {string} [pain.alternativeId]   substitution the user chose, if any
 */
export async function setPain(sessionId, exerciseId, pain) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    pain: pain === null ? null : {
      score: clampScore(pain.score),
      location: String(pain.location ?? '').slice(0, 120),
      note: String(pain.note ?? '').slice(0, 500),
      action: Object.values(PAIN_ACTION).includes(pain.action)
        ? pain.action
        : PAIN_ACTION.COMPLETED,
      alternativeId: pain.alternativeId ?? null,
      loggedAt: new Date().toISOString(),
    },
  }));
}

export async function clearPain(sessionId, exerciseId) {
  return patchEntry(sessionId, exerciseId, (entry) => ({ ...entry, pain: null }));
}

/** Record which difficulty rung a difficulty-first movement was worked at. */
export async function setDifficulty(sessionId, exerciseId, difficulty) {
  return patchEntry(sessionId, exerciseId, (entry) => ({
    ...entry,
    difficulty: difficulty || null,
  }));
}

/** Every pain log in a session, for the summary and the report. */
export function getPainLogs(session) {
  return (session?.entries ?? [])
    .filter((entry) => entry.pain)
    .map((entry) => ({
      exerciseId: entry.exerciseId,
      exerciseName: programService.getExercise(entry.exerciseId)?.name ?? entry.exerciseId,
      ...entry.pain,
    }));
}

/** Pain logs across a date range, newest first — the report's pain section. */
export function getPainLogsBetween(startKey, endKey) {
  const out = [];
  for (const session of getCompletedSessions()) {
    if (session.date < startKey || session.date > endKey) continue;
    for (const log of getPainLogs(session)) {
      out.push({ date: session.date, sessionId: session.id, ...log });
    }
  }
  return out;
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.min(10, Math.max(0, Math.round(score)));
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * A stable comparison id for a free-typed machine label.
 *
 * The label is what the user reads and may re-type slightly differently; the
 * slug is what the app compares. "Stack A", "stack a" and "Stack  A" are one
 * machine, which is the whole reason the two are stored separately.
 */
function slug(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

/**
 * A summary of a finished session: what was done, what it earned, and which
 * lifts now advance. This is what the completion sheet shows, and what the
 * two-week review will quote.
 */
export function getSessionSummary(sessionId) {
  const session = getSessionById(sessionId);
  if (!session) return null;

  const day = programService.getDayById(session.dayId);
  const completion = getSessionCompletion(session);
  const advancing = [];
  const held = [];
  const painLimited = [];
  const maintained = [];
  const substitutions = [];
  let warmupSetCount = 0;
  let topSetCount = 0;
  let dropSequences = 0;
  let failureSets = 0;

  for (const raw of session.entries) {
    const exercise = programService.getExercise(raw.exerciseId);
    if (!exercise) continue;
    const entry = normalizeEntry(raw);

    const counts = composition(entry);
    warmupSetCount += counts.warmupDone;
    topSetCount += counts.topDone;
    dropSequences += counts.dropSequences;
    failureSets += counts.failureSets;

    if (entry.substitution) {
      substitutions.push({
        exerciseId: entry.exerciseId,
        plannedName: exercise.name,
        performedName: entry.substitution.label
          ?? performedExercise(entry)?.name
          ?? entry.substitution.performedId,
        comparableLoad: entry.substitution.comparableLoad === true,
      });
    }

    const done = workingSets(entry).filter((set) => set.completed);
    if (!done.length) {
      // Nothing prescribed was completed. If discomfort was logged that is the
      // headline, not an omission — it belongs in the summary rather than
      // vanishing from it.
      if (isPainLimited(entry)) {
        painLimited.push({
          exerciseId: entry.exerciseId,
          name: exercise.name,
          sets: 0,
          pain: entry.pain,
        });
      }
      continue;
    }

    const repeatable = repeatableSets(entry).filter((set) => set.completed && (set.reps ?? 0) > 0);
    const record = {
      exerciseId: entry.exerciseId,
      name: exercise.name,
      performedName: entry.substitution
        ? (entry.substitution.label ?? performedExercise(entry)?.name ?? null)
        : null,
      sets: done.length,
      topWeightKg: Math.max(...done.map((set) => set.weightKg ?? 0)),
      // The load the next session will actually be built on, so the summary
      // agrees with the card the user sees next week.
      workingWeightKg: repeatable.length
        ? Math.max(...repeatable.map((set) => set.weightKg ?? 0))
        : null,
      topSets: counts.topDone,
      reps: done.map((set) => set.reps ?? 0),
      pain: entry.pain ?? null,
    };

    // Four outcomes, not two. A pain-limited exercise filed under "held" would
    // read as a stall, and a maintained movement filed there would read as one
    // that failed to progress — when not progressing is the prescription.
    if (isPainLimited(entry)) painLimited.push(record);
    else if (programService.isMaintained(exercise)) maintained.push(record);
    else if (earnedAdvance(exercise, workingSets(entry))) advancing.push(record);
    else held.push(record);
  }

  const volume = getSessionVolumeBreakdown(session);

  return {
    session,
    dayLabel: day?.label ?? session.dayId,
    schedule: getSchedule(session),
    completion,
    volumeKg: volume.workingKg,
    volume,
    warmupSetCount,
    topSetCount,
    dropSequences,
    failureSets,
    substitutions,
    painLogs: getPainLogs(session),
    durationSeconds: session.durationSeconds,
    exercisesDone: advancing.length + held.length + painLimited.length + maintained.length,
    advancing,
    held,
    maintained,
    painLimited,
  };
}

/**
 * Whether every prescribed working set in a session has been ticked.
 *
 * Entries with no working sets are skipped rather than counted as incomplete:
 * an optional pre-workout warm-up has nothing to tick, and letting it hold the
 * session open forever would mean the finish button never lights up on chest
 * day.
 */
export function isSessionComplete(session) {
  const prescribed = session.entries.filter((entry) => workingSets(entry).length > 0);
  return prescribed.length > 0 && prescribed.every(isEntryComplete);
}

/* --- Derived statistics ------------------------------------------------- */

/**
 * How much of a session was completed, as **working** sets done over working
 * sets prescribed.
 *
 * Warm-up rows and intensity work are excluded from both sides. Ticking three
 * ramp sets must not read as 30% of the session done, and adding a drop set
 * must not push a finished session below 100%.
 */
export function getSessionCompletion(session) {
  let done = 0;
  let total = 0;
  for (const entry of session.entries) {
    const sets = workingSets(entry);
    total += sets.length;
    done += sets.filter((set) => set.completed).length;
  }
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Working-set volume for a session, in kg-reps.
 *
 * This is the headline volume figure everywhere in the app, and it counts
 * working sets only. Ramp-up and intensity work are reported separately by
 * `getSessionVolumeBreakdown` — see `engine/set-model.js` for why they are never
 * summed into one number.
 *
 * Every loading convention now counts its stored load once. An earlier build
 * doubled dumbbell volume on the assumption that the logged figure was per
 * hand; under the convention actually used — both dumbbells summed — that
 * counted every dumbbell set twice. Bodyweight movements still count only the
 * *added* load, because body weight is tracked separately and would otherwise
 * swamp the trend every time the user gained a kilo.
 */
export function getSessionVolume(session) {
  return getSessionVolumeBreakdown(session).workingKg;
}

/**
 * Volume split by the kind of work that produced it.
 * @returns {{workingKg: number, warmupKg: number, intensityKg: number}}
 */
export function getSessionVolumeBreakdown(session) {
  const total = { workingKg: 0, warmupKg: 0, intensityKg: 0 };
  const countWarmupMovements = trainingPrefs.getPrefs().pushupsCountAsVolume === true;

  for (const raw of session.entries ?? []) {
    const exercise = programService.getExercise(raw.exerciseId);
    const entry = normalizeEntry(raw);
    const part = entryVolume(entry, volumeMultiplier(exercise));

    // A pre-workout warm-up movement is logged as reps, not as load. By default
    // it contributes to neither figure: pushing bodyweight push-ups into chest
    // volume is exactly what the preference forbids. Turning the preference on
    // folds them into working volume, which is what "counts as working volume"
    // has to mean if it is to mean anything.
    if (programService.isWarmupOnly(exercise)) {
      if (countWarmupMovements) total.workingKg += part.workingKg + part.warmupKg;
      continue;
    }

    total.workingKg += part.workingKg;
    total.warmupKg += part.warmupKg;
    total.intensityKg += part.intensityKg;
  }

  return total;
}

/** Set counts for a session, split by kind — the report's set-type table. */
export function getSessionSetCounts(session) {
  const counts = {
    working: 0, workingDone: 0, top: 0, topDone: 0, legacy: 0, legacyDone: 0,
    warmup: 0, warmupDone: 0, dropSequences: 0, dropStages: 0, failureSets: 0,
  };

  for (const entry of session.entries ?? []) {
    const part = composition(normalizeEntry(entry));
    for (const key of Object.keys(counts)) counts[key] += part[key] ?? 0;
  }

  return counts;
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

  const { done, scheduled: total, outstanding } = programService.getScheduleCompletion(monday, dayKey);

  const offSchedule = getCompletedSessions()
    .filter((session) => session.date >= monday && session.date <= dayKey)
    .filter(isOffSchedule).length;

  return {
    done,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
    weekStart: monday,
    scheduledThisWeek: programService.getTrainingDays().length,
    outstanding,
    // Sessions done this week on a day other than their own. Reported, never
    // penalised: the split is rolling by design.
    offSchedule,
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
  if (weekday < 7) cursor = addDays(cursor, -7);

  for (let i = 0; i < 260; i += 1) {   // hard stop at five years
    const weekEnd = addDays(cursor, 6);
    const completion = programService.getScheduleCompletion(cursor, weekEnd);
    if (!completion.scheduled || completion.done !== completion.scheduled) break;
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

export async function setSessionIntensity(sessionId, isDeload) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');
  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, {
    originalIsDeload: session.originalIsDeload ?? session.isDeload,
    originalIntensityMetadata: session.originalIntensityMetadata ?? {
      isDeload: session.isDeload, plannedDeload: session.plannedDeload,
      scheduledDeload: session.scheduledDeload, actualDeload: session.actualDeload,
      updatedAt: session.updatedAt,
    },
    plannedDeload: session.plannedDeload ?? session.isDeload,
    actualDeload: isDeload,
    isDeload, scheduledDeload: session.scheduledDeload ?? session.isDeload,
  });
}

/** Wall-clock logs left open overnight are not credible training durations. */
export function getDurationSeconds(session) {
  const value = session?.durationSeconds;
  return Number.isFinite(value) && value > 0 && value <= 6 * 3600 ? value : null;
}

/** Explicitly reviewed corrections only; never run on import or startup. */
export function getOctoberDeloadCorrections() {
  return getCompletedSessions().flatMap((session) => {
    if (session.date >= '2026-10-10' && session.date <= '2026-10-12') return [{ session, isDeload: false }];
    if ((session.date === '2026-10-13' && session.dayId === 'tuesday-chest')
      || (session.date === '2026-10-15' && session.dayId === 'wednesday-back-biceps')) return [{ session, isDeload: true }];
    return [];
  });
}

/** Refresh only a pristine open workout. Never replace performed work. */
export async function refreshUnloggedPrescription(sessionId) {
  const session = getSessionById(sessionId);
  if (!session || session.status !== 'in-progress' || session.editingCompletedAt
    || getSessionCompletion(session).done > 0) throw new Error('Logged workouts keep their original prescription.');
  const wave = programService.getTrainingWeek(session.date);
  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, {
    plannedDeload: wave.isDeload, isDeload: wave.isDeload, actualDeload: null,
    entries: session.entries.map((entry) => {
      const exercise = programService.getExercise(entry.substitution?.performedId ?? entry.exerciseId);
      if (!exercise || programService.isWarmupOnly(exercise)) return entry;
      const plan = getRecommendation(exercise, session.date, { context: entry.context });
      return { ...entry, targetWeightKg: plan.weightKg, targetReps: plan.perSetReps,
        plannedAction: plan.action, planReason: plan.reason,
        sets: plan.perSetReps.map((reps, index) => ({ weightKg: plan.perSetWeights?.[index] ?? plan.weightKg,
          reps, completed: false, rpe: null, kind: SET_KIND.WORKING })) };
    }),
  });
}
