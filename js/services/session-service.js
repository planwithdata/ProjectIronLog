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
 *       setModel: 'v2' | 'legacy',
 *       sets: [{ weightKg, reps, completed, rpe, kind }],   // WORKING SETS
 *       warmupSets: [{ weightKg, reps, completed, kind }],  // ramp-up work
 *       intensitySets: [{ id, type, stages: [...] }],       // drop / failure
 *       pain: null | { score, location, note, action, alternativeId },
 *       difficulty: null | string,
 *       notes,
 *     }],
 *   }
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
import { EVENTS, emit } from '../core/events.js';
import { today, isoWeekday, addDays, daysBetween } from '../core/format.js';
import * as programService from './program-service.js';
import * as settingsService from './settings-service.js';
import * as trainingPrefs from './training-prefs-service.js';
import { recommend, isEntryComplete, earnedAdvance } from '../engine/progression.js';
import { volumeMultiplier } from '../engine/loading.js';
import {
  SET_KIND, INTENSITY_TYPE, PAIN_ACTION,
  normalizeEntry, workingSets, completedWorkingSets, warmupSets,
  completedWarmupSets, intensitySequences, completedIntensityStages,
  isLegacyEntry, isPainLimited, composition, entryVolume, rampSets as buildRampSets,
} from '../engine/set-model.js';

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
    const raw = session.entries.find((item) => item.exerciseId === exerciseId);
    if (!raw) continue;
    const entry = normalizeEntry(raw);

    const done = workingSets(entry).filter((set) => set.completed);
    const warmups = completedWarmupSets(entry);
    const intensity = intensitySequences(entry);

    // An entry with no working sets is still worth reporting when it holds
    // warm-up work, intensity work or a pain log — "I tried and stopped" is
    // information. It is skipped only when there is genuinely nothing in it.
    if (!done.length && !warmups.length && !intensity.length && !entry.pain) continue;

    history.push({
      sessionId: session.id,
      date: session.date,
      week: session.week,
      isDeload: session.isDeload,
      targetWeightKg: entry.targetWeightKg ?? null,
      sets: done,
      warmupSets: warmups,
      intensitySets: intensity,
      pain: entry.pain ?? null,
      painLimited: isPainLimited(entry),
      incomplete: prescribed > 0 && done.length < prescribed,
      difficulty: entry.difficulty ?? null,
      legacy: isLegacyEntry(entry),
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
    entries: day.exercises
      // The pre-workout warm-up is a preference, so an entry for it is only
      // created when it is switched on. Turning it off later leaves the
      // sessions that already logged it untouched.
      .filter((exercise) =>
        !programService.isWarmupOnly(exercise) || trainingPrefs.pushupWarmupEnabled())
      .map((exercise) => buildEntry(exercise, wave)),
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
function buildEntry(exercise, wave) {
  const history = getExerciseHistory(exercise.id, 6);
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
      notes: '',
    };
  }

  const setCount = wave.isDeload
    ? programService.deloadSets(exercise.sets)
    : exercise.sets;

  const plan = recommend(exercise, history, {
    isDeload: wave.isDeload,
    setCount,
    loadPrefs,
  });

  return {
    exerciseId: exercise.id,
    targetWeightKg: plan.weightKg,
    targetReps: plan.perSetReps,
    plannedAction: plan.action,
    planReason: plan.reason,
    setModel: 'v2',
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
export function getRecommendation(exercise, dayKey = today()) {
  const wave = programService.getTrainingWeek(dayKey);
  const setCount = wave.isDeload
    ? programService.deloadSets(exercise.sets)
    : exercise.sets;
  return recommend(exercise, getExerciseHistory(exercise.id, 6), {
    isDeload: wave.isDeload,
    setCount,
    loadPrefs: trainingPrefs.getLoadPrefs(),
  });
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
  return db.replaceById(COLLECTIONS.SESSIONS, sessionId, {
    status: 'in-progress',
    completedAt: null,
  });
}

/** Add an extra set to an entry — for the days where one more feels right. */
export async function addSet(sessionId, exerciseId) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('That session no longer exists.');

  const entries = session.entries.map((entry) => {
    if (entry.exerciseId !== exerciseId) return entry;
    const last = entry.sets[entry.sets.length - 1];
    return {
      ...entry,
      sets: [...entry.sets, {
        // Carry the last set's load forward; a new set is almost never a
        // different weight, and an empty field is one more thing to type.
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
 * @param {Array<'warmup'|'working'|'drop'>} kinds  one per existing set, in order
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
  let warmupSetCount = 0;
  let dropSequences = 0;
  let failureSets = 0;

  for (const raw of session.entries) {
    const exercise = programService.getExercise(raw.exerciseId);
    if (!exercise) continue;
    const entry = normalizeEntry(raw);

    const counts = composition(entry);
    warmupSetCount += counts.warmupDone;
    dropSequences += counts.dropSequences;
    failureSets += counts.failureSets;

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

    const record = {
      exerciseId: entry.exerciseId,
      name: exercise.name,
      sets: done.length,
      topWeightKg: Math.max(...done.map((set) => set.weightKg ?? 0)),
      reps: done.map((set) => set.reps ?? 0),
      pain: entry.pain ?? null,
    };

    // A pain-limited exercise is reported as its own outcome. Filing it under
    // "held" would read as a stall, which is precisely the wrong conclusion.
    if (isPainLimited(entry)) painLimited.push(record);
    else if (earnedAdvance(exercise, workingSets(entry))) advancing.push(record);
    else held.push(record);
  }

  const volume = getSessionVolumeBreakdown(session);

  return {
    session,
    dayLabel: day?.label ?? session.dayId,
    completion,
    volumeKg: volume.workingKg,
    volume,
    warmupSetCount,
    dropSequences,
    failureSets,
    painLogs: getPainLogs(session),
    durationSeconds: session.durationSeconds,
    exercisesDone: advancing.length + held.length + painLimited.length,
    advancing,
    held,
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
    working: 0, workingDone: 0, legacy: 0, legacyDone: 0,
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
