/**
 * config.js — Build-wide constants.
 *
 * APP_VERSION is the single place the version is written. The service worker
 * keeps its own copy of the cache name because it runs outside the module
 * graph and cannot import this file — bump both together when releasing.
 */

export const APP_NAME = 'Project IronLog';
export const APP_VERSION = '1.8.0';

/** Session of the staged build plan that this code delivers. */
export const BUILD_SESSION = 6;

/**
 * A one-off correction to where the next working weight is measured from.
 *
 * Week 1 was logged as a ramp *inside* the working sets — 150/180/200/220 on
 * the squat, 43/57/63 on a row — because the top set was being used to find a
 * limit rather than to train at. The engine carries the heaviest completed
 * working set forward (see `engine/progression.workingWeight`), so left alone
 * it would prescribe that one-off probe as the load for *every* set of the
 * coming week. That is not what those numbers meant.
 *
 * Working sets are meant to be stable and repeatable, and the second set is
 * the honest reading of what that was. So for the first `sessions` workouts
 * logged on or after `fromDate`, the baseline is read from working set number
 * `setIndex` of the previous performance instead of from the heaviest one.
 *
 * It expires by itself. Once those five sessions are complete the rule stops
 * applying and ordinary double progression resumes — from whatever was
 * actually logged under it, which by then is a stable working load rather than
 * a probe. Nothing here rewrites history: it changes only what gets
 * *prescribed*, and only for one week.
 *
 * Set `setIndex` to null to switch the whole thing off.
 */
export const WORKING_SET_REBASELINE = {
  /** Local YYYY-MM-DD date the correction starts applying from. */
  fromDate: '2026-08-13',
  /** How many completed sessions it covers — one full 5-day training week. */
  sessions: 5,
  /** Which working set to baseline from, 1-based. */
  setIndex: 2,
};
