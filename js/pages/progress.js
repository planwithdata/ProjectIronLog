/**
 * progress.js — The Progress dashboard.
 *
 * Reading order
 * -------------
 * Conclusions first, then the charts that support them, then body data. That
 * order is the point of this page's rewrite: the previous version opened with a
 * body-weight line and one exercise's estimated 1RM, which answered "what did I
 * do" and left "am I getting stronger, and where" as an exercise for the
 * reader. So the page now opens with the answer — in sentences — and every
 * chart below it exists to be checked against that answer rather than to be
 * interpreted from scratch.
 *
 * The interpretation itself lives in `engine/insights.js`, which is pure and
 * tested. This file lays it out and does no reasoning of its own: if a status
 * or a percentage looks wrong, it is wrong in the engine, and there is exactly
 * one place to fix it.
 *
 * What the page will not do
 * -------------------------
 * It does not print a confident number over two data points. Insights carry a
 * `confidence` and a `comparableSessions` count, and cards defer to them —
 * "not enough comparable sessions yet" is a real answer and appears often in
 * the first month. It also never compares loads across a machine change; those
 * exercises are listed under their own heading with what can and cannot be
 * said about them.
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
import { RANGES, STATUS } from '../services/analytics-service.js';
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
  const exercises = analytics.progressionExercises().map((exercise) => ({ exercise, sessions: sessionService.getExerciseHistory(exercise.id, Infinity).length }));
  if (!exercises.some((item) => item.exercise.id === exerciseId)) exerciseId = exercises.find((item) => item.sessions)?.exercise.id ?? exercises[0]?.exercise.id;

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
          change: (event) => { exerciseId = event.target.value; rerender(); document.querySelector('#progress-strength')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
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
  // Insight readings are memoised for one paint. Four cards ask for the same
  // exercise's reading, and recomputing a whole history four times per render
  // is the sort of waste that shows up as a stutter on a phone.
  analytics.resetInsights();
  host.id = 'progress-body';

  replace(host, [
    // The answers, in sentences.
    headlineSection(context),
    scorecardSection(context),
    driverSection(context),
    // Then the evidence, per exercise.
    strengthSection(context),
    adherenceSection(context),
    // Then the program-level shape.
    muscleSection(context),
    waveSection(context),
    deloadSection(context),
    volumeSection(context),
    consistencySection(context),
    recordsSection(),
    // Then the body, which is a different subject and reads last.
    weightSection(context),
    compositionSection(context),
  ].filter(Boolean));
}

/* --- The reading -------------------------------------------------------
   The three questions the brief opens with — am I getting stronger, which
   lifts need attention, where is the progress coming from — answered in
   words, above every chart. A dashboard that makes the reader derive these
   from a line graph has not answered them.
   ====================================================================== */

function headlineSection({ days, endKey }) {
  const reading = analytics.headlines(days, endKey);
  if (!sessionService.getCompletedSessions().length) return null;

  const strength = reading.strength;
  const tone = { yes: 'success', mixed: 'warning', no: 'danger', unknown: '' }[strength.verdict];

  return el('section', {}, [
    sectionHead('Where you are'),
    el('div.card', {}, [
      el('div.row', { style: { gap: 'var(--s-3)', alignItems: 'flex-start' } }, [
        el('div.reading__mark', {}, [icon('trend', { size: 20 })]),
        el('div', { style: { minWidth: 0, flex: '1 1 auto' } }, [
          el('div.row', { style: { gap: 'var(--s-2)', alignItems: 'baseline', flexWrap: 'wrap' } }, [
            el('h3.t-title-3', { text: 'Am I getting stronger?' }),
            tone
              ? el(`span.pill.pill--${tone}`, {
                  text: { yes: 'Yes', mixed: 'Mostly', no: 'Not yet', unknown: 'Too early' }[strength.verdict],
                })
              : null,
          ].filter(Boolean)),
          el('p.t-subhead.t-dim', { text: strength.text, style: { marginTop: '2px' } }),
        ]),
      ]),

      el('div.reading__list', {}, [
        reading.driver
          ? readingRow('Where the progress comes from', reading.driver.text)
          : null,
        reading.attention.length
          ? readingRow(
              'Needs attention',
              reading.attention.map((item) => `${item.name} (${item.statusLabel.toLowerCase()})`).join(', ')
            )
          : readingRow('Needs attention', 'Nothing is stalled or losing reps.'),
        reading.scaleChanged
          ? readingRow(
              'Not comparable',
              `${pluralize(reading.scaleChanged, 'exercise')} changed load scale — tag the machine `
              + 'and the trend restarts from there.'
            )
          : null,
        readingRow(
          'Consistency',
          consistencySentence(reading.consistency)
        ),
      ].filter(Boolean)),
    ]),
  ]);
}

function readingRow(label, text) {
  return el('div.reading__row', {}, [
    el('span.reading__label', { text: label }),
    el('span.reading__text', { text }),
  ]);
}

/**
 * Consistency in a sentence, and deliberately not as a percentage.
 *
 * The program's own missed-day rules call the split rolling, so a session
 * trained a day late is done rather than missed — and a completion percentage
 * that docks it would be grading against a calendar the plan does not keep.
 */
function consistencySentence(consistency) {
  if (!consistency.sessions) return 'No sessions in this range.';
  const parts = [`${pluralize(consistency.sessions, 'session')}`];
  if (consistency.perWeek) parts.push(`${consistency.perWeek} a week`);
  if (consistency.lateSessions) {
    parts.push(`${consistency.lateSessions} trained on a different day, all counted as done`);
  }
  if (consistency.longestGapDays !== null) {
    parts.push(`longest gap ${pluralize(consistency.longestGapDays, 'day')}`);
  }
  return `${parts.join(' · ')}.`;
}

/* --- Scorecard ---------------------------------------------------------
   Every exercise sorted into the pile that says what to do about it. The
   attention pile leads, because it is the only one that asks for a decision.
   ====================================================================== */

function scorecardSection() {
  const board = analytics.getScorecard();
  const total = Object.values(board).reduce((sum, list) => sum + list.length, 0);
  if (!total) return null;

  const groups = [
    { key: 'attention', title: 'Needs attention', tone: 'danger', list: board.attention,
      blurb: 'Stalled, or losing reps under a load that is holding. These are the ones worth '
        + 'changing something about.' },
    { key: 'scaleChanged', title: 'Load scale changed', tone: 'warning', list: board.scaleChanged,
      blurb: 'The numbers moved further than training explains, or the machine was different. '
        + 'Tag the machine while logging and the trend picks up from there.' },
    { key: 'progressing', title: 'Progressing', tone: 'success', list: board.progressing,
      blurb: 'Estimated strength up over the comparable run, or more reps at the same load.' },
    { key: 'holding', title: 'Holding', tone: '', list: board.holding,
      blurb: 'Flat, but not for long enough to call it a stall.' },
    { key: 'maintained', title: 'Maintained by design', tone: '', list: board.maintained,
      blurb: 'Quality work the program does not progress. Never stalled, never advanced.' },
    { key: 'tooNew', title: 'Too new to read', tone: '', list: board.tooNew,
      blurb: 'One comparable session so far.' },
  ].filter((group) => group.list.length);

  return el('section', {}, [
    sectionHead('Every exercise', { hint: pluralize(total, 'movement') }),
    el('div.stack', { style: { gap: 'var(--s-4)' } }, groups.map((group) =>
      el('div.card', {}, [
        el('div.row', { style: { gap: 'var(--s-2)', alignItems: 'baseline' } }, [
          el('h3.t-callout.t-semibold', { text: group.title }),
          el(`span.pill${group.tone ? `.pill--${group.tone}` : ''}`, {
            text: String(group.list.length),
          }),
        ]),
        el('p.t-caption.t-faint', { text: group.blurb, style: { marginTop: '2px' } }),
        el('div.stack', { style: { gap: 'var(--s-2)', marginTop: 'var(--s-3)' } },
          group.list.map((item) => insightRow(item))),
      ])
    )),
  ]);
}

/**
 * One exercise's reading: name, what it is doing, the numbers behind it, and a
 * sentence saying what that means.
 *
 * Tapping it selects the exercise for the strength chart below, so the row is
 * the way into the detail rather than a dead end.
 */
function insightRow(insight) {
  const units = settingsService.getUnits();
  const numbers = [
    insight.load.from === null
      ? null
      : `${trimNumber(displayWeight(insight.load.from, units), 2)} → ${trimNumber(displayWeight(insight.load.to, units), 2)} ${units}`,
    `${insight.reps.from} → ${insight.reps.to} reps`,
    insight.e1rm.percent === null || insight.maintained
      ? null
      : `est. 1RM ${signedPercent(insight.e1rm.percent)}`,
  ].filter(Boolean).join(' · ');

  return el('button.insight-row', {
    type: 'button',
    on: {
      click: () => {
        exerciseId = insight.exerciseId;
        rerender();
        document.querySelector('#progress-strength')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    },
  }, [
    el('div.row.row--between', { style: { gap: 'var(--s-2)' } }, [
      el('span.t-subhead.t-semibold.t-truncate', { text: insight.name }),
      el('span.t-micro.t-faint', {
        // How much of the history the reading could actually use. The gap
        // between this and the session count is the honest answer to "how much
        // of my log is comparable", and it belongs next to the conclusion.
        text: insight.comparableSessions === insight.sessions
          ? pluralize(insight.sessions, 'session')
          : `${insight.comparableSessions} of ${insight.sessions} comparable`,
      }),
    ]),
    numbers ? el('div.t-caption.t-dim.tnum', { text: numbers }) : null,
    el('div.t-caption.t-faint', { text: insight.statusDetail }),
  ].filter(Boolean));
}

/* --- Load versus reps --------------------------------------------------
   "Where am I adding reps versus adding load" — a question double
   progression makes answerable and that no single chart shows. Counted in
   exercises rather than averaged, because a mean of a squat's percentage and
   a lateral raise's percentage refers to nothing.
   ====================================================================== */

function driverSection() {
  const mix = analytics.getDriverMix();
  if (!mix.total) return null;

  return el('section', {}, [
    sectionHead('Load or reps'),
    el('div.card', {}, [
      el('p.t-caption.t-faint', {
        text: 'Double progression adds reps until the top of the range, then load. Early in a '
          + 'wave this should lean towards reps; a run of load-driven weeks with reps falling is '
          + 'the pattern worth catching.',
      }),
      el('ul.muscle-bars', { style: { marginTop: 'var(--s-3)' } }, mix.byDriver.map((row) =>
        el('li.muscle-bars__row', {}, [
          el('span.muscle-bars__label', { text: row.label }),
          el('span.muscle-bars__track', {}, [
            el('span.muscle-bars__fill', { style: { width: `${Math.max(2, row.percent)}%` } }),
          ]),
          el('span.muscle-bars__value.tnum', { text: `${row.count}` }),
        ])
      )),
    ]),
  ]);
}

/* --- Adherence ---------------------------------------------------------
   What the app planned against what was actually performed. Both facts are
   kept in the log and neither overwrites the other, so this is the card that
   says so — and it reads a consistent bias as feedback about the plan rather
   than as a failure by the lifter.
   ====================================================================== */

function adherenceSection() {
  const rows = analytics.getAdherence();
  if (!rows.length) return null;

  const units = settingsService.getUnits();

  return el('section', {}, [
    sectionHead('Plan against performance', { hint: pluralize(rows.length, 'exercise') }),
    el('div.card', {}, [
      el('p.t-caption.t-faint', {
        text: 'The app keeps what it prescribed and what you actually lifted as two separate '
          + 'facts. A consistent gap is information about the prescription, not a mistake — '
          + 'recommendations always build on what was performed.',
      }),
      el('div.stack', { style: { gap: 'var(--s-2)', marginTop: 'var(--s-3)' } },
        rows.slice(0, 8).map((row) => el('div.insight-row.insight-row--static', {}, [
          el('div.row.row--between', { style: { gap: 'var(--s-2)' } }, [
            el('span.t-subhead.t-semibold.t-truncate', { text: row.name }),
            el(`span.t-micro.t-semibold.tnum.stat__delta--${row.meanDeviationKg > 0 ? 'up' : 'down'}`, {
              text: `${row.meanDeviationKg > 0 ? '+' : '−'}${trimNumber(Math.abs(displayWeight(row.meanDeviationKg, units)), 2)} ${units}`,
            }),
          ]),
          el('div.t-caption.t-dim', {
            text: `${pluralize(row.deviations, 'session')} off plan `
              + `(${row.above} above, ${row.below} below) · ${row.verdict}`,
          }),
        ]))),
    ]),
  ]);
}

/* --- Muscle groups ----------------------------------------------------- */

function muscleSection() {
  const groups = analytics.getMuscleProgress().filter((group) => group.changeRatio !== null);
  if (groups.length < 2) return null;

  const max = Math.max(...groups.map((group) => Math.abs((group.changeRatio ?? 1) - 1)), 0.01);

  return el('section', {}, [
    sectionHead('By muscle group'),
    el('div.card', {}, [
      el('p.t-caption.t-faint', {
        text: 'Median change in estimated strength across the exercises whose primary muscle is '
          + 'this one. A median rather than a mean, because with two or three exercises per group '
          + 'one outlier would otherwise decide the whole reading.',
      }),
      el('ul.muscle-bars', { style: { marginTop: 'var(--s-3)' } }, groups.map((group) => {
        const change = (group.changeRatio ?? 1) - 1;
        return el('li.muscle-bars__row', {
          title: group.names.join(', '),
        }, [
          el('span.muscle-bars__label', { text: group.muscle }),
          el('span.muscle-bars__track', {}, [
            el(`span.muscle-bars__fill${change < 0 ? '.muscle-bars__fill--down' : ''}`, {
              style: { width: `${Math.max(2, (Math.abs(change) / max) * 100)}%` },
            }),
          ]),
          el('span.muscle-bars__value.tnum', { text: signedPercent(Math.round(change * 100)) }),
        ]);
      })),
      el('p.t-caption.t-faint', {
        text: 'An exercise counts in full towards each of its primary muscles and not at all '
          + 'towards its secondaries — the program does not say how a row splits between lats '
          + 'and mid back. Read these as emphasis, not physiology.',
        style: { marginTop: 'var(--s-3)' },
      }),
    ]),
  ]);
}

/* --- Wave weeks -------------------------------------------------------- */

function waveSection({ units }) {
  const wave = analytics.waveWeekProgress();
  if (wave.volume.length < 2) return null;

  const card = chartCard({
    title: 'Average session by wave week',
    subtitle: 'Week 1 of every cycle grouped together, not calendar weeks',
    type: 'bar',
    height: 170,
    yBounds: 'zero',
    series: [{
      label: `Volume (${units})`,
      points: wave.volume.map((week) => ({
        date: `w${week.waveWeek}`,
        value: displayWeight(week.value, units),
      })),
    }],
    formatValue: (value) => compactNumber(value),
    formatLabel: (key) => {
      const week = wave.volume.find((item) => `w${item.waveWeek}` === key);
      return week ? `${week.label}${week.isDeload ? ' ·D' : ''}` : key;
    },
    valueHeader: `Volume (${units})`,
  });

  return el('section', {}, [
    sectionHead('The wave', { hint: `${wave.volume.length} of 5 weeks logged` }),
    track(card),
    el('p.t-caption.t-faint', {
      text: 'The plan is four loading weeks then a deload. Grouped this way, week 4 should be '
        + 'the tallest bar and week 5 the shortest — a flat set of bars means the wave is not '
        + 'actually being run.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

/* --- Deload response --------------------------------------------------- */

function deloadSection({ units }) {
  const rows = analytics.getDeloadResponse();
  if (!rows.length) return null;

  const better = rows.filter((row) => (row.change.ratio ?? 1) > 1.01).length;

  return el('section', {}, [
    sectionHead('After the deload', { hint: `${better} of ${rows.length} came back stronger` }),
    el('div.card', {}, [
      el('p.t-caption.t-faint', {
        text: 'The justification for giving up a training week is that the week after it goes '
          + 'better. This is the card that checks.',
      }),
      el('div.stack', { style: { gap: 'var(--s-2)', marginTop: 'var(--s-3)' } },
        rows.map((row) => el('div.insight-row.insight-row--static', {}, [
          el('div.row.row--between', { style: { gap: 'var(--s-2)' } }, [
            el('span.t-subhead.t-semibold.t-truncate', { text: row.name }),
            el(`span.t-micro.t-semibold.tnum.stat__delta--${(row.change.delta ?? 0) >= 0 ? 'up' : 'down'}`, {
              text: `${signedPercent(row.change.percent ?? 0)} est. 1RM`,
            }),
          ]),
          el('div.t-caption.t-dim', {
            text: `${trimNumber(displayWeight(row.before.loadKg, units), 2)} ${units} × `
              + `${row.before.reps} reps → ${trimNumber(displayWeight(row.after.loadKg, units), 2)} ${units} × `
              + `${row.after.reps} reps`,
          }),
        ]))),
    ]),
  ]);
}

function signedPercent(percent) {
  const value = Math.round(Number(percent) || 0);
  if (value === 0) return '0%';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)}%`;
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
  const data = analytics.exerciseProgression(exerciseId, days, endKey);
  return el('section', { id: 'progress-strength' }, [
    sectionHead(data.exercise?.name ?? 'Exercise progression', { hint: pluralize(data.sessions, 'session') }),
    el('p.t-caption.t-dim', { text: data.note, style: { marginBottom: 'var(--s-3)' } }),
    !data.sessions ? emptyState({ iconName: 'chart', title: 'No completed working sets in this range', text: 'Widen the date range, or select another exercise.' })
      : el('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))' } }, data.charts.map((metric) => {
        const unit = metric.unit === 'kg' ? units : metric.unit;
        return track(chartCard({ title: metric.label, subtitle: unit,
          series: [{ label: metric.label, showPoints: true, breakGaps: true,
            points: metric.points.map((point) => ({ ...point, value: point.value == null ? null : metric.unit === 'kg' ? displayWeight(point.value, units) : point.value })) }],
          height: 170,
          formatValue: (value) => `${trimNumber(value, 1)} ${unit}`,
          formatLabel: (key) => formatDate(key.split('|')[0]),
          valueHeader: unit,
        }));
      })),
    data.sessions ? insightDetail(analytics.getInsight(exerciseId), units) : null,
  ]);
}

/**
 * The selected exercise's reading, laid out beside its chart: status, the three
 * numbers behind it, its records, and how much of its history was usable.
 */
function insightDetail(insight, units) {
  const tone = {
    [STATUS.PROGRESSING]: 'success',
    [STATUS.STALLED]: 'danger',
    [STATUS.GRINDING]: 'danger',
    [STATUS.SCALE_CHANGE]: 'warning',
  }[insight.status] ?? '';

  const records = analytics.getMeaningfulRecords(insight.exerciseId);

  return el('div.card', { style: { marginTop: 'var(--s-3)' } }, [
    el('div.row', { style: { gap: 'var(--s-2)', alignItems: 'baseline', flexWrap: 'wrap' } }, [
      el(`span.pill${tone ? `.pill--${tone}` : ''}`, { text: insight.statusLabel }),
      el('span.t-caption.t-faint', {
        text: `${insight.confidence} confidence · `
          + `${pluralize(insight.comparableSessions, 'comparable session')}`,
      }),
    ]),
    el('p.t-subhead.t-dim', { text: insight.statusDetail, style: { marginTop: 'var(--s-2)' } }),

    el('div.grid.grid--auto', { style: { marginTop: 'var(--s-3)' } }, [
      stat({
        label: 'Working load',
        value: insight.load.to === null ? null : trimNumber(displayWeight(insight.load.to, units), 2),
        unit: units,
        delta: insight.load.delta === null ? null : Number(displayWeight(insight.load.delta, units).toFixed(2)),
        foot: insight.load.to === null ? 'Bodyweight' : 'the load you repeat',
      }),
      stat({
        label: 'Reps at that load',
        value: String(insight.reps.to ?? 0),
        delta: insight.reps.delta,
        foot: 'across all working sets',
      }),
      stat({
        label: 'Per week',
        value: insight.perWeek ? trimNumber(displayWeight(insight.perWeek.perWeek, units), 2) : null,
        unit: `${units}/wk`,
        // The r² is printed, not hidden: a slope over three wobbly points looks
        // just as confident as a real trend, and the reader is entitled to know
        // which they are looking at.
        foot: insight.perWeek
          ? `est. 1RM trend · fit ${insight.perWeek.r2 === null ? '—' : insight.perWeek.r2}`
          : 'Needs three comparable sessions',
      }),
    ]),

    records.length
      ? el('div', { style: { marginTop: 'var(--s-3)' } }, [
          el('span.field__label', { text: 'Records worth beating' }),
          el('div.stack', { style: { gap: 'var(--s-1)' } }, records.map((record) =>
            el('div.row.row--between', { style: { gap: 'var(--s-2)' } }, [
              el('span.t-caption.t-dim', { text: record.label }),
              el('span.t-caption.t-semibold.tnum', {
                text: `${trimNumber(record.unit === 'kg' ? displayWeight(record.value, units) : record.value, 2)} `
                  + `${record.unit === 'kg' ? units : record.unit}`
                  + `${record.current ? ' · current' : ` · ${relativeDay(record.date)}`}`,
              }),
            ])
          )),
        ])
      : null,
  ].filter(Boolean));
}

/* --- Volume ------------------------------------------------------------- */

function volumeSection({ days, endKey, units }) {
  const weeks = analytics.volumeByWeek(days, endKey);
  const split = analytics.volumeSplitByWeek(days, endKey);
  const muscles = analytics.volumeByMuscle(days, endKey);
  if (!weeks.length) return null;

  // Working, warm-up and intensity volume as three bars rather than one total.
  // A fortnight where warm-up volume doubled and working volume fell is a
  // different fortnight from one where the total happened to hold, and a single
  // number cannot say which happened.
  const hasExtra = split.warmup.some((week) => week.value > 0)
    || split.intensity.some((week) => week.value > 0);

  const volumeCard = chartCard({
    title: 'Weekly volume',
    subtitle: hasExtra
      ? 'Split by the kind of work that produced it — never summed into one figure'
      : 'Working-set load moved per week',
    type: 'bar',
    height: 180,
    yBounds: 'zero',
    series: [
      {
        label: `Working (${units})`,
        points: split.working.map((week) => ({
          date: week.date, value: displayWeight(week.value, units),
        })),
      },
      ...(hasExtra ? [
        {
          label: `Warm-up (${units})`,
          points: split.warmup.map((week) => ({
            date: week.date, value: displayWeight(week.value, units),
          })),
        },
        {
          label: `Intensity (${units})`,
          points: split.intensity.map((week) => ({
            date: week.date, value: displayWeight(week.value, units),
          })),
        },
      ] : []),
    ],
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
  const consistency = analytics.getConsistency(days, endKey);

  return el('section', {}, [
    sectionHead('Consistency', {
      hint: perfect ? `${perfect} of ${weeks.length} weeks complete` : null,
    }),
    track(card),
    el('div.grid.grid--auto', { style: { marginTop: 'var(--s-3)' } }, [
      stat({
        label: 'Sessions a week',
        value: consistency.perWeek === null ? null : trimNumber(consistency.perWeek, 1),
        foot: pluralize(consistency.sessions, 'session'),
      }),
      stat({
        label: 'On their own day',
        value: `${consistency.onDay}`,
        foot: consistency.lateSessions
          ? `${consistency.lateSessions} trained late — counted as done`
          : 'all of them',
      }),
      stat({
        label: 'Longest gap',
        value: consistency.longestGapDays === null ? null : String(consistency.longestGapDays),
        unit: 'days',
        foot: consistency.medianGapDays === null
          ? 'Needs two sessions'
          : `typical gap ${consistency.medianGapDays}`,
      }),
    ]),
    el('p.t-caption.t-faint', {
      text: 'A session trained a day late is a session done. The program calls the split '
        + 'rolling rather than calendar-locked, so moving one is a normal thing to do and is '
        + 'reported rather than penalised.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

/* --- Personal records --------------------------------------------------- */

function recordsSection() {
  const records = prService.getAllRecords();
  if (!records.length) return null;

  const units = settingsService.getUnits();
  const feed = prService.getRecordFeed();
  const recent = new Set(prService.getRecentRecords(21).map((r) => `${r.exerciseId}:${r.kind}`));

  // One badge per exercise, headlined on the **working** record — the heaviest
  // load actually repeated across the sets. That is the record that says what
  // the lifter can do rather than what they once touched, and it is the one
  // that moves when the training works. The estimated 1RM stands in where a
  // working record has not been established.
  const badges = records
    .filter((record) => record.working || record.e1rm)
    .map((record) => ({ record, headline: record.working ?? record.e1rm }))
    .sort((a, b) => b.headline.value - a.headline.value)
    .map(({ record, headline }) => {
      const kind = record.working ? PR_KINDS.WORKING : PR_KINDS.E1RM;
      const isRecent = recent.has(`${record.exerciseId}:${kind}`);
      const classes = ['pr-badge'];
      if (isRecent && !headline.unverified) classes.push('pr-badge--fresh');
      if (headline.unverified) classes.push('pr-badge--unverified');

      return el(`div.${classes.join('.')}`, {
        title: headline.caveat ?? undefined,
      }, [
        el('div.pr-badge__top', {}, [
          icon(headline.unverified ? 'warning' : 'trophy', { size: 15 }),
          headline.unverified
            ? el('span.pill.pill--warning', { text: 'Check' })
            : (isRecent ? el('span.pill.pill--pr', { text: 'New' }) : null),
        ].filter(Boolean)),
        el('div.pr-badge__name.t-truncate', { text: record.name }),
        el('div.pr-badge__value', {
          text: `${trimNumber(displayWeight(headline.value, units), 1)} ${units}`,
        }),
        el('div.pr-badge__meta', {
          text: record.working
            ? `working load · ${headline.sets ?? 0} ${headline.sets === 1 ? 'set' : 'sets'}`
            : `est. 1RM · ${trimNumber(displayWeight(headline.weightKg, units), 1)} × ${headline.reps}`,
        }),
        el('div.pr-badge__date', { text: relativeDay(headline.date) }),
      ]);
    });

  const unverified = feed.filter((entry) => entry.unverified).length;

  return el('section', {}, [
    sectionHead('Personal records', { hint: pluralize(feed.length, 'record') }),
    el('div.pr-grid', {}, badges),
    el('p.t-caption.t-faint', {
      text: 'The headline is the heaviest load actually *repeated* across the working sets, not '
        + 'the heaviest single set — that is the record that says what you can do on demand. '
        + 'Records are computed from your log, never stored, so deleting a session removes any '
        + 'record it set.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
    unverified
      ? el('p.t-caption.t-faint', {
          text: `${pluralize(unverified, 'record')} sits on a session where the load scale `
            + 'changed — a different machine reading, not necessarily a stronger lift. Those are '
            + 'marked rather than hidden: the set was performed, but the number is not comparable '
            + 'until the machine is tagged.',
          style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
        })
      : null,
  ].filter(Boolean));
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
