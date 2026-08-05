/**
 * progression.js — The double progression engine.
 *
 * This module is deliberately **pure**: it imports nothing, touches no
 * storage, and reads no globals. Everything it needs arrives as arguments and
 * everything it decides comes back as a return value. That is what makes it
 * testable outside a browser (`node tools/test.mjs`) — and this is the one
 * part of the app where a silent mistake would quietly wreck years of
 * training, so it needs to be tested rather than eyeballed.
 *
 * The rules it implements, verbatim from the program:
 *
 *   1. Pick a starting weight where the last 1-2 reps of the first set feel
 *      genuinely hard, with good form on every rep.
 *   2. Each session, add one rep to any set below the top of its rep range,
 *      keeping the same weight.
 *   3. Once ALL working sets reach the top of the rep range, add that
 *      exercise's increment and drop back to the bottom of the range.
 *   4. If the top of the range was not reached, repeat the previous weight.
 *      The '+X kg' figures are a ceiling on how much to add, not a
 *      requirement to add it on schedule.
 *   5. Bodyweight moves marked 'add reps first' take no external load until
 *      the top of the range is comfortable.
 *   6. Week 5 is a deload: sets cut ~40%, load at 60-70% of Week 4.
 *   7. A lift stalled for 3 straight sessions drops ~10% and rebuilds.
 *
 * Worked example from the brief, which `tools/test.mjs` asserts directly:
 *
 *   range 6-8, at 27.5 kg, logged 8 / 8 / 7 / 6
 *   -> stay at 27.5 kg, target 8 / 8 / 8 / 7
 */

/** What the engine decided to do. */
export const ACTIONS = {
  START:       'start',        // no history — the user picks the first weight
  HOLD:        'hold',         // same weight, chase reps
  ADVANCE:     'advance',      // top of range on every set — add load
  REPS_FIRST:  'reps-first',   // bodyweight: add reps before any load
  DELOAD_WAVE: 'deload-wave',  // scheduled Week 5 deload
  DELOAD_STALL: 'deload-stall', // stalled 3 sessions — drop and rebuild
};

/** Sessions without improvement before the stall rule fires. */
export const STALL_SESSIONS = 3;

/** Fraction of the working weight kept after a stall. */
export const STALL_RETAIN = 0.9;

/** Mid-point of the program's 60-70% deload band. */
export const DELOAD_LOAD_FACTOR = 0.65;

/**
 * Recommend the next session for one exercise.
 *
 * @param {object} exercise   an entry from workouts.json
 * @param {Array<object>} history
 *        Past performances, **newest first**, each shaped
 *        `{ date, sets: [{ weightKg, reps, completed }], isDeload }`.
 *        This is exactly what session-service.getExerciseHistory returns.
 * @param {object} [options]
 * @param {boolean} [options.isDeload]  true during the wave's deload week
 * @param {number}  [options.setCount]  override the prescribed set count
 *
 * @returns {{
 *   action: string,
 *   weightKg: number|null,
 *   perSetReps: number[],
 *   increment: number,
 *   reason: string,
 *   previous: {weightKg: number|null, reps: number[], date: string}|null,
 *   atTopOfRange: boolean,
 *   stalledSessions: number,
 * }}
 */
export function recommend(exercise, history = [], options = {}) {
  const range = repRange(exercise);
  const setCount = options.setCount ?? exercise.sets;
  const increment = incrementFor(exercise);
  const repsFirst = exercise.progression?.mode === 'reps-first';

  // A pyramid (a different load and rep target per set) is a different shape
  // from the uniform-set default, so it gets its own branch rather than being
  // flattened into a single weight it cannot represent.
  if (Array.isArray(exercise.setPlan) && exercise.setPlan.length) {
    return recommendPyramid(exercise, history, { ...options, setCount, increment, range });
  }

  // Only real, loaded sessions inform a recommendation. A deload week is a
  // deliberate step backwards, so treating it as the new baseline would
  // ratchet the whole program down every fifth week.
  const working = history.filter((entry) => !entry.isDeload && completedSets(entry).length > 0);
  const last = working[0] ?? null;

  /* --- No history: the user chooses ----------------------------------- */
  if (!last) {
    return {
      action: ACTIONS.START,
      weightKg: null,
      perSetReps: fill(setCount, range.min),
      increment,
      reason: repsFirst
        ? `Work in the ${range.label} range with bodyweight. Add load only once the top of the range is comfortable.`
        : 'Pick a weight where the last 1-2 reps of the first set are genuinely hard, with good form.',
      previous: null,
      atTopOfRange: false,
      stalledSessions: 0,
    };
  }

  const lastWeight = workingWeight(last);
  const lastReps = completedSets(last).map((set) => set.reps ?? 0);
  const previous = { weightKg: lastWeight, reps: lastReps, date: last.date };

  // "All working sets at the top of the range" is judged against the sets
  // actually prescribed. Hitting the top on three of four sets is a hold.
  const atTop = lastReps.length >= setCount
    && lastReps.slice(0, setCount).every((reps) => reps >= range.max);

  const stalledSessions = countStalledSessions(working, range, setCount);

  /* --- Scheduled deload week ------------------------------------------ */
  if (options.isDeload) {
    return {
      action: ACTIONS.DELOAD_WAVE,
      weightKg: lastWeight === null
        ? null
        : roundTo(lastWeight * DELOAD_LOAD_FACTOR, increment),
      perSetReps: fill(setCount, range.min),
      increment,
      reason: 'Deload week: sets cut and load at roughly 65% of last week. Let the joints catch up.',
      previous,
      atTopOfRange: atTop,
      stalledSessions,
    };
  }

  /* --- Stalled: drop and rebuild -------------------------------------- */
  // Checked before the advance branch: a lift that just hit the top of the
  // range has by definition improved, so `stalledSessions` would be 0 there.
  if (stalledSessions >= STALL_SESSIONS && lastWeight) {
    return {
      action: ACTIONS.DELOAD_STALL,
      weightKg: roundTo(lastWeight * STALL_RETAIN, increment),
      perSetReps: fill(setCount, range.min),
      increment,
      reason: `No progress for ${stalledSessions} sessions. Drop about 10% and rebuild — this is normal, not a failure.`,
      previous,
      atTopOfRange: atTop,
      stalledSessions,
    };
  }

  /* --- Top of range on every set: add load ---------------------------- */
  if (atTop) {
    if (repsFirst && (lastWeight === null || lastWeight === 0)) {
      // Bodyweight lift graduating to added load for the first time.
      return {
        action: ACTIONS.ADVANCE,
        weightKg: increment,
        perSetReps: fill(setCount, range.min),
        increment,
        reason: `Top of the range on every set at bodyweight. Add ${trim(increment)} kg with a belt or vest and drop back to ${range.min} reps.`,
        previous,
        atTopOfRange: true,
        stalledSessions,
      };
    }

    return {
      action: ACTIONS.ADVANCE,
      weightKg: (lastWeight ?? 0) + increment,
      perSetReps: fill(setCount, range.min),
      increment,
      reason: `Top of the range on every set. Add ${trim(increment)} kg and drop back to ${range.min} reps.`,
      previous,
      atTopOfRange: true,
      stalledSessions,
    };
  }

  /* --- Hold the weight, chase reps ------------------------------------ */
  return {
    action: repsFirst ? ACTIONS.REPS_FIRST : ACTIONS.HOLD,
    weightKg: lastWeight,
    perSetReps: nextRepTargets(lastReps, setCount, range),
    increment,
    reason: repsFirst
      ? `Add a rep to any set below ${range.max}. No added load until every set hits ${range.max}.`
      : `Stay at ${lastWeight === null ? 'the same weight' : `${trim(lastWeight)} kg`} and add a rep to any set below ${range.max}.`,
    previous,
    atTopOfRange: false,
    stalledSessions,
  };
}

/* --- Pyramid sets -------------------------------------------------------
   Some prescriptions ramp the load across sets — 10/15/20 kg for 12/10/8 reps.
   Double progression still applies, just per rung: each set has its own load
   and its own rep target, and the whole ladder moves up only once every rung
   has been earned. Flattening this into one weight and one range would lose
   the prescription entirely.
   ====================================================================== */

function recommendPyramid(exercise, history, { isDeload, setCount, increment, range }) {
  const plan = exercise.setPlan.slice(0, setCount);
  const planWeights = plan.map((step) => step.weightKg ?? null);
  const planReps = plan.map((step) => step.reps ?? range.min);

  const working = history.filter((entry) => !entry.isDeload && completedSets(entry).length > 0);
  const last = working[0] ?? null;

  const base = {
    increment,
    perSetReps: planReps,
    perSetWeights: planWeights,
    isPyramid: true,
    atTopOfRange: false,
    stalledSessions: 0,
  };

  if (!last) {
    return {
      ...base,
      action: ACTIONS.START,
      // The heaviest rung is the headline figure the card shows.
      weightKg: maxOrNull(planWeights),
      reason: `Ramp the load: ${describePyramid(plan)}. Adjust any rung whose last rep is not genuinely hard.`,
      previous: null,
    };
  }

  const lastSets = completedSets(last);
  const lastReps = lastSets.map((set) => set.reps ?? 0);
  const lastWeights = lastSets.map((set) => set.weightKg ?? null);
  const previous = { weightKg: workingWeight(last), reps: lastReps, date: last.date };

  if (isDeload) {
    return {
      ...base,
      action: ACTIONS.DELOAD_WAVE,
      weightKg: maxOrNull(lastWeights),
      perSetWeights: lastWeights
        .slice(0, setCount)
        .map((weight) => (weight === null ? null : roundTo(weight * DELOAD_LOAD_FACTOR, increment))),
      reason: 'Deload week: same ladder at roughly 65% of last week, with sets cut.',
      previous,
    };
  }

  // Earned only when every rung met its own rep target.
  const earned = lastReps.length >= setCount
    && planReps.every((target, index) => (lastReps[index] ?? 0) >= target);

  // Progress from what was actually lifted, not from the original plan — the
  // ladder has moved up if previous sessions advanced it.
  const currentWeights = planWeights.map((planned, index) => {
    const logged = lastWeights[index];
    return logged === null || logged === undefined ? planned : logged;
  });

  if (earned) {
    return {
      ...base,
      action: ACTIONS.ADVANCE,
      perSetWeights: currentWeights.map((weight) =>
        (weight === null ? null : round2(weight + increment))),
      weightKg: maxOrNull(currentWeights.map((w) => (w === null ? null : w + increment))),
      reason: `Every rung hit its target. Add ${trim(increment)} kg to each set.`,
      previous,
      atTopOfRange: true,
    };
  }

  return {
    ...base,
    action: ACTIONS.HOLD,
    perSetWeights: currentWeights,
    weightKg: maxOrNull(currentWeights),
    // Chase the per-rung target rather than a shared range top. Deliberately
    // no shared minimum floor: on this ladder `reps.min` is 8, which is the
    // *top* rung's target, so clamping to it would jump a 6 straight to 8 and
    // skip the rep that was actually being earned.
    perSetReps: planReps.map((target, index) => {
      const done = lastReps[index] ?? 0;
      // A skipped set has nothing to add a rep to; re-prescribe its target.
      if (done <= 0) return target;
      return Math.min(done + 1, target);
    }),
    reason: `Hold the ladder and add a rep to any set below its target (${planReps.join('/')}).`,
    previous,
  };
}

/** "10 kg x 12, 15 kg x 10, 20 kg x 8" */
function describePyramid(plan) {
  return plan
    .map((step) => `${trim(step.weightKg ?? 0)} kg x ${step.reps}`)
    .join(', ');
}

function maxOrNull(values) {
  const numbers = values.filter((value) => value !== null && value !== undefined);
  return numbers.length ? Math.max(...numbers) : null;
}

/**
 * Per-set rep targets for a hold: add one rep to every set that is below the
 * top of the range, and leave the sets already there alone.
 *
 *   [8, 8, 7, 6] in a 6-8 range -> [8, 8, 8, 7]
 *
 * Sets with no prior data (a set count that grew, or a skipped set) start at
 * the bottom of the range rather than inheriting a neighbour's number.
 */
export function nextRepTargets(lastReps, setCount, range) {
  const targets = [];
  for (let index = 0; index < setCount; index += 1) {
    const previous = lastReps[index];
    if (previous === undefined || previous === null || previous <= 0) {
      targets.push(range.min);
    } else if (previous >= range.max) {
      targets.push(range.max);
    } else {
      // Never jump past the top of the range, and never target below it.
      targets.push(clamp(previous + 1, range.min, range.max));
    }
  }
  return targets;
}

/**
 * How many consecutive recent sessions showed no improvement.
 *
 * A session improved on the one before it if the weight went up, or the
 * weight held and total reps went up. Comparing totals rather than set-by-set
 * means moving a rep from set 4 to set 1 does not read as progress.
 */
export function countStalledSessions(working, range, setCount) {
  if (working.length < 2) return 0;

  let stalled = 0;
  for (let index = 0; index < working.length - 1; index += 1) {
    const current = summarise(working[index]);
    const older = summarise(working[index + 1]);

    const improved =
      (current.weight ?? 0) > (older.weight ?? 0) ||
      ((current.weight ?? 0) === (older.weight ?? 0) && current.totalReps > older.totalReps);

    if (improved) break;
    stalled += 1;
  }

  return stalled;
}

/* --- Applying a recommendation ----------------------------------------- */

/**
 * Whether every prescribed set of an entry has been logged.
 * Used to decide when the workout screen can offer to finish.
 */
export function isEntryComplete(entry) {
  return entry.sets.length > 0 && entry.sets.every((set) => set.completed);
}

/**
 * Did this performance earn the next load increase?
 * Shown on the workout screen the moment the last set is ticked, so the
 * result of the session is visible before leaving the gym.
 */
export function earnedAdvance(exercise, sets) {
  const done = sets.filter((set) => set.completed && (set.reps ?? 0) > 0);
  if (done.length < exercise.sets) return false;

  // A pyramid is judged rung by rung against its own targets, not against a
  // single shared range top.
  if (Array.isArray(exercise.setPlan) && exercise.setPlan.length) {
    return exercise.setPlan
      .slice(0, exercise.sets)
      .every((step, index) => (done[index]?.reps ?? 0) >= (step.reps ?? 0));
  }

  const range = repRange(exercise);
  return done.slice(0, exercise.sets).every((set) => (set.reps ?? 0) >= range.max);
}

/** The load to suggest next time, given what was just done. */
export function nextWeight(exercise, sets) {
  const weight = workingWeight({ sets });
  if (weight === null) return null;
  return earnedAdvance(exercise, sets) ? weight + incrementFor(exercise) : weight;
}

/* --- Shared helpers ---------------------------------------------------- */

/** Normalised rep range with a display label. */
export function repRange(exercise) {
  const min = exercise.reps?.min ?? 8;
  const max = exercise.reps?.max ?? min;
  return { min, max, label: min === max ? String(min) : `${min}-${max}`, fixed: min === max };
}

/**
 * The load step for one exercise.
 *
 * The program gives a range ("+2.5-5 kg"); the engine defaults to the bottom
 * of it because the source document is explicit that these are a ceiling on
 * how much to add, not a target. Smaller jumps also survive longer before
 * stalling.
 */
export function incrementFor(exercise) {
  const increment = exercise.progression?.increment;
  if (typeof increment === 'number') return increment;
  return increment?.min ?? 2.5;
}

/** Completed sets with a real rep count. */
function completedSets(entry) {
  return (entry.sets ?? []).filter((set) => set.completed && (set.reps ?? 0) > 0);
}

/**
 * The session's working weight: the heaviest load actually completed.
 *
 * Heaviest rather than first, because a lifter who works up across sets is
 * still working at the top load — anchoring to set one would stall them.
 * Returns null when nothing was loaded (pure bodyweight work).
 */
export function workingWeight(entry) {
  const loads = completedSets(entry)
    .map((set) => set.weightKg)
    .filter((weight) => weight !== null && weight !== undefined);
  if (!loads.length) return null;
  return Math.max(...loads);
}

function summarise(entry) {
  const sets = completedSets(entry);
  return {
    weight: workingWeight(entry),
    totalReps: sets.reduce((total, set) => total + (set.reps ?? 0), 0),
    setCount: sets.length,
  };
}

function fill(count, value) {
  return Array.from({ length: Math.max(0, count) }, () => value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Round to a multiple of `step`, keeping it off the floor. */
function roundTo(value, step) {
  if (!step || step <= 0) return round2(value);
  const rounded = Math.round(value / step) * step;
  return round2(Math.max(step, rounded));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function trim(value) {
  return String(round2(value));
}

/** Human label for an action, for the workout screen's badge. */
export function actionLabel(action) {
  switch (action) {
    case ACTIONS.START:        return 'First session';
    case ACTIONS.HOLD:         return 'Hold weight';
    case ACTIONS.ADVANCE:      return 'Add weight';
    case ACTIONS.REPS_FIRST:   return 'Add reps';
    case ACTIONS.DELOAD_WAVE:  return 'Deload';
    case ACTIONS.DELOAD_STALL: return 'Reset load';
    default:                   return '';
  }
}

/** Tone for the action badge: maps onto the pill modifier classes. */
export function actionTone(action) {
  switch (action) {
    case ACTIONS.ADVANCE:      return 'success';
    case ACTIONS.DELOAD_STALL: return 'danger';
    case ACTIONS.DELOAD_WAVE:  return 'warning';
    case ACTIONS.START:        return 'accent';
    default:                   return '';
  }
}
