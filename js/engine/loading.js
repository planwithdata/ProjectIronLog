/**
 * loading.js — What a logged number *means*.
 *
 * Pure, like the other engine modules: no imports, no storage, no clock. It
 * takes an exercise, a stored kilogram value and the user's display
 * preferences, and returns a descriptor the view layer can format.
 *
 * The problem this solves
 * ----------------------
 * "40 kg" is not one thing. On a barbell it is the plates, with a 20 kg bar
 * underneath it. On dumbbells it is both dumbbells together, so it is 20 kg in
 * each hand. On a cable stack it is whatever that particular machine calls 40,
 * which is not comparable to the machine beside it. The number the user types
 * is the number the user reads off the equipment, and the app's job is to
 * *label* it correctly rather than to convert it into some canonical truth.
 *
 * Rish's conventions, which this module encodes (see README, "Rish's Training
 * Preferences"):
 *
 *   barbell    — the plates only. The bar is not included. Display "+40 kg
 *                plates", optionally with an estimated total when the bar
 *                weight is known.
 *   dumbbell   — the total of BOTH dumbbells. Display per hand, because that is
 *                what you pick off the rack: stored 55 -> "27.5 kg / hand".
 *   machine    — the raw value on that machine. Never normalised, never
 *                compared across machines.
 *   bodyweight — added load only; body weight itself is tracked separately.
 *
 * Storage is never rewritten to suit a display choice. Every function here is
 * a read-side transform, which is what makes switching a preference safe on a
 * database that already holds a month of training.
 */

/** How the stored number relates to the load on the body. */
export const LOAD_ENTRY = {
  /** Stored = added plates. A bar may sit under it. */
  PLATES: 'plates',
  /** Stored = both dumbbells summed. Half of it is in each hand. */
  TOTAL_BOTH: 'total-both',
  /** Stored = the reading on that machine or stack. Not comparable elsewhere. */
  MACHINE: 'machine',
  /** Stored = added load only; 0 or null means unloaded body weight. */
  BODYWEIGHT: 'bodyweight-plus-added',
};

/**
 * Display preferences, with the defaults Rish trains by. A caller that passes
 * nothing gets these, so every function here is safe to call bare.
 */
export const DEFAULT_LOAD_PREFS = {
  /** 'per-hand' shows half the stored total; 'total' shows it as logged. */
  dumbbellDisplay: 'per-hand',
  /** 'plates' shows the added load; 'total' adds the bar in. */
  barbellDisplay: 'plates',
  /**
   * Which side of a dumbbell pair the program's increment refers to.
   *
   * The program says "+2.5-5 kg" for Incline Dumbbell Press. Dumbbells come in
   * pairs, so the smallest real jump is the next pair up — 2.5 kg per hand,
   * which is 5 kg of stored total. Reading the increment as a total instead
   * would recommend 52.5 kg (26.25 per hand), a dumbbell that does not exist
   * on any rack.
   */
  dumbbellIncrementBasis: 'per-hand',
};

/* --- Classification ----------------------------------------------------- */

/**
 * The loading convention for one exercise.
 *
 * An explicit `loadEntry` in workouts.json always wins. Everything else is
 * inferred from the older `loadType` / `equipment` pair, so a program document
 * that has not been updated still behaves correctly rather than falling into a
 * default that mislabels dumbbells.
 */
export function loadEntryFor(exercise) {
  if (!exercise) return LOAD_ENTRY.MACHINE;
  if (exercise.loadEntry) return exercise.loadEntry;

  if (exercise.loadType === 'bodyweight-plus-added') return LOAD_ENTRY.BODYWEIGHT;
  if (exercise.equipment === 'barbell') return LOAD_ENTRY.PLATES;

  // Equipment decides before the older `loadType` does, because `loadType:
  // 'per-hand'` historically meant two different things at once: a dumbbell
  // pair, and a cable movement run one side at a time. Only the first is a pair
  // of loads to halve; a single cable stack is just a machine reading.
  if (exercise.equipment === 'dumbbell') return LOAD_ENTRY.TOTAL_BOTH;

  return LOAD_ENTRY.MACHINE;
}

/** Does this exercise's stored number cover both limbs at once? */
export function isPairedLoad(exercise) {
  return loadEntryFor(exercise) === LOAD_ENTRY.TOTAL_BOTH;
}

/**
 * Whether the machine reading applies to one side only.
 *
 * A two-stack cable fly is set to 8 on each side. The reading is still the raw
 * machine value — it is not doubled and not normalised — but the label says
 * "per side" so a future reader knows what the 8 referred to.
 */
export function isPerSideMachine(exercise) {
  return loadEntryFor(exercise) === LOAD_ENTRY.MACHINE
    && (exercise?.perSideLoad === true || exercise?.loadType === 'per-hand');
}

/* --- Volume ------------------------------------------------------------- */

/**
 * Multiplier applied to a stored load when accumulating volume.
 *
 * This is 1 for every convention above, and that is the point. An earlier
 * build doubled dumbbell loads on the assumption that the logged number was
 * per hand; under the convention actually used — both dumbbells summed — the
 * stored number is already the whole load, so doubling it counted every
 * dumbbell set twice.
 *
 * Kept as a function rather than deleted at the call sites: it is the seam
 * where a future convention (a genuinely per-hand log, say) would be handled,
 * and one named function is easier to audit than five inline `? 2 : 1`s.
 */
export function volumeMultiplier(exercise) {
  switch (loadEntryFor(exercise)) {
    case LOAD_ENTRY.TOTAL_BOTH: return 1;   // already both dumbbells
    case LOAD_ENTRY.PLATES:     return 1;   // plates only, bar excluded by design
    case LOAD_ENTRY.BODYWEIGHT: return 1;   // added load only
    default:                    return 1;   // raw machine value
  }
}

/* --- Increments --------------------------------------------------------- */

/**
 * Scale factor from a program increment to a step in stored units.
 *
 * @param {object} exercise
 * @param {object} [prefs]  merged over DEFAULT_LOAD_PREFS
 * @returns {number} 2 for a dumbbell pair on a per-hand basis, else 1
 */
export function incrementScale(exercise, prefs = DEFAULT_LOAD_PREFS) {
  const merged = { ...DEFAULT_LOAD_PREFS, ...prefs };
  if (!isPairedLoad(exercise)) return 1;
  return merged.dumbbellIncrementBasis === 'per-hand' ? 2 : 1;
}

/* --- Description -------------------------------------------------------- */

/**
 * Describe a stored load for display.
 *
 * Returns plain data rather than a string so the view layer can apply the
 * user's kg/lb preference and its own typography. `core/format.formatLoad`
 * turns this into text.
 *
 * @param {object} exercise
 * @param {number|null} weightKg   the stored value, in kilograms
 * @param {object} [prefs]
 * @returns {{
 *   entry: string,
 *   displayKg: number|null,
 *   qualifier: string,
 *   prefix: string,
 *   bodyweight: boolean,
 *   secondaryKg: number|null,
 *   secondaryQualifier: string,
 *   storedKg: number|null,
 * }}
 */
export function describeLoad(exercise, weightKg, prefs = DEFAULT_LOAD_PREFS) {
  const merged = { ...DEFAULT_LOAD_PREFS, ...prefs };
  const entry = loadEntryFor(exercise);
  const stored = weightKg === null || weightKg === undefined || weightKg === ''
    ? null
    : Number(weightKg);

  const base = {
    entry,
    displayKg: stored,
    qualifier: '',
    prefix: '',
    bodyweight: false,
    secondaryKg: null,
    secondaryQualifier: '',
    storedKg: stored,
  };

  switch (entry) {
    case LOAD_ENTRY.TOTAL_BOTH: {
      if (stored === null) return base;
      if (merged.dumbbellDisplay === 'total') {
        return { ...base, qualifier: 'total', secondaryKg: half(stored), secondaryQualifier: '/ hand' };
      }
      return {
        ...base,
        displayKg: half(stored),
        qualifier: '/ hand',
        secondaryKg: stored,
        secondaryQualifier: 'total',
      };
    }

    case LOAD_ENTRY.PLATES: {
      if (stored === null) return base;
      const bar = barWeightKg(exercise);
      if (merged.barbellDisplay === 'total' && bar !== null) {
        return {
          ...base,
          displayKg: round2(stored + bar),
          qualifier: 'total',
          secondaryKg: stored,
          secondaryQualifier: 'plates',
        };
      }
      return {
        ...base,
        prefix: '+',
        qualifier: 'plates',
        // Only offered when the bar is actually known. Inventing a 20 kg bar
        // for an EZ bar or a fixed-weight barbell would be a guess presented
        // as a measurement.
        secondaryKg: bar === null ? null : round2(stored + bar),
        secondaryQualifier: bar === null ? '' : 'est. total',
      };
    }

    case LOAD_ENTRY.BODYWEIGHT: {
      if (stored === null || stored === 0) {
        return { ...base, displayKg: null, bodyweight: true };
      }
      return { ...base, prefix: '+', bodyweight: true };
    }

    default:
      return { ...base, qualifier: isPerSideMachine(exercise) ? 'per side' : '' };
  }
}

/**
 * The load the user should set on the equipment, given a stored value.
 * Used by the workout screen's "Recommended" line, which has to be actionable:
 * "27.5 kg / hand" is something you can go and pick up.
 */
export function actionableLoadKg(exercise, weightKg, prefs = DEFAULT_LOAD_PREFS) {
  return describeLoad(exercise, weightKg, prefs).displayKg;
}

/** Bar weight for a barbell movement, or null when it is not configured. */
export function barWeightKg(exercise) {
  const bar = exercise?.barWeightKg;
  return typeof bar === 'number' && bar > 0 ? bar : null;
}

/* --- Helpers ------------------------------------------------------------ */

function half(value) {
  return round2(Number(value) / 2);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
