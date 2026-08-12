/**
 * training-prefs-service.js — How this user trains.
 *
 * These are conventions, not settings in the usual sense. A theme is a matter
 * of taste; "my dumbbell numbers are the total of both dumbbells" is a fact
 * about the data already in the database, and the app reads it the wrong way
 * round if it does not know.
 *
 * They live in their own collection rather than inside `settings` so that they
 * export, import and migrate as a unit, and so that a glance at a backup shows
 * what the numbers in it mean.
 *
 * Nothing here rewrites stored data. Every preference is applied on the read
 * side, which is what makes it safe to change one on a database that already
 * holds a month of training.
 */

import * as db from './db.js';
import { COLLECTIONS, defaultTrainingPrefs } from './db.js';
import { EVENTS, emit } from '../core/events.js';

/**
 * The preference surface, in the order Settings renders it. Declaring it as
 * data keeps the UI a loop rather than forty lines of near-identical rows, and
 * puts the explanation of each convention next to the convention itself.
 */
export const PREFERENCES = [
  {
    group: 'Reminders',
    key: 'morningWeightReminder',
    label: 'Morning weight reminder',
    help: 'On a training day, asks once whether to log today\'s weight. Never blocks starting a workout.',
    type: 'toggle',
  },
  {
    group: 'Set model',
    key: 'separateWarmupSets',
    label: 'Separate warm-up sets',
    help: 'Ramp-up sets are logged apart from working sets and excluded from progression and volume.',
    type: 'toggle',
  },
  {
    group: 'Set model',
    key: 'defaultWarmupSets',
    label: 'Ramp sets offered',
    help: 'How many ramp-up rows to pre-fill on a compound lift.',
    type: 'number',
    min: 1,
    max: 4,
  },
  {
    group: 'Intensity techniques',
    key: 'dropSetsAllowed',
    label: 'Drop sets',
    help: 'Offer a drop-set sequence on exercises where the program allows it.',
    type: 'toggle',
  },
  {
    group: 'Intensity techniques',
    key: 'failureTechniques',
    label: 'Failure work',
    help: 'Optional means available when you choose it, never prescribed and never required.',
    type: 'choice',
    options: [
      { value: 'optional', label: 'Optional' },
      { value: 'off', label: 'Off' },
    ],
  },
  {
    group: 'Intensity techniques',
    key: 'dropSetsAffectProgression',
    label: 'Count towards progression',
    help: 'Off by design. Only prescribed working sets decide the next programmed weight.',
    type: 'toggle',
    warnOn: true,
  },
  {
    group: 'Chest day',
    key: 'pushupsBeforeChest',
    label: 'Push-ups before chest',
    help: 'Shows the optional pre-workout push-up warm-up on Tuesday.',
    type: 'toggle',
  },
  {
    group: 'Chest day',
    key: 'pushupsCountAsVolume',
    label: 'Count as working volume',
    help: 'Off: warm-up push-ups stay out of chest volume and progression.',
    type: 'toggle',
    warnOn: true,
  },
  {
    group: 'Exercise handling',
    key: 'pullUpMode',
    label: 'Pull-ups',
    help: 'Pain-aware allows fewer pain-free reps, an early stop or a substitution without recording a regression.',
    type: 'choice',
    options: [
      { value: 'pain-aware', label: 'Pain-aware' },
      { value: 'standard', label: 'Standard' },
    ],
  },
  {
    group: 'Exercise handling',
    key: 'abWheelProgression',
    label: 'Ab wheel',
    help: 'Difficulty first: reps, then control and range, then a harder variation. Load last.',
    type: 'choice',
    options: [
      { value: 'difficulty', label: 'Difficulty' },
      { value: 'load', label: 'Load' },
    ],
  },
  {
    group: 'Load conventions',
    key: 'dumbbellDisplay',
    label: 'Dumbbell display',
    help: 'You log the total of both dumbbells. Per hand shows half of it, which is what you pick off the rack.',
    type: 'choice',
    options: [
      { value: 'per-hand', label: 'Per hand' },
      { value: 'total', label: 'Total' },
    ],
  },
  {
    group: 'Load conventions',
    key: 'barbellDisplay',
    label: 'Barbell display',
    help: 'You log the plates only. The bar is added as an estimate where its weight is known.',
    type: 'choice',
    options: [
      { value: 'plates', label: 'Plates' },
      { value: 'total', label: 'With bar' },
    ],
  },
  {
    group: 'Load conventions',
    key: 'dumbbellIncrementBasis',
    label: 'Dumbbell increment',
    help: 'Per hand: "+2.5 kg" means the next pair up, so 5 kg of logged total.',
    type: 'choice',
    options: [
      { value: 'per-hand', label: 'Per hand' },
      { value: 'total', label: 'As logged' },
    ],
  },
  {
    group: 'Load conventions',
    key: 'machineLoadHandling',
    label: 'Machine and cable loads',
    help: 'Raw: the number on that machine, never normalised against another machine.',
    type: 'readonly',
    display: 'Raw machine value',
  },
];

/** Every preference, with defaults filled in for anything missing. */
export function getPrefs() {
  const stored = db.read(COLLECTIONS.TRAINING);
  return { ...defaultTrainingPrefs(), ...(stored ?? {}) };
}

export function get(key) {
  return getPrefs()[key];
}

/** Update one preference. */
export async function set(key, value) {
  await db.update(COLLECTIONS.TRAINING, (prefs) => ({ ...prefs, [key]: value }));
  emit(EVENTS.SETTINGS_CHANGED, { key, value });
  return value;
}

/** Restore the documented defaults. */
export async function reset() {
  await db.write(COLLECTIONS.TRAINING, defaultTrainingPrefs());
  emit(EVENTS.SETTINGS_CHANGED, { key: '*', value: null });
}

/**
 * The subset `engine/loading.js` needs. Passed explicitly rather than read from
 * storage inside the engine, which stays pure.
 */
export function getLoadPrefs() {
  const prefs = getPrefs();
  return {
    dumbbellDisplay: prefs.dumbbellDisplay,
    barbellDisplay: prefs.barbellDisplay,
    dumbbellIncrementBasis: prefs.dumbbellIncrementBasis,
  };
}

/* --- Derived questions the UI asks ------------------------------------- */

/** Should the warm-up section appear for this exercise? */
export function warmupEnabled() {
  return getPrefs().separateWarmupSets !== false;
}

/** Should intensity-technique controls be offered at all? */
export function intensityEnabled() {
  const prefs = getPrefs();
  return prefs.dropSetsAllowed !== false || prefs.failureTechniques !== 'off';
}

export function dropSetsEnabled() {
  return getPrefs().dropSetsAllowed !== false;
}

export function failureSetsEnabled() {
  return getPrefs().failureTechniques !== 'off';
}

export function pushupWarmupEnabled() {
  return getPrefs().pushupsBeforeChest !== false;
}

export function painAwareEnabled() {
  return getPrefs().pullUpMode !== 'standard';
}

export function difficultyProgressionEnabled() {
  return getPrefs().abWheelProgression !== 'load';
}

/** How many ramp rows to pre-fill, bounded to something sensible. */
export function warmupSetCount(fallback = 3) {
  const value = Number(getPrefs().defaultWarmupSets);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(4, Math.max(1, Math.round(value)));
}
