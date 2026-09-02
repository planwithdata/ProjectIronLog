/**
 * pr-service.js — Personal record detection.
 *
 * PRs are *derived*, never authored: they are computed from the session log
 * so they can never drift out of step with it, and so deleting a mislogged
 * session correctly removes the record it created.
 *
 * Five kinds are tracked, because "strongest" means different things:
 *   weight   — heaviest load for a single completed set
 *   working  — heaviest load actually *repeated* across the working sets
 *   reps     — most reps in one set
 *   e1rm     — best estimated one-rep max (Epley), the fairest cross-rep
 *              comparison and the one that catches progress made by adding
 *              reps rather than plates
 *   volume   — most load moved in one session for that exercise
 *
 * Why `working` was added
 * -----------------------
 * `weight` is the heaviest single set, and it is a real record — but on a
 * session logged 55 / 55 / 72 it reports 72, which was held once and never
 * repeated. "Heaviest working load" is the record that describes what the
 * lifter can actually do on demand, and it is the one that moves when training
 * works. Both are kept, and they say which they are.
 *
 * Records that cannot be trusted
 * ------------------------------
 * Every record carries `unverified` and, when set, a `caveat`. A record is
 * unverified when the session that set it sits on a **load scale change** — a
 * declared machine change, or a load jump larger than any programmed increment
 * can explain. A cable stack reading 50 where the previous one read 9.1 is not
 * a 440% personal best, and a trophy for it would be the app congratulating the
 * user for walking across the gym.
 *
 * Such a record is still reported, because the set was genuinely performed and
 * hiding it would be its own kind of lie. It is labelled, ranked below verified
 * records, and excluded from "latest PR" on Home.
 */

import * as sessionService from './session-service.js';
import * as programService from './program-service.js';
import { estimate1rm } from '../engine/one-rep-max.js';
import { volumeMultiplier } from '../engine/loading.js';
import { repeatableLoad, repsAtLoad } from '../engine/progression.js';
import { markDiscontinuities, isMachineScaled } from '../engine/context.js';

export { estimate1rm };

export const PR_KINDS = {
  WEIGHT:  'weight',
  WORKING: 'working',
  REPS:    'reps',
  E1RM:    'e1rm',
  VOLUME:  'volume',
};

export const PR_LABELS = {
  [PR_KINDS.WEIGHT]:  'Heaviest single set',
  [PR_KINDS.WORKING]: 'Heaviest working load',
  [PR_KINDS.REPS]:    'Most reps',
  [PR_KINDS.E1RM]:    'Estimated 1RM',
  [PR_KINDS.VOLUME]:  'Volume',
};

/**
 * The kinds worth putting a trophy on, in order.
 *
 * `working` leads because it is the one that answers "how strong am I" rather
 * than "what did I once touch".
 */
export const HEADLINE_KINDS = [PR_KINDS.WORKING, PR_KINDS.E1RM, PR_KINDS.WEIGHT];

/**
 * Best records for one exercise across all completed sessions.
 * Returns null when the exercise has never been logged with load.
 */
export function getRecordsFor(exerciseId) {
  const history = sessionService.getExerciseHistory(exerciseId, Infinity);
  if (!history.length) return null;

  const exercise = programService.getExercise(exerciseId);
  // Records come from working sets only: `getExerciseHistory` supplies nothing
  // else, so a drop set to a weight never held for a working set cannot become
  // a "heaviest weight" PR. Each load counts once — see engine/loading.js.
  const multiplier = volumeMultiplier(exercise);

  // Which sessions sit on a load scale change. Computed once for the whole
  // history rather than per set, because it is a property of the session.
  const suspect = suspectSessions(exercise, history);

  let weight = null;
  let working = null;
  let reps = null;
  let e1rm = null;
  let volume = null;

  // History is newest-first; walk oldest-first so that ties keep the earliest
  // date — a record belongs to the session that first achieved it.
  for (const performance of [...history].reverse()) {
    let sessionVolume = 0;
    const caveat = suspect.get(performance.date) ?? null;
    const stamp = {
      date: performance.date,
      sessionId: performance.sessionId,
      unverified: Boolean(caveat),
      caveat,
    };

    for (const set of performance.sets) {
      const load = set.weightKg ?? 0;
      const setReps = set.reps ?? 0;
      if (!setReps) continue;

      sessionVolume += load * setReps * multiplier;

      if (load > 0 && beats(weight, load)) {
        weight = { value: load, reps: setReps, ...stamp };
      }

      if (beats(reps, setReps)) {
        reps = { value: setReps, weightKg: load, ...stamp };
      }

      const estimated = estimate1rm(load, setReps);
      if (estimated > 0 && beats(e1rm, estimated)) {
        e1rm = { value: estimated, weightKg: load, reps: setReps, ...stamp };
      }
    }

    // The load actually repeated, which is the record that says what the lifter
    // can do rather than what they once touched.
    const repeatable = repeatableLoad(performance);
    if (repeatable !== null && repeatable > 0 && beats(working, repeatable)) {
      const atLoad = repsAtLoad(performance, repeatable)
        .filter((value) => value !== null && value > 0);
      working = {
        value: repeatable,
        reps: atLoad.length ? Math.max(...atLoad) : null,
        sets: atLoad.length,
        ...stamp,
      };
    }

    if (sessionVolume > 0 && beats(volume, sessionVolume)) {
      volume = { value: sessionVolume, ...stamp };
    }
  }

  if (!weight && !working && !reps && !e1rm && !volume) return null;

  return { exerciseId, name: exercise?.name ?? exerciseId, weight, working, reps, e1rm, volume };
}

/**
 * A record only loses to a *verified* better one.
 *
 * Without this, one session on a heavier-reading cable stack would take every
 * record permanently and the verified history behind it would be unreachable —
 * the app would show a caveated trophy forever and never mention the real best.
 * A verified record therefore always beats an unverified one, whatever the
 * numbers say, and only then does magnitude decide.
 */
function beats(current, value) {
  if (!current) return true;
  if (current.unverified) return true;
  return value > current.value;
}

/**
 * Sessions whose loads sit on a scale change, mapped to the reason.
 *
 * Machine-scaled movements only. A dumbbell reading 24 is 24 kg in every gym,
 * so a dumbbell PR needs no caveat and inventing one would be noise.
 */
function suspectSessions(exercise, history) {
  const out = new Map();
  if (!isMachineScaled(exercise)) return out;

  const marked = markDiscontinuities(
    [...history].reverse()
      .map((performance) => ({
        date: performance.date,
        legacy: Boolean(performance.legacy),
        contextKey: performance.contextKey,
        loadKg: repeatableLoad(performance),
      })),
    { machineScaled: true }
  );

  for (const point of marked) {
    if (!point.contextChanged && !point.discontinuous) continue;
    out.set(point.date, point.contextChanged
      ? 'Set on a different machine from the session before it, so it is not comparable.'
      : 'The load jumped further than a programmed increment allows, which usually means a '
        + 'different machine. Tag the machine to confirm or clear this.');
  }

  return out;
}

/**
 * Records for every exercise that has history.
 *
 * Retired movements are included. A record is a thing that happened; dropping
 * the Back Squat from the split does not un-lift the heaviest set of it, and
 * silently deleting that PR would make the feed a record of the current program
 * rather than of the training. `getRecordsFor` returns null for anything never
 * logged, so a retired movement with no history costs nothing.
 */
export function getAllRecords() {
  return [...programService.getAllExercises(), ...programService.getRetiredExercises()]
    .map((exercise) => getRecordsFor(exercise.id))
    .filter(Boolean);
}

/**
 * Every record as a flat, date-sorted list — newest first.
 * Used for the PR feed and for "Latest PR" on Home.
 */
export function getRecordFeed() {
  const feed = [];

  for (const record of getAllRecords()) {
    for (const kind of Object.values(PR_KINDS)) {
      const entry = record[kind];
      if (!entry) continue;
      feed.push({
        kind,
        label: PR_LABELS[kind],
        exerciseId: record.exerciseId,
        exerciseName: record.name,
        date: entry.date,
        sessionId: entry.sessionId,
        value: entry.value,
        reps: entry.reps ?? null,
        sets: entry.sets ?? null,
        weightKg: entry.weightKg ?? null,
        unverified: Boolean(entry.unverified),
        caveat: entry.caveat ?? null,
      });
    }
  }

  return feed.sort((a, b) => b.date.localeCompare(a.date));
}

/** Records the app is willing to state without a caveat. */
export function getVerifiedFeed() {
  return getRecordFeed().filter((entry) => !entry.unverified);
}

/**
 * The single most recent personal record.
 *
 * A session usually sets several records at once, so a plain "newest" pick
 * would be whichever exercise happened to sort first — effectively random.
 * Two tie-breaks make it deterministic and meaningful: prefer estimated 1RM,
 * because it captures "I got stronger" rather than "I did more sets", and
 * among those prefer the heaviest, so the headline record is the biggest lift
 * of the day rather than an incidental one.
 */
export function getLatestRecord() {
  // Verified only. A caveated record on Home would be the app leading with a
  // number it does not believe.
  const feed = getVerifiedFeed();
  if (!feed.length) return null;

  const newestDate = feed[0].date;
  const sameDay = feed.filter((entry) => entry.date === newestDate);
  const priority = [PR_KINDS.WORKING, PR_KINDS.E1RM, PR_KINDS.WEIGHT, PR_KINDS.REPS, PR_KINDS.VOLUME];

  for (const kind of priority) {
    const matches = sameDay
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => b.value - a.value);
    if (matches.length) return matches[0];
  }
  return sameDay[0];
}

/**
 * Records that a specific session set.
 *
 * Because records are derived from the whole log rather than stored, this is
 * simply the feed filtered by session — which means it stays correct if that
 * session is later edited or deleted.
 */
export function getRecordsSetIn(sessionId) {
  return getRecordFeed().filter((entry) => entry.sessionId === sessionId);
}

/** Records set within the last `days` days. */
export function getRecentRecords(days = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  return getRecordFeed().filter((entry) => entry.date > cutoffKey);
}

/** How a PR reads in one line: "42.5 kg × 8". */
export function describeRecord(record) {
  if (!record) return '—';
  const round = (value) => String(Number(Number(value).toFixed(1)));

  switch (record.kind) {
    case PR_KINDS.WEIGHT:
      return `${round(record.value)} kg × ${record.reps}`;
    case PR_KINDS.WORKING:
      return record.sets
        ? `${round(record.value)} kg × ${record.sets} ${record.sets === 1 ? 'set' : 'sets'}`
        : `${round(record.value)} kg`;
    case PR_KINDS.REPS:
      return record.weightKg
        ? `${record.value} reps @ ${round(record.weightKg)} kg`
        : `${record.value} reps`;
    case PR_KINDS.E1RM:
      return `${round(record.value)} kg est. 1RM`;
    case PR_KINDS.VOLUME:
      return `${round(record.value)} kg total`;
    default:
      return round(record.value);
  }
}
