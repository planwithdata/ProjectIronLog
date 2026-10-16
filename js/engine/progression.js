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
 * Repeatable load, not heaviest load
 * ----------------------------------
 * The load carried into the next session is the **repeatable** working load,
 * not the heaviest set of the day. Those are different numbers and conflating
 * them was a real bug: a single 72 kg flat dumbbell bench set logged among two
 * 55 kg sets became the prescription for all three sets of the following week,
 * at a load that had never been held twice.
 *
 * `repeatableLoad` reads it as the lower median of the completed repeatable
 * sets, which is the heaviest load at least half the sets were actually
 * performed at. On uniform sets — the normal case — that is simply the load. On
 * a session with one heavier probe it is the load underneath the probe. On a
 * week-one ramp logged as working sets (150/180/200/220) it is the second rung,
 * which is the same reading a human gives those numbers and the same one the
 * hand-written `WORKING_SET_REBASELINE` correction used to make by date.
 *
 * A set explicitly marked `kind: 'top'` is excluded outright, which is the
 * precise version of the same idea. The median is what protects the sessions
 * nobody remembered to tag.
 *
 * Rep targets are built the same way: only from the sets performed **at** that
 * load. Five reps at 72 kg says nothing about what set three at 55 kg should
 * be, so it is not allowed to set its target.
 *
 * Loads that are not comparable
 * -----------------------------
 * Machine and cable readings are arbitrary scales — see `engine/context.js`.
 * When the load between two sessions moves further than any programmed
 * increment could explain, or when the entry declares a different machine, the
 * engine stops comparing: no stall is counted across the break, and the
 * recommendation says why. It never converts between scales and never claims
 * to know which machine a legacy number came from.
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
import { contextKey, compareLoads, isMachineScaled, DEFAULT_CONTEXT } from './context.js';

/** What the engine decided to do. */
export const ACTIONS = {
  START:       'start',        // no history — the user picks the first weight
  HOLD:        'hold',         // same weight, chase reps
  ADVANCE:     'advance',      // top of range on every set — add load
  REPS_FIRST:  'reps-first',   // bodyweight: add reps before any load
  DELOAD_WAVE: 'deload-wave',  // scheduled Week 5 deload
  DELOAD_STALL: 'deload-stall', // stalled 3 sessions — drop and rebuild
  DIFFICULTY:  'difficulty',   // earned a harder variation, not more load
  MAINTAIN:    'maintain',     // quality work, deliberately not progressed
  RE_ANCHOR:   're-anchor',    // the load scale changed; rebuild from here
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
 *        instead of from the repeatable one. See `baselineWeight`.
 * @param {string} [options.contextKey]
 *        The machine/attachment the coming session will use. When given, the
 *        engine anchors on the newest performance from that same context and
 *        says so when there is none. See `engine/context.js`.
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
  const plan = recommendWorking(exercise, history, options);
  if (!options.isDeload) return plan;
  return { ...plan, targetRir: '3?4', reason: plan.weightKg === null
    ? 'Deload: use a comfortable light load or easier variation, with 3?4 reps in reserve. Fewer working sets; avoid failure and intensity work.'
    : `${plan.reason} Keep 3?4 reps in reserve; avoid failure and intensity work.` };
}

function recommendWorking(exercise, history = [], options = {}) {
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

  // Quality work the program deliberately does not progress - the Pallof press.
  // It branches before any of the load arithmetic because there is none: the
  // point of the movement is bracing against rotation at a load you can hold
  // position at, and ratcheting that up every week turns a 45-second core
  // exercise into a grinding compound.
  if (exercise.progression?.mode === 'maintain') {
    return recommendMaintain(exercise, history, { ...options, setCount, increment, range });
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

  // Rep history aligned to the sets performed *at* the anchor load. A set at a
  // different load holds `null` rather than a number, because a heavier probe's
  // rep count is not a target for the load underneath it.
  const alignedReps = repsAtLoad(last, lastWeight);
  const baselineReps = alignedReps.filter((reps) => reps !== null && reps > 0);
  // A conservative floor for a set with no reading at this load: the weakest
  // set that *was* performed at it. Not the bottom of the range, which on a
  // 12-15 movement would prescribe a step backwards.
  const repFloor = baselineReps.length ? Math.min(...baselineReps) : range.min;

  const continuity = judgeContinuity(exercise, working, options);

  const previous = {
    // What the next load is measured from: the repeatable working load, unless
    // a baseline override says otherwise.
    weightKg: lastWeight,
    // Always the heaviest, so a caller showing "last session" still shows what
    // was actually lifted rather than the figure the engine chose to build on.
    topWeightKg: workingWeight(last),
    reps: lastReps,
    repsAtLoad: baselineReps,
    date: last.date,
    painLimited: Boolean(last.painLimited),
    // What the app asked for last time, kept alongside what was done so a
    // caller can show both instead of quietly replacing one with the other.
    targetWeightKg: last.targetWeightKg ?? null,
    deviation: loadDeviation(last, lastWeight),
    contextKey: contextKey(last),
    contextChanged: continuity.contextChanged,
    discontinuous: continuity.discontinuous,
  };

  // "All working sets at the top of the range" is judged against the sets
  // performed at the anchor load, compacted. Three sets at 55 kg plus one probe
  // at 72 is three sets, not four - and the probe cannot help earn an increase
  // for a load it was not performed at.
  const atTop = baselineReps.length >= setCount
    && baselineReps.slice(0, setCount).every((reps) => reps >= range.max);

  // Stalling is only judged across performances whose loads mean the same
  // thing. A machine change is not three sessions of no progress.
  const stalledSessions = countStalledSessions(
    judgeableHistory(continuity.comparableRun, exercise), range, setCount
  );

  // Append every caveat that actually applies: a moved anchor, a scale break, a
  // deviation from what was planned.
  const explain = (result) => {
    const notes = [
      lastWeight === previous.topWeightKg
        ? null
        : baselineNote(options.baselineSetIndex, lastWeight, previous.topWeightKg),
      continuity.note,
      deviationNote(previous.deviation),
    ].filter(Boolean);

    return notes.length ? { ...result, reason: `${result.reason} ${notes.join(' ')}` } : result;
  };

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

  /* --- The scale changed: rebuild from the new reading ----------------- */
  // Before the stall and advance branches, because neither question can be
  // answered across a break. What the last session managed at another
  // machine's numbers says nothing about what to load on this one.
  if (continuity.discontinuous || continuity.contextChanged) {
    return explain({
      action: ACTIONS.RE_ANCHOR,
      weightKg: lastWeight,
      perSetReps: nextRepTargets(alignedReps, setCount, range, repFloor),
      increment,
      reason: lastWeight === null
        ? 'Repeat last session and chase reps rather than load.'
        : `Work from last session's reading of ${trim(lastWeight)} kg and chase reps, not load.`,
      previous,
      atTopOfRange: atTop,
      stalledSessions: 0,
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
    perSetReps: nextRepTargets(alignedReps, setCount, range, repFloor),
    increment,
    reason: holdReason({ exercise, last, lastWeight, range, repsFirst, baselineReps, setCount }),
    previous,
    atTopOfRange: false,
    stalledSessions,
  });
}

/**
 * One sentence explaining that the load was anchored somewhere other than the
 * heaviest set. Only ever appended when the two figures actually differ.
 *
 * Two phrasings, because there are two reasons they can differ: an explicit
 * `baselineSetIndex` override, or - far more often now - the ordinary reading
 * of a session that contained one heavier set than the rest.
 */
function baselineNote(setIndex, baseline, top) {
  const from = baseline === null ? 'bodyweight' : `${trim(baseline)} kg`;
  const was = top === null ? 'bodyweight' : `${trim(top)} kg`;

  if (setIndex) {
    return `Measured from working set ${setIndex} (${from}) rather than the ${was} top set, `
      + 'because a working set is a load you repeat, not a limit you probe.';
  }

  return `Measured from ${from}, the load you actually repeated, rather than the ${was} top set - `
    + 'a weight pushed once is not the weight for every set.';
}

/**
 * How far the performed load sat from what the app asked for.
 *
 * Returned as data rather than folded into the recommendation, because the two
 * facts are both true and the app must not overwrite one with the other. The
 * engine builds on what was *done* - that is what the body did - while the plan
 * is kept so the deviation itself can be reported and read.
 *
 * @returns {{plannedKg: number, performedKg: number|null, deltaKg: number}|null}
 */
function loadDeviation(performance, performedKg) {
  const planned = performance?.targetWeightKg;
  if (planned === null || planned === undefined) return null;
  if (performedKg === null || performedKg === undefined) return null;
  const deltaKg = round2(performedKg - planned);
  if (Math.abs(deltaKg) < 0.01) return null;
  return { plannedKg: round2(planned), performedKg: round2(performedKg), deltaKg };
}

/**
 * A sentence naming the deviation, appended to the reason.
 *
 * Deliberately does not scold or correct: the number the body moved is the
 * real one, and a single session above or below plan is information, not an
 * instruction to re-plan. Saying it out loud is what stops the app looking as
 * though it silently lost the target.
 */
function deviationNote(deviation) {
  if (!deviation) return null;
  const direction = deviation.deltaKg > 0 ? 'above' : 'below';
  return `Last session was planned at ${trim(deviation.plannedKg)} kg and performed at `
    + `${trim(deviation.performedKg)} kg - ${trim(Math.abs(deviation.deltaKg))} kg ${direction} plan. `
    + 'Today builds on what was performed.';
}

/**
 * Whether the last performance's load may be compared with the one before it,
 * and which run of recent performances are comparable to each other.
 *
 * Three ways a comparison can be refused:
 *
 *   - the coming session declares a context (`options.contextKey`) that the
 *     last performance was not logged in;
 *   - the last two performances declare different contexts;
 *   - on a machine-scaled movement, the load moved further between them than
 *     any programmed increment could explain.
 *
 * The third is a suspicion rather than a fact, and its wording says so. None of
 * them alter a stored number, and none of them hide a session: they only stop
 * the engine drawing a strength conclusion from a change of scale.
 *
 * @returns {{contextChanged: boolean, discontinuous: boolean, note: string|null,
 *            comparableRun: Array<object>}}
 */
function judgeContinuity(exercise, working, options = {}) {
  const machineScaled = isMachineScaled(exercise);
  const last = working[0] ?? null;
  if (!last) {
    return { contextChanged: false, discontinuous: false, note: null, comparableRun: working };
  }

  const lastKey = contextKey(last);
  const wanted = options.contextKey ?? null;

  // Walk back from the newest performance for as long as loads stay comparable.
  // That run - and only it - is what stall detection and trend lines may read.
  const comparableRun = [last];
  let breakReason = null;

  for (let index = 1; index < working.length; index += 1) {
    const older = working[index];
    const newer = working[index - 1];

    if (contextKey(older) !== contextKey(newer)) {
      if (index === 1) breakReason = 'context';
      break;
    }

    // A session logged before warm-ups and working sets were told apart has a
    // working load that is a reading of a mixed list, not a measurement. It
    // still supplies the load — it is the only record there is — but it is not
    // compared against a classified session, because week one's face pulls
    // (11.3 / 13.6 / 6.8 / 6.8) would otherwise make the following week's clean
    // 13.6 look like a machine change.
    if (older.legacy || newer.legacy) {
      if (index === 1) breakReason = 'unclassified';
      break;
    }

    if (machineScaled) {
      const move = compareLoads(repeatableLoad(older), repeatableLoad(newer));
      if (move.discontinuous) {
        if (index === 1) breakReason = 'discontinuity';
        break;
      }
    }

    comparableRun.push(older);
  }

  // A declared context the history has never seen is the strongest break there
  // is: nothing in the log was measured on this scale.
  if (wanted && wanted !== DEFAULT_CONTEXT && wanted !== lastKey) {
    const seen = working.some((entry) => contextKey(entry) === wanted);
    return {
      contextChanged: true,
      discontinuous: false,
      note: seen
        ? 'The last session was on a different machine, so its load is not the one to set here.'
        : 'First session logged on this machine, so its numbers have no history yet. Pick a load '
          + 'where the last 1-2 reps are genuinely hard and let the reps do the progressing.',
      comparableRun: [],
    };
  }

  if (breakReason === 'context') {
    return {
      contextChanged: true,
      discontinuous: false,
      note: 'Logged on a different machine or attachment from the session before it, so the two '
        + 'loads are not comparable and no stall is counted across the change.',
      comparableRun,
    };
  }

  if (breakReason === 'discontinuity') {
    return {
      contextChanged: false,
      discontinuous: true,
      note: 'The load moved by far more than a programmed increment, which usually means a '
        + 'different machine rather than a change in strength. Tag the machine on this exercise '
        + 'and the history will stop reading it as one.',
      comparableRun,
    };
  }

  // Only the run is shortened. No caveat is added to the card and no re-anchor
  // is triggered: ordinary double progression from an unclassified session is
  // the right behaviour, and the only thing that would be wrong is counting a
  // stall across it.
  if (breakReason === 'unclassified') {
    return { contextChanged: false, discontinuous: false, note: null, comparableRun };
  }

  return { contextChanged: false, discontinuous: false, note: null, comparableRun };
}

/**
 * Why we are holding — phrased for the situation rather than from a template.
 *
 * A pain-limited session gets different words on purpose. Telling someone whose
 * elbow hurt last Wednesday to "add a rep to any set below 10" is the app
 * pushing them into the exact rep that hurt.
 */
function holdReason({ exercise, last, lastWeight, range, repsFirst, baselineReps = [], setCount = 0 }) {
  if (last?.painLimited && exercise?.painAware) {
    return `Last session was cut short by discomfort. Repeat it only as far as it stays pain-free — `
      + `${range.label} reps is the target, not a requirement.`;
  }
  if (repsFirst) {
    return `Add a rep to any set below ${range.max}. No added load until every set hits ${range.max}.`;
  }

  const base = `Stay at ${lastWeight === null ? 'the same weight' : `${trim(lastWeight)} kg`} `
    + `and add a rep to any set below ${range.max}.`;

  // A set at the top of the range next to sets well below it is the case the
  // brief singles out: 12/8/8 contains a 12, and reading the 12 as the story of
  // the session is how a load gets prescribed that only one set earned. Name
  // the spread so the reason matches the numbers on the card.
  const spread = baselineReps.length > 1
    ? Math.max(...baselineReps) - Math.min(...baselineReps)
    : 0;

  if (spread >= 3) {
    return `${base} Sets ran ${baselineReps.join('/')} last time — the later sets are what the load `
      + 'is judged on, so the weight moves once all of them reach the top, not just the first.';
  }

  if (setCount && baselineReps.length && baselineReps.length < setCount) {
    return `${base} Only ${baselineReps.length} of ${setCount} sets were logged at this load last `
      + 'time, so it has not been earned yet.';
  }

  return base;
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

/* --- Maintained (deliberately un-progressed) work ----------------------
   Some movements exist to be done well, not to be loaded up. The Pallof press
   is one: it is an anti-rotation brace, its prescription is a fixed rep count
   per side, and its useful load is whatever you can hold position against. Put
   it on a double-progression ladder and within a month it is a slow, heavy,
   ten-minute finisher at the end of an already long chest day - which is
   exactly the complaint that produced this branch.

   So it holds its load, prescribes its reps, and says so. It never advances,
   never counts a stall, and never triggers a deload: there is nothing to
   deload from. The load is still logged and still editable, because a load
   that is not progressed is not the same thing as a load that is not recorded.
   ====================================================================== */

function recommendMaintain(exercise, history, { isDeload, setCount, increment, range }) {
  const working = history.filter((entry) => !entry.isDeload && completedSets(entry).length > 0);
  const last = working[0] ?? null;
  const holdLabel = exercise.tempo?.label ? ` ${exercise.tempo.label}` : '';

  const base = {
    action: ACTIONS.MAINTAIN,
    increment,
    perSetReps: fill(setCount, range.max),
    atTopOfRange: false,
    stalledSessions: 0,
    maintained: true,
  };

  if (!last) {
    return {
      ...base,
      weightKg: null,
      reason: `Quality work, not a progression lift. ${range.label} reps at a load you can hold `
        + `position against.${holdLabel}`,
      previous: null,
    };
  }

  const lastWeight = repeatableLoad(last);

  return {
    ...base,
    weightKg: isDeload && lastWeight !== null
      ? roundTo(lastWeight * DELOAD_LOAD_FACTOR, increment)
      : lastWeight,
    reason: `Not a progression lift - hold ${lastWeight === null ? 'a comfortable load' : `${trim(lastWeight)} kg`} `
      + `and keep the reps clean. Adjust the load only if bracing gets easy or the position breaks down.${holdLabel}`,
    previous: {
      weightKg: lastWeight,
      topWeightKg: workingWeight(last),
      reps: completedSets(last).map((set) => set.reps ?? 0),
      date: last.date,
      painLimited: Boolean(last.painLimited),
      targetWeightKg: last.targetWeightKg ?? null,
      deviation: loadDeviation(last, lastWeight),
      contextKey: contextKey(last),
      contextChanged: false,
      discontinuous: false,
    },
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
 * Sets with no prior data start at `fallback`, which defaults to the bottom of
 * the range. Callers that know better pass something better: a set logged at a
 * *different* load has no rep target of its own, and prescribing the bottom of
 * a 12-15 range for it would ask for a step backwards. `recommend` passes the
 * weakest set that was performed at the anchor load, which is a target that is
 * both achievable and honest about being a guess.
 */
export function nextRepTargets(lastReps, setCount, range, fallback = null) {
  const floor = clamp(fallback ?? range.min, range.min, range.max);
  const targets = [];
  for (let index = 0; index < setCount; index += 1) {
    const previous = lastReps[index];
    if (previous === undefined || previous === null || previous <= 0) {
      targets.push(floor);
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
 * A session improved on the one before it if the repeatable load went up, or
 * the load held and total reps at that load went up. Comparing totals rather
 * than set-by-set means moving a rep from set 4 to set 1 does not read as
 * progress; measuring at the repeatable load rather than the heaviest set means
 * a one-off probe cannot fake a session's worth of progress and then leave the
 * next session looking like a regression.
 *
 * The caller decides which performances are eligible: `recommend` passes only
 * the run of recent sessions whose loads are mutually comparable, so a machine
 * change never accumulates towards a stall.
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
  const done = (sets ?? []).filter((set) => set.completed && (set.reps ?? 0) > 0);
  if (done.length < exercise.sets) return false;

  // Movements the program does not progress cannot earn a load increase, and
  // showing "Next: +1 kg" on the Pallof press is how one starts climbing.
  if (exercise.progression?.mode === 'maintain') return false;

  // A pyramid is judged rung by rung against its own targets, not against a
  // single shared range top.
  if (Array.isArray(exercise.setPlan) && exercise.setPlan.length) {
    return exercise.setPlan
      .slice(0, exercise.sets)
      .every((step, index) => (done[index]?.reps ?? 0) >= (step.reps ?? 0));
  }

  // Judged at the repeatable load, and only on the sets performed there: the
  // heavier probe among them was never the working weight, so it can neither
  // earn the increase nor be asked to.
  const load = repeatableLoad({ sets: done });
  const atLoad = repsAtLoad({ sets: done }, load)
    .filter((value) => value !== null && value > 0);
  if (atLoad.length < exercise.sets) return false;

  const range = repRange(exercise);
  return atLoad.slice(0, exercise.sets).every((reps) => reps >= range.max);
}

/** The load to suggest next time, given what was just done. */
export function nextWeight(exercise, sets) {
  const weight = repeatableLoad({ sets });
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

/** How close two loads have to be to count as the same load. */
const LOAD_EPSILON = 0.01;

/** Completed sets with a real rep count. */
function completedSets(entry) {
  return (entry?.sets ?? []).filter((set) => set.completed && (set.reps ?? 0) > 0);
}

/**
 * Completed sets that represent a load meant to be repeated.
 *
 * Sets explicitly marked `kind: 'top'` are a probe at a limit and are left out.
 * If every set was marked that way the filter would leave nothing to prescribe
 * from, so it falls back to all of them: "these were all probes" is still a
 * session, and refusing to read it would be worse than reading it coarsely.
 */
function completedRepeatable(entry) {
  const done = completedSets(entry);
  const repeatable = done.filter((set) => set.kind !== 'top');
  return repeatable.length ? repeatable : done;
}

function sameLoad(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Math.abs(Number(a) - Number(b)) < LOAD_EPSILON;
}

/**
 * The **repeatable** working load of a session: the load at least half the
 * completed working sets were actually performed at.
 *
 * Implemented as the lower median of those loads, which is the same thing and
 * needs no tie-breaking rules:
 *
 *   55 / 55 / 55        -> 55    the ordinary case, unchanged
 *   55 / 55 / 72        -> 55    two working sets and one probe
 *   150 / 180 / 200/220 -> 180   a week-one ramp logged as working sets
 *   45 / 55             -> 45    two loads, neither repeated: the lower one
 *
 * The lower median rather than the upper, deliberately. Where the sets
 * disagree, the load you can be sure of is the one you did *at least* half your
 * sets at, and a prescription that is slightly too light costs one session of
 * rep progress while one that is too heavy costs a month of grinding and a
 * false stall. Returns null when nothing was loaded (bodyweight work).
 */
export function repeatableLoad(entry) {
  const loads = completedRepeatable(entry)
    .map((set) => set.weightKg)
    .filter((weight) => weight !== null && weight !== undefined)
    .map(Number)
    .filter((weight) => Number.isFinite(weight))
    .sort((a, b) => a - b);

  if (!loads.length) return null;
  return loads[Math.floor((loads.length - 1) / 2)];
}

/**
 * Rep counts aligned to the completed sets, with `null` wherever a set was not
 * performed at `load`.
 *
 * Positions are preserved rather than compacted, so a per-set rep target lands
 * on the set it belongs to. A bodyweight movement (load `null`) matches every
 * set, which is what makes this safe to call unconditionally.
 */
export function repsAtLoad(entry, load) {
  return completedSets(entry).map((set) =>
    (sameLoad(set.weightKg, load) ? (set.reps ?? 0) : null));
}

/**
 * The heaviest load actually completed in a session.
 *
 * This is a *display and record* figure, not a prescription: it is what to show
 * as "top set" and what the heaviest-weight PR is measured on. The load the
 * next session is built from is `repeatableLoad`, which is a different question
 * and usually a different number. Returns null for pure bodyweight work.
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
 * Normally `repeatableLoad` — the load at least half the working sets were
 * actually performed at. That is the whole of the correction described at the
 * top of this file, and it is now the default rather than a dated exception:
 * `config.WORKING_SET_REBASELINE` existed to make this reading by hand for one
 * week of untagged history, and it no longer has to.
 *
 * `setIndex` (1-based) still overrides it with one nominated working set, for
 * the cases where the user knows something the numbers do not say. Falls back
 * to the repeatable load whenever the nominated set cannot answer — a session
 * with fewer sets than the index, or a bodyweight movement where the set
 * carries no load — so passing an index is at worst a no-op, never a hole in
 * the prescription.
 *
 * Reads *completed* sets, in the order they were logged, which is the same
 * sequence every other judgement in this module is made against.
 */
export function baselineWeight(entry, setIndex = null) {
  const repeatable = repeatableLoad(entry);
  if (!setIndex || setIndex < 1) return repeatable;

  const nominated = completedSets(entry)[setIndex - 1]?.weightKg;
  if (nominated === null || nominated === undefined) return repeatable;
  return Number(nominated);
}

function summarise(entry) {
  const load = repeatableLoad(entry);
  const reps = repsAtLoad(entry, load).filter((value) => value !== null && value > 0);
  return {
    weight: load,
    totalReps: reps.reduce((total, value) => total + value, 0),
    setCount: reps.length,
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
    case ACTIONS.MAINTAIN:     return 'Quality work';
    case ACTIONS.RE_ANCHOR:    return 'New load scale';
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
    case ACTIONS.RE_ANCHOR:    return 'warning';
    case ACTIONS.MAINTAIN:     return '';
    default:                   return '';
  }
}
