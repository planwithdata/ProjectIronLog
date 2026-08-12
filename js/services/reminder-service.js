/**
 * reminder-service.js — The morning weigh-in prompt.
 *
 * The whole design constraint here is *not being annoying*. A reminder that
 * interrupts, repeats, or stands between the user and starting a workout would
 * be worse than no reminder, because it would be dismissed by reflex within a
 * week and then ignored forever.
 *
 * So the rules are narrow:
 *
 *   - Only on a training day. A rest-day weigh-in is welcome but not prompted.
 *   - Only if today's weight has not already been logged.
 *   - At most once per calendar day, whether it was answered or skipped.
 *   - Never modal. It renders as a banner in the page flow; the Start Workout
 *     button stays exactly where it was and stays tappable.
 *
 * "Shown" is recorded the moment it renders, not when it is dismissed, so a
 * reload does not bring it back.
 */

import * as db from './db.js';
import { COLLECTIONS } from './db.js';
import { today } from '../core/format.js';
import * as bodyService from './body-service.js';
import * as programService from './program-service.js';
import * as trainingPrefs from './training-prefs-service.js';

/**
 * Should the morning weigh-in prompt appear right now?
 *
 * @param {string} [dayKey]
 * @returns {boolean}
 */
export function shouldPromptForWeight(dayKey = today()) {
  if (!trainingPrefs.getPrefs().morningWeightReminder) return false;

  // Rest and recovery days are part of the program, but the program does not
  // ask for a weigh-in on them, so neither does the app.
  const day = programService.getTodayDay(dayKey);
  if (day?.type !== 'training') return false;

  if (bodyService.getWeightOn(dayKey)) return false;
  if (wasPromptedToday(dayKey)) return false;

  return true;
}

export function wasPromptedToday(dayKey = today()) {
  return db.read(COLLECTIONS.META).lastMorningPromptDate === dayKey;
}

/**
 * Record that the prompt has been shown today.
 *
 * Called on render rather than on dismissal: the point of the once-a-day rule
 * is that the prompt does not come back, and a user who navigates away without
 * touching it has still seen it.
 */
export async function markPrompted(dayKey = today()) {
  if (wasPromptedToday(dayKey)) return;
  await db.update(COLLECTIONS.META, (meta) => ({ ...meta, lastMorningPromptDate: dayKey }));
}

/** Clear the once-a-day guard — used by the Settings toggle and by tests. */
export async function resetPrompt() {
  await db.update(COLLECTIONS.META, (meta) => ({ ...meta, lastMorningPromptDate: null }));
}
