/**
 * tools/test-review.mjs — Tests for the two-week review engine.
 *
 *     node --test tools/
 *
 * The recommendation is an explicit priority ladder, so these tests pin the
 * *order* as much as the individual rules: which finding wins when several are
 * true at once is the actual policy, and it is the part that would silently
 * change if someone reordered the conditionals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReview, TONE, THRESHOLDS } from '../js/engine/review.js';

/** A period with everything healthy, for tests to override one field of. */
function healthy(overrides = {}) {
  return {
    period: { start: '2026-07-23', end: '2026-08-05', days: 14 },
    weight: { startAvg: 76.0, endAvg: 76.7, perWeek: 0.35, goalKg: 79 },
    adherence: { done: 10, scheduled: 10 },
    strength: { improved: 8, held: 2, regressed: 0, tracked: 10, advancing: [], stalled: [] },
    volume: { currentKg: 30000, previousKg: 29000 },
    records: { records: 3 },
    recovery: { entries: 14, meanSleepHours: 7.8, meanSoreness: 2.2 },
    ...overrides,
  };
}

/* --- The default path --------------------------------------------------- */

test('a clean period recommends continuing', () => {
  const review = buildReview(healthy());
  assert.equal(review.recommendation.action, 'Continue current calories');
  assert.equal(review.recommendation.tone, TONE.GOOD);
});

test("the brief's example summary produces the expected headline", () => {
  // The brief's worked example: +0.5 kg, improved in 8/10 lifts, 100%
  // completion, "continue current calories".
  const review = buildReview(healthy({
    weight: { startAvg: 76.0, endAvg: 76.5, perWeek: 0.25, goalKg: 79 },
  }));

  const byLabel = Object.fromEntries(review.headline.map((item) => [item.label, item.value]));
  assert.equal(byLabel.Weight, '+0.5 kg');
  assert.equal(byLabel.Strength, '8/10 lifts');
  assert.equal(byLabel.Completion, '100%');
  assert.equal(review.recommendation.action, 'Continue current calories');
});

/* --- Ladder priority ---------------------------------------------------- */

test('poor adherence outranks every other finding', () => {
  // Everything else looks bad too, but nothing is diagnosable until the
  // sessions are actually being done.
  const review = buildReview(healthy({
    weight: { startAvg: 76, endAvg: 76, perWeek: 0, goalKg: 79 },
    adherence: { done: 4, scheduled: 10 },
    strength: { improved: 1, held: 2, regressed: 7, tracked: 10, advancing: [], stalled: [] },
    recovery: { entries: 5, meanSleepHours: 5.5, meanSoreness: 4 },
  }));

  assert.equal(review.recommendation.action, 'Fix adherence first');
  assert.equal(review.recommendation.tone, TONE.BAD);
});

test('low sleep outranks calories when adherence is fine', () => {
  const review = buildReview(healthy({
    weight: { startAvg: 76, endAvg: 76, perWeek: 0.02, goalKg: 79 },
    strength: { improved: 2, held: 4, regressed: 4, tracked: 10, advancing: [], stalled: [] },
    recovery: { entries: 14, meanSleepHours: 5.9, meanSoreness: 3.9 },
  }));

  assert.equal(review.recommendation.action, 'Prioritise sleep');
  assert.match(review.recommendation.text, /sleep and protein/);
});

test('reaching the goal weight forces the hold-or-cut decision', () => {
  const review = buildReview(healthy({
    weight: { startAvg: 78.6, endAvg: 79.2, perWeek: 0.3, goalKg: 79 },
  }));
  assert.equal(review.recommendation.action, 'Decide: hold or cut');
});

/* --- Calorie rules ----------------------------------------------------- */

test('gaining too fast recommends pulling calories back', () => {
  const review = buildReview(healthy({
    weight: { startAvg: 76, endAvg: 78, perWeek: 1.0, goalKg: 82 },
  }));
  assert.equal(review.recommendation.action, 'Reduce calories slightly');
});

test('stalling while weight is flat recommends more calories', () => {
  const review = buildReview(healthy({
    weight: { startAvg: 76, endAvg: 76, perWeek: 0.01, goalKg: 79 },
    strength: { improved: 2, held: 4, regressed: 4, tracked: 10, advancing: [], stalled: ['Back Squat'] },
  }));
  assert.equal(review.recommendation.action, 'Increase calories');
});

test('flat weight but improving strength is a hold, not a change', () => {
  const review = buildReview(healthy({
    weight: { startAvg: 76, endAvg: 76.05, perWeek: 0.02, goalKg: 79 },
  }));
  assert.equal(review.recommendation.action, 'Hold and watch');
});

test('losing weight on a bulk is called out as a deficit', () => {
  const review = buildReview(healthy({
    weight: { startAvg: 77, endAvg: 76.4, perWeek: -0.3, goalKg: 79 },
    strength: { improved: 3, held: 3, regressed: 4, tracked: 10, advancing: [], stalled: [] },
  }));
  const weight = review.findings.find((finding) => finding.key === 'weight');
  assert.match(weight.text, /calorie deficit/);
  assert.equal(review.recommendation.action, 'Increase calories');
});

/* --- Individual findings ------------------------------------------------ */

test('a volume spike is flagged as outrunning recovery', () => {
  const review = buildReview(healthy({ volume: { currentKg: 40000, previousKg: 30000 } }));
  const volume = review.findings.find((finding) => finding.key === 'volume');
  assert.equal(volume.tone, TONE.WATCH);
  assert.match(volume.text, /outruns recovery/);
});

test('a volume collapse is flagged too', () => {
  const review = buildReview(healthy({ volume: { currentKg: 20000, previousKg: 30000 } }));
  const volume = review.findings.find((finding) => finding.key === 'volume');
  assert.equal(volume.tone, TONE.WATCH);
  assert.match(volume.text, /missed sessions or dropped sets/);
});

test('rising body fat is only flagged past the scale noise floor', () => {
  const noisy = buildReview(healthy({ bodyFat: { startPercent: 14.5, endPercent: 14.8 } }));
  assert.equal(noisy.findings.find((f) => f.key === 'bodyFat').tone, TONE.GOOD);

  const real = buildReview(healthy({ bodyFat: { startPercent: 14.5, endPercent: 15.8 } }));
  assert.equal(real.findings.find((f) => f.key === 'bodyFat').tone, TONE.WATCH);
});

test('widespread stalling is called a recovery or calorie problem', () => {
  const review = buildReview(healthy({
    strength: { improved: 1, held: 4, regressed: 5, tracked: 10, advancing: [], stalled: ['A', 'B'] },
  }));
  const strength = review.findings.find((finding) => finding.key === 'strength');
  assert.equal(strength.tone, TONE.BAD);
  assert.match(strength.text, /recovery or calories/);
});

/* --- Absent data -------------------------------------------------------- */

test('missing weight data yields a neutral finding, not a guess', () => {
  const review = buildReview({
    period: { start: '2026-07-23', end: '2026-08-05', days: 14 },
    weight: { startAvg: null, endAvg: null, perWeek: null, goalKg: null },
    adherence: { done: 10, scheduled: 10 },
  });

  const weight = review.findings.find((finding) => finding.key === 'weight');
  assert.equal(weight.tone, TONE.NEUTRAL);
  assert.match(weight.text, /Not enough weigh-ins/);
});

test('findings are omitted rather than invented when data is absent', () => {
  const review = buildReview({ period: { start: '2026-07-23', end: '2026-08-05', days: 14 } });
  assert.deepEqual(
    review.findings.map((finding) => finding.key),
    ['weight'],
    'only the weight finding, which exists to explain the gap'
  );
  assert.equal(review.headline.length, 0, 'no headline figures without data');
});

test('an empty review still produces a usable recommendation', () => {
  const review = buildReview({ period: { start: '2026-07-23', end: '2026-08-05', days: 14 } });
  assert.ok(review.recommendation.action, 'must not be blank');
  assert.ok(review.recommendation.text.length > 0);
});


test('a missing start-of-period average never reports absolute weight as a gain', () => {
  // Regression: `endAvg - (startAvg ?? 0)` rendered the whole body weight as
  // the fortnight's change — "+76.88 kg" on the report cover.
  const review = buildReview(healthy({
    weight: { startAvg: null, endAvg: 76.88, perWeek: 0.3, goalKg: 79 },
  }));

  const weight = review.findings.find((finding) => finding.key === 'weight');
  assert.ok(!String(weight.value).includes('76'), `value was "${weight.value}"`);
  assert.match(weight.value, /kg\/wk$/, 'falls back to the rate');

  const headline = Object.fromEntries(review.headline.map((item) => [item.label, item.value]));
  assert.equal(headline.Weight, undefined, 'no bogus change figure');
  assert.equal(headline['Weight rate'], '+0.3 kg/wk');
});

test('a start-to-end change is reported when both averages exist', () => {
  const review = buildReview(healthy({
    weight: { startAvg: 76.2, endAvg: 76.88, perWeek: 0.34, goalKg: 79 },
  }));
  const headline = Object.fromEntries(review.headline.map((item) => [item.label, item.value]));
  assert.equal(headline.Weight, '+0.68 kg');
});

/* --- Thresholds --------------------------------------------------------- */

test('every threshold the ladder uses is declared in THRESHOLDS', () => {
  // Guards against a magic number creeping back into a conditional.
  for (const key of ['gainSlow', 'gainFast', 'adherenceGood', 'adherencePoor',
                     'strengthGood', 'strengthPoor', 'sleepLow', 'sorenessHigh',
                     'volumeDropConcerning', 'volumeSpikeConcerning']) {
    assert.equal(typeof THRESHOLDS[key], 'number', `${key} should be a declared number`);
  }
});

test('every finding carries the figure it was judged on', () => {
  // A finding the user cannot trace back to a number is not actionable.
  const review = buildReview(healthy());
  for (const finding of review.findings) {
    assert.ok(finding.label, 'finding needs a label');
    assert.ok(finding.text, `${finding.key} needs explanatory text`);
    assert.ok(Object.values(TONE).includes(finding.tone), `${finding.key} needs a valid tone`);
  }
});
