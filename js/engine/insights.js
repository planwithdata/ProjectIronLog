/**
 * insights.js — Reading a training log, rather than plotting it.
 *
 * Pure, like its siblings: plain arrays in, plain objects out, no storage and
 * no clock. `services/analytics-service.js` decides where the data comes from.
 *
 * What this module is for
 * ----------------------
 * The Progress page could already draw a line for one exercise and a bar per
 * week. That answers "what did I do" and leaves "am I getting stronger, and
 * where" to the reader. This module answers the second question, and the ones
 * the brief asks alongside it: which lifts are moving, which have stopped,
 * whether progress is coming from load or from reps, where performance is
 * falling under a load that is holding, what happens after a deload.
 *
 * Three rules govern every figure in here, and they are why the numbers can be
 * trusted rather than merely displayed:
 *
 *   1. **Measure the repeatable load, not the heaviest set.** A probe is not a
 *      working weight. See `engine/progression.repeatableLoad`.
 *
 *   2. **Never compare across a scale change.** A cable stack reading is
 *      arbitrary; a machine change is not a 120% strength gain. Every trend
 *      here is measured over a *comparable run* — the newest stretch of
 *      sessions whose loads mean the same thing — and says how long that run
 *      was. See `engine/context.js`.
 *
 *   3. **Say when there is not enough data.** Four sessions is four sessions.
 *      A slope fitted to three points with an r² of 0.2 is a decoration, and
 *      `confidence` exists so the UI can decline to draw a conclusion instead
 *      of dressing one up.
 *
 * Deloads are excluded from every trend by default. A deliberate step back is
 * not a regression, and letting Week 5 into a slope makes every fifth week look
 * like a collapse.
 */

import { estimate1rm } from './one-rep-max.js';
import { repeatableLoad, repsAtLoad, repRange } from './progression.js';
import { markDiscontinuities, isMachineScaled, contextKey } from './context.js';

/* --- Status vocabulary -------------------------------------------------- */

/**
 * What one exercise is currently doing.
 *
 * `GRINDING` is the status this module exists for. It is the case the brief
 * names and no chart shows: the load is holding or even climbing, and the reps
 * underneath it are falling. On a volume chart that reads as flat; on a
 * top-set chart it reads as progress. It is neither.
 */
export const STATUS = {
  PROGRESSING: 'progressing',
  HOLDING:     'holding',
  GRINDING:    'grinding',
  STALLED:     'stalled',
  SCALE_CHANGE: 'scale-change',
  MAINTAINED:  'maintained',
  NEW:         'new',
};

export const STATUS_LABELS = {
  [STATUS.PROGRESSING]:  'Progressing',
  [STATUS.HOLDING]:      'Holding',
  [STATUS.GRINDING]:     'Losing reps',
  [STATUS.STALLED]:      'Stalled',
  [STATUS.SCALE_CHANGE]: 'Load scale changed',
  [STATUS.MAINTAINED]:   'Maintained',
  [STATUS.NEW]:          'Too new to read',
};

/** Statuses that mean "look at this one". */
export const NEEDS_ATTENTION = new Set([STATUS.STALLED, STATUS.GRINDING]);

/** Where an improvement came from. */
export const DRIVER = {
  LOAD:  'load',
  REPS:  'reps',
  BOTH:  'both',
  NONE:  'none',
};

export const DRIVER_LABELS = {
  [DRIVER.LOAD]: 'Adding load',
  [DRIVER.REPS]: 'Adding reps',
  [DRIVER.BOTH]: 'Load and reps',
  [DRIVER.NONE]: 'Neither yet',
};

/**
 * How much an estimated 1RM has to move before it counts as a move.
 *
 * 2% is roughly a single rep on a ten-rep set — the smallest real unit of
 * progress this program produces. Below it, a "change" is arithmetic noise from
 * the Epley formula rather than training.
 */
export const MEANINGFUL_CHANGE = 0.02;

/**
 * And for a rep total, which needs a wider band.
 *
 * A three-set exercise carries thirty to forty reps, so one extra rep is under
 * 3% and would clear a 2% threshold on its own. 3% asks for a rep *and* a
 * meaningful share of the total, which on this program means one rep on a
 * three-set movement of ten and two on a four-set movement of fifteen.
 */
export const REP_CHANGE = 0.03;

/** How far a rep total has to fall before it reads as losing ground. */
export const REP_DECLINE = 0.06;

/** Consecutive comparable sessions with no improvement before it reads as stalled. */
export const STALL_SESSIONS = 2;

/**
 * Comparable sessions needed before "losing reps" may be reported.
 *
 * Three, and the reason is double progression itself: the session after a load
 * increase is *supposed* to come in at the bottom of the rep range. Hip thrusts
 * going 80 kg for 11/11/10 and then 85 kg for 8/8/8 is the scheme working
 * exactly as designed, and flagging it would be the app telling the user off
 * for following its own prescription. Only when the reps fail to come back over
 * a third session is there something to look at.
 */
export const GRIND_SESSIONS = 3;

/* --- One exercise ------------------------------------------------------- */

/**
 * Everything worth saying about one exercise.
 *
 * @param {object} exercise
 * @param {Array<object>} history
 *        Performances newest first, as `session-service.getExerciseHistory`
 *        returns them: `{ date, sets, isDeload, painLimited, incomplete,
 *        targetWeightKg, contextKey, context, substitution, week, waveWeek }`.
 * @returns {object|null} null when the exercise has never been logged
 */
export function exerciseInsight(exercise, history = []) {
  const loaded = history.filter((entry) => (entry.sets ?? []).some((set) => set.reps > 0));
  if (!loaded.length) return null;

  const range = repRange(exercise);
  const machineScaled = isMachineScaled(exercise);
  const maintained = exercise?.progression?.mode === 'maintain';

  // Oldest first for everything that reads as a trend.
  const points = [...loaded].reverse().map((entry) => describePerformance(entry, range));
  const marked = markDiscontinuities(
    points.map((point) => ({ ...point, loadKg: point.workingLoadKg })),
    { machineScaled }
  );

  // The trend is measured over the newest run of mutually comparable, non-deload
  // sessions. `run` is oldest-first within that stretch.
  const run = comparableRun(marked);
  const trainingRun = run.filter((point) => !point.isDeload);
  const latest = marked[marked.length - 1];
  const first = trainingRun[0] ?? latest;
  const last = trainingRun[trainingRun.length - 1] ?? latest;

  const load = delta(first.workingLoadKg, last.workingLoadKg);
  const reps = delta(first.repsAtLoad, last.repsAtLoad);
  const e1rm = delta(first.e1rmKg, last.e1rmKg);
  const volume = delta(first.workingVolumeKg, last.workingVolumeKg);

  const stalledSessions = countFlatSessions(trainingRun);
  const status = judgeStatus({
    maintained, latest, trainingRun, load, reps, e1rm, stalledSessions,
  });

  return {
    exerciseId: exercise.id,
    name: exercise.name,
    category: exercise.category ?? null,
    primaryMuscles: exercise.primaryMuscles ?? [],
    equipment: exercise.equipment ?? null,
    machineScaled,
    maintained,
    range,

    sessions: loaded.length,
    // How many of those the trend could actually use. The gap between the two
    // numbers is the honest answer to "how much of my history is comparable".
    comparableSessions: trainingRun.length,
    firstDate: first.date,
    lastDate: last.date,
    spanDays: daysApart(first.date, last.date),

    status,
    statusLabel: STATUS_LABELS[status],
    statusDetail: explainStatus({ status, load, reps, e1rm, stalledSessions, latest, range }),
    needsAttention: NEEDS_ATTENTION.has(status),

    load,
    reps,
    e1rm,
    volume,
    driver: judgeDriver(load, reps),
    perWeek: ratePerWeek(trainingRun.map((point) => ({ date: point.date, value: point.e1rmKg }))),
    confidence: confidenceOf(trainingRun),
    stalledSessions,

    current: {
      date: last.date,
      workingLoadKg: last.workingLoadKg,
      topLoadKg: last.topLoadKg,
      reps: last.reps,
      repsAtLoad: last.repsAtLoad,
      e1rmKg: last.e1rmKg,
      atTopOfRange: last.atTopOfRange,
      setsAtLoad: last.setsAtLoad,
    },

    // Every point, marked, for the chart — including the ones outside the
    // comparable run, because hiding them would hide the machine change.
    series: marked,
    // Only the two breaks worth telling the user about. An unclassified
    // comparison is surfaced through History's reclassification control, not as
    // a caveat on a chart the user cannot act on from there.
    breaks: marked.filter((point) => point.contextChanged || point.discontinuous),
    unclassifiedComparisons: marked.filter((point) => point.unclassified).length,
    // Sessions where what was performed differed from what was planned.
    deviations: points.filter((point) => point.deviationKg !== null),
    substituted: points.filter((point) => point.substituted).length,
    painLimited: points.filter((point) => point.painLimited).length,
  };
}

/**
 * Reduce one logged performance to the handful of figures a trend needs.
 *
 * `workingLoadKg` and `repsAtLoad` are the pair that matter. Reps are counted
 * only at the working load, so a heavier probe cannot inflate a session's rep
 * total and then leave the next one looking like a collapse.
 *
 * Exported because the two-week review asks the same question of a *window*
 * rather than of a whole history, and it has to read a session the same way
 * this module does or the review and the dashboard will disagree about the
 * same week.
 */
export function readPerformance(entry, range) {
  return describePerformance(entry, range);
}

function describePerformance(entry, range) {
  const sets = (entry.sets ?? []).filter((set) => (set.reps ?? 0) > 0);
  const workingLoadKg = repeatableLoad(entry);
  const atLoad = repsAtLoad(entry, workingLoadKg).filter((value) => value !== null && value > 0);

  const loads = sets.map((set) => set.weightKg).filter((value) => value !== null && value !== undefined);
  const repeatable = sets.filter((set) => set.kind !== 'top');

  return {
    date: entry.date,
    week: entry.week ?? null,
    waveWeek: entry.waveWeek ?? null,
    isDeload: Boolean(entry.isDeload),
    painLimited: Boolean(entry.painLimited),
    incomplete: Boolean(entry.incomplete),
    contextKey: entry.contextKey ?? contextKey(entry),
    contextLabel: entry.contextLabel ?? null,
    substituted: Boolean(entry.substituted),
    // Logged before warm-ups and working sets were told apart. Its working load
    // is a coarse reading, so it is not compared against a classified session.
    legacy: Boolean(entry.legacy),

    workingLoadKg,
    topLoadKg: loads.length ? Math.max(...loads) : null,
    reps: sets.map((set) => set.reps),
    repsAtLoad: atLoad.reduce((total, value) => total + value, 0),
    setsAtLoad: atLoad.length,
    atTopOfRange: atLoad.length > 0 && atLoad.every((value) => value >= range.max),

    // Estimated 1RM as the **mean across the sets performed at the working
    // load** — not the best set of the day.
    //
    // This is the difference between reading a workout and reading its high
    // point. Leg extensions went 12/11/11 one week and 13/10/8 the next: the
    // best set improved, the session got materially worse, and a max-based
    // series calls that progress. The brief's ninth point is exactly this
    // complaint, and a mean is the fix — every set votes, and one strong set
    // cannot carry a session it did not represent.
    //
    // `bestE1rmKg` keeps the maximum, including any top-set probe, because a
    // personal best genuinely is a single-set question.
    e1rmKg: round1(meanOrZero(
      atLoad.map((reps) => estimate1rm(workingLoadKg ?? 0, reps))
    )),
    bestE1rmKg: round1(Math.max(0, ...sets.map((set) => estimate1rm(set.weightKg ?? 0, set.reps)))),
    workingVolumeKg: round1(repeatable.reduce(
      (total, set) => total + (set.weightKg ?? 0) * (set.reps ?? 0), 0
    )),

    plannedKg: entry.targetWeightKg ?? null,
    deviationKg: entry.targetWeightKg === null || entry.targetWeightKg === undefined
      || workingLoadKg === null
      ? null
      : round1(workingLoadKg - entry.targetWeightKg),
  };
}

/**
 * The newest stretch of points whose loads may be compared with each other.
 *
 * Walks backwards from the most recent session and stops at the first break.
 * Returned oldest-first so a caller can read it as a series.
 */
export function comparableRun(marked) {
  const run = [];
  for (let index = marked.length - 1; index >= 0; index -= 1) {
    run.unshift(marked[index]);
    if (!marked[index].comparable) break;
  }
  return run;
}

/**
 * Consecutive recent sessions with no improvement, newest backwards.
 *
 * Improvement is a higher working load, or the same load carrying more reps.
 * Pain-limited and incomplete sessions are skipped rather than counted: they
 * say nothing about strength, and letting them accumulate would report a stall
 * for having been sensible.
 */
export function countFlatSessions(run) {
  const judgeable = run.filter((point) => !point.painLimited && !point.incomplete);
  if (judgeable.length < 2) return 0;

  let flat = 0;
  for (let index = judgeable.length - 1; index > 0; index -= 1) {
    const current = judgeable[index];
    const older = judgeable[index - 1];
    const improved = (current.workingLoadKg ?? 0) > (older.workingLoadKg ?? 0)
      || ((current.workingLoadKg ?? 0) === (older.workingLoadKg ?? 0)
        && current.repsAtLoad > older.repsAtLoad);
    if (improved) break;
    flat += 1;
  }
  return flat;
}

/**
 * What one exercise is doing, in the order the questions have to be asked.
 *
 * The sequence matters more than any single test. Maintained work is exempt
 * from all of it; a scale change makes every remaining question unanswerable;
 * and progress has to be checked *before* decline, because on a rep-first
 * scheme most progress arrives as reps at an unchanged load and would
 * otherwise be filed as "no load change".
 */
function judgeStatus({ maintained, latest, trainingRun, load, reps, e1rm, stalledSessions }) {
  // A movement the program does not progress cannot be stalled, and reporting
  // it as such would ask the user to fix something that is working correctly.
  if (maintained) return STATUS.MAINTAINED;

  // The scale changed on the most recent session: nothing can be said about
  // strength yet, and saying it anyway is the bug this whole path exists for.
  // An unclassified comparison is excluded here rather than reported as a scale
  // change — it is a gap in the record, not a different machine.
  if (latest?.contextChanged || latest?.discontinuous) return STATUS.SCALE_CHANGE;

  if (trainingRun.length < 2) return STATUS.NEW;

  const signals = readSignals(load, reps, e1rm);

  if (signals.improved) return STATUS.PROGRESSING;
  // Reps falling with no strength gain to show for it. Requires a third
  // comparable session, so the deliberate rep drop after a load increase is not
  // mistaken for one — see GRIND_SESSIONS.
  if (signals.repsFell && trainingRun.length >= GRIND_SESSIONS) return STATUS.GRINDING;
  if (stalledSessions >= STALL_SESSIONS) return STATUS.STALLED;
  return STATUS.HOLDING;
}

/**
 * The three ways this program produces progress, read from one span.
 *
 * Ratios are unusable when the starting figure is zero — a bodyweight movement
 * that gains its first added load, an estimated 1RM series starting from
 * nothing — so each test falls back to the absolute difference. That fallback
 * is what makes the hanging knee raise going from bodyweight to +7.5 kg read as
 * progress rather than as a division by zero.
 */
function readSignals(load, reps, e1rm) {
  const loadHeld = (load.delta ?? 0) === 0;

  const e1rmImproved = e1rm.ratio !== null
    ? e1rm.ratio >= 1 + MEANINGFUL_CHANGE
    : (e1rm.delta ?? 0) > 0;

  const loadImproved = load.ratio !== null
    ? load.ratio >= 1 + MEANINGFUL_CHANGE / 2
    : (load.delta ?? 0) > 0;

  const repsImproved = (reps.ratio ?? 1) >= 1 + REP_CHANGE;
  const repsFell = (reps.ratio ?? 1) <= 1 - REP_DECLINE;

  return {
    loadHeld,
    loadImproved,
    repsImproved,
    repsFell,
    e1rmImproved,
    // More reps at the same load is the whole of double progression between
    // load increases, so it counts on its own — but only at the same load,
    // since more reps at a *lower* load is not progress.
    improved: e1rmImproved
      || (loadHeld && repsImproved)
      || (loadImproved && !repsFell),
  };
}

function explainStatus({ status, load, reps, e1rm, stalledSessions, latest, range }) {
  switch (status) {
    case STATUS.MAINTAINED:
      return 'Held at its load by design — quality work, not a progression lift.';

    case STATUS.SCALE_CHANGE:
      return latest?.contextChanged
        ? 'The last session was logged on a different machine or attachment, so its load cannot '
          + 'be read against the previous one. The reps are still comparable.'
        : 'The load jumped further than a programmed increment allows, which usually means a '
          + 'different machine. Tag the machine and the trend picks up again from there.';

    case STATUS.NEW:
      return 'One comparable session so far. Two are needed before a direction means anything.';

    case STATUS.GRINDING:
      return (load.delta ?? 0) > 0
        ? `The load is up ${signed(load.delta)} kg but the reps under it are down `
          + `${percentText(reps)} and have not come back over three sessions. `
          + 'The increase has not been absorbed — worth holding here until it has.'
        : `Same load, ${percentText(reps)} fewer reps under it. The sets are `
          + 'getting harder rather than stronger, which usually points at recovery rather than '
          + 'at the programming.';

    case STATUS.STALLED:
      return `No load or rep gain for ${stalledSessions} comparable sessions. The program's own `
        + 'answer is to drop about 10% and rebuild, which the engine will now prescribe.';

    case STATUS.PROGRESSING:
      return `Estimated strength up ${percentText(e1rm)} over this run`
        + `${(load.delta ?? 0) > 0 ? `, with the working load up ${signed(load.delta)} kg` : ''}.`;

    default:
      return latest?.atTopOfRange
        ? `Every set at the top of the ${range.label} range — the next session earns the load.`
        : 'Flat, but not for long enough to call it a stall. Chase the reps.';
  }
}

function judgeDriver(load, reps) {
  const signals = readSignals(load, reps, { ratio: null, delta: null });
  if (signals.loadImproved && signals.repsImproved) return DRIVER.BOTH;
  if (signals.loadImproved) return DRIVER.LOAD;
  if (signals.repsImproved) return DRIVER.REPS;
  return DRIVER.NONE;
}

/**
 * How much weight to put on this exercise's trend.
 *
 * Sessions, not days: this program trains a movement once a week, so five
 * comparable sessions is five weeks and is as much as anyone has. Reported so
 * the UI can rank a confident reading above a suggestive one rather than
 * printing both in the same type.
 */
export function confidenceOf(run) {
  const usable = run.filter((point) => !point.painLimited).length;
  if (usable >= 5) return 'high';
  if (usable >= 3) return 'medium';
  return 'low';
}

/* --- Roll-ups ----------------------------------------------------------- */

/**
 * Sort every exercise into the four piles worth acting on.
 *
 * Ordered *within* each pile by how much it moved, so the top of each list is
 * the most extreme case rather than whichever exercise sorts first
 * alphabetically. `attention` is deliberately the union of stalled and
 * grinding: from the user's point of view they are one question — which lifts
 * need me to do something differently.
 */
export function scorecard(insights) {
  const byE1rm = (a, b) => (b.e1rm.ratio ?? 1) - (a.e1rm.ratio ?? 1);
  const byWorst = (a, b) => (a.e1rm.ratio ?? 1) - (b.e1rm.ratio ?? 1);

  return {
    progressing: insights.filter((item) => item.status === STATUS.PROGRESSING).sort(byE1rm),
    holding: insights.filter((item) => item.status === STATUS.HOLDING).sort(byE1rm),
    attention: insights.filter((item) => item.needsAttention).sort(byWorst),
    scaleChanged: insights.filter((item) => item.status === STATUS.SCALE_CHANGE),
    maintained: insights.filter((item) => item.status === STATUS.MAINTAINED),
    tooNew: insights.filter((item) => item.status === STATUS.NEW),
  };
}

/**
 * Where progress is coming from, across the whole program.
 *
 * Counts exercises by driver rather than averaging percentages: "eleven lifts
 * are adding reps and two are adding load" is a fact about the training, while
 * a mean of thirteen unrelated percentages is a number with no referent. Early
 * in a wave the answer should be reps-heavy — that is what double progression
 * does between load increases — and seeing it confirms the scheme is working.
 */
export function driverMix(insights) {
  const counts = { [DRIVER.LOAD]: 0, [DRIVER.REPS]: 0, [DRIVER.BOTH]: 0, [DRIVER.NONE]: 0 };
  for (const item of insights) {
    if (item.status === STATUS.MAINTAINED || item.status === STATUS.NEW) continue;
    counts[item.driver] += 1;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    total,
    byDriver: Object.entries(counts).map(([driver, count]) => ({
      driver,
      label: DRIVER_LABELS[driver],
      count,
      percent: total ? Math.round((count / total) * 100) : 0,
    })),
  };
}

/**
 * Progression rolled up by primary muscle group.
 *
 * Attribution follows the same rule the volume chart uses: an exercise counts
 * in full towards each of its primary muscles and not at all towards its
 * secondaries. The program does not say how a row splits between lats and mid
 * back, and inventing a ratio would invent precision — so this is a comparison
 * of emphasis, and it is labelled as one wherever it is shown.
 */
export function muscleProgress(insights) {
  const groups = new Map();

  for (const item of insights) {
    const muscles = item.primaryMuscles.length ? item.primaryMuscles : ['Other'];
    for (const muscle of muscles) {
      if (!groups.has(muscle)) {
        groups.set(muscle, { muscle, exercises: [], progressing: 0, attention: 0, ratios: [] });
      }
      const group = groups.get(muscle);
      group.exercises.push(item);
      if (item.status === STATUS.PROGRESSING) group.progressing += 1;
      if (item.needsAttention) group.attention += 1;
      if (item.e1rm.ratio !== null && item.comparableSessions >= 2) group.ratios.push(item.e1rm.ratio);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      muscle: group.muscle,
      count: group.exercises.length,
      progressing: group.progressing,
      attention: group.attention,
      // A median rather than a mean: with two or three exercises per group one
      // outlier would otherwise decide the whole group's reading.
      changeRatio: group.ratios.length ? median(group.ratios) : null,
      names: group.exercises.map((item) => item.name),
    }))
    .sort((a, b) => (b.changeRatio ?? 0) - (a.changeRatio ?? 0));
}

/**
 * Meaningful personal records.
 *
 * "Meaningful" is doing real work here. Excluded:
 *
 *   - anything achieved in a session flagged as a scale change, because a
 *     bigger number off a different machine is not a record;
 *   - loads reached only in a top-set probe, which get their own list;
 *   - deload weeks.
 *
 * What is left is two kinds worth celebrating: the heaviest load actually
 * *held for the prescribed sets*, and the most reps ever done at the current
 * working load. Both are things the lifter can repeat, which is what makes
 * them worth beating.
 */
export function meaningfulRecords(insight) {
  if (!insight) return [];
  const records = [];
  const usable = insight.series.filter(
    (point) => !point.isDeload && !point.contextChanged && !point.discontinuous
      && !point.legacy
  );
  if (!usable.length) return records;

  const bestLoad = usable.reduce(
    (best, point) => ((point.workingLoadKg ?? 0) > (best?.workingLoadKg ?? -1) ? point : best),
    null
  );
  if (bestLoad?.workingLoadKg) {
    records.push({
      kind: 'working-load',
      label: 'Heaviest working load',
      value: bestLoad.workingLoadKg,
      unit: 'kg',
      date: bestLoad.date,
      detail: `${bestLoad.setsAtLoad} ${bestLoad.setsAtLoad === 1 ? 'set' : 'sets'} at `
        + `${bestLoad.reps.join('/')}`,
      current: bestLoad.date === insight.current.date,
    });
  }

  // Most reps at the load currently being trained. Comparing reps across
  // different loads is meaningless, so this is scoped to one load.
  const atCurrentLoad = usable.filter(
    (point) => point.workingLoadKg === insight.current.workingLoadKg && point.setsAtLoad > 0
  );
  const bestReps = atCurrentLoad.reduce(
    (best, point) => (point.repsAtLoad > (best?.repsAtLoad ?? -1) ? point : best),
    null
  );
  if (bestReps && atCurrentLoad.length > 1) {
    records.push({
      kind: 'reps-at-load',
      label: `Most reps at ${round1(insight.current.workingLoadKg)} kg`,
      value: bestReps.repsAtLoad,
      unit: 'reps',
      date: bestReps.date,
      detail: bestReps.reps.join('/'),
      current: bestReps.date === insight.current.date,
    });
  }

  const bestE1rm = usable.reduce(
    (best, point) => (point.e1rmKg > (best?.e1rmKg ?? -1) ? point : best),
    null
  );
  if (bestE1rm?.e1rmKg) {
    records.push({
      kind: 'e1rm',
      label: 'Best estimated 1RM',
      value: round1(bestE1rm.e1rmKg),
      unit: 'kg',
      date: bestE1rm.date,
      detail: 'from working sets only',
      current: bestE1rm.date === insight.current.date,
    });
  }

  return records;
}

/**
 * How the program's wave weeks compare with each other.
 *
 * Grouped by `waveWeek` rather than by calendar week, so week 1 of every cycle
 * lands together. That is the comparison the plan is built on — four loading
 * weeks then a deload — and it is the one a calendar-week bar chart cannot make.
 */
export function byWaveWeek(sessions, reduce) {
  const buckets = new Map();

  for (const session of sessions) {
    const week = session.waveWeek ?? null;
    if (!week) continue;
    if (!buckets.has(week)) buckets.set(week, []);
    buckets.get(week).push(session);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([waveWeek, group]) => ({
      waveWeek,
      label: `Week ${waveWeek}`,
      isDeload: group.some((session) => session.isDeload),
      count: group.length,
      value: reduce(group),
    }));
}

/**
 * What happened in the sessions after each deload, against the ones before it.
 *
 * The whole justification for giving up a training week is that the week after
 * it goes better. This is the only figure in the app that checks. Returns an
 * empty array until a deload has actually happened, rather than a card full of
 * dashes — five weeks in, that is the honest state.
 */
export function deloadResponse(insights) {
  const out = [];

  for (const insight of insights) {
    const series = insight.series;
    for (let index = 0; index < series.length; index += 1) {
      if (!series[index].isDeload) continue;
      const before = lastNonDeload(series, index - 1, -1);
      const after = lastNonDeload(series, index + 1, 1);
      if (!before || !after) continue;

      out.push({
        exerciseId: insight.exerciseId,
        name: insight.name,
        deloadDate: series[index].date,
        before: { date: before.date, e1rmKg: before.e1rmKg, loadKg: before.workingLoadKg, reps: before.repsAtLoad },
        after: { date: after.date, e1rmKg: after.e1rmKg, loadKg: after.workingLoadKg, reps: after.repsAtLoad },
        change: delta(before.e1rmKg, after.e1rmKg),
      });
    }
  }

  return out;
}

function lastNonDeload(series, from, step) {
  for (let index = from; index >= 0 && index < series.length; index += step) {
    if (!series[index].isDeload) return series[index];
  }
  return null;
}

/**
 * Whether the app's prescriptions are being followed, and where they are not.
 *
 * Both directions matter and they mean opposite things. Consistently *above*
 * plan says the engine is prescribing too conservatively — which is exactly
 * what happened on the incline Smith press, planned at 40 kg and performed at
 * 45. Consistently *below* says the opposite. Neither is a failure to be
 * scolded for; both are feedback about the plan.
 */
export function adherence(insights) {
  const rows = [];

  for (const insight of insights) {
    const deviations = insight.deviations.filter((point) => Math.abs(point.deviationKg) >= 0.5);
    if (!deviations.length) continue;

    const above = deviations.filter((point) => point.deviationKg > 0);
    const below = deviations.filter((point) => point.deviationKg < 0);

    rows.push({
      exerciseId: insight.exerciseId,
      name: insight.name,
      sessions: insight.sessions,
      deviations: deviations.length,
      above: above.length,
      below: below.length,
      meanDeviationKg: round1(
        deviations.reduce((sum, point) => sum + point.deviationKg, 0) / deviations.length
      ),
      latest: deviations[deviations.length - 1],
      verdict: above.length > below.length
        ? 'The plan is running behind what you actually lift.'
        : (below.length > above.length
          ? 'The plan is asking for more than the sessions are delivering.'
          : 'Deviations go both ways — no consistent bias.'),
    });
  }

  return rows.sort((a, b) => Math.abs(b.meanDeviationKg) - Math.abs(a.meanDeviationKg));
}

/**
 * Training consistency, read as the split intends it.
 *
 * A session done on the wrong weekday is *done*. The program's own missed-day
 * rules describe the split as rolling, so counting a Tuesday workout performed
 * on Wednesday as a miss would grade the user against a calendar the plan
 * itself does not keep. What is worth reporting is the shape of it: how many
 * sessions, how many landed on their own day, and how many days went by
 * between them.
 */
export function consistency(sessions) {
  if (!sessions.length) {
    return { sessions: 0, onDay: 0, offDay: 0, medianGapDays: null, longestGapDays: null, perWeek: null };
  }

  const dates = sessions.map((session) => session.date).sort();
  const gaps = [];
  for (let index = 1; index < dates.length; index += 1) {
    gaps.push(daysApart(dates[index - 1], dates[index]));
  }

  const onDay = sessions.filter((session) => (session.schedule?.offsetDays ?? 0) === 0).length;
  const spanDays = daysApart(dates[0], dates[dates.length - 1]) || 1;

  return {
    sessions: sessions.length,
    onDay,
    offDay: sessions.length - onDay,
    // Late is not the same as missed, and this is the number that says so.
    lateSessions: sessions.filter((session) => (session.schedule?.offsetDays ?? 0) > 0).length,
    medianGapDays: gaps.length ? median(gaps) : null,
    longestGapDays: gaps.length ? Math.max(...gaps) : null,
    perWeek: round1((sessions.length / spanDays) * 7),
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
  };
}

/* --- Small maths -------------------------------------------------------- */

/**
 * A change between two figures, as both a difference and a ratio.
 *
 * Both, because neither alone is readable: +2.5 kg means something different on
 * a 4.5 kg cable fly and a 180 kg hack squat, and +55% means something
 * different on 20 reps and on one. Nulls all the way through when there is
 * nothing to compare, so a caller can print a dash rather than a zero — a zero
 * says "no change", and "no data" is not the same claim.
 */
export function delta(from, to) {
  const a = toNumber(from);
  const b = toNumber(to);
  if (a === null || b === null) return { from: a, to: b, delta: null, ratio: null, percent: null };
  return {
    from: round1(a),
    to: round1(b),
    delta: round1(b - a),
    ratio: a === 0 ? null : round3(b / a),
    percent: a === 0 ? null : Math.round(((b - a) / a) * 100),
  };
}

/**
 * Change per week across a dated series, fitted by least squares.
 *
 * Reported with an r², and the caller is expected to look at it: three points
 * on a wobbly line produce a confident-looking slope and an r² of 0.1, and the
 * slope is meaningless. Null below three points, because two points always fit
 * a line perfectly and an r² of 1 from two points is not evidence.
 */
export function ratePerWeek(series) {
  const points = series
    .filter((point) => point.value !== null && point.value !== undefined && point.value > 0);
  if (points.length < 3) return null;

  const origin = points[0].date;
  const xs = points.map((point) => daysApart(origin, point.date));
  const ys = points.map((point) => Number(point.value));

  const meanX = mean(xs);
  const meanY = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index] - meanX) * (ys[index] - meanY);
    sxx += (xs[index] - meanX) ** 2;
  }
  if (sxx === 0) return null;

  const slopePerDay = sxy / sxx;
  const intercept = meanY - slopePerDay * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const predicted = intercept + slopePerDay * xs[index];
    ssRes += (ys[index] - predicted) ** 2;
    ssTot += (ys[index] - meanY) ** 2;
  }

  return {
    perWeek: round2(slopePerDay * 7),
    r2: ssTot === 0 ? null : round2(1 - ssRes / ssTot),
    points: points.length,
    days: daysApart(origin, points[points.length - 1].date),
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Mean of a list, or 0 for an empty one — so a series can hold a real zero. */
function meanOrZero(values) {
  return values.length ? mean(values) : 0;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * A change as a percentage, read from the `delta` that produced it.
 *
 * Takes the whole delta rather than a ratio so there is exactly one rounding in
 * the system. Deriving a second percentage from an already-rounded ratio made a
 * row report "+24%" and its own sentence report "25%" about the same number,
 * which is the kind of discrepancy that makes a reader stop trusting the page.
 * Unsigned, because every call site supplies its own direction in words.
 */
function percentText(delta) {
  return `${Math.abs(delta?.percent ?? 0)}%`;
}

function signed(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${round1(number)}`;
}

/* Date helpers, duplicated from core/format.js so this module stays
   import-free of the app shell — the same trade `engine/analytics.js` makes. */

function parseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function daysApart(aKey, bKey) {
  return Math.round((parseDay(bKey) - parseDay(aKey)) / 86400000);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
