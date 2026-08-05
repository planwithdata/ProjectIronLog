/**
 * home.js — The Home page.
 *
 * This is the screen that gets opened in the gym doorway, so it answers one
 * question above all others: what am I doing today, and do I start now?
 * Everything else on the page is glanceable context beneath that.
 *
 * Every tile degrades to an em dash with a hint rather than a zero, because
 * on day one there is no history and a wall of "0 kg" would read as data.
 */

import { el, icon } from '../core/dom.js';
import { go } from '../core/router.js';
import {
  weekdayName, today, displayWeight, trimNumber, formatDuration,
  formatDayCount, relativeDay, pluralize,
} from '../core/format.js';
import * as programService from '../services/program-service.js';
import * as sessionService from '../services/session-service.js';
import * as bodyService from '../services/body-service.js';
import * as notesService from '../services/notes-service.js';
import * as prService from '../services/pr-service.js';
import * as settingsService from '../services/settings-service.js';
import { percentRing } from '../../components/ring.js';
import { stat, sectionHead, emptyState } from '../../components/stat.js';

export function render() {
  const dayKey = today();
  const day = programService.getTodayDay(dayKey);
  const wave = programService.getTrainingWeek(dayKey);
  const active = sessionService.getActiveSession();

  const page = el('div.page.enter', {}, [
    heroCard({ day, wave, active, dayKey }),
    todayFocus(day),
    weekCard(dayKey),
    bodyStats(),
    latestPrCard(),
    recentWorkouts(),
    coachNotesCard(),
  ]);

  return page;
}

/* --- Hero: today's workout --------------------------------------------- */

function heroCard({ day, wave, active, dayKey }) {
  const isTraining = day?.type === 'training';
  const resuming = Boolean(active && active.dayId === day?.id);

  // A session left open from an earlier day: offer to resume it rather than
  // silently stranding the log.
  const strandedSession = active && active.dayId !== day?.id
    ? programService.getDayById(active.dayId)
    : null;

  const weekPill = el('span.pill.pill--accent', {
    text: wave.isDeload ? `Week ${wave.week} · Deload` : `Week ${wave.week}`,
  });

  const children = [
    el('div.hero__eyebrow', {}, [
      el('span.t-caption.t-semibold.t-dim', { text: weekdayName(dayKey).toUpperCase() }),
      weekPill,
      wave.isDeload
        ? el('span.pill.pill--warning', { text: 'Cut sets ~40%' })
        : null,
    ]),
    el('h2.hero__title', { text: day ? day.label : 'No session scheduled' }),
  ];

  if (isTraining) {
    const exerciseCount = day.exercises.length;
    const setCount = wave.isDeload
      ? day.exercises.reduce((sum, ex) => sum + programService.deloadSets(ex.sets), 0)
      : programService.countSets(day);

    children.push(
      el('div.hero__meta', {}, [
        metaItem('dumbbell', pluralize(exerciseCount, 'exercise')),
        metaItem('check', pluralize(setCount, 'set')),
        metaItem('timer', `~${formatDuration(estimateDuration(day, wave.isDeload))}`),
      ]),
      el('div', { style: { marginTop: 'var(--s-5)' } }, [
        el('button.btn.btn--primary.btn--lg.btn--block', {
          type: 'button',
          on: { click: () => go('workout', { day: day.id }) },
        }, [
          icon(resuming ? 'play' : 'play', { className: 'btn__icon', filled: true }),
          el('span', { text: resuming ? 'Resume Workout' : 'Start Workout' }),
        ]),
      ])
    );

    if (resuming) {
      const completion = sessionService.getSessionCompletion(active);
      children.push(
        el('p.t-footnote.t-dim.t-center', {
          text: `In progress · ${completion.done} of ${completion.total} sets logged`,
          style: { marginTop: 'var(--s-3)' },
        })
      );
    }
  } else {
    // Rest and recovery days get the same visual weight — they are part of
    // the program, not an absence of one.
    children.push(
      el('p.t-subhead.t-dim', {
        text: day?.type === 'recovery'
          ? 'Recovery day. No lifting.'
          : 'Rest day. Nothing scheduled.',
        style: { marginTop: 'var(--s-2)' },
      }),
      el('div', { style: { marginTop: 'var(--s-5)' } }, [
        el('button.btn.btn--tinted.btn--block', {
          type: 'button',
          text: 'Browse the week',
          on: { click: () => go('workout') },
        }),
      ])
    );
  }

  if (strandedSession) {
    children.push(
      el('button.note', {
        type: 'button',
        style: { marginTop: 'var(--s-4)', width: '100%', textAlign: 'left' },
        on: { click: () => go('workout', { day: strandedSession.id }) },
      }, [
        el('span.t-footnote.t-semibold', { text: `${strandedSession.label} is still open` }),
        el('span.note__meta', { text: `Started ${relativeDay(active.date)} · tap to finish or discard` }),
      ])
    );
  }

  return el('section.hero', {}, children);
}

function metaItem(iconName, label) {
  return el('span.hero__meta-item', {}, [
    icon(iconName, { size: 15 }),
    el('span', { text: label }),
  ]);
}

/**
 * Rough session length: prescribed sets multiplied by their rest interval,
 * plus ~40s of actual work per set. Deliberately an estimate — it exists to
 * answer "have I got time for this before work", not to be a stopwatch.
 */
function estimateDuration(day, isDeload) {
  const WORK_SECONDS_PER_SET = 40;
  return day.exercises.reduce((total, exercise) => {
    const sets = isDeload ? programService.deloadSets(exercise.sets) : exercise.sets;
    const rest = exercise.rest?.seconds ?? 60;
    // The final set of an exercise needs no rest before the next movement.
    return total + sets * WORK_SECONDS_PER_SET + Math.max(0, sets - 1) * rest;
  }, 0);
}

/* --- Today's focus ----------------------------------------------------- */

function todayFocus(day) {
  if (!day?.focus?.length) return null;

  return el('section', {}, [
    sectionHead("Today's focus"),
    el('div.card', {}, [
      el('ul.stack', { style: { gap: 'var(--s-2)' } },
        day.focus.map((line) =>
          el('li.row', { style: { alignItems: 'flex-start', gap: 'var(--s-2)' } }, [
            el('span', {
              style: {
                width: '5px', height: '5px', borderRadius: '50%',
                background: 'var(--c-accent)', flex: '0 0 auto', marginTop: '9px',
              },
            }),
            el('span.t-subhead.t-dim', { text: line }),
          ])
        )
      ),
    ]),
  ]);
}

/* --- This week --------------------------------------------------------- */

function weekCard(dayKey) {
  const week = sessionService.getWeekCompletion(dayKey);
  const streak = sessionService.getWeeklyStreak(dayKey);
  const hasHistory = sessionService.getCompletedSessions().length > 0;

  return el('section', {}, [
    sectionHead('This week'),
    el('div.card', {}, [
      el('div.row', { style: { gap: 'var(--s-4)' } }, [
        percentRing({
          percent: week.percent,
          size: 76,
          sub: '%',
          ariaLabel: `${week.percent} percent of this week's scheduled sessions completed`,
        }),
        el('div', { style: { flex: '1 1 auto', minWidth: '0' } }, [
          el('div.t-title-3', {
            text: hasHistory
              ? `${week.done} of ${week.total} done`
              : 'Not started',
          }),
          el('p.t-footnote.t-dim', {
            text: hasHistory
              ? `${week.scheduledThisWeek} training days a week · scheduled so far: ${week.total}`
              : 'Complete your first session to start tracking.',
            style: { marginTop: '2px' },
          }),
          streak > 0
            ? el('div', { style: { marginTop: 'var(--s-2)' } }, [
                el('span.pill.pill--success', {}, [
                  icon('flame', { size: 13 }),
                  el('span', { text: `${pluralize(streak, 'week')} streak` }),
                ]),
              ])
            : null,
        ]),
      ]),
    ]),
  ]);
}

/* --- Body metrics ------------------------------------------------------ */

function bodyStats() {
  const units = settingsService.getUnits();
  const latestWeight = bodyService.getLatestWeight();
  const bodyFat = bodyService.getLatestField('bodyFatPercent');
  const rate = bodyService.getLeanBulkRate();
  const review = programService.getReviewCountdown();
  const profile = settingsService.getProfile();

  // Distance to the goal weight, when one has been set — the number the
  // lean-bulk decision actually turns on.
  const toGoal = latestWeight && profile.goalWeightKg
    ? profile.goalWeightKg - latestWeight.weightKg
    : null;

  return el('section', {}, [
    sectionHead('Body', { hint: latestWeight ? relativeDay(latestWeight.date) : null }),
    el('div.grid.grid--auto', {}, [
      stat({
        label: 'Body weight',
        value: latestWeight
          ? trimNumber(displayWeight(latestWeight.weightKg, units), 1)
          : null,
        unit: units,
        delta: rate ? Number(rate.kgPerWeek.toFixed(2)) : null,
        deltaSuffix: rate ? '/ week' : '',
        foot: latestWeight ? undefined : 'No weigh-ins yet',
      }),
      stat({
        label: 'Body fat',
        value: bodyFat ? trimNumber(bodyFat.value, 1) : null,
        unit: '%',
        foot: bodyFat ? relativeDay(bodyFat.date) : 'No scale reading yet',
      }),
      stat({
        label: toGoal === null ? 'Goal weight' : 'To goal',
        value: toGoal === null
          ? (profile.goalWeightKg ? trimNumber(displayWeight(profile.goalWeightKg, units), 1) : null)
          : trimNumber(Math.abs(displayWeight(toGoal, units)), 1),
        unit: units,
        foot: toGoal === null
          ? 'Set a goal in Settings'
          : (toGoal > 0 ? 'to gain' : 'above goal'),
      }),
      stat({
        label: 'Next review',
        value: review.daysRemaining === null ? null : formatDayCount(review.daysRemaining),
        foot: review.daysRemaining === null
          ? `Every ${review.intervalDays} days`
          : (review.isOverdue ? 'Review is due' : `Due ${relativeDay(review.dueDate)}`),
      }),
    ]),
    rate
      ? el('p.t-caption.t-faint', {
          text: leanBulkVerdict(rate),
          style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
        })
      : null,
  ]);
}

function leanBulkVerdict(rate) {
  const perWeek = `${trimNumber(rate.kgPerWeek, 2)} kg/week`;
  if (rate.verdict === 'slow') return `Gaining ${perWeek} — slower than a lean bulk needs.`;
  if (rate.verdict === 'fast') return `Gaining ${perWeek} — fast for a lean bulk.`;
  return `Gaining ${perWeek} — on pace for a lean bulk.`;
}

/* --- Latest PR --------------------------------------------------------- */

function latestPrCard() {
  const record = prService.getLatestRecord();

  return el('section', {}, [
    sectionHead('Latest PR'),
    record
      ? el('div.card.row', { style: { gap: 'var(--s-4)' } }, [
          el('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '42px', height: '42px', borderRadius: 'var(--r-md)',
              background: 'var(--c-pr-dim)', color: 'var(--c-pr)', flex: '0 0 auto',
            },
          }, [icon('trophy', { size: 22 })]),
          el('div', { style: { flex: '1 1 auto', minWidth: '0' } }, [
            el('div.t-callout.t-semibold.t-truncate', { text: record.exerciseName }),
            el('div.t-footnote.t-dim', { text: `${record.label} · ${prService.describeRecord(record)}` }),
          ]),
          el('span.pill.pill--pr', { text: relativeDay(record.date) }),
        ])
      : el('div.card.card--quiet', {}, [
          emptyState({
            iconName: 'trophy',
            title: 'No records yet',
            text: 'Log your first session and IronLog will start tracking weight, rep, 1RM and volume records automatically.',
          }),
        ]),
  ]);
}

/* --- Recent workouts --------------------------------------------------- */

/**
 * The last few sessions. Omitted entirely until there is history, rather than
 * shown as an empty card — Home already carries two empty states on day one.
 */
function recentWorkouts() {
  const sessions = sessionService.getCompletedSessions().slice(0, 3);
  if (!sessions.length) return null;

  const units = settingsService.getUnits();

  return el('section', {}, [
    sectionHead('Recent', { action: 'All', onAction: () => go('history') }),
    el('div.list', {}, sessions.map((session) => {
      const sessionDay = programService.getDayById(session.dayId);
      const completion = sessionService.getSessionCompletion(session);
      const volume = sessionService.getSessionVolume(session);

      return el('button.list__row.list__row--tappable', {
        type: 'button',
        on: { click: () => go('history', { id: session.id }) },
      }, [
        el('div.list__icon', {}, [icon('dumbbell')]),
        el('div.list__body', {}, [
          el('div.list__title', { text: sessionDay?.label ?? session.dayId }),
          el('div.list__sub', {
            text: [
              relativeDay(session.date),
              `${completion.done}/${completion.total} sets`,
              `${trimNumber(displayWeight(volume, units), 0)} ${units}`,
            ].join(' · '),
          }),
        ]),
        icon('chevron', { className: 'list__chevron' }),
      ]);
    })),
  ]);
}

/* --- Coach notes ------------------------------------------------------- */

function coachNotesCard() {
  const notes = notesService.getHighlightNotes(3);
  const total = notesService.countActive();

  return el('section', {}, [
    sectionHead('Coach notes', {
      hint: total > notes.length ? `${notes.length} of ${total}` : null,
    }),
    notes.length
      ? el('div.stack', {}, notes.map((note) =>
          el('div.note', {}, [
            el('span', { text: note.text }),
            el('span.note__meta', {
              text: [note.source, relativeDay(note.date), note.pinned ? 'Pinned' : null]
                .filter(Boolean)
                .join(' · '),
            }),
          ])
        ))
      : el('div.card.card--quiet', {}, [
          emptyState({
            iconName: 'note',
            title: 'No coach notes',
            text: 'Add the advice you receive and it will show up here, on the workout screen, and in every report.',
          }),
        ]),
  ]);
}

export const page = {
  name: 'home',
  title: 'Home',
  render,
};
