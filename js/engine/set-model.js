/**
 * set-model.js — The three kinds of work in a session, kept apart.
 *
 * Pure: no imports, no storage, no clock.
 *
 * Why the model is shaped this way
 * -------------------------------
 * The program distinguishes ramp-up sets from working sets, and says plainly
 * that ramp-ups "aren't counted in the sets above". Rish also uses drop sets
 * and failure work on accessory lifts by choice. All three are real training
 * and all three belong in the history — but only one of them may move the
 * progression engine.
 *
 * That could have been done by tagging every set in one array with a `kind`
 * and filtering at each call site. It is not, deliberately: there are seven
 * modules that read `entry.sets`, and a filter forgotten in any one of them
 * would silently feed warm-ups to the double-progression engine, which is
 * exactly the failure this change exists to prevent.
 *
 * So the arrays are separate, and `entry.sets` keeps its original name and
 * meaning — *the prescribed working sets*. Code that predates this module, or
 * code that simply forgets, reads working sets and nothing else. Warm-ups and
 * intensity work are additive and have to be asked for by name.
 *
 *   entry = {
 *     exerciseId, targetWeightKg, targetReps, plannedAction, planReason, notes,
 *     setModel:      'v2' | 'legacy',
 *     sets:          [ { weightKg, reps, completed, rpe, kind } ],   // WORKING
 *     warmupSets:    [ { weightKg, reps, completed, kind: 'warmup' } ],
 *     intensitySets: [ { id, type, note, stages: [...] } ],
 *     pain:          null | { score, location, note, action, alternativeId },
 *     difficulty:    null | string,
 *   }
 *
 * `setModel: 'legacy'` marks an entry logged before the distinction existed.
 * Its sets are preserved byte for byte and are *not* reclassified by guesswork
 * — see `isLegacyEntry` for what that costs and why it is still right.
 */

/** What a single logged set is. */
export const SET_KIND = {
  /** A prescribed working set. The only kind progression may read. */
  WORKING: 'working',
  /** A ramp-up set on the way to the working weight. */
  WARMUP: 'warmup',
  /** One rung of a drop-set sequence. */
  DROP: 'drop',
  /** A deliberate to-failure set outside the prescription. */
  FAILURE: 'failure',
  /**
   * Logged before warm-up tracking existed. Treated as working — it is the
   * only information there is — but labelled honestly everywhere it appears.
   */
  LEGACY: 'legacy',
};

/** Optional intensity techniques, which never affect progression. */
export const INTENSITY_TYPE = {
  DROP: 'drop',
  FAILURE: 'failure',
};

/** What the user did when discomfort showed up. */
export const PAIN_ACTION = {
  COMPLETED: 'completed',   // finished as prescribed
  REDUCED: 'reduced',       // fewer pain-free reps
  STOPPED: 'stopped',       // stopped the exercise
  SKIPPED: 'skipped',       // did not start it
};

export const PAIN_ACTION_LABELS = {
  [PAIN_ACTION.COMPLETED]: 'Completed',
  [PAIN_ACTION.REDUCED]: 'Fewer pain-free reps',
  [PAIN_ACTION.STOPPED]: 'Stopped the exercise',
  [PAIN_ACTION.SKIPPED]: 'Skipped due to discomfort',
};

/**
 * Pain at or above this score marks the performance as pain-limited, so the
 * progression engine stops reading it as a strength signal.
 *
 * Not a medical threshold and not a diagnosis — a logging threshold. It exists
 * so that stopping a set because your elbow hurts does not read to the app as
 * getting weaker.
 */
export const PAIN_LIMIT_SCORE = 3;

/* --- Reading an entry --------------------------------------------------- */

/**
 * Fill in the arrays a v2 entry is expected to have, without mutating.
 *
 * Every read path goes through this, so an entry that predates the migration —
 * or one restored from an old backup that somehow skipped it — still reads
 * cleanly instead of throwing on `entry.warmupSets.length`.
 */
export function normalizeEntry(entry) {
  if (!entry) return entry;
  return {
    ...entry,
    sets: Array.isArray(entry.sets) ? entry.sets : [],
    warmupSets: Array.isArray(entry.warmupSets) ? entry.warmupSets : [],
    intensitySets: Array.isArray(entry.intensitySets) ? entry.intensitySets : [],
    pain: entry.pain ?? null,
    difficulty: entry.difficulty ?? null,
    setModel: entry.setModel ?? 'legacy',
  };
}

/** The prescribed working sets. This is what progression reads. */
export function workingSets(entry) {
  return Array.isArray(entry?.sets) ? entry.sets : [];
}

/** Working sets that were actually completed with a real rep count. */
export function completedWorkingSets(entry) {
  return workingSets(entry).filter((set) => set.completed && (set.reps ?? 0) > 0);
}

export function warmupSets(entry) {
  return Array.isArray(entry?.warmupSets) ? entry.warmupSets : [];
}

export function completedWarmupSets(entry) {
  return warmupSets(entry).filter((set) => set.completed && (set.reps ?? 0) > 0);
}

/** Drop-set and failure-set sequences attached to an entry. */
export function intensitySequences(entry) {
  return Array.isArray(entry?.intensitySets) ? entry.intensitySets : [];
}

/** Every stage of every intensity sequence, flattened. */
export function intensityStages(entry) {
  return intensitySequences(entry).flatMap((sequence) =>
    Array.isArray(sequence.stages) ? sequence.stages : []);
}

export function completedIntensityStages(entry) {
  return intensityStages(entry).filter((stage) => stage.completed && (stage.reps ?? 0) > 0);
}

/**
 * Was this entry logged before warm-up/working classification existed?
 *
 * A legacy entry's sets are used as working sets, because that is the only
 * reading available and discarding them would erase real training. What is not
 * done is *inference*: a rising-weight, falling-rep pattern looks exactly like
 * a ramp, but it also looks exactly like a pyramid or like working up to a top
 * set, and the app has no way to tell which. Guessing would rewrite history
 * with a story the user never told it. So it says "unclassified" instead, and
 * offers a manual reclassification control in the session detail view.
 */
export function isLegacyEntry(entry) {
  if (!entry) return false;
  if (entry.setModel === 'legacy') return true;
  if (entry.setModel === 'v2') return false;
  // No marker at all: only treat it as legacy if it actually holds sets.
  return workingSets(entry).length > 0;
}

export function hasWarmup(entry) {
  return warmupSets(entry).length > 0;
}

export function hasIntensityWork(entry) {
  return intensitySequences(entry).length > 0;
}

/* --- Pain --------------------------------------------------------------- */

export function painLog(entry) {
  return entry?.pain ?? null;
}

/**
 * Should this performance be kept out of strength and stall judgements?
 *
 * True when discomfort was logged at or above the threshold, or when the user
 * said they reduced, stopped or skipped. The set data itself is untouched and
 * still shows in history and reports — this only stops the engine reading a
 * pain-shortened session as a regression, which the brief is explicit about.
 */
export function isPainLimited(entry) {
  const pain = painLog(entry);
  if (!pain) return false;
  if (pain.action && pain.action !== PAIN_ACTION.COMPLETED) return true;
  return Number(pain.score ?? 0) >= PAIN_LIMIT_SCORE;
}

/* --- Composition -------------------------------------------------------- */

/**
 * Count what an entry actually contains, by kind.
 *
 * `dropSequences` counts *sequences*, not stages: a three-rung drop set is one
 * piece of intensity work, and reporting it as three extra sets is precisely
 * the misleading arithmetic the brief asks to avoid.
 */
export function composition(entry) {
  const working = workingSets(entry);
  const legacy = isLegacyEntry(entry);
  const sequences = intensitySequences(entry);

  return {
    working: legacy ? 0 : working.length,
    workingDone: legacy ? 0 : working.filter((set) => set.completed).length,
    legacy: legacy ? working.length : 0,
    legacyDone: legacy ? working.filter((set) => set.completed).length : 0,
    warmup: warmupSets(entry).length,
    warmupDone: completedWarmupSets(entry).length,
    dropSequences: sequences.filter((item) => item.type === INTENSITY_TYPE.DROP).length,
    failureSets: sequences.filter((item) => item.type === INTENSITY_TYPE.FAILURE).length,
    dropStages: intensityStages(entry).length,
  };
}

/**
 * "3 working sets + 1 drop-set sequence" — the phrasing reports use.
 *
 * Joined throughout with "+" rather than commas: each term is a different *kind*
 * of work, and a comma list reads as one homogeneous total, which is the exact
 * impression this whole module exists to avoid.
 *
 * Returns an empty string for an entry with nothing logged.
 */
export function describeComposition(entry) {
  const counts = composition(entry);
  const parts = [];

  if (counts.working) parts.push(plural(counts.working, 'working set'));
  if (counts.legacy) parts.push(`${plural(counts.legacy, 'set')} (unclassified)`);
  if (counts.warmup) parts.push(plural(counts.warmup, 'warm-up set'));
  if (counts.dropSequences) parts.push(plural(counts.dropSequences, 'drop-set sequence'));
  if (counts.failureSets) parts.push(plural(counts.failureSets, 'failure set'));

  return parts.join(' + ');
}

/**
 * Volume for one entry, split by the kind of work that produced it.
 *
 * Never summed into a single figure here. A fortnight where warm-up volume
 * doubled and working volume fell is a meaningfully different fortnight from
 * one where the total happened to stay flat, and a single number cannot say so.
 *
 * @param {object} entry
 * @param {number} [multiplier]  from engine/loading.volumeMultiplier
 */
export function entryVolume(entry, multiplier = 1) {
  const sum = (sets) => sets.reduce(
    (total, set) => total + (Number(set.weightKg) || 0) * (Number(set.reps) || 0) * multiplier,
    0
  );

  const working = completedWorkingSets(entry);

  return {
    workingKg: sum(working),
    warmupKg: sum(completedWarmupSets(entry)),
    intensityKg: sum(completedIntensityStages(entry)),
  };
}

/* --- Ramp-up prescription ----------------------------------------------- */

/**
 * Percentages of the working weight for a ramp, by set count, with a rep
 * target for each rung.
 *
 * Light and brief on purpose: a ramp exists to rehearse the movement and wake
 * the joints up, not to accumulate fatigue before the sets that count. Three
 * rungs at 40/60/80% is the standard for a 6-8 rep compound.
 */
export const RAMP_PROFILES = {
  1: [{ percent: 0.5, reps: 8 }],
  2: [{ percent: 0.5, reps: 8 }, { percent: 0.75, reps: 5 }],
  3: [{ percent: 0.4, reps: 8 }, { percent: 0.6, reps: 5 }, { percent: 0.8, reps: 3 }],
  4: [
    { percent: 0.35, reps: 10 }, { percent: 0.5, reps: 8 },
    { percent: 0.65, reps: 5 }, { percent: 0.8, reps: 3 },
  ],
};

/**
 * Suggested ramp sets for a working weight.
 *
 * Returns an empty array when there is no working weight to ramp towards —
 * a first-ever session, or a bodyweight movement. In that case the UI offers
 * empty rows to fill in rather than inventing loads.
 *
 * @param {number|null} workingWeightKg
 * @param {number} [count]      how many ramp sets
 * @param {number} [step]       round each load to a multiple of this
 * @returns {Array<{weightKg: number, reps: number}>}
 */
export function rampSets(workingWeightKg, count = 3, step = 2.5) {
  const target = Number(workingWeightKg);
  const profile = RAMP_PROFILES[clampCount(count)] ?? RAMP_PROFILES[3];
  if (!target || target <= 0) return [];

  return profile.map((rung) => ({
    weightKg: roundTo(target * rung.percent, step),
    reps: rung.reps,
  }));
}

/**
 * Loads for the rungs of a drop set, dropping by a fixed fraction each stage.
 * Only a starting point — every rung is editable, because what is available on
 * the rack decides this more than arithmetic does.
 */
export function dropStages(topWeightKg, stages = 3, dropFraction = 0.2, step = 2.5) {
  const top = Number(topWeightKg);
  if (!top || top <= 0) return Array.from({ length: stages }, () => ({ weightKg: null, reps: null }));

  const out = [];
  let load = top;
  for (let index = 0; index < stages; index += 1) {
    out.push({ weightKg: index === 0 ? roundTo(load, step) : roundTo(load, step), reps: null });
    load *= 1 - dropFraction;
  }
  return out;
}

/* --- Helpers ------------------------------------------------------------ */

function clampCount(count) {
  const n = Math.round(Number(count) || 3);
  return Math.min(4, Math.max(1, n));
}

function roundTo(value, step) {
  if (!step || step <= 0) return round2(value);
  return round2(Math.max(step, Math.round(value / step) * step));
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function plural(count, singular) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
