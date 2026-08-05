/**
 * progress.js — The Progress dashboard.
 *
 * Layout follows one filter row, then sections. The range and exercise
 * controls sit in that single row above everything they scope, rather than
 * inside individual cards: a filter buried in a card looks like it only
 * affects that card, and two cards showing different windows side by side is
 * how a dashboard starts lying.
 *
 * Chart lifecycle: every card returns a `destroy()`, and this page collects
 * them so the router's cleanup can dispose of every Chart.js instance on the
 * way out. Leaking one canvas and resize observer per route change would
 * eventually stall the page.
 */

import { el, icon, replace } from '../core/dom.js';
import { go } from '../core/router.js';
import { EVENTS, on } from '../core/events.js';
import {
  today, trimNumber, displayWeight, formatDate, relativeDay, pluralize,
} from '../core/format.js';
import * as analytics from '../services/analytics-service.js';
import { RANGES } from '../services/analytics-service.js';
import * as bodyService from '../services/body-service.js';
import * as sessionService from '../services/session-service.js';
import * as settingsService from '../services/settings-service.js';
import * as prService from '../services/pr-service.js';
import { PR_KINDS } from '../services/pr-service.js';
import { chartCard } from '../../components/chart-card.js';
import { sectionHead, stat, emptyState } from '../../components/stat.js';

/** Filter state, kept across re-renders within a visit. */
let rangeKey = '90d';
let exerciseId = null;

/** Live chart instances, disposed by the router's cleanup. */
let cards = [];

export function render() {
  const range = analytics.rangeByKey(rangeKey);
  const days = range.days;
  const endKey = today();
  const units = settingsService.getUnits();

  disposeCards();

  const hasSessions = sessionService.getCompletedSessions().length > 0;
  const hasWeight = bodyService.getWeightEntries().length > 0;

  if (!hasSessions && !hasWeight) {
    return el('div.page.enter', {}, [
      el('div.card.card--quiet', {}, [
        emptyState({
          iconName: 'chart',
          title: 'Nothing to chart yet',
          text: 'Log a workout or a morning weigh-in and the charts appear here automatically.',
          action: 'Go to today’s workout',
          onAction: () => go('workout'),
        }),
      ]),
    ]);
  }

  const body = el('div.stack', { style: { gap: 'var(--s-6)' } });

  const page = el('div.page.enter', {}, [
    filterRow(),
    overviewStats(days, endKey, units),
    body,
  ]);

  // Sections are appended after the filter row so a later re-render replaces
  // only the body.
  paintSections(body, { days, endKey, units });

  return page;
}

export function mount() {
  // Re-theme on a theme change: Chart.js bakes colours into its instances, so
  // the charts have to be rebuilt rather than restyled.
  const off = on(EVENTS.SETTINGS_CHANGED, ({ key }) => {
    if (key === 'theme' || key === 'units') rerender();
  });

  return () => {
    off();
    disposeCards();
  };
}

function rerender() {
  const body = document.querySelector('#progress-body');
  if (!body) return;
  const range = analytics.rangeByKey(rangeKey);
  paintSections(body, {
    days: range.days,
    endKey: today(),
    units: settingsService.getUnits(),
  });
}

function disposeCards() {
  for (const card of cards) {
    try { card.destroy(); } catch (error) { console.error('[progress] dispose failed:', error); }
  }
  cards = [];
}

/** Track a chart card so it gets disposed, and return its node. */
function track(card) {
  cards.push(card);
  return card.node;
}

/* --- Filter row --------------------------------------------------------- */

function filterRow() {
  const exercises = analytics.exercisesWithHistory();
  if (!exerciseId && exercises.length) exerciseId = exercises[0].exercise.id;

  const rangeGroup = el('div.segmented', { role: 'radiogroup', 'aria-label': 'Date range' });
  const buttons = RANGES.map((range) =>
    el('button.segmented__opt', {
      type: 'button',
      role: 'radio',
      'aria-checked': range.key === rangeKey ? 'true' : 'false',
      text: range.label,
      on: {
        click: () => {
          rangeKey = range.key;
          for (const button of buttons) {
            button.setAttribute('aria-checked',
              button.textContent === range.label ? 'true' : 'false');
          }
          rerender();
        },
      },
    })
  );
  rangeGroup.append(...buttons);

  const exerciseSelect = exercises.length > 1
    ? el('select.input.chart-filter__select', {
        'aria-label': 'Exercise for the strength chart',
        on: {
          change: (event) => { exerciseId = event.target.value; rerender(); },
        },
      }, exercises.map(({ exercise, sessions }) =>
        el('option', {
          value: exercise.id,
          text: `${exercise.name} (${sessions})`,
          selected: exercise.id === exerciseId,
        })
      ))
    : null;

  return el('div.chart-filter', {}, [
    rangeGroup,
    exerciseSelect,
  ].filter(Boolean));
}

/* --- Overview ----------------------------------------------------------- */

function overviewStats(days, endKey, units) {
  const summary = analytics.overview(days, endKey);

  return el('div.grid.grid--auto', {}, [
    stat({ label: 'Sessions', value: String(summary.sessions) }),
    stat({ label: 'Sets', value: String(summary.sets) }),
    stat({
      label: 'Volume',
      value: trimNumber(displayWeight(summary.volumeKg, units), 0),
      unit: units,
    }),
    stat({
      label: 'Consistency',
      value: String(summary.consistencyPercent),
      unit: '%',
      foot: summary.streakWeeks
        ? `${pluralize(summary.streakWeeks, 'week')} streak`
        : 'mean per week',
    }),
  ]);
}

/* --- Sections ----------------------------------------------------------- */

function paintSections(host, context) {
  disposeCards();
  host.id = 'progress-body';

  replace(host, [
    weightSection(context),
    strengthSection(context),
    volumeSection(context),
    consistencySection(context),
    recordsSection(),
    compositionSection(context),
  ].filter(Boolean));
}

/* --- Body weight -------------------------------------------------------- */

function weightSection({ days, endKey, units }) {
  const trend = analytics.weightTrend(days, endKey);
  if (!trend.daily.length) return null;

  const goalKg = settingsService.getGoalWeightKg();
  const latest = bodyService.getLatestWeight();
  const weekly = bodyService.getWeeklyAverage(endKey);
  const monthly = bodyService.getMonthlyAverage(endKey);
  const rate = bodyService.getLeanBulkRate(endKey);

  const toDisplay = (points) =>
    points.map((point) => ({ date: point.date, value: displayWeight(point.value, units) }));

  const bounds = analytics.niceBounds(
    [...toDisplay(trend.daily), ...toDisplay(trend.average)],
    { minSpan: units === 'lb' ? 4 : 2 }
  );

  const card = chartCard({
    title: 'Body weight',
    subtitle: 'Daily weigh-ins with a 7-day average',
    headline: latest
      ? {
          value: trimNumber(displayWeight(latest.weightKg, units), 1),
          unit: units,
          delta: rate ? Number(displayWeight(rate.kgPerWeek, units).toFixed(2)) : null,
          deltaSuffix: '/ week',
        }
      : null,
    type: 'line',
    height: 200,
    yBounds: bounds,
    series: [
      // Slot 1 carries the 7-day average, because that is the series to read.
      { label: '7-day average', points: toDisplay(trend.average) },
      // Daily readings recede to muted ink: context, not the message. Body
      // weight swings ~1 kg on water alone, which is larger than a week's gain.
      {
        label: 'Daily',
        points: toDisplay(trend.daily),
        color: 'var(--c-text-3)',
        dashed: true,
        showPoints: true,
      },
    ],
    reference: goalKg
      ? {
          value: displayWeight(goalKg, units),
          label: `Goal ${trimNumber(displayWeight(goalKg, units), 1)} ${units}`,
        }
      : null,
    formatValue: (value) => trimNumber(value, 1),
    formatLabel: (key) => formatDate(key),
    valueHeader: `Weight (${units})`,
  });

  return el('section', {}, [
    sectionHead('Body weight', {
      hint: latest ? relativeDay(latest.date) : null,
    }),
    track(card),
    el('div.grid.grid--auto', { style: { marginTop: 'var(--s-3)' } }, [
      stat({
        label: '7-day average',
        value: weekly ? trimNumber(displayWeight(weekly.average, units), 2) : null,
        unit: units,
        foot: weekly ? pluralize(weekly.count, 'reading') : 'No readings',
      }),
      stat({
        label: '30-day average',
        value: monthly ? trimNumber(displayWeight(monthly.average, units), 2) : null,
        unit: units,
        foot: monthly ? pluralize(monthly.count, 'reading') : 'No readings',
      }),
      stat({
        label: 'Lean bulk rate',
        value: rate ? trimNumber(displayWeight(rate.kgPerWeek, units), 2) : null,
        unit: `${units}/wk`,
        foot: rate ? verdictLabel(rate.verdict) : 'Needs two weeks of data',
      }),
    ]),
  ]);
}

function verdictLabel(verdict) {
  if (verdict === 'slow') return 'Slower than a lean bulk';
  if (verdict === 'fast') return 'Fast for a lean bulk';
  return 'On pace';
}

/* --- Strength ----------------------------------------------------------- */

function strengthSection({ days, endKey, units }) {
  if (!exerciseId) return null;

  const data = analytics.strengthSeries(exerciseId, days, endKey);
  if (!data.e1rm.length) {
    return el('section', {}, [
      sectionHead('Strength'),
      el('div.card.card--quiet', {}, [
        emptyState({
          iconName: 'chart',
          title: 'No loaded sets in this range',
          text: 'Widen the range, or pick another exercise.',
        }),
      ]),
    ]);
  }

  const toDisplay = (points) =>
    points.map((point) => ({ date: point.date, value: displayWeight(point.value, units) }));

  const series = [
    { label: 'Estimated 1RM', points: toDisplay(data.e1rm) },
    { label: 'Top set', points: toDisplay(data.topSet) },
  ];

  const bounds = analytics.niceBounds(
    series.flatMap((entry) => entry.points),
    { minSpan: units === 'lb' ? 10 : 5 }
  );

  const card = chartCard({
    title: data.exercise?.name ?? 'Strength',
    subtitle: 'Estimated 1RM (Epley) and heaviest completed set',
    headline: data.stats
      ? {
          value: trimNumber(displayWeight(data.stats.last, units), 1),
          unit: units,
          delta: Number(displayWeight(data.stats.change, units).toFixed(1)),
          deltaSuffix: 'in range',
        }
      : null,
    type: 'line',
    height: 200,
    yBounds: bounds,
    series,
    formatValue: (value) => trimNumber(value, 1),
    formatLabel: (key) => formatDate(key),
    valueHeader: `Load (${units})`,
    emptyText: 'Log this exercise to see it here.',
  });

  return el('section', {}, [
    sectionHead('Strength', { hint: pluralize(data.e1rm.length, 'session') }),
    track(card),
    el('p.t-caption.t-faint', {
      text: 'Estimated 1RM is the series to watch — it registers progress made by adding reps, which is most of what double progression produces between load increases.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

/* --- Volume ------------------------------------------------------------- */

function volumeSection({ days, endKey, units }) {
  const weeks = analytics.volumeByWeek(days, endKey);
  const muscles = analytics.volumeByMuscle(days, endKey);
  if (!weeks.length) return null;

  const volumeCard = chartCard({
    title: 'Weekly volume',
    subtitle: 'Load moved per week, all exercises',
    type: 'bar',
    height: 180,
    yBounds: 'zero',
    series: [{
      label: `Volume (${units})`,
      points: weeks.map((week) => ({
        date: week.date,
        value: displayWeight(week.value, units),
      })),
    }],
    formatValue: (value) => compactNumber(value),
    formatLabel: (key) => weekLabelFor(weeks, key),
    valueHeader: `Volume (${units})`,
  });

  const setsCard = chartCard({
    title: 'Sets per week',
    subtitle: 'Completed working sets',
    type: 'bar',
    height: 160,
    yBounds: 'zero',
    series: [{
      label: 'Sets',
      points: analytics.setsByWeek(days, endKey).map((week) => ({
        date: week.date, value: week.value,
      })),
    }],
    formatValue: (value) => String(Math.round(value)),
    formatLabel: (key) => weekLabelFor(weeks, key),
    valueHeader: 'Sets',
  });

  return el('section', {}, [
    sectionHead('Volume'),
    el('div.stack', {}, [
      track(volumeCard),
      track(setsCard),
      muscles.length ? muscleCard(muscles, units) : null,
    ].filter(Boolean)),
  ]);
}

/**
 * Volume by muscle group, as a ranked horizontal bar list.
 *
 * Built in HTML rather than as a chart: with fifteen groups a canvas bar chart
 * needs scrolling and a cramped label gutter, while a list gives every row its
 * full name, its value, and a proportional bar. The categories are ordered by
 * magnitude, so the single-hue sequential ramp is legitimate here — it is
 * reinforcing an order the rows already have, not colouring nominal categories
 * by size.
 */
function muscleCard(muscles, units) {
  const max = muscles[0].value || 1;

  return el('article.chart-card', {}, [
    el('div.chart-card__head', {}, [
      el('div', {}, [
        el('h3.chart-card__title', { text: 'Volume by muscle group' }),
        el('p.chart-card__sub', { text: 'Emphasis, not a physiological total' }),
      ]),
    ]),
    el('ul.muscle-bars', {}, muscles.map((muscle) => {
      const share = muscle.value / max;
      return el('li.muscle-bars__row', {}, [
        el('span.muscle-bars__label', { text: muscle.label }),
        el('span.muscle-bars__track', {}, [
          el('span.muscle-bars__fill', {
            style: { width: `${Math.max(2, share * 100)}%` },
          }),
        ]),
        el('span.muscle-bars__value.tnum', {
          text: `${compactNumber(displayWeight(muscle.value, units))}`,
        }),
      ]);
    })),
    el('p.t-caption.t-faint', {
      text: `A set's full volume is credited to each of the exercise's primary muscles and none to its secondaries — the program does not say how a row splits between lats and mid back, and inventing a ratio would invent precision. Read these as relative emphasis in ${units}.`,
      style: { marginTop: 'var(--s-3)' },
    }),
  ]);
}

/* --- Consistency -------------------------------------------------------- */

function consistencySection({ days, endKey }) {
  const weeks = analytics.consistencyByWeek(days, endKey);
  if (!weeks.length) return null;

  const card = chartCard({
    title: 'Workout consistency',
    subtitle: 'Scheduled sessions completed each week',
    type: 'bar',
    height: 160,
    yBounds: 'zero',
    series: [{
      label: 'Completion',
      points: weeks.map((week) => ({ date: week.date, value: week.value })),
    }],
    formatValue: (value) => `${Math.round(value)}%`,
    formatLabel: (key) => weekLabelFor(weeks, key),
    valueHeader: 'Completion (%)',
  });

  const perfect = weeks.filter((week) => week.value === 100).length;

  return el('section', {}, [
    sectionHead('Consistency', {
      hint: perfect ? `${perfect} of ${weeks.length} weeks complete` : null,
    }),
    track(card),
  ]);
}

/* --- Personal records --------------------------------------------------- */

function recordsSection() {
  const records = prService.getAllRecords();
  if (!records.length) return null;

  const units = settingsService.getUnits();
  const feed = prService.getRecordFeed();
  const recent = new Set(prService.getRecentRecords(21).map((r) => `${r.exerciseId}:${r.kind}`));

  // One badge per exercise, showing its best estimated 1RM — the fairest
  // cross-rep comparison — with the heaviest set as the supporting detail.
  const badges = records
    .filter((record) => record.e1rm)
    .sort((a, b) => b.e1rm.value - a.e1rm.value)
    .map((record) => {
      const isRecent = recent.has(`${record.exerciseId}:${PR_KINDS.E1RM}`);
      return el(`div.pr-badge${isRecent ? '.pr-badge--fresh' : ''}`, {}, [
        el('div.pr-badge__top', {}, [
          icon('trophy', { size: 15 }),
          isRecent ? el('span.pill.pill--pr', { text: 'New' }) : null,
        ].filter(Boolean)),
        el('div.pr-badge__name.t-truncate', { text: record.name }),
        el('div.pr-badge__value', {
          text: `${trimNumber(displayWeight(record.e1rm.value, units), 1)} ${units}`,
        }),
        el('div.pr-badge__meta', {
          text: `est. 1RM · ${trimNumber(displayWeight(record.e1rm.weightKg, units), 1)} × ${record.e1rm.reps}`,
        }),
        el('div.pr-badge__date', { text: relativeDay(record.e1rm.date) }),
      ]);
    });

  return el('section', {}, [
    sectionHead('Personal records', { hint: pluralize(feed.length, 'record') }),
    el('div.pr-grid', {}, badges),
    el('p.t-caption.t-faint', {
      text: 'Records are computed from your log, never stored — deleting a session removes any record it set.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

/* --- Body composition --------------------------------------------------- */

/**
 * Small multiples, one card per scale metric.
 *
 * Weight is in kilograms, body fat in percent, BMR in kilocalories. One plot
 * with all ten would need several y-axes, and a dual-axis chart invents a
 * correlation that is not in the data — so each metric gets its own axis.
 */
function compositionSection({ days, endKey }) {
  const entries = analytics.compositionSeries(days, endKey);
  if (!entries.length) return null;

  return el('section', {}, [
    sectionHead('Body composition', { hint: pluralize(entries.length, 'metric') }),
    el('div.small-multiples', {}, entries.map(({ field, points, stats }) => {
      const card = chartCard({
        title: field.label,
        headline: {
          value: trimNumber(stats.last, field.decimals),
          unit: field.unit,
          delta: Number(stats.change.toFixed(field.decimals)),
          deltaSuffix: 'in range',
          // For body fat and visceral fat, down is the improvement.
          invertDelta: field.key === 'bodyFatPercent' || field.key === 'visceralFat',
        },
        type: 'line',
        height: 96,
        yBounds: analytics.niceBounds(points, { minSpan: Math.max(1, stats.mean * 0.04) }),
        // A single series needs no legend — the card title names it.
        series: [{ label: field.label, points, showPoints: points.length < 20 }],
        formatValue: (value) => trimNumber(value, field.decimals),
        formatLabel: (key) => formatDate(key),
        valueHeader: field.unit ? `${field.label} (${field.unit})` : field.label,
      });
      return track(card);
    })),
    el('p.t-caption.t-faint', {
      text: 'Each metric has its own axis. Combining kilograms, percentages and kilocalories on one plot would need several scales, and their alignment would be arbitrary.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

/* --- Helpers ------------------------------------------------------------ */

/** "12.4k" for axis ticks — full precision stays in the tooltip and table. */
function compactNumber(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1000) return `${trimNumber(n / 1000, 1)}k`;
  return trimNumber(n, 0);
}

function weekLabelFor(weeks, key) {
  return weeks.find((week) => week.date === key)?.label ?? formatDate(key);
}

export const page = {
  name: 'progress',
  title: 'Progress',
  render,
  mount,
};
