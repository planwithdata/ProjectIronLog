/**
 * context.js — Which machine the numbers came off, and when they stop being
 * comparable.
 *
 * Pure: no imports, no storage, no clock.
 *
 * The problem this solves
 * ----------------------
 * A cable stack is not a unit of measurement. Rish trains rope pushdowns at
 * "9.1" on one machine and "20" on another, and low-to-high flies at "4.5" on
 * one and "10" on the next. Both are the same effort for the same reps. The app
 * has always stored the reading verbatim and refused to normalise it, which is
 * right — but it then compared those readings to each other across sessions,
 * which turned walking to a different machine into a 120% strength gain.
 *
 * So a load is only ever compared against another load from the *same context*:
 * the same machine, with the same attachment. Anything else is a different
 * scale, and the honest thing to say about a scale change is that the number
 * changed and the strength is unknown — not that it doubled.
 *
 * Two mechanisms, and they are deliberately different:
 *
 *   1. **Declared context.** The user tags an entry with a machine label and an
 *      attachment. Exact, cheap, and the only thing that can actually be known.
 *      `contextKey` turns that into a comparison key.
 *
 *   2. **Detected discontinuity.** For history that was never tagged — which is
 *      all of it before this build — a load that moves by far more than a
 *      programmed increment is flagged as *not comparable*, without claiming to
 *      know why. It is not reclassified and nothing is rewritten: the flag only
 *      stops the engine and the charts asserting a strength change they cannot
 *      support. See `detectDiscontinuity` for the threshold and why it is where
 *      it is.
 *
 * Note the asymmetry: a declared context is a fact, a detected discontinuity is
 * a suspicion. They are reported under different names throughout, and only the
 * first is ever presented to the user as certain.
 */

/** Comparison key used when an entry carries no context at all. */
export const DEFAULT_CONTEXT = 'default';

/**
 * Loading conventions whose stored number is an arbitrary machine reading
 * rather than a mass. Only these are subject to discontinuity detection: a
 * dumbbell that says 24 weighs 24 on every rack in the world, and flagging a
 * jump from 20 to 30 kg of plates as "possibly a different barbell" would be
 * nonsense.
 */
export const MACHINE_SCALED = new Set(['machine']);

/**
 * How far a load may move between two sessions before it stops being read as
 * training.
 *
 * 1.35 is not arbitrary. The program's increments are 1-2.5 kg on loads from
 * about 5 to 200 kg, so a genuine session-to-session change is at most a few
 * per cent on a compound and rarely past 25% on the lightest cable work — a
 * 30 lb pin moving to 35 lb is +17%, and 4.5 to 5.5 kg is +22%. The machine
 * changes in the real log are +120% and worse. 1.35 sits in the empty space
 * between those two populations rather than at a round number between them.
 */
export const DISCONTINUITY_RATIO = 1.35;

/**
 * And a floor, so the ratio test cannot fire on trivia. At 3 kg a single pin
 * is already a 30% move; without an absolute minimum every light cable
 * movement would be permanently flagged.
 */
export const DISCONTINUITY_MIN_KG = 2;

/* --- Declared context --------------------------------------------------- */

/**
 * The comparison key for one entry or performance.
 *
 * Machine and attachment both take part, because a rope and a straight bar on
 * the same stack do not move the same pin for the same effort. A substituted
 * movement gets its own key for the same reason.
 *
 * Case- and space-insensitive, so "Stack A" and "stack a" are one machine
 * rather than two.
 */
export function contextKey(source) {
  if (!source) return DEFAULT_CONTEXT;
  const context = source.context ?? null;
  const substitution = source.substitution ?? null;

  const parts = [
    normalise(context?.machineId ?? context?.label),
    normalise(context?.attachment),
    // A substitution is a context change by definition: the movement itself
    // differs, so its loads belong to their own series.
    substitution && substitution.comparableLoad === false
      ? `sub:${normalise(substitution.performedId)}`
      : '',
  ].filter(Boolean);

  return parts.length ? parts.join('|') : DEFAULT_CONTEXT;
}

/** Do two entries carry loads that may be compared to each other? */
export function sameContext(a, b) {
  return contextKey(a) === contextKey(b);
}

/** A short human label for a context, or null when there is nothing to say. */
export function describeContext(source) {
  const context = source?.context ?? null;
  if (!context) return null;
  const parts = [context.label || context.machineId || null, context.attachment || null]
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Is this exercise's stored number an arbitrary machine reading? */
export function isMachineScaled(exercise, loadEntry) {
  const entry = loadEntry ?? exercise?.loadEntry ?? null;
  if (entry) return MACHINE_SCALED.has(entry);
  // Fall back to the older tags, matching engine/loading.loadEntryFor.
  return exercise?.equipment === 'cable' || exercise?.equipment === 'machine';
}

/* --- Detected discontinuity --------------------------------------------- */

/**
 * Compare two loads from the same declared context and say whether the change
 * is bigger than training can explain.
 *
 * @param {number|null} from  the older load
 * @param {number|null} to    the newer load
 * @returns {{discontinuous: boolean, ratio: number|null, deltaKg: number|null,
 *            direction: 'up'|'down'|'flat'}}
 */
export function compareLoads(from, to) {
  const a = toLoad(from);
  const b = toLoad(to);
  if (a === null || b === null || a <= 0 || b <= 0) {
    return { discontinuous: false, ratio: null, deltaKg: null, direction: 'flat' };
  }

  const ratio = b / a;
  const deltaKg = round2(b - a);
  const direction = b > a ? 'up' : (b < a ? 'down' : 'flat');
  const bigEnough = Math.abs(deltaKg) >= DISCONTINUITY_MIN_KG;
  const farEnough = ratio >= DISCONTINUITY_RATIO || ratio <= 1 / DISCONTINUITY_RATIO;

  return { discontinuous: bigEnough && farEnough, ratio: round2(ratio), deltaKg, direction };
}

/**
 * Walk a load series and mark the points where the scale appears to have
 * changed.
 *
 * Only ever applied to machine-scaled movements, and only between points that
 * share a declared context: if the user has already said "this was a different
 * machine", the app does not need to guess, and a tagged change is a fact
 * rather than a flag.
 *
 * Three ways a point can stop being comparable, and they are kept apart because
 * they warrant different words:
 *
 *   `contextChanged`  the entry declares a different machine. A fact.
 *   `discontinuous`   the load moved further than training explains. A
 *                     suspicion, usually a machine change.
 *   `unclassified`    one side of the comparison predates warm-up/working
 *                     classification, so its "working load" is a coarse
 *                     reading of a mixed session rather than a measurement.
 *
 * The third exists because of a real false positive: week one's face pulls were
 * logged 11.3 / 13.6 / 6.8 / 6.8 in one undifferentiated list, which reads as a
 * 6.8 kg working load, which then made the following week's clean 13.6 look
 * like a doubling. It was neither a machine change nor a strength change — it
 * was an unclassified session being compared with a classified one, and saying
 * "you probably changed machines" about it would be a confident wrong answer.
 *
 * @param {Array<{date: string, loadKg: number|null, contextKey?: string,
 *                legacy?: boolean}>} points  oldest first
 * @param {object} [options]
 * @param {boolean} [options.machineScaled]  false disables load detection
 * @returns {Array<object>} the same points, each with the three flags above
 *          plus `comparable`, `ratio` and `deltaKg`
 */
export function markDiscontinuities(points, { machineScaled = true } = {}) {
  let previous = null;

  return points.map((point) => {
    const key = point.contextKey ?? DEFAULT_CONTEXT;
    const legacy = Boolean(point.legacy);

    if (!previous) {
      previous = { key, loadKg: point.loadKg, legacy };
      return {
        ...point,
        contextChanged: false,
        discontinuous: false,
        unclassified: false,
        comparable: true,
        ratio: null,
        deltaKg: null,
      };
    }

    const contextChanged = key !== previous.key;
    const unclassified = !contextChanged && (legacy || previous.legacy);
    const comparison = contextChanged || unclassified || !machineScaled
      ? { discontinuous: false, ratio: null, deltaKg: null }
      : compareLoads(previous.loadKg, point.loadKg);

    previous = { key, loadKg: point.loadKg ?? previous.loadKg, legacy };

    return {
      ...point,
      contextChanged,
      discontinuous: comparison.discontinuous,
      unclassified,
      comparable: !contextChanged && !unclassified && !comparison.discontinuous,
      ratio: comparison.ratio ?? null,
      deltaKg: comparison.deltaKg ?? null,
    };
  });
}

/**
 * Split a marked series into runs of mutually comparable points.
 *
 * This is what the strength chart draws: one line per segment, with a visible
 * break where the scale changed. A single continuous line across a machine
 * change is a picture of a strength gain that did not happen.
 */
export function segments(marked) {
  const out = [];
  let current = null;

  for (const point of marked) {
    if (!current || !point.comparable) {
      current = { from: point.date, to: point.date, points: [point], reason: segmentReason(point) };
      out.push(current);
    } else {
      current.points.push(point);
      current.to = point.date;
    }
  }

  return out;
}

function segmentReason(point) {
  if (point.contextChanged) return 'context';
  if (point.discontinuous) return 'discontinuity';
  if (point.unclassified) return 'unclassified';
  return 'start';
}

/**
 * One sentence explaining why a load is not being read as a strength change.
 * Returns null when the point is comparable and needs no caveat.
 */
export function explainBreak(point, { exerciseName = 'this movement' } = {}) {
  if (!point) return null;
  if (point.contextChanged) {
    return 'Logged on a different machine or attachment, so the loads are not comparable — '
      + 'the reps are still the honest signal.';
  }
  if (point.discontinuous) {
    const move = point.ratio && point.ratio > 1 ? 'up' : 'down';
    return `The load moved ${move} by far more than a programmed increment. If ${exerciseName} `
      + 'was performed on a different machine, tag it so the history stops reading this as a '
      + 'strength change.';
  }
  if (point.unclassified) {
    return 'One side of this comparison predates warm-up and working-set classification, so its '
      + 'working load is a reading of a mixed session rather than a measurement. Reclassify that '
      + 'session in History and the comparison becomes meaningful.';
  }
  return null;
}

/* --- Helpers ------------------------------------------------------------ */

function normalise(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function toLoad(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
