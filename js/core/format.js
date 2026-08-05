/**
 * format.js — Date, number and unit formatting.
 *
 * Date handling policy
 * --------------------
 * Every date this app stores is a *local calendar day* ("the day I trained"),
 * not an instant. Storing ISO timestamps would mean a workout logged at
 * 22:00 IST could read back as the previous day after a timezone change, so
 * days are stored as plain `YYYY-MM-DD` strings and parsed at local noon —
 * noon, not midnight, so a DST shift can never roll the date backwards.
 */

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT  = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* --- Dates ------------------------------------------------------------- */

/** Today as `YYYY-MM-DD` in the device's local timezone. */
export function today() {
  return toDayKey(new Date());
}

/** Convert a Date to a local `YYYY-MM-DD` key. */
export function toDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse a `YYYY-MM-DD` key into a Date at local noon. */
export function fromDayKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

/** Whole days between two day keys (b - a). Negative if b precedes a. */
export function daysBetween(aKey, bKey) {
  const MS_PER_DAY = 86400000;
  return Math.round((fromDayKey(bKey) - fromDayKey(aKey)) / MS_PER_DAY);
}

/** Shift a day key by a number of days. */
export function addDays(key, delta) {
  const date = fromDayKey(key);
  date.setDate(date.getDate() + delta);
  return toDayKey(date);
}

/**
 * ISO weekday for a day key: 1 = Monday … 7 = Sunday.
 * The program's `weekday` fields use this convention.
 */
export function isoWeekday(key = today()) {
  const jsDay = fromDayKey(key).getDay(); // 0 = Sunday
  return jsDay === 0 ? 7 : jsDay;
}

/** "Tuesday" */
export function weekdayName(key = today()) {
  return WEEKDAY_LONG[fromDayKey(key).getDay()];
}

/** "5 Aug 2026" — or "5 Aug" when the year matches today. */
export function formatDate(key, { withYear = 'auto' } = {}) {
  if (!key) return '—';
  const date = fromDayKey(key);
  const showYear = withYear === true
    || (withYear === 'auto' && date.getFullYear() !== new Date().getFullYear());
  const base = `${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;
  return showYear ? `${base} ${date.getFullYear()}` : base;
}

/** "Today", "Yesterday", "3 days ago", then falls back to a date. */
export function relativeDay(key) {
  if (!key) return '—';
  const delta = daysBetween(key, today());
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Yesterday';
  if (delta === -1) return 'Tomorrow';
  if (delta > 1 && delta < 7) return `${delta} days ago`;
  if (delta < -1 && delta > -7) return `in ${Math.abs(delta)} days`;
  return formatDate(key);
}

/** "3 days", "1 day", "Today" — for countdowns. */
export function formatDayCount(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return '—';
  if (days <= 0) return 'Due now';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/* --- Durations --------------------------------------------------------- */

/** Seconds to `M:SS`, for the rest timer. */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Seconds to a compact human duration: "45s", "2 min", "1h 12m". */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/* --- Numbers ----------------------------------------------------------- */

/**
 * Trim trailing zeroes from a fixed-decimal number: 27.50 -> "27.5", 30.0 -> "30".
 * Gym weights are read at a glance; "30" beats "30.0".
 */
export function trimNumber(value, maxDecimals = 2) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return String(Number(n.toFixed(maxDecimals)));
}

/** A signed delta: "+0.5", "-1.2", "0". */
export function formatDelta(value, maxDecimals = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const body = trimNumber(Math.abs(n), maxDecimals);
  if (Number(body) === 0) return '0';
  return `${n > 0 ? '+' : '−'}${body}`;
}

/** Direction of a delta, for colour coding: 'up' | 'down' | 'flat'. */
export function deltaDirection(value, epsilon = 0.001) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'flat';
  const n = Number(value);
  if (n > epsilon) return 'up';
  if (n < -epsilon) return 'down';
  return 'flat';
}

/** "27.5 kg" */
export function formatWeight(value, unit = 'kg') {
  if (value === null || value === undefined || value === '') return '—';
  return `${trimNumber(value)} ${unit}`;
}

/** Round to the nearest step — used when suggesting the next load. */
export function roundToStep(value, step) {
  if (!step || step <= 0) return value;
  return Math.round(value / step) * step;
}

/** Clamp into an inclusive range. */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Percentage 0–100, rounded, safe against a zero denominator. */
export function percent(numerator, denominator) {
  if (!denominator) return 0;
  return clamp(Math.round((numerator / denominator) * 100), 0, 100);
}

/* --- Units ------------------------------------------------------------- */

const KG_PER_LB = 0.45359237;

export const toLb = (kg) => kg / KG_PER_LB;
export const toKg = (lb) => lb * KG_PER_LB;

/**
 * Convert a stored value (always kilograms) into the user's display unit.
 * Storage stays canonical in kg so that switching units never rewrites data.
 */
export function displayWeight(kg, unit = 'kg') {
  if (kg === null || kg === undefined || kg === '') return null;
  return unit === 'lb' ? toLb(Number(kg)) : Number(kg);
}

/** Convert a value the user typed in `unit` back into canonical kilograms. */
export function storeWeight(value, unit = 'kg') {
  if (value === null || value === undefined || value === '') return null;
  return unit === 'lb' ? toKg(Number(value)) : Number(value);
}

/** Pluralise a count: `pluralize(1, 'set')` -> "1 set". */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
