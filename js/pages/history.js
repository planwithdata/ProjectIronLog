/**
 * history.js — Workout history and session detail.
 *
 * Two views on one route: a list of past sessions, and one session expanded
 * (`#/history/<id>`). Keeping them together means the back-and-forth between
 * "which session was that" and "what did I lift" is a single hash change.
 *
 * Editing a past session is deliberately a two-step action — reopen, then
 * change — because completed sessions are what the PR engine and the reports
 * are computed from.
 */

import { el, icon } from '../core/dom.js';
import { go, refresh } from '../core/router.js';
import { toast } from '../core/events.js';
import {
  formatDate, relativeDay, formatDuration, trimNumber,
  displayWeight, pluralize, formatLoad,
} from '../core/format.js';
import * as sessionService from '../services/session-service.js';
import * as programService from '../services/program-service.js';
import * as settingsService from '../services/settings-service.js';
import * as trainingPrefs from '../services/training-prefs-service.js';
import * as prService from '../services/pr-service.js';
import { repRange, difficultyRung } from '../engine/progression.js';
import { describeLoad } from '../engine/loading.js';
import {
  normalizeEntry, workingSets, warmupSets, intensitySequences,
  isLegacyEntry, describeComposition, PAIN_ACTION_LABELS,
} from '../engine/set-model.js';
import { sectionHead, emptyState, stat } from '../../components/stat.js';
import { confirmSheet, openSheet } from '../../components/sheet.js';

export function render(params = {}) {
  const sessionId = params.id ?? params[0] ?? null;
  return sessionId ? detailView(sessionId) : listView();
}

/* --- List --------------------------------------------------------------- */

function listView() {
  const sessions = sessionService.getCompletedSessions();
  const units = settingsService.getUnits();

  if (!sessions.length) {
    return el('div.page.enter', {}, [
      el('div.card.card--quiet', {}, [
        emptyState({
          iconName: 'calendar',
          title: 'No workouts logged yet',
          text: 'Finish a session and it will appear here with every set you logged.',
          action: 'Go to today’s workout',
          onAction: () => go('workout'),
        }),
      ]),
    ]);
  }

  // Totals across the whole log, so the page opens with something to read
  // rather than just a list.
  const totalVolume = sessions.reduce((sum, s) => sum + sessionService.getSessionVolume(s), 0);
  const totalSets = sessions.reduce((sum, s) => sum + sessionService.getSessionCompletion(s).done, 0);

  return el('div.page.enter', {}, [

    el('div.grid.grid--auto', {}, [
      stat({ label: 'Sessions', value: String(sessions.length) }),
      stat({ label: 'Sets logged', value: String(totalSets) }),
      stat({
        label: 'Total volume',
        value: trimNumber(displayWeight(totalVolume, units), 0),
        unit: units,
      }),
    ]),

    ...groupByMonth(sessions).map(({ label, items }) =>
      el('section', {}, [
        sectionHead(label, { hint: pluralize(items.length, 'session') }),
        el('div.list', {}, items.map((session) => sessionRow(session, units))),
      ])
    ),
  ]);
}

/** Group sessions into month buckets, newest first. */
function groupByMonth(sessions) {
  const buckets = new Map();
  for (const session of sessions) {
    const key = session.date.slice(0, 7);           // YYYY-MM
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(session);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => {
      const [year, month] = key.split('-').map(Number);
      const label = new Date(year, month - 1, 15)
        .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      return { label, items };
    });
}

function sessionRow(session, units) {
  const day = programService.getDayById(session.dayId);
  const completion = sessionService.getSessionCompletion(session);
  const volume = sessionService.getSessionVolume(session);

  return el('button.list__row.list__row--tappable', {
    type: 'button',
    on: { click: () => go('history', { id: session.id }) },
  }, [
    el('div.list__body', {}, [
      el('div.list__title', { text: day?.label ?? session.dayId }),
      el('div.list__sub', {
        text: [
          formatDate(session.date),
          `Week ${session.week}`,
          session.isDeload ? 'deload' : null,
          `${trimNumber(displayWeight(volume, units), 0)} ${units}`,
        ].filter(Boolean).join(' · '),
      }),
    ]),
    el('div.history-row__bar', {}, [
      el('div.bar', {}, [
        el('div.bar__fill' + (completion.percent === 100 ? '.bar__fill--success' : ''), {
          style: { width: `${completion.percent}%` },
        }),
      ]),
      el('div.t-micro.t-faint.t-center', {
        text: `${completion.done}/${completion.total}`,
        style: { marginTop: '3px' },
      }),
    ]),
    icon('chevron', { className: 'list__chevron' }),
  ]);
}

/* --- Detail ------------------------------------------------------------- */

function detailView(sessionId) {
  const session = sessionService.getSessionById(sessionId);

  if (!session) {
    return el('div.page.enter', {}, [
      emptyState({
        title: 'Session not found',
        text: 'It may have been deleted.',
        action: 'Back to history',
        onAction: () => go('history'),
      }),
    ]);
  }

  const day = programService.getDayById(session.dayId);
  const summary = sessionService.getSessionSummary(sessionId);
  const records = prService.getRecordsSetIn(sessionId);
  const units = settingsService.getUnits();

  return el('div.page.enter', {}, [
    el('button.btn.btn--ghost.btn--sm', {
      type: 'button',
      style: { paddingLeft: '0' },
      on: { click: () => go('history') },
    }, [
      icon('chevron', { className: 'btn__icon', style: 'transform:rotate(180deg)' }),
      el('span', { text: 'History' }),
    ]),

    el('div', {}, [
      el('h2.t-title-1', { text: day?.label ?? session.dayId }),
      el('p.t-footnote.t-dim', {
        text: [
          formatDate(session.date, { withYear: true }),
          relativeDay(session.date),
          `Week ${session.week}`,
          session.isDeload ? 'Deload' : null,
          session.status === 'in-progress' ? 'In progress' : null,
        ].filter(Boolean).join(' · '),
      }),
    ]),

    el('div.grid.grid--auto', {}, [
      stat({
        label: 'Working sets',
        value: `${summary.completion.done}/${summary.completion.total}`,
        foot: [
          summary.warmupSetCount ? `${summary.warmupSetCount} warm-up` : null,
          summary.dropSequences ? pluralize(summary.dropSequences, 'drop set') : null,
          summary.failureSets ? pluralize(summary.failureSets, 'failure set') : null,
        ].filter(Boolean).join(' · ') || undefined,
      }),
      stat({
        label: 'Working volume',
        value: trimNumber(displayWeight(summary.volume.workingKg, units), 0),
        unit: units,
        foot: summary.volume.warmupKg || summary.volume.intensityKg
          ? [
              summary.volume.warmupKg
                ? `+${trimNumber(displayWeight(summary.volume.warmupKg, units), 0)} warm-up`
                : null,
              summary.volume.intensityKg
                ? `+${trimNumber(displayWeight(summary.volume.intensityKg, units), 0)} intensity`
                : null,
            ].filter(Boolean).join(' · ')
          : undefined,
      }),
      stat({
        label: 'Duration',
        value: session.durationSeconds ? formatDuration(session.durationSeconds) : null,
        foot: session.durationSeconds ? null : 'Not recorded',
      }),
    ]),

    records.length
      ? el('section', {}, [
          sectionHead(pluralize(records.length, 'record set')),
          el('div.stack', {}, records.map((record) =>
            el('div.card.row', { style: { gap: 'var(--s-3)' } }, [
              el('div', {
                style: {
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: '34px', height: '34px', borderRadius: 'var(--r-md)',
                  background: 'var(--c-pr-dim)', color: 'var(--c-pr)', flex: '0 0 auto',
                },
              }, [icon('trophy', { size: 18 })]),
              el('div', { style: { minWidth: 0 } }, [
                el('div.t-callout.t-semibold.t-truncate', { text: record.exerciseName }),
                el('div.t-caption.t-dim', {
                  text: `${record.label} · ${prService.describeRecord(record)}`,
                }),
              ]),
            ])
          )),
        ])
      : null,

    el('section', {}, [
      sectionHead('Logged sets'),
      el('div.stack', {}, session.entries.map((entry) => entryCard(entry, units, sessionId))),
    ]),

    el('section', {}, [
      sectionHead('Manage'),
      el('div.list', {}, [
        session.status === 'completed'
          ? actionRow('upload', 'Re-open for editing', 'Return this session to in-progress', () => handleReopen(sessionId))
          : actionRow('play', 'Continue logging', 'This session is still open', () => go('workout')),
        actionRow('info', 'Delete session', 'Removes it from history and from your records', () => handleDelete(sessionId), true),
      ]),
      el('p.t-caption.t-faint', {
        text: 'Records and charts are computed from the log, so deleting a session also removes any record it set.',
        style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
      }),
    ]),
  ]);
}

/**
 * One exercise's logged work, grouped by kind.
 *
 * Warm-up, working and intensity sets are shown in separate rows with their own
 * labels. A flat chip list would make a three-rung drop set look like three more
 * working sets, which is the reading the whole set model exists to prevent.
 */
function entryCard(entry, units, sessionId) {
  const exercise = programService.getExercise(entry.exerciseId);
  const live = normalizeEntry(entry);
  const working = workingSets(live).filter((set) => set.completed);
  const warmups = warmupSets(live).filter((set) => set.completed);
  const sequences = intensitySequences(live);
  const legacy = isLegacyEntry(live);
  const range = exercise ? repRange(exercise) : { max: Infinity };
  const loadPrefs = trainingPrefs.getLoadPrefs();

  const chip = (set, { top = false } = {}) => {
    const descriptor = exercise ? describeLoad(exercise, set.weightKg, loadPrefs) : null;
    return el(`span.set-chip${top ? '.set-chip--top' : ''}`, {}, [
      el('span.set-chip__weight', {
        text: set.weightKg
          ? trimNumber(displayWeight(descriptor?.displayKg ?? set.weightKg, units), 2)
          : 'BW',
      }),
      el('span.set-chip__reps', { text: `× ${set.reps ?? 0}` }),
      set.rpe ? el('span.set-chip__reps', { text: ` @${set.rpe}` }) : null,
      set.toFailure ? el('span.set-chip__reps', { text: ' → failure' }) : null,
    ]);
  };

  // How the numbers in the chips should be read. Spelled out as a sentence
  // rather than pasted in raw: "Loads shown / hand." is not English.
  const readingNote = (() => {
    if (!exercise || !working.length) return null;
    switch (describeLoad(exercise, working[0]?.weightKg ?? null, loadPrefs).qualifier) {
      case '/ hand':   return 'Loads shown per hand.';
      case 'plates':   return 'Loads shown as plates; the bar is not included.';
      case 'per side': return 'Loads shown as the machine value, per side.';
      case 'total':    return 'Loads shown as the total of both dumbbells.';
      default:         return null;
    }
  })();

  return el('article.card', {}, [
    el('div.row.row--between', { style: { alignItems: 'flex-start' } }, [
      el('div', { style: { minWidth: 0 } }, [
        el('div.t-callout.t-semibold', { text: exercise?.name ?? entry.exerciseId }),
        el('div.t-caption.t-faint', {
          text: describeComposition(live) || 'Skipped',
        }),
      ]),
      el('div.row', { style: { gap: 'var(--s-1)', flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
        legacy ? el('span.pill', { text: 'unclassified' }) : null,
        entry.targetWeightKg !== null && entry.targetWeightKg !== undefined && exercise
          ? el('span.pill', {
              text: `target ${formatLoad(describeLoad(exercise, entry.targetWeightKg, loadPrefs), units)}`,
            })
          : null,
      ]),
    ]),

    warmups.length
      ? el('div', { style: { marginTop: 'var(--s-2)' } }, [
          el('div.t-micro.t-faint', { text: 'WARM-UP' }),
          el('div.session-detail__sets', {}, warmups.map((set) => chip(set))),
        ])
      : null,

    working.length
      ? el('div', { style: { marginTop: 'var(--s-2)' } }, [
          el('div.t-micro.t-faint', {
            text: legacy ? 'LOGGED SETS' : 'WORKING SETS',
          }),
          el('div.session-detail__sets', {},
            working.map((set) => chip(set, { top: (set.reps ?? 0) >= range.max }))),
        ])
      : null,

    ...sequences.map((sequence) => el('div', { style: { marginTop: 'var(--s-2)' } }, [
      el('div.t-micro.t-faint', {
        text: sequence.type === 'drop' ? 'DROP SET' : 'FAILURE SET',
      }),
      el('div.session-detail__sets', {},
        // Arrows between stages: a drop set is a sequence, and the order is the
        // technique.
        sequence.stages.flatMap((stage, index) => [
          index ? el('span.t-caption.t-faint', { text: '↓' }) : null,
          chip(stage),
        ]).filter(Boolean)),
      sequence.note
        ? el('div.t-caption.t-faint', { text: sequence.note, style: { marginTop: '2px' } })
        : null,
    ])),

    live.pain
      ? el('div.pain-panel', { style: { marginTop: 'var(--s-3)' } }, [
          el('div.t-footnote.t-semibold', { text: `Discomfort ${live.pain.score}/10` }),
          el('div.t-caption.t-dim', {
            text: [live.pain.location, PAIN_ACTION_LABELS[live.pain.action], live.pain.note]
              .filter(Boolean).join(' · '),
          }),
        ])
      : null,

    live.difficulty
      ? el('p.t-caption.t-dim', {
          text: `Difficulty: ${difficultyRung(exercise, live.difficulty)?.label ?? live.difficulty}`,
          style: { marginTop: 'var(--s-2)' },
        })
      : null,

    readingNote
      ? el('p.t-micro.t-faint', { text: readingNote, style: { marginTop: 'var(--s-2)' } })
      : null,

    // The honest fix for unclassified history: let the user say what those sets
    // were, rather than have the app decide for them.
    legacy && working.length
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          style: { marginTop: 'var(--s-2)' },
          on: { click: () => openReclassifySheet(sessionId, entry, exercise, units) },
        }, [el('span', { text: 'Classify these sets' })])
      : null,

    entry.notes ? el('p.t-caption.t-dim', { text: entry.notes, style: { marginTop: 'var(--s-2)' } }) : null,
  ]);
}

/**
 * Ask which of a legacy entry's sets were ramps.
 *
 * Every set defaults to Working — the reading the migration already uses — so
 * confirming without changing anything is a no-op rather than a silent
 * reinterpretation.
 */
async function openReclassifySheet(sessionId, entry, exercise, units) {
  const sets = normalizeEntry(entry).sets;
  const choices = sets.map(() => 'working');

  const rows = sets.map((set, index) => {
    const label = set.weightKg
      ? `${trimNumber(displayWeight(set.weightKg, units), 2)} ${units} × ${set.reps ?? 0}`
      : `Bodyweight × ${set.reps ?? 0}`;

    const select = el('select.input', {
      'aria-label': `Set ${index + 1} kind`,
      on: { change: (event) => { choices[index] = event.target.value; } },
    }, [
      el('option', { value: 'working', text: 'Working set', selected: true }),
      el('option', { value: 'warmup', text: 'Warm-up / ramp' },),
      el('option', { value: 'drop', text: 'Drop-set stage' }),
    ]);

    return el('div.row.row--between', { style: { gap: 'var(--s-3)' } }, [
      el('span.t-subhead.tnum', { text: `${index + 1}. ${label}` }),
      el('div', { style: { flex: '0 0 auto', width: '150px' } }, [select]),
    ]);
  });

  const choice = await openSheet({
    title: 'Classify these sets',
    text: `${exercise?.name ?? 'This exercise'} was logged before warm-up tracking existed, so `
      + 'the app does not know which sets were ramps. Nothing changes unless you say so — the '
      + 'weights and reps are untouched either way.',
    body: el('div.stack', { style: { gap: 'var(--s-3)' } }, rows),
    actions: [
      { label: 'Save', value: true, tone: 'primary' },
      { label: 'Cancel', value: false, tone: 'plain' },
    ],
  });

  if (!choice) return;

  try {
    await sessionService.reclassifyLegacySets(sessionId, entry.exerciseId, choices);
    toast('Sets classified', 'success');
    refresh();
  } catch (error) {
    toast(error.message || 'Could not classify those sets', 'danger');
  }
}

function actionRow(iconName, title, sub, onClick, danger = false) {
  return el('button.list__row.list__row--tappable', { type: 'button', on: { click: onClick } }, [
    el('div.list__icon', danger ? { style: { background: 'var(--c-danger-dim)' } } : {}, [icon(iconName)]),
    el('div.list__body', {}, [
      el('div.list__title', danger ? { text: title, style: { color: 'var(--c-danger)' } } : { text: title }),
      el('div.list__sub', { text: sub }),
    ]),
  ]);
}

/* --- Actions ----------------------------------------------------------- */

async function handleReopen(sessionId) {
  try {
    await sessionService.reopenSession(sessionId);
    toast('Session re-opened');
    go('workout');
  } catch (error) {
    toast(error.message || 'Could not re-open that session', 'danger');
  }
}

async function handleDelete(sessionId) {
  const confirmed = await confirmSheet({
    title: 'Delete this session?',
    text: 'Every set logged in it will be removed, along with any personal record it set. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await sessionService.deleteSession(sessionId);
    toast('Session deleted');
    go('history');
  } catch (error) {
    toast(error.message || 'Could not delete that session', 'danger');
  }
}

export const page = {
  name: 'history',
  title: 'History',
  render,
};
