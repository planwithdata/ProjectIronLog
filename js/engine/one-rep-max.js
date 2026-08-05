/**
 * one-rep-max.js — Estimated 1RM.
 *
 * Pure, so it can be tested outside a browser alongside the progression
 * engine. Lives in `engine/` rather than in pr-service.js for that reason.
 */

/**
 * Epley estimated one-rep max.
 *
 * Chosen over Brzycki because it stays sane across the 6-15 rep ranges this
 * program actually prescribes; Brzycki degrades badly past about 12 reps.
 * Both are estimates — what matters is that one formula is applied
 * consistently, so trends over time mean something.
 *
 * @param {number} weightKg
 * @param {number} reps
 * @returns {number} estimated 1RM in kg, or 0 when there is nothing to estimate
 */
export function estimate1rm(weightKg, reps) {
  const load = Number(weightKg);
  const count = Number(reps);
  if (!load || !count || count < 1) return 0;
  if (count === 1) return load;
  return load * (1 + count / 30);
}

/**
 * The load that should allow a target rep count, given a known 1RM.
 * The inverse of `estimate1rm`. Used by the reports layer to describe
 * strength changes in terms the user actually lifts.
 */
export function loadForReps(oneRepMax, reps) {
  const max = Number(oneRepMax);
  const count = Number(reps);
  if (!max || !count || count < 1) return 0;
  if (count === 1) return max;
  return max / (1 + count / 30);
}
