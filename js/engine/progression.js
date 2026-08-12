/**
 * progression.js — The double progression engine.
 *
 * This module is deliberately **pure**: it touches no storage, reads no
 * globals, and imports only its pure sibling `loading.js`. Everything it needs
 * arrives as arguments and everything it decides comes back as a return value.
 * That is what makes it testable outside a browser (`node tools/test.mjs`) —
 * and this is the one part of the app where a silent mistake would quietly
 * wreck years of training, so it needs to be tested rather than eyeballed.
 *
 * What this engine is allowed to see
 * ---------------------------------
 * **Working sets only.** Ramp-up sets and optional intensity work (drop sets,
 * failure sets) are real training and appear in history and reports, but they
 * must never move a prescribed load. That separation is structural rather than
 * conditional: `session-service.getExerciseHistory` builds each performance
 * from `entry.sets`, which under the v2 set model holds working sets and
 * nothing else (see `engine/set-model.js`). There is no filter here to forget,
 * because warm-ups never arrive here in the first place.
 *
 * A performance may also arrive flagged `painLimited` or `incomplete`. Those
 * are excluded from stall detection — stopping a set because your elbow hurts
 * is not evidence of getting weaker, and the engine must not respond to it by
 * cutting the load.
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
 * And one rule that is Rish's rather than the document's:
 *
 *   8. Movements marked 'difficulty-first' (the ab wheel) climb a difficulty
 *      ladder before they ever take external load. Reaching 12 reps earns
 *      better control, more range, or a harder variation — not a plate.
 *
 * Which set the next load is measured from is a separate question from all of
 * the above, and it is the caller's: by default the heaviest completed working
 * set, or a nominated one via `options.baselineSetIndex`. See `baselineWeight`.
 *
 * Worked example from the brief, which `tools/test.mjs` asserts directly:
 *
 *   range 6-8, at 27.5 kg, logged 8 / 8 / 7 / 6
 *   -> stay at 27.5 kg, target 8 / 8 / 8 / 7
 */

import { incrementScale, DEFAULT_LOAD_PREFS } from './loading.js';

/** What the engine decided to do. */
export const ACTIONS = {
  START:       'start',        // no history — the user picks the first weight
  HOLD:        'hold',         // same weight, chase reps
  ADVANCE:     'advance',      // top of range on every set — add load
  REPS_FIRST:  'reps-first',   // bodyweight: add reps before any load
  DELOAD_WAVE: 'deload-wave',  // scheduled Week 5 deload
  DELOAD_STALL: 'deload-stall', // stalled 3 sessions — drop and rebuild
  DIFFICULTY:  'difficulty',   // earned a harder variation, not more load
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
 *        Past **working-set** performances, newest first, each shaped
 *        `{ date, sets: [{ weightKg, reps, completed }], isDeload,
 *           painLimited?, incomplete?, difficulty? }`.
 *        This is exactly what session-service.getExerciseHistory returns.
 * @param {object} [options]
 * @param {boolean} [options.isDeload]  true during the wave's deload week
 * @param {number}  [options.setCount]  override the prescribed set count
 * @param {object}  [options.loadPrefs] display/increment conventions
 * @param {number|null} [options.baselineSetIndex]
 *        Read the load to carry forward from this working set (1-based)
 *        instead of from the heaviest one. See `baselineWeight`.
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
 *   difficulty?: string,        // difficulty-first movements only
 * }}
 */
export function recommend(exercise, history = [], options = {}) {
  const range = repRange(exercise);
  const setCount = options.setCount ?? exercise.sets;
  const increment = incrementFor(exercise, options.loadPrefs);
  const repsFirst = exercise.progression?.mode === 'reps-first';

  // A difficulty-first movement never earns load by hitting the rep ceiling, so
  // it branches before any of the weight arithmetic below.
  if (exercise.progression?.mode === 'difficulty-first') {
    return recommendDifficulty(exercise, history, { ...options, setCount, increment, range });
  }

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

  const lastWeight = baselineWeight(last, options.baselineSetIndex);
  const lastReps = completedSets(last).map((set) => set.reps ?? 0);
  const previous = {
    // What the next load is measured from, which is the heaviest completed set
    // unless a baseline override says otherwise.
    weightKg: lastWeight,
    // Always the heaviest, so a caller showing "last session" still shows what
    // was actually lifted rather than the figure the engine chose to build on.
    topWeightKg: workingWeight(last),
    reps: lastReps,
    date: last.date,
    painLimited: Boolean(last.painLimited),
  };

  // "All working sets at the top of the range" is judged against the sets
  // actually prescribed. Hitting the top on three of four sets is a hold.
  const atTop = lastReps.length >= setCount
    && lastReps.slice(0, setCount).every((reps) => reps >= range.max);

  const stalledSessions = countStalledSessions(judgeableHistory(working, exercise), range, setCount);

  // When a baseline override actually moved the anchor, say so on the card.
  // A load that drops without explanation reads as the app losing track of a
  // session, and the user has no way to tell that from a deliberate reset.
  const explain = (result) => (
    lastWeight === previous.topWeightKg
      ? result
      : { ...result, reason: `${result.reason} ${baselineNote(options.baselineSetIndex, lastWeight, previous.topWeightKg)}` }
  );

  /* --- Scheduled deload week ------------------------------------------ */
  if (options.isDeload) {
    return explain({
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
    });
  }

  /* --- Stalled: drop and rebuild -------------------------------------- */
  // Checked before the advance branch: a lift that just hit the top of the
  // range has by definition improved, so `stalledSessions` would be 0 there.
  if (stalledSessions >= STALL_SESSIONS && lastWeight) {
    return explain({
      action: ACTIONS.DELOAD_STALL,
      weightKg: roundTo(lastWeight * STALL_RETAIN, increment),
      perSetReps: fill(setCount, range.min),
      increment,
      reason: `No progress for ${stalledSessions} sessions. Drop about 10% and rebuild — this is normal, not a failure.`,
      previous,
      atTopOfRange: atTop,
      stalledSessions,
    });
  }

  /* --- Top of range on every set: add load ---------------------------- */
  if (atTop) {
    if (repsFirst && (lastWeight === null || lastWeight === 0)) {
      // Bodyweight lift graduating to added load for the first time.
      return explain({
        action: ACTIONS.ADVANCE,
        weightKg: increment,
        perSetReps: fill(setCount, range.min),
        increment,
        reason: `Top of the range on every set at bodyweight. Add ${trim(increment)} kg with a belt or vest and drop back to ${range.min} reps.`,
        previous,
        atTopOfRange: true,
        stalledSessions,
      });
    }

    return explain({
      action: ACTIONS.ADVANCE,
      weightKg: (lastWeight ?? 0) + increment,
      perSetReps: fill(setCount, range.min),
      increment,
      reason: `Top of the range on every set. Add ${trim(increment)} kg and drop back to ${range.min} reps.`,
      previous,
      atTopOfRange: true,
      stalledSessions,
    });
  }

  /* --- Hold the weight, chase reps ------------------------------------ */
  return explain({
    action: repsFirst ? ACTIONS.REPS_FIRST : ACTIONS.HOLD,
    weightKg: lastWeight,
    perSetReps: nextRepTargets(lastReps, setCount, range),
    increment,
    reason: holdReason({ exercise, last, lastWeight, range, repsFirst }),
    previous,
    atTopOfRange: false,
    stalledSessions,
  });
}

/**
 * One sentence explaining that the load was anchored somewhere other than the
 * top set. Only ever appended when the two figures actually differ.
 */
function baselineNote(setIndex, baseline, top) {
  const from = baseline === null ? 'bodyweight' : `${trim(baseline)} kg`;
  const was = top === null ? 'bodyweight' : `${trim(top)} kg`;
  return `Measured from working set ${setIndex} (${from}) rather than the ${was} top set, `
    + 'because a working set is a load you repeat, not a limit you probe.';
}

/**
 * Why we are holding — phrased for the situation rather than from a template.
 *
 * A pain-limited session gets different words on purpose. Telling someone whose
 * elbow hurt last Wednesday to "add a rep to any set below 10" is the app
 * pushing them into the exact rep that hurt.
 */
function holdReason({ exercise, last, lastWeight, range, repsFirst }) {
  if (last?.painLimited && exercise?.painAware) {
    return `Last session was cut short by discomfort. Repeat it only as far as it stays pain-free — `
      + `${range.label} reps is the target, not a requirement.`;
  }
  if (repsFirst) {
    return `Add a rep to any set below ${range.max}. No added load until every set hits ${range.max}.`;
  }
  return `Stay at ${lastWeight === null ? 'the same weight' : `${trim(lastWeight)} kg`} `
    + `and add a rep to any set below ${range.max}.`;
}

/**
 * The performances the engine may use to judge whether progress has stalled.
 *
 * Two exclusions, both narrow:
 *
 *   - **Pain-limited**, on any exercise. A session stopped because something
 *     hurt says nothing about strength, and responding to it with the stall
 *     rule would cut the load for having been sensible.
 *   - **Incomplete**, on pain-aware exercises only. The brief is explicit that
 *     incomplete pull-up sets must not read as a regression. Elsewhere an
 *     unfinished session genuinely is a signal worth counting, so it still is.
 *
 * Excluded performances remain in the history, remain visible in reports, and
 * still supply the current working load. They just do not vote on stalling.
 */
export function judgeableHistory(history = [], exercise = null) {
  return history.filter((entry) => {
    if (entry.painLimited) return false;
    if (exercise?.painAware && entry.incomplete) return false;
    return true;
  });
}

/* --- Difficulty-first progression --------------------------------------
   The ab wheel. Reaching the top of the rep range on a bodyweight core
   movement does not mean "hang a plate on it" — it means the movement has
   become easy enough to make harder. External resistance is the last rung of
   the ladder, not the first response to 12 reps.
   ====================================================================== */

/** Rungs used when the program document does not define its own ladder. */
export const DEFAULT_DIFFICULTY_LADDER = [
  { id: 'standard', label: 'Standard', note: 'Controlled rollout, ribs down, no sag.' },
  { id: 'slow-eccentric', label: 'Slow eccentric', note: 'Take 3-4 seconds on the way out.' },
  { id: 'longer-rom', label: 'Longer range', note: 'Roll further out while keeping the ribs down.' },
  { id: 'advanced', label: 'Advanced variation', note: 'From the feet, or standing.' },
  { id: 'weighted', label: 'Weighted', note: 'Only now consider external resistance.' },
];

export function difficultyLadder(exercise) {
  const ladder = exercise?.progression?.difficultyLadder;
  return Array.isArray(ladder) && ladder.length ? ladder : DEFAULT_DIFFICULTY_LADDER;
}

export function difficultyRung(exercise, id) {
  const ladder = difficultyLadder(exercise);
  return ladder.find((rung) => rung.id === id) ?? ladder[0];
}

function recommendDifficulty(exercise, history, {
  isDeload, setCount, increment, range, baselineSetIndex,
}) {
  const ladder = difficultyLadder(exercise);
  const working = history.filter((entry) => !entry.isDeload && completedSets(entry).length > 0);
  const last = working[0] ?? null;

  const base = {
    increment,
    weightKg: null,
    perSetReps: fill(setCount, range.min),
    atTopOfRange: false,
    stalledSessions: 0,
    previous: null,
    difficulty: ladder[0].id,
  };

  if (!last) {
    return {
      ...base,
      action: ACTIONS.START,
      reason: `Build clean reps in the ${range.label} range at ${ladder[0].label.toLowerCase()} difficulty. `
        + 'Progression here is control and range first, resistance last.',
    };
  }

  const lastReps = completedSets(last).map((set) => set.reps ?? 0);
  const lastWeight = baselineWeight(last, baselineSetIndex);
  const currentId = last.difficulty ?? ladder[0].id;
  const currentIndex = Math.max(0, ladder.findIndex((rung) => rung.id === currentId));
  const current = ladder[currentIndex];
  const previous = {
    weightKg: lastWeight,
    reps: lastReps,
    date: last.date,
    difficulty: currentId,
    painLimited: Boolean(last.painLimited),
  };

  if (isDeload) {
    return {
      ...base,
      action: ACTIONS.DELOAD_WAVE,
      weightKg: lastWeight,
      previous,
      difficulty: currentId,
      reason: `Deload week: fewer sets at ${current.label.toLowerCase()}. Keep the quality, drop the volume.`,
    };
  }

  const atTop = lastReps.length >= setCount
    && lastReps.slice(0, setCount).every((reps) => reps >= range.max);

  if (!atTop) {
    return {
      ...base,
      action: ACTIONS.REPS_FIRST,
      weightKg: lastWeight,
      perSetReps: nextRepTargets(lastReps, setCount, range),
      previous,
      difficulty: currentId,
      reason: `Add a rep to any set below ${range.max} at ${current.label.toLowerCase()}. `
        + 'Stop a rep short of losing position rather than grinding one out.',
    };
  }

  const next = ladder[currentIndex + 1] ?? null;

  // Top of the ladder: now, and only now, load is the remaining variable.
  if (!next) {
    return {
      ...base,
      action: ACTIONS.ADVANCE,
      weightKg: (lastWeight ?? 0) + increment,
      previous,
      atTopOfRange: true,
      difficulty: currentId,
      reason: `Top of the range at ${current.label.toLowerCase()} — the hardest rung on the ladder. `
        + `Add ${trim(increment)} kg and drop back to ${range.min} reps.`,
    };
  }

  return {
    ...base,
    action: ACTIONS.DIFFICULTY,
    weightKg: next.id === 'weighted' ? (lastWeight ?? 0) + increment : lastWeight,
    previous,
    atTopOfRange: true,
    difficulty: next.id,
    reason: `${range.max} reps on every set at ${current.label.toLowerCase()}. `
      + `Move to ${next.label.toLowerCase()} and drop back to ${range.min} reps. ${next.note}`,
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
 * The load step for one exercise, in **stored** units.
 *
 * The program gives a range ("+2.5-5 kg"); the engine defaults to the bottom
 * of it because the source document is explicit that these are a ceiling on
 * how much to add, not a target. Smaller jumps also survive longer before
 * stalling.
 *
 * For a dumbbell pair the program's figure is per hand, while storage holds
 * both dumbbells together, so the step is doubled: "+2.5 kg" means the next
 * pair up, which is 5 kg of stored total. Without this the engine would
 * recommend 52.5 kg — 26.25 kg per hand, a dumbbell that exists on no rack.
 * See engine/loading.js `incrementScale`.
 */
export function incrementFor(exercise, loadPrefs = DEFAULT_LOAD_PREFS) {
  const increment = exercise.progression?.increment;
  const base = typeof increment === 'number' ? increment : (increment?.min ?? 2.5);
  return round2(base * incrementScale(exercise, loadPrefs));
}

/** The program's own figure, unscaled — for showing the prescription as written. */
export function programIncrement(exercise) {
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

/**
 * The load the next session should be built on.
 *
 * Normally that is `workingWeight` — the heaviest set actually completed —
 * because someone who works up across their sets is still working at the top
 * load, and anchoring to set one would stall them.
 *
 * `setIndex` (1-based) overrides that with one nominated working set. It exists
 * for the opposite case: sets logged as a ramp, where the top set was a probe
 * at a limit rather than a load meant to be repeated four times. Carrying the
 * probe forward would prescribe a weight that was never held for a working set.
 *
 * Falls back to the heaviest set whenever the nominated one cannot answer —
 * a session with fewer sets than the index, or a bodyweight movement where the
 * set carries no load. That fallback is why passing an index is always at
 * worst a no-op, never a hole in the prescription.
 *
 * Reads *completed* sets, in the order they were logged, which is the same
 * sequence every other judgement in this module is made against.
 */
export function baselineWeight(entry, setIndex = null) {
  const top = workingWeight(entry);
  if (!setIndex || setIndex < 1) return top;

  const nominated = completedSets(entry)[setIndex - 1]?.weightKg;
  if (nominated === null || nominated === undefined) return top;
  return nominated;
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
    case ACTIONS.DIFFICULTY:   return 'Harder variation';
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
    case ACTIONS.DIFFICULTY:   return 'success';
    default:                   return '';
  }
}
