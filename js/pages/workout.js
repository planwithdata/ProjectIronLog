/**
 * workout.js — The logging screen.
 *
 * Two modes on one route:
 *
 *   Browsing — no session open for this day. Shows the prescription and the
 *              engine's recommendation, with a Start button.
 *   Logging  — a session is open. Every set is editable, the rest timer runs,
 *              and a finish panel appears once the work is done.
 *
 * Re-render policy
 * ----------------
 * Ticking a set does *not* re-render the page. Rebuilding the DOM would blur
 * the field the user is in and lose the scroll position mid-workout, which is
 * unacceptable on a phone between sets. Instead each set row patches its own
 * classes and the affected card's header updates in place. A full re-render
 * happens only on genuine mode changes: start, finish, discard, day switch.
 */

import { el, icon, replace, append } from '../core/dom.js';
import { go, refresh } from '../core/router.js';
import { toast } from '../core/events.js';
import {
  today, isoWeekday, pluralize, trimNumber, displayWeight,
  relativeDay, formatDuration,
} from '../core/format.js';
import * as programService from '../services/program-service.js';
import * as sessionService from '../services/session-service.js';
import * as notesService from '../services/notes-service.js';
import * as settingsService from '../services/settings-service.js';
import * as prService from '../services/pr-service.js';
import * as restTimer from '../services/rest-timer.js';
import { actionLabel, repRange, incrementFor, earnedAdvance } from '../engine/progression.js';
import { setRow } from '../../components/set-row.js';
import { mountRestBar } from '../../components/rest-bar.js';
import { openSheet, confirmSheet, sheetRow } from '../../components/sheet.js';
import { sectionHead, emptyState } from '../../components/stat.js';

/** Teardown for the rest bar, held so mount() can return it to the router. */
let unmountRestBar = null;

export function render(params = {}) {
  const dayKey = today();
  const active = sessionService.getActiveSession();

  // An open session wins over the URL: the user must not be able to navigate
  // away from a half-logged workout by tapping a different weekday.
  const requestedId = params.day ?? params[0] ?? null;
  const dayId = active?.dayId ?? requestedId ?? programService.getTodayDay(dayKey)?.id;
  const day = programService.getDayById(dayId) ?? programService.getTodayDay(dayKey);

  if (!day) {
    return el('div.page.enter', {}, [
      emptyState({ title: 'No training day found', text: 'The program has no day for today.' }),
    ]);
  }

  const wave = programService.getTrainingWeek(dayKey);
  const session = active && active.dayId === day.id ? active : null;

  return el('div.page.enter', {}, [
    daySwitcher(day, dayKey, Boolean(active)),
    dayHeader(day, wave, session),
    day.type === 'training'
      ? el('div.stack', {},
          day.exercises.map((exercise) =>
            session
              ? loggingCard(exercise, session, wave)
              : browseCard(exercise, day, wave)))
      : restDayPanel(day),
    session ? finishPanel(session) : startPanel(day, wave, active),
    day.type === 'training' && !session ? progressionPanel() : null,
  ]);
}

/** Mount the rest bar only while a session is open. */
export function mount() {
  const active = sessionService.getActiveSession();
  if (active) unmountRestBar = mountRestBar(document.body);

  return () => {
    if (unmountRestBar) { unmountRestBar(); unmountRestBar = null; }
  };
}

/* --- Day switcher ------------------------------------------------------- */

function daySwitcher(selected, dayKey, locked) {
  const currentWeekday = isoWeekday(dayKey);

  return el('div.day-strip', {
    style: {
      display: 'flex', gap: 'var(--s-2)', overflowX: 'auto',
      paddingBottom: 'var(--s-1)', marginInline: 'calc(var(--gutter) * -1)',
      paddingInline: 'var(--gutter)', scrollbarWidth: 'none',
    },
  }, programService.getDays().map((day) => {
    const isSelected = day.id === selected?.id;
    const isToday = day.weekday === currentWeekday;
    const trainable = day.type === 'training';
    // While a workout is open, other days are inert rather than hidden — the
    // week is still useful context, it just is not navigable.
    const disabled = locked && !isSelected;

    return el('button', {
      type: 'button',
      disabled,
      'aria-current': isSelected ? 'true' : null,
      title: disabled ? 'Finish or discard the workout in progress first' : day.label,
      style: {
        flex: '0 0 auto',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
        minWidth: '52px', minHeight: '58px', padding: 'var(--s-2)',
        borderRadius: 'var(--r-md)',
        background: isSelected ? 'var(--c-accent)' : 'var(--c-surface-1)',
        color: isSelected ? 'var(--c-accent-text)' : (trainable ? 'var(--c-text)' : 'var(--c-text-3)'),
        border: `1px solid ${isToday && !isSelected ? 'var(--c-accent)' : 'var(--c-hairline)'}`,
        opacity: disabled ? '0.4' : '1',
      },
      on: { click: () => go('workout', { day: day.id }) },
    }, [
      el('span.t-micro.t-semibold', {
        text: day.day.slice(0, 3).toUpperCase(),
        style: { opacity: isSelected ? '0.85' : '0.55' },
      }),
      el('span.t-callout.t-semibold', { text: trainable ? String(day.exercises.length) : '—' }),
    ]);
  }));
}

/* --- Day header --------------------------------------------------------- */

function dayHeader(day, wave, session) {
  const setCount = wave.isDeload
    ? day.exercises.reduce((sum, ex) => sum + programService.deloadSets(ex.sets), 0)
    : programService.countSets(day);

  const pills = [];
  if (day.type === 'training') {
    if (session) {
      const completion = sessionService.getSessionCompletion(session);
      pills.push(el('span.pill.pill--accent', {
        text: `${completion.done}/${completion.total} sets`,
      }));
    } else {
      pills.push(el('span.pill', { text: pluralize(day.exercises.length, 'exercise') }));
      pills.push(el('span.pill', { text: pluralize(setCount, 'set') }));
    }
    if (wave.isDeload) pills.push(el('span.pill.pill--warning', { text: 'Deload' }));
  }

  return el('section', {}, [
    el('div.row.row--between', { style: { alignItems: 'flex-start' } }, [
      el('div', { style: { minWidth: 0 } }, [
        el('h2.t-title-1', { text: day.label }),
        el('p.t-footnote.t-dim', {
          text: session ? `Week ${session.week} · in progress` : day.day,
        }),
      ]),
      el('div.row', { style: { gap: 'var(--s-1)', flexWrap: 'wrap', justifyContent: 'flex-end' } }, pills),
    ]),
    // History is a sub-view of Workout rather than a sixth tab: a bottom bar
    // stops being tappable much past five items.
    !session && sessionService.getCompletedSessions().length
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          style: { paddingLeft: '0', marginTop: 'var(--s-2)' },
          on: { click: () => go('history') },
        }, [
          icon('calendar', { className: 'btn__icon' }),
          el('span', { text: 'Workout history' }),
        ])
      : null,
  ]);
}

/* --- Browsing mode ----------------------------------------------------- */

/** The prescription plus what the engine will recommend when you start. */
function browseCard(exercise, day, wave) {
  const sets = wave.isDeload ? programService.deloadSets(exercise.sets) : exercise.sets;
  const plan = sessionService.getRecommendation(exercise);
  const units = settingsService.getUnits();
  const last = sessionService.getLastPerformance(exercise.id);

  return el('article.card', {}, [
    exerciseHead(exercise),
    el('div.ex-card__art', { 'aria-hidden': 'true' }, [
      icon('dumbbell', { size: 20 }),
      el('span.t-caption', { text: 'Illustration' }),
    ]),

    el('div.ex-card__meta', {}, [
      metaPill('Sets', String(sets)),
      metaPill('Reps', exercise.reps.label + (exercise.reps.perSide ? '/side' : '')),
      metaPill('Rest', exercise.rest.label),
      plan.weightKg !== null
        ? metaPill('Target', `${trimNumber(displayWeight(plan.weightKg, units), 2)} ${units}`, 'accent')
        : null,
    ]),

    el('div.ex-card__plan', {}, [
      el('span.t-semibold', { text: `${actionLabel(plan.action)} · ` }),
      el('span', { text: plan.reason }),
    ]),

    last ? lastPerformanceLine(last, exercise, units) : null,
    cuesList(exercise),
    exerciseNotes(exercise, day),
  ]);
}

/* --- Logging mode ------------------------------------------------------ */

/**
 * A live exercise card. Set changes are written straight to storage and the
 * card patches itself; see the re-render policy at the top of this file.
 */
function loggingCard(exercise, session, wave) {
  const entry = session.entries.find((item) => item.exerciseId === exercise.id);
  if (!entry) return null;

  const units = settingsService.getUnits();
  const range = repRange(exercise);
  const increment = incrementFor(exercise);
  const showRpe = true;
  const last = sessionService.getLastPerformance(exercise.id);

  const card = el('article.card', { dataset: { exerciseId: exercise.id } });
  const setsHost = el('div.ex-card__sets');
  const footHost = el('div.ex-card__foot');

  /** Rebuild only this card's rows and footer. */
  const paintCard = () => {
    const current = sessionService.getSessionById(session.id);
    const currentEntry = current?.entries.find((item) => item.exerciseId === exercise.id);
    if (!currentEntry) return;

    const allDone = currentEntry.sets.every((set) => set.completed);
    card.classList.toggle('ex-card--done', allDone);

    replace(setsHost, currentEntry.sets.map((set, index) =>
      setRow({
        index,
        set,
        targetReps: currentEntry.targetReps?.[index] ?? range.min,
        increment,
        units,
        showRpe,
        perSide: Boolean(exercise.reps.perSide),
        onChange: (patch) => handleSetChange(session.id, exercise, index, patch, paintCard),
        // Only sets beyond the prescription can be removed, and only then.
        onRemove: index >= exercise.sets
          ? () => handleRemoveSet(session.id, exercise.id, index, paintCard)
          : null,
      })
    ));

    replace(footHost, [
      el('button.btn.btn--sm.btn--ghost', {
        type: 'button',
        on: { click: () => handleAddSet(session.id, exercise.id, paintCard) },
      }, [icon('plus', { className: 'btn__icon' }), el('span', { text: 'Add set' })]),
      el('span.spacer'),
      earnedAdvance(exercise, currentEntry.sets)
        ? el('span.pill.pill--success', {}, [
            icon('check', { size: 13 }),
            el('span', { text: `Next: +${trimNumber(increment, 2)} kg` }),
          ])
        : allDone
          ? el('span.pill', { text: 'Hold this weight' })
          : el('span.t-caption.t-faint', {
              text: `${currentEntry.sets.filter((s) => s.completed).length}/${currentEntry.sets.length} done`,
            }),
    ]);
  };

  // dom.js `append`, not the native Element.append: the native one stringifies
  // a null child into the literal text "null".
  append(card, [
    exerciseHead(exercise, entry),
    el('div.ex-card__meta', {}, [
      metaPill('Reps', range.label + (exercise.reps.perSide ? '/side' : '')),
      metaPill('Rest', exercise.rest.label),
      entry.targetWeightKg !== null
        ? metaPill('Target', `${trimNumber(displayWeight(entry.targetWeightKg, units), 2)} ${units}`, 'accent')
        : null,
    ]),
    entry.planReason
      ? el('div.ex-card__plan', {}, [
          el('span.t-semibold', { text: `${actionLabel(entry.plannedAction)} · ` }),
          el('span', { text: entry.planReason }),
        ])
      : null,
    last ? lastPerformanceLine(last, exercise, units) : null,
    setsHost,
    footHost,
    exerciseNotes(exercise, programService.getDayById(session.dayId)),
  ]);

  paintCard();
  return card;
}

/**
 * Persist a set change, then start the rest timer if a set was just ticked.
 * The write is fire-and-forget from the UI's point of view: the row has
 * already painted the new state, and a storage failure surfaces as a toast
 * rather than by reverting under the user's thumb.
 */
function handleSetChange(sessionId, exercise, setIndex, patch, paintCard) {
  const wasCompleted = sessionService
    .getSessionById(sessionId)
    ?.entries.find((entry) => entry.exerciseId === exercise.id)
    ?.sets[setIndex]?.completed;

  sessionService.updateSet(sessionId, exercise.id, setIndex, patch)
    .then(() => {
      paintCard();
      updateHeaderCount(sessionId);
      updateFinishPanel(sessionId);
    })
    .catch((error) => {
      console.error('[workout] could not save the set:', error);
      toast(error.message || 'Could not save that set', 'danger');
    });

  // Rest starts on the transition into completed, never on an edit of an
  // already-completed set — nudging a rep count should not restart the clock.
  if (patch.completed === true && !wasCompleted) {
    if (settingsService.getSettings().restTimerAutoStart) {
      restTimer.start(exercise.rest?.seconds ?? 90, exercise.name);
      if (!unmountRestBar) unmountRestBar = mountRestBar(document.body);
    }
  }
}

function handleAddSet(sessionId, exerciseId, paintCard) {
  sessionService.addSet(sessionId, exerciseId)
    .then(() => { paintCard(); updateHeaderCount(sessionId); updateFinishPanel(sessionId); })
    .catch((error) => toast(error.message || 'Could not add a set', 'danger'));
}

function handleRemoveSet(sessionId, exerciseId, setIndex, paintCard) {
  sessionService.removeSet(sessionId, exerciseId, setIndex)
    .then(() => { paintCard(); updateHeaderCount(sessionId); updateFinishPanel(sessionId); })
    .catch((error) => toast(error.message || 'Could not remove that set', 'danger'));
}

/* --- Shared card pieces ------------------------------------------------- */

function exerciseHead(exercise, entry = null) {
  return el('div.ex-card__head', {}, [
    el('span.ex-card__order', { text: String(exercise.order) }),
    el('div', { style: { flex: '1 1 auto', minWidth: 0 } }, [
      el('h3.t-callout.t-semibold', { text: exercise.name }),
      el('p.t-caption.t-faint', {
        text: [exercise.equipment, exercise.category, ...(exercise.primaryMuscles ?? [])]
          .filter(Boolean).join(' · '),
        style: { marginTop: '1px' },
      }),
    ]),
    entry && exercise.progression.mode === 'reps-first'
      ? el('span.pill.pill--warning', { text: 'reps first' })
      : null,
  ]);
}

function metaPill(label, value, tone = '') {
  return el(`span.pill${tone ? `.pill--${tone}` : ''}`, {}, [
    el('span', { text: `${label} `, style: { opacity: '0.6' } }),
    el('span.t-semibold.tnum', { text: value }),
  ]);
}

/** "Last: 27.5 kg × 8, 8, 7, 6 · 5 days ago" */
function lastPerformanceLine(last, exercise, units) {
  const range = repRange(exercise);
  const reps = last.sets.map((set) => set.reps ?? 0);
  const weight = Math.max(...last.sets.map((set) => set.weightKg ?? 0));

  return el('p.t-caption.t-dim', { style: { marginTop: 'var(--s-2)' } }, [
    el('span.t-semibold', { text: 'Last: ' }),
    el('span.tnum', {
      text: weight > 0
        ? `${trimNumber(displayWeight(weight, units), 2)} ${units} × ${reps.join(', ')}`
        : `${reps.join(', ')} reps`,
    }),
    el('span.t-faint', { text: ` · ${relativeDay(last.date)}` }),
    reps.every((count) => count >= range.max)
      ? el('span.t-accent', { text: ' · hit the top of the range' })
      : null,
  ]);
}

function cuesList(exercise) {
  if (!exercise.cues?.length) return null;
  return el('ul', { style: { marginTop: 'var(--s-3)', display: 'grid', gap: 'var(--s-1)' } },
    exercise.cues.map((cue) => el('li.t-caption.t-dim', { text: `· ${cue}` })));
}

function exerciseNotes(exercise, day) {
  const notes = notesService
    .getNotesFor({ dayId: day?.id, exerciseId: exercise.id })
    .filter((note) => note.exerciseId === exercise.id);

  if (!notes.length && !exercise.notes) return null;

  return el('div.stack', { style: { marginTop: 'var(--s-3)', gap: 'var(--s-2)' } }, [
    exercise.notes ? el('p.t-caption.t-faint', { text: exercise.notes }) : null,
    ...notes.map((note) => el('div.note', {}, [el('span.t-footnote', { text: note.text })])),
  ]);
}

/* --- Start / finish ---------------------------------------------------- */

function startPanel(day, wave, active) {
  if (day.type !== 'training') return null;

  // Another day's session is open — offer to go to it rather than silently
  // refusing to start this one.
  if (active && active.dayId !== day.id) {
    const openDay = programService.getDayById(active.dayId);
    return el('div.finish-panel', {}, [
      el('p.t-subhead', { text: `${openDay?.label ?? 'A workout'} is still in progress.` }),
      el('p.t-caption.t-dim', {
        text: `Started ${relativeDay(active.date)}. Finish or discard it before starting another.`,
        style: { marginTop: 'var(--s-1)' },
      }),
      el('button.btn.btn--primary.btn--block', {
        type: 'button',
        text: `Go to ${openDay?.label ?? 'it'}`,
        style: { marginTop: 'var(--s-4)' },
        on: { click: () => go('workout', { day: active.dayId }) },
      }),
    ]);
  }

  return el('div', { style: { marginTop: 'var(--s-6)' } }, [
    el('button.btn.btn--primary.btn--lg.btn--block', {
      type: 'button',
      on: { click: () => handleStart(day.id) },
    }, [
      icon('play', { className: 'btn__icon', filled: true }),
      el('span', { text: wave.isDeload ? 'Start Deload Session' : 'Start Workout' }),
    ]),
    el('p.t-caption.t-faint.t-center', {
      text: 'Weights and reps are pre-filled from your last session.',
      style: { marginTop: 'var(--s-3)' },
    }),
  ]);
}

function finishPanel(session) {
  const panel = el('div.finish-panel', { id: 'finish-panel' });
  paintFinishPanel(panel, session.id);
  return panel;
}

/** Rebuilt in place as sets are ticked, so the button state stays honest. */
function paintFinishPanel(panel, sessionId) {
  const session = sessionService.getSessionById(sessionId);
  if (!session) return;

  const completion = sessionService.getSessionCompletion(session);
  const allDone = completion.done === completion.total && completion.total > 0;

  replace(panel, [
    el('div.row.row--between', {}, [
      el('div', {}, [
        el('div.t-callout.t-semibold', {
          text: allDone ? 'All sets logged' : `${completion.done} of ${completion.total} sets`,
        }),
        el('div.t-caption.t-dim', {
          text: allDone
            ? 'Finish to save this session and update your records.'
            : 'You can finish early — only completed sets are saved.',
        }),
      ]),
      el('div.bar', { style: { width: '64px', flex: '0 0 auto' } }, [
        el('div.bar__fill' + (allDone ? '.bar__fill--success' : ''), {
          style: { width: `${completion.percent}%` },
        }),
      ]),
    ]),
    el('button.btn.btn--block' + (allDone ? '.btn--primary' : '.btn--tinted'), {
      type: 'button',
      text: 'Finish Workout',
      style: { marginTop: 'var(--s-4)' },
      on: { click: () => handleFinish(sessionId) },
    }),
    el('button.btn.btn--block.btn--ghost.btn--sm', {
      type: 'button',
      text: 'Discard workout',
      style: { marginTop: 'var(--s-2)', color: 'var(--c-danger)' },
      on: { click: () => handleDiscard(sessionId) },
    }),
  ]);
}

function updateFinishPanel(sessionId) {
  const panel = document.getElementById('finish-panel');
  if (panel) paintFinishPanel(panel, sessionId);
}

/** Keep the header's set counter in step without a full re-render. */
function updateHeaderCount(sessionId) {
  const session = sessionService.getSessionById(sessionId);
  if (!session) return;
  const completion = sessionService.getSessionCompletion(session);
  const pill = document.querySelector('.page .pill--accent');
  if (pill) pill.textContent = `${completion.done}/${completion.total} sets`;
}

/* --- Actions ----------------------------------------------------------- */

async function handleStart(dayId) {
  try {
    await sessionService.startSession(dayId);
    refresh();
    toast('Workout started', 'success');
  } catch (error) {
    console.error('[workout] could not start:', error);
    toast(error.message || 'Could not start the workout', 'danger');
  }
}

async function handleDiscard(sessionId) {
  const session = sessionService.getSessionById(sessionId);
  const completion = session ? sessionService.getSessionCompletion(session) : null;

  const confirmed = await confirmSheet({
    title: 'Discard this workout?',
    text: completion && completion.done > 0
      ? `${pluralize(completion.done, 'logged set')} will be deleted. This cannot be undone.`
      : 'Nothing has been logged yet, so nothing will be lost.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep logging',
    danger: true,
  });

  if (!confirmed) return;

  try {
    restTimer.stop();
    await sessionService.abandonSession(sessionId);
    refresh();
    toast('Workout discarded');
  } catch (error) {
    toast(error.message || 'Could not discard the workout', 'danger');
  }
}

/**
 * Finish the session, then show what it earned.
 *
 * The summary is built *after* completing, because PRs are derived from the
 * log — the session has to be in it before it can hold a record.
 */
async function handleFinish(sessionId) {
  const session = sessionService.getSessionById(sessionId);
  if (!session) return;

  const completion = sessionService.getSessionCompletion(session);

  if (completion.done === 0) {
    const discard = await confirmSheet({
      title: 'Nothing logged',
      text: 'No sets were completed. Discard this session instead?',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep logging',
      danger: true,
    });
    if (discard) await handleDiscard(sessionId);
    return;
  }

  if (completion.done < completion.total) {
    const proceed = await confirmSheet({
      title: 'Finish early?',
      text: `${completion.done} of ${completion.total} sets are logged. The rest will not be saved.`,
      confirmLabel: 'Finish anyway',
      cancelLabel: 'Keep logging',
    });
    if (!proceed) return;
  }

  try {
    restTimer.stop();
    await sessionService.completeSession(sessionId);
    await showSummary(sessionId);
    refresh();
  } catch (error) {
    console.error('[workout] could not finish:', error);
    toast(error.message || 'Could not finish the workout', 'danger');
  }
}

async function showSummary(sessionId) {
  const summary = sessionService.getSessionSummary(sessionId);
  if (!summary) return;

  const records = prService.getRecordsSetIn(sessionId);
  const units = settingsService.getUnits();

  const body = [
    sheetRow('Sets completed', `${summary.completion.done}/${summary.completion.total}`, { iconName: 'check' }),
    sheetRow('Exercises', String(summary.exercisesDone), { iconName: 'dumbbell' }),
    sheetRow(
      'Volume',
      `${trimNumber(displayWeight(summary.volumeKg, units), 0)} ${units}`,
      { iconName: 'chart' }
    ),
    summary.durationSeconds
      ? sheetRow('Duration', formatDuration(summary.durationSeconds), { iconName: 'timer' })
      : null,
  ].filter(Boolean);

  if (summary.advancing.length) {
    body.push(
      el('p.t-overline', { text: 'Earned a load increase', style: { marginTop: 'var(--s-4)' } }),
      ...summary.advancing.map((item) =>
        el('div.sheet__row', {}, [
          icon('check', { size: 16 }),
          el('span.t-subhead.t-truncate', { text: item.name }),
          el('span.spacer'),
          el('span.t-subhead.t-semibold.stat__delta--up', { text: 'next session' }),
        ])
      )
    );
  }

  if (records.length) {
    body.push(
      el('p.t-overline', { text: pluralize(records.length, 'new record'), style: { marginTop: 'var(--s-4)' } }),
      ...records.slice(0, 6).map((record) =>
        el('div.sheet__row', {}, [
          icon('trophy', { size: 16 }),
          el('div', { style: { minWidth: 0 } }, [
            el('div.t-subhead.t-truncate', { text: record.exerciseName }),
            el('div.t-caption.t-faint', { text: `${record.label} · ${prService.describeRecord(record)}` }),
          ]),
        ])
      )
    );
  }

  await openSheet({
    title: `${summary.dayLabel} complete`,
    text: summary.completion.percent === 100
      ? 'Every prescribed set logged.'
      : `${summary.completion.percent}% of the prescription logged.`,
    body,
    actions: [
      { label: 'Done', value: true, tone: 'primary' },
      { label: 'View history', value: 'history', tone: 'plain' },
    ],
  }).then((choice) => {
    if (choice === 'history') go('history');
  });
}

/* --- Rest / recovery days ---------------------------------------------- */

function restDayPanel(day) {
  return el('div.card', {}, [
    el('div.row', { style: { gap: 'var(--s-3)', marginBottom: 'var(--s-3)' } }, [
      el('div.list__icon', {}, [icon(day.type === 'recovery' ? 'flame' : 'bed')]),
      el('div', {}, [
        el('div.t-callout.t-semibold', {
          text: day.type === 'recovery' ? 'Active recovery' : 'Full rest',
        }),
        el('div.t-caption.t-dim', { text: 'No lifting scheduled' }),
      ]),
    ]),
    el('ul.stack', { style: { gap: 'var(--s-2)' } },
      (day.focus ?? []).map((line) => el('li.t-subhead.t-dim', { text: `· ${line}` }))),
  ]);
}

/* --- Progression reference --------------------------------------------- */

function progressionPanel() {
  const rules = programService.getProgressionRules();
  const program = programService.getProgram().program;

  return el('section', {}, [
    sectionHead('How progression works'),
    el('div.card', {}, [
      el('p.t-subhead', { text: rules.summary }),
      el('ul.stack', { style: { gap: 'var(--s-2)', marginTop: 'var(--s-3)' } },
        rules.rules.map((rule) => el('li.t-footnote.t-dim', { text: `· ${rule}` }))),
      el('hr.divider'),
      el('div.t-overline', { text: 'Wave' }),
      el('p.t-footnote.t-dim', { text: program.wave.deload.note, style: { marginTop: 'var(--s-2)' } }),
      el('div.t-overline', { text: 'If a lift stalls', style: { marginTop: 'var(--s-4)' } }),
      el('p.t-footnote.t-dim', { text: rules.stall.note, style: { marginTop: 'var(--s-2)' } }),
    ]),
  ]);
}

export const page = {
  name: 'workout',
  title: 'Workout',
  render,
  mount,
};
