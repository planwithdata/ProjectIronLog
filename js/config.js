/**
 * config.js — Build-wide constants.
 *
 * APP_VERSION is the single place the version is written. The service worker
 * keeps its own copy of the cache name because it runs outside the module
 * graph and cannot import this file — bump both together when releasing.
 */

export const APP_NAME = 'Project IronLog';
export const APP_VERSION = '1.9.4';

/** Session of the staged build plan that this code delivers. */
export const BUILD_SESSION = 7;

/**
 * A one-off correction to where the next working weight is measured from.
 *
 * **Retired, and deliberately left in place as a switch rather than deleted.**
 *
 * Week 1 was logged as a ramp *inside* the working sets — 150/180/200/220 on
 * the hack squat, 43/57/63 on a row — because the top set was being used to
 * find a limit rather than to train at. The engine carried the heaviest
 * completed working set forward, so left alone it would have prescribed that
 * one-off probe as the load for *every* set of the coming week. This rule
 * corrected it by hand, for five sessions, by reading the load from working
 * set 2 instead.
 *
 * That was a patch on a symptom. The engine now reads the **repeatable** load
 * by default — the load at least half the working sets were actually performed
 * at, which on a ramp is the second rung and on a session with one heavier
 * probe is the load underneath it. See `engine/progression.repeatableLoad`.
 * The same reading the dated rule made for one week is now the permanent one
 * for every week, and it also catches the case this rule missed entirely: the
 * 72 kg flat dumbbell bench set logged in week 3, three weeks after the window
 * had closed.
 *
 * `setIndex: null` switches it off. The mechanism stays because it is the seam
 * where a future "read this exercise from set N" correction would go, and
 * `session-service.baselineSetIndex` is tested against it.
 */
export const WORKING_SET_REBASELINE = {
  /** Local YYYY-MM-DD date the correction starts applying from. */
  fromDate: '2026-08-13',
  /** How many completed sessions it covers — one full 5-day training week. */
  sessions: 5,
  /** Which working set to baseline from, 1-based. Null disables the rule. */
  setIndex: null,
};
