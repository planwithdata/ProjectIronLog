/**
 * analytics.js — Pure derivations for the Progress dashboard.
 *
 * Like progression.js, this module imports nothing and touches no storage:
 * every function takes plain arrays and returns plain arrays. That keeps the
 * chart maths testable in Node, and keeps the service layer above it free to
 * worry only about where the data came from.
 *
 * Series shape throughout: `[{ date: 'YYYY-MM-DD', value: number }]`, sorted
 * oldest first.
 */

/* --- Rolling averages --------------------------------------------------- */

/**
 * Centre-free trailing rolling mean over a *calendar* window.
 *
 * Windowing by date rather than by sample count is the whole point: body
 * weight is logged most mornings but not all of them, and a 7-sample mean over
 * gappy data silently compares this week with a fortnight ago. A 7-day window
 * always means seven days.
 *
 * @param {Array<{date: string, value: number}>} series  oldest first
 * @param {number} days
 * @param {number} [minSamples]  points required before a value is emitted
 * @returns {Array<{date: string, value: number, count: number}>}
 */
export function rollingAverage(series, days = 7, minSamples = 2) {
  const out = [];

  for (let i = 0; i < series.length; i += 1) {
    const end = series[i].date;
    const start = shiftDay(end, -(days - 1));

    let sum = 0;
    let count = 0;
    // Walk backwards from i; the series is sorted, so we can stop early.
    for (let j = i; j >= 0; j -= 1) {
      if (series[j].date < start) break;
      sum += series[j].value;
      count += 1;
    }

    if (count >= minSamples) {
      out.push({ date: end, value: sum / count, count });
    }
  }

  return out;
}

/**
 * Rate of change per week, from the first to the last point of a rolling
 * average. Reported over the actual span rather than assumed to be weekly, so
 * a partial window does not exaggerate the trend.
 *
 * @returns {{perWeek: number, days: number, from: number, to: number}|null}
 */
export function trendPerWeek(smoothed) {
  if (!smoothed || smoothed.length < 2) return null;
  const first = smoothed[0];
  const last = smoothed[smoothed.length - 1];
  const days = daysApart(first.date, last.date);
  if (days <= 0) return null;
  return {
    perWeek: ((last.value - first.value) / days) * 7,
    days,
    from: first.value,
    to: last.value,
  };
}

/* --- Bucketing ---------------------------------------------------------- */

/**
 * Group dated items into ISO weeks (Monday-start).
 *
 * @param {Array<object>} items          each needs a `date` day key
 * @param {(bucket: object[]) => number} reduce  turns a week's items into a value
 * @returns {Array<{date: string, value: number, count: number, label: string}>}
 *          `date` is that week's Monday
 */
export function byWeek(items, reduce) {
  const buckets = new Map();

  for (const item of items) {
    const monday = weekStart(item.date);
    if (!buckets.has(monday)) buckets.set(monday, []);
    buckets.get(monday).push(item);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monday, group]) => ({
      date: monday,
      value: reduce(group),
      count: group.length,
      label: weekLabel(monday),
    }));
}

/**
 * Fill in weeks with no data between the first and last, so a gap reads as a
 * gap rather than closing up. Bars for empty weeks are genuinely zero.
 */
export function fillWeeks(weeks) {
  if (weeks.length < 2) return weeks;

  const filled = [];
  let cursor = weeks[0].date;
  const last = weeks[weeks.length - 1].date;
  const bySunday = new Map(weeks.map((week) => [week.date, week]));

  // Hard cap so a corrupt date cannot spin forever.
  for (let guard = 0; guard < 520 && cursor <= last; guard += 1) {
    filled.push(bySunday.get(cursor) ?? {
      date: cursor,
      value: 0,
      count: 0,
      label: weekLabel(cursor),
    });
    cursor = shiftDay(cursor, 7);
  }

  return filled;
}

/** Group dated items into calendar months. */
export function byMonth(items, reduce) {
  const buckets = new Map();
  for (const item of items) {
    const key = item.date.slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => ({
      date: `${key}-01`,
      value: reduce(group),
      count: group.length,
      label: key,
    }));
}

/* --- Windowing ---------------------------------------------------------- */

/**
 * Keep only the points within the last `days` days of `endKey`.
 * `days === null` means "everything".
 */
export function withinDays(series, days, endKey) {
  if (!days) return series;
  const start = shiftDay(endKey, -(days - 1));
  return series.filter((point) => point.date >= start && point.date <= endKey);
}

/* --- Summary statistics ------------------------------------------------- */

/** min, max, first, last, mean and change for a series. */
export function summarise(series) {
  if (!series.length) return null;
  const values = series.map((point) => point.value);
  const first = series[0];
  const last = series[series.length - 1];
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    first: first.value,
    last: last.value,
    firstDate: first.date,
    lastDate: last.date,
    change: last.value - first.value,
    count: series.length,
  };
}

/**
 * Nice axis bounds for a series that does not start at zero.
 *
 * Body weight and estimated 1RM both live in a narrow band well above zero —
 * forcing the axis to zero flattens a real 3 kg move into a straight line.
 * Bars, which encode magnitude by length, must still start at zero; that is
 * the caller's decision, not this function's.
 */
export function niceBounds(series, { padRatio = 0.12, minSpan = 1 } = {}) {
  const stats = summarise(series);
  if (!stats) return { min: 0, max: 1 };

  let low = stats.min;
  let high = stats.max;

  // A flat or nearly-flat series must be widened around its midpoint, not just
  // padded: padding a zero span still gives a near-zero axis, which magnifies
  // scale noise into what looks like a real trend.
  const span = high - low;
  if (span < minSpan) {
    const mid = (high + low) / 2;
    low = mid - minSpan / 2;
    high = mid + minSpan / 2;
  }

  const pad = (high - low) * padRatio;

  return {
    min: round2(low - pad),
    max: round2(high + pad),
  };
}

/* --- Date helpers -------------------------------------------------------
   Duplicated from core/format.js on purpose: this module stays import-free so
   it can be tested in Node without a DOM. They are five lines each and the
   alternative is coupling the engine to the app's core.
   ====================================================================== */

/** Parse a day key at local noon — noon so a DST shift cannot roll the date. */
function parseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function formatDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shiftDay(key, delta) {
  const date = parseDay(key);
  date.setDate(date.getDate() + delta);
  return formatDay(date);
}

export function daysApart(aKey, bKey) {
  return Math.round((parseDay(bKey) - parseDay(aKey)) / 86400000);
}

/** The Monday of the week containing `key`. */
export function weekStart(key) {
  const date = parseDay(key);
  const isoDay = date.getDay() === 0 ? 7 : date.getDay();
  date.setDate(date.getDate() - (isoDay - 1));
  return formatDay(date);
}

/** "5 Aug" — a compact label for a week's Monday. */
function weekLabel(mondayKey) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = parseDay(mondayKey);
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
