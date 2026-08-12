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
  relativeDay, formatDuration, formatLoad, formatLoadSecondary,
} from '../core/format.js';
import * as programService from '../services/program-service.js';
import * as sessionService from '../services/session-service.js';
import * as notesService from '../services/notes-service.js';
import * as settingsService from '../services/settings-service.js';
import * as trainingPrefs from '../services/training-prefs-service.js';
import * as prService from '../services/pr-service.js';
import * as restTimer from '../services/rest-timer.js';
import {
  actionLabel, repRange, incrementFor, earnedAdvance,
  difficultyLadder, difficultyRung,
} from '../engine/progression.js';
import { describeLoad } from '../engine/loading.js';
import {
  normalizeEntry, workingSets, warmupSets, intensitySequences,
  isLegacyEntry, isPainLimited, describeComposition, PAIN_ACTION, PAIN_ACTION_LABELS,
} from '../engine/set-model.js';
import { setRow } from '../../components/set-row.js';
import { intensityBlock, intensityActions } from '../../components/intensity-block.js';
import { exerciseArt } from '../../components/exercise-art.js';
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
          visibleExercises(day, session).map((exercise) =>
            session
              ? loggingCard(exercise, session, wave)
              : browseCard(exercise, day, wave)))
      : restDayPanel(day),
    session ? finishPanel(session) : startPanel(day, wave, active),
    day.type === 'training' && !session ? progressionPanel() : null,
  ]);
}

/**
 * Which exercises to draw.
 *
 * An open session is the authority: it lists exactly what was prescribed when
 * it started, so turning the push-up warm-up off mid-week does not make a row
 * the user has already logged disappear. Browsing follows the current
 * preference instead.
 */
function visibleExercises(day, session) {
  if (session) {
    const logged = new Set(session.entries.map((entry) => entry.exerciseId));
    return day.exercises.filter((exercise) => logged.has(exercise.id));
  }
  return day.exercises.filter((exercise) =>
    !programService.isWarmupOnly(exercise) || trainingPrefs.pushupWarmupEnabled());
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
        background: isSelected ? 'var(--c-accent-fill)' : 'var(--c-surface-1)',
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
      // Working exercises only, so Tuesday reads 9 here and 9 in the header
      // rather than gaining a tenth from the optional warm-up movement.
      el('span.t-callout.t-semibold', {
        text: trainable ? String(programService.getWorkingExercises(day).length) : '—',
      }),
    ]);
  }));
}

/* --- Day header --------------------------------------------------------- */

function dayHeader(day, wave, session) {
  // Working exercises only: the optional warm-up movement is not one of the
  // nine things you came to do, and it prescribes no sets to count.
  const working = programService.getWorkingExercises(day);
  const setCount = wave.isDeload
    ? working.reduce((sum, ex) => sum + programService.deloadSets(ex.sets), 0)
    : programService.countSets(day);

  const pills = [];
  if (day.type === 'training') {
    if (session) {
      const completion = sessionService.getSessionCompletion(session);
      pills.push(el('span.pill.pill--accent', {
        text: `${completion.done}/${completion.total} sets`,
      }));
    } else {
      pills.push(el('span.pill', { text: pluralize(working.length, 'exercise') }));
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
  const units = settingsService.getUnits();
  const loadPrefs = trainingPrefs.getLoadPrefs();

  // A pre-workout warm-up movement has no prescription to recommend, so it
  // shows what it is rather than a target it does not have.
  if (programService.isWarmupOnly(exercise)) {
    return el('article.card', {}, [
      exerciseHead(exercise),
      exerciseArt(exercise),
      el('div.ex-card__meta', {}, [
        metaPill('Sets', `1-2 optional`),
        metaPill('Reps', exercise.reps.label),
      ]),
      warmupOnlyBlurb(exercise),
      cuesList(exercise),
      exerciseNotes(exercise, day),
    ]);
  }

  const sets = wave.isDeload ? programService.deloadSets(exercise.sets) : exercise.sets;
  const plan = sessionService.getRecommendation(exercise);
  const last = sessionService.getLastPerformance(exercise.id);
  const range = repRange(exercise);

  const descriptor = plan.weightKg === null || plan.weightKg === undefined
    ? null
    : describeLoad(exercise, plan.weightKg, loadPrefs);

  return el('article.card', {}, [
    exerciseHead(exercise),
    exerciseArt(exercise),

    el('div.ex-card__meta', {}, [
      metaPill('Sets', String(sets)),
      metaPill('Reps', exercise.reps.label),
      metaPill('Rest', exercise.rest.label),
      descriptor ? metaPill('Target', formatLoad(descriptor, units), 'accent') : null,
      programService.supportsRamp(exercise) && trainingPrefs.warmupEnabled()
        ? metaPill('Ramp', `${programService.rampSetCount(exercise)} sets`)
        : null,
    ]),

    el('div.ex-card__plan', {}, [
      el('span.t-semibold', { text: `${actionLabel(plan.action)} · ` }),
      el('span', { text: plan.reason }),
    ]),

    planCompare({
      exercise,
      entry: { targetWeightKg: plan.weightKg, targetReps: plan.perSetReps },
      last,
      units,
      loadPrefs,
      range,
      wave,
    }),

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
  const raw = session.entries.find((item) => item.exerciseId === exercise.id);
  if (!raw) return null;

  const entry = normalizeEntry(raw);
  const units = settingsService.getUnits();
  const prefs = trainingPrefs.getPrefs();
  const loadPrefs = trainingPrefs.getLoadPrefs();
  const range = repRange(exercise);
  const increment = incrementFor(exercise, loadPrefs);
  const last = sessionService.getLastPerformance(exercise.id);
  const warmupOnly = programService.isWarmupOnly(exercise);

  // "55 kg logged" -> "27.5 kg / hand". Shown under the field so the number you
  // typed and the load you are lifting are visibly the same thing.
  const captionFor = (weightKg) => {
    if (weightKg === null || weightKg === undefined) return null;
    const descriptor = describeLoad(exercise, weightKg, loadPrefs);
    if (descriptor.entry === 'machine') return null;   // nothing to derive
    const primary = formatLoad(descriptor, units);
    const secondary = formatLoadSecondary(descriptor, units);
    return secondary ? `${primary} · ${secondary}` : primary;
  };

  const card = el('article.card', { dataset: { exerciseId: exercise.id } });
  const warmupHost = el('div.set-group.set-group--warmup');
  const setsHost = el('div.ex-card__sets');
  const footHost = el('div.ex-card__foot');
  const intensityHost = el('div.set-group.set-group--intensity');
  const painHost = el('div');

  /** Rebuild only this card's rows and footers. */
  const paintCard = () => {
    const current = sessionService.getSessionById(session.id);
    const found = current?.entries.find((item) => item.exerciseId === exercise.id);
    if (!found) return;
    const live = normalizeEntry(found);

    const working = workingSets(live);
    const allDone = working.length > 0 && working.every((set) => set.completed);
    card.classList.toggle('ex-card--done', allDone);

    paintWarmup(warmupHost, { exercise, entry: live, session, units, increment, captionFor, paintCard, warmupOnly });
    paintWorking(setsHost, { exercise, entry: live, session, units, increment, range, captionFor, paintCard, warmupOnly });
    paintFoot(footHost, { exercise, entry: live, session, units, increment, allDone, paintCard, warmupOnly });
    paintIntensity(intensityHost, { exercise, entry: live, session, units, increment, captionFor, paintCard });
    paintPain(painHost, { exercise, entry: live, session, paintCard });
  };

  // dom.js `append`, not the native Element.append: the native one stringifies
  // a null child into the literal text "null".
  append(card, [
    exerciseHead(exercise, entry),
    exerciseArt(exercise),
    warmupOnly ? null : el('div.ex-card__meta', {}, [
      metaPill('Reps', exercise.reps.label),
      metaPill('Rest', exercise.rest.label),
      entry.targetWeightKg !== null && entry.targetWeightKg !== undefined
        ? metaPill(
            'Target',
            formatLoad(describeLoad(exercise, entry.targetWeightKg, loadPrefs), units),
            'accent'
          )
        : null,
    ]),
    warmupOnly ? warmupOnlyBlurb(exercise) : null,
    entry.planReason && !warmupOnly
      ? el('div.ex-card__plan', {}, [
          el('span.t-semibold', { text: `${actionLabel(entry.plannedAction)} · ` }),
          el('span', { text: entry.planReason }),
        ])
      : null,
    // Last session vs today, side by side — the comparison the brief asked for.
    warmupOnly ? null : planCompare({ exercise, entry, last, units, loadPrefs, range, wave }),
    difficultyPicker({ exercise, entry, session }),
    warmupHost,
    setsHost,
    footHost,
    intensityHost,
    painHost,
    exerciseNotes(exercise, programService.getDayById(session.dayId)),
  ]);

  paintCard();
  return card;
}

/* --- Warm-up / ramp section -------------------------------------------- */

/**
 * Ramp-up sets, above the working sets and clearly apart from them.
 *
 * Always offered, even where the program prescribes no ramp: the brief asks
 * that a warm-up set can be added to any exercise. What the program *does*
 * prescribe is pre-filled; everywhere else the section only appears once the
 * user adds a row.
 */
function paintWarmup(host, { exercise, entry, session, units, increment, captionFor, paintCard, warmupOnly }) {
  const rows = warmupSets(entry);
  const enabled = trainingPrefs.warmupEnabled();

  if (!enabled || (!rows.length && !programService.supportsRamp(exercise) && !warmupOnly)) {
    replace(host, []);
    return;
  }

  const done = rows.filter((set) => set.completed).length;

  replace(host, [
    setGroupHead(
      warmupOnly ? 'Pre-workout warm-up' : 'Warm-up / ramp sets',
      rows.length ? `${done}/${rows.length}` : 'not counted as working sets'
    ),

    ...rows.map((set, index) => setRow({
      index,
      set,
      targetReps: null,
      increment,
      units,
      showRpe: false,
      variant: warmupOnly ? 'reps-only' : 'warmup',
      indexLabel: `W${index + 1}`,
      // A bodyweight warm-up movement is logged as reps. No weight field.
      showWeight: !warmupOnly,
      captionFor: warmupOnly ? null : captionFor,
      onChange: (patch) => {
        sessionService.updateWarmupSet(session.id, exercise.id, index, patch)
          .then(paintCard)
          .catch((error) => toast(error.message || 'Could not save that warm-up set', 'danger'));
      },
      onRemove: () => {
        sessionService.removeWarmupSet(session.id, exercise.id, index)
          .then(paintCard)
          .catch((error) => toast(error.message || 'Could not remove that set', 'danger'));
      },
    })),

    el('div.row', { style: { gap: 'var(--s-2)', marginTop: 'var(--s-1)', flexWrap: 'wrap' } }, [
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        on: {
          click: () => sessionService.addWarmupSet(session.id, exercise.id)
            .then(paintCard)
            .catch((error) => toast(error.message || 'Could not add a warm-up set', 'danger')),
        },
      }, [icon('plus', { className: 'btn__icon' }), el('span', { text: 'Add warm-up set' })]),
      !warmupOnly && entry.targetWeightKg
        ? el('button.btn.btn--ghost.btn--sm', {
            type: 'button',
            title: 'Fill the ramp from today\'s working weight',
            on: {
              click: () => sessionService.suggestWarmup(session.id, exercise.id)
                .then(paintCard)
                .catch((error) => toast(error.message || 'Could not build a ramp', 'danger')),
            },
          }, [el('span', { text: 'Suggest ramp' })])
        : null,
    ]),
  ]);
}

/* --- Working sets ------------------------------------------------------ */

function paintWorking(host, { exercise, entry, session, units, increment, range, captionFor, paintCard, warmupOnly }) {
  if (warmupOnly) {
    replace(host, []);
    return;
  }

  const sets = workingSets(entry);
  const done = sets.filter((set) => set.completed).length;
  const legacy = isLegacyEntry(entry);

  replace(host, [
    setGroupHead(
      legacy ? 'Logged sets (unclassified)' : 'Working sets',
      `${done}/${sets.length}`,
      'working'
    ),
    ...sets.map((set, index) => setRow({
      index,
      set,
      targetReps: entry.targetReps?.[index] ?? range.min,
      increment,
      units,
      showRpe: true,
      perSide: Boolean(exercise.reps.perSide),
      captionFor,
      onChange: (patch) => handleSetChange(session.id, exercise, index, patch, paintCard),
      // Only sets beyond the prescription can be removed, and only then.
      onRemove: index >= exercise.sets
        ? () => handleRemoveSet(session.id, exercise.id, index, paintCard)
        : null,
    })),
  ]);
}

function paintFoot(host, { exercise, entry, session, units, increment, allDone, paintCard, warmupOnly }) {
  if (warmupOnly) {
    replace(host, []);
    return;
  }

  const sets = workingSets(entry);
  const loadPrefs = trainingPrefs.getLoadPrefs();

  // What the increase is worth in the units the user reads. On a dumbbell pair
  // "+5 kg" of stored total is "+2.5 kg / hand" on the rack.
  const incrementLabel = () => {
    const descriptor = describeLoad(exercise, increment, loadPrefs);
    if (descriptor.entry === 'total-both') {
      return `+${trimNumber(displayWeight(descriptor.displayKg, units), 2)} ${units} / hand`;
    }
    return `+${trimNumber(displayWeight(increment, units), 2)} ${units}`;
  };

  replace(host, [
    el('button.btn.btn--sm.btn--ghost', {
      type: 'button',
      on: { click: () => handleAddSet(session.id, exercise.id, paintCard) },
    }, [icon('plus', { className: 'btn__icon' }), el('span', { text: 'Add set' })]),
    el('span.spacer'),
    earnedAdvance(exercise, sets)
      ? el('span.pill.pill--success', {}, [
          icon('check', { size: 13 }),
          el('span', { text: `Next: ${incrementLabel()}` }),
        ])
      : allDone
        ? el('span.pill', { text: 'Hold this weight' })
        : el('span.t-caption.t-faint', {
            text: `${sets.filter((s) => s.completed).length}/${sets.length} done`,
          }),
  ]);
}

/* --- Intensity techniques ---------------------------------------------- */

function paintIntensity(host, { exercise, entry, session, units, increment, captionFor, paintCard }) {
  const sequences = intensitySequences(entry);
  const allowedHere = programService.allowsIntensityTechniques(exercise);
  const allowDrop = allowedHere && trainingPrefs.dropSetsEnabled();
  const allowFailure = allowedHere && trainingPrefs.failureSetsEnabled();

  if (!sequences.length && !allowDrop && !allowFailure) {
    replace(host, []);
    return;
  }

  const fail = (error) => toast(error.message || 'Could not save that', 'danger');
  const run = (promise) => promise.then(paintCard).catch(fail);

  replace(host, [
    // The composition line goes below the blocks, not in the group header: it is
    // a sentence, and squeezing it onto the label row crushes both.
    sequences.length
      ? setGroupHead('Optional intensity technique', '', 'intensity')
      : null,

    ...sequences.map((sequence) => intensityBlock({
      sequence,
      units,
      increment,
      captionFor,
      renderRow: setRow,
      onStageChange: (stageIndex, patch) => run(sessionService.updateIntensityStage(
        session.id, exercise.id, sequence.id, stageIndex, patch
      )),
      onAddStage: () => run(sessionService.addDropStage(session.id, exercise.id, sequence.id)),
      onRemoveStage: (stageIndex) => run(sessionService.removeDropStage(
        session.id, exercise.id, sequence.id, stageIndex
      )),
      onRemove: () => run(sessionService.removeIntensitySequence(session.id, exercise.id, sequence.id)),
      onNoteChange: (note) => run(sessionService.updateIntensitySequence(
        session.id, exercise.id, sequence.id, { note }
      )),
    })),

    el('div', { style: { marginTop: 'var(--s-2)' } }, [
      intensityActions({
        allowDrop,
        allowFailure,
        onAddDrop: () => run(sessionService.addDropSet(session.id, exercise.id)),
        onAddFailure: () => run(sessionService.addFailureSet(session.id, exercise.id)),
      }),
    ]),

    sequences.length
      ? el('p.t-caption.t-faint', {
          text: `${describeComposition(entry)}. Intensity work is kept out of progression and out `
            + 'of your working-set volume, and is reported separately.',
          style: { marginTop: 'var(--s-2)' },
        })
      : null,
  ]);
}

/* --- Pain-aware logging ------------------------------------------------ */

/**
 * Optional discomfort logging.
 *
 * Shown on pain-aware movements, and available on any exercise once something
 * has been logged. Deliberately not diagnostic: it records a number, a place
 * and what the user decided to do, and nothing else. The guidance line is
 * informational and says to seek a professional assessment rather than
 * offering one.
 */
function paintPain(host, { exercise, entry, session, paintCard }) {
  const painAware = programService.isPainAware(exercise) && trainingPrefs.painAwareEnabled();
  const logged = entry.pain;

  if (!painAware && !logged) {
    replace(host, []);
    return;
  }

  if (!logged) {
    replace(host, [
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        style: { marginTop: 'var(--s-2)' },
        on: { click: () => openPainSheet(session.id, exercise, entry, paintCard) },
      }, [
        icon('heart', { className: 'btn__icon' }),
        el('span', { text: 'Log pain or discomfort' }),
      ]),
    ]);
    return;
  }

  const alternative = (programService.getAlternatives(exercise) ?? [])
    .find((item) => item.id === logged.alternativeId);

  replace(host, [
    el('div.pain-panel.pain-panel--logged', {}, [
      el('div.row.row--between', {}, [
        el('div', { style: { minWidth: 0 } }, [
          el('div.t-footnote.t-semibold', { text: `Discomfort ${logged.score}/10` }),
          el('div.t-caption.t-dim', {
            text: [
              logged.location || null,
              PAIN_ACTION_LABELS[logged.action] ?? null,
              alternative ? `switched to ${alternative.label}` : null,
            ].filter(Boolean).join(' · ') || 'Logged',
          }),
        ]),
        el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          text: 'Edit',
          on: { click: () => openPainSheet(session.id, exercise, entry, paintCard) },
        }),
      ]),
      logged.note
        ? el('p.t-caption.t-dim', { text: logged.note, style: { marginTop: 'var(--s-2)' } })
        : null,
      el('p.pain-panel__guidance', {
        text: 'Do not force painful repetitions. Consider a pain-free alternative, and seek '
          + 'professional assessment if the problem persists.',
      }),
    ]),
  ]);
}

/**
 * The pain sheet: a 0-10 scale, a location, what you did about it, and an
 * optional substitution. Every field optional except the score.
 */
async function openPainSheet(sessionId, exercise, entry, paintCard) {
  const existing = entry.pain ?? {};
  let score = Number(existing.score ?? 0);
  let action = existing.action ?? PAIN_ACTION.COMPLETED;
  let alternativeId = existing.alternativeId ?? null;

  const dots = [];
  const scale = el('div.pain-panel__scale', {}, Array.from({ length: 11 }, (_, value) => {
    const dot = el('button.pain-panel__dot', {
      type: 'button',
      text: String(value),
      'aria-pressed': value === score ? 'true' : 'false',
      'aria-label': `Discomfort ${value} out of 10`,
      on: {
        click: () => {
          score = value;
          for (const other of dots) {
            other.setAttribute('aria-pressed', Number(other.textContent) === score ? 'true' : 'false');
          }
        },
      },
    });
    dots.push(dot);
    return dot;
  }));

  const locationInput = el('input.input', {
    type: 'text',
    value: existing.location ?? '',
    placeholder: 'Location (optional) — e.g. right elbow',
    'aria-label': 'Location of the discomfort',
  });

  const noteInput = el('input.input', {
    type: 'text',
    value: existing.note ?? '',
    placeholder: 'Notes (optional)',
    'aria-label': 'Notes about the discomfort',
  });

  const actionSelect = el('select.input', {
    'aria-label': 'What you did',
    on: { change: (event) => { action = event.target.value; } },
  }, Object.values(PAIN_ACTION).map((value) => el('option', {
    value,
    text: PAIN_ACTION_LABELS[value],
    selected: value === action,
  })));

  const alternatives = programService.getAlternatives(exercise);
  const altSelect = alternatives.length
    ? el('select.input', {
        'aria-label': 'Alternative exercise',
        on: { change: (event) => { alternativeId = event.target.value || null; } },
      }, [
        el('option', { value: '', text: 'No substitution', selected: !alternativeId }),
        ...alternatives.map((item) => el('option', {
          value: item.id,
          text: item.label,
          selected: item.id === alternativeId,
        })),
      ])
    : null;

  const choice = await openSheet({
    title: 'Pain or discomfort',
    text: 'Logged so the app stops reading a short session as lost strength. Nothing here is a diagnosis.',
    body: el('div.stack', { style: { gap: 'var(--s-3)' } }, [
      el('div', {}, [
        el('span.field__label', { text: 'How much, 0-10' }),
        scale,
      ]),
      locationInput,
      el('div', {}, [
        el('span.field__label', { text: 'What you did' }),
        actionSelect,
      ]),
      altSelect
        ? el('div', {}, [
            el('span.field__label', { text: 'Switched to' }),
            altSelect,
            el('span.t-caption.t-faint', {
              text: 'Nothing is replaced automatically — this records what you chose.',
            }),
          ])
        : null,
      noteInput,
    ]),
    actions: [
      { label: 'Save', value: 'save', tone: 'primary' },
      entry.pain ? { label: 'Remove log', value: 'clear', tone: 'plain' } : null,
      { label: 'Cancel', value: false, tone: 'plain' },
    ].filter(Boolean),
  });

  if (choice === 'save') {
    try {
      await sessionService.setPain(sessionId, exercise.id, {
        score,
        location: locationInput.value,
        note: noteInput.value,
        action,
        alternativeId,
      });
      paintCard();
      toast('Discomfort logged');
    } catch (error) {
      toast(error.message || 'Could not save that', 'danger');
    }
  } else if (choice === 'clear') {
    try {
      await sessionService.clearPain(sessionId, exercise.id);
      paintCard();
    } catch (error) {
      toast(error.message || 'Could not remove that log', 'danger');
    }
  }
}

/* --- Difficulty ladder ------------------------------------------------- */

/**
 * Which rung of the difficulty ladder today's sets are being worked at.
 * Only for difficulty-first movements — the ab wheel, today.
 */
function difficultyPicker({ exercise, entry, session }) {
  if (exercise.progression?.mode !== 'difficulty-first') return null;
  if (!trainingPrefs.difficultyProgressionEnabled()) return null;

  const ladder = difficultyLadder(exercise);
  const currentId = entry.difficulty ?? ladder[0].id;
  const current = difficultyRung(exercise, currentId);

  const select = el('select.input', {
    'aria-label': 'Difficulty',
    on: {
      change: (event) => {
        sessionService.setDifficulty(session.id, exercise.id, event.target.value)
          .then(() => refresh())
          .catch((error) => toast(error.message || 'Could not save that', 'danger'));
      },
    },
  }, ladder.map((rung) => el('option', {
    value: rung.id,
    text: rung.label,
    selected: rung.id === currentId,
  })));

  return el('div', { style: { marginTop: 'var(--s-3)' } }, [
    el('span.field__label', { text: 'Difficulty' }),
    select,
    el('span.t-caption.t-faint', { text: current?.note ?? '' }),
    el('p.t-caption.t-faint', {
      text: 'Progression: build clean reps → improve control/range → increase difficulty → '
        + 'optional external resistance.',
      style: { marginTop: 'var(--s-2)' },
    }),
  ]);
}

/* --- Last session vs today --------------------------------------------- */

/**
 * The two figures that actually decide what to load: what was done last time,
 * and what to do today. Working sets only on both sides.
 */
function planCompare({ exercise, entry, last, units, loadPrefs, range, wave }) {
  const target = entry.targetWeightKg;
  const setCount = entry.targetReps?.length ?? exercise.sets;

  const lastDescriptor = last && last.sets.length
    ? describeLoad(exercise, Math.max(...last.sets.map((set) => set.weightKg ?? 0)) || null, loadPrefs)
    : null;
  const todayDescriptor = target === null || target === undefined
    ? null
    : describeLoad(exercise, target, loadPrefs);

  return el('div.plan-compare', {}, [
    el('div.plan-compare__col', {}, [
      el('div.plan-compare__label', { text: 'Last session' }),
      el('div.plan-compare__value', {
        text: last && last.sets.length
          ? (lastDescriptor?.displayKg ? formatLoad(lastDescriptor, units) : 'Bodyweight')
          : '—',
      }),
      el('div.plan-compare__meta', {
        text: last && last.sets.length
          ? last.sets.map((set) => set.reps ?? 0).join(' / ')
          : 'No history yet',
      }),
      last
        ? el('div.t-micro.t-faint', {
            text: [
              relativeDay(last.date),
              last.painLimited ? 'pain-limited' : null,
              last.legacy ? 'unclassified' : null,
              last.warmupSets?.length ? `${last.warmupSets.length} warm-up` : null,
              last.intensitySets?.length
                ? pluralize(last.intensitySets.length, 'intensity set')
                : null,
            ].filter(Boolean).join(' · '),
            style: { marginTop: '2px' },
          })
        : null,
    ]),
    el('div.plan-compare__col', {}, [
      el('div.plan-compare__label', { text: wave.isDeload ? 'Today · deload' : 'Today' }),
      el('div.plan-compare__value', {
        text: todayDescriptor ? formatLoad(todayDescriptor, units) : 'Your choice',
      }),
      el('div.plan-compare__meta', {
        text: `${range.label} reps × ${setCount} ${setCount === 1 ? 'set' : 'sets'}`,
      }),
      todayDescriptor && formatLoadSecondary(todayDescriptor, units)
        ? el('div.t-micro.t-faint', {
            text: formatLoadSecondary(todayDescriptor, units),
            style: { marginTop: '2px' },
          })
        : null,
    ]),
  ]);
}

/* --- Small pieces ------------------------------------------------------ */

function setGroupHead(label, hint = '', tone = 'warmup') {
  return el('div.set-group__head', {}, [
    el('span.set-group__label', { text: label }),
    el('span.set-group__rule'),
    hint ? el('span.t-micro.t-faint', { text: hint }) : null,
  ]);
}

function warmupOnlyBlurb(exercise) {
  return el('div.ex-card__plan', {}, [
    el('span.t-semibold', { text: 'Optional warm-up · ' }),
    el('span', {
      text: `${exercise.reps?.label ?? '8-15'} reps, 1-2 sets, not to failure. `
        + 'Not counted as working sets or as chest volume.',
    }),
  ]);
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
    exercisePill(exercise, entry),
  ]);
}

/** One badge, chosen by what most changes how this exercise is logged. */
function exercisePill(exercise, entry) {
  if (programService.isWarmupOnly(exercise)) {
    return el('span.pill', { text: 'warm-up' });
  }
  if (programService.isPainAware(exercise) && trainingPrefs.painAwareEnabled()) {
    return el('span.pill', { text: 'pain-aware' });
  }
  if (!entry) return null;
  if (exercise.progression?.mode === 'difficulty-first') {
    return el('span.pill.pill--warning', { text: 'difficulty first' });
  }
  if (exercise.progression?.mode === 'reps-first') {
    return el('span.pill.pill--warning', { text: 'reps first' });
  }
  return null;
}

function metaPill(label, value, tone = '') {
  return el(`span.pill${tone ? `.pill--${tone}` : ''}`, {}, [
    el('span', { text: `${label} `, style: { opacity: '0.6' } }),
    el('span.t-semibold.tnum', { text: value }),
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
    sheetRow('Working sets', `${summary.completion.done}/${summary.completion.total}`, { iconName: 'check' }),
    summary.warmupSetCount
      ? sheetRow('Warm-up sets', String(summary.warmupSetCount), { iconName: 'flame' })
      : null,
    summary.dropSequences || summary.failureSets
      ? sheetRow(
          'Intensity work',
          [
            summary.dropSequences ? pluralize(summary.dropSequences, 'drop set') : null,
            summary.failureSets ? pluralize(summary.failureSets, 'failure set') : null,
          ].filter(Boolean).join(' · '),
          { iconName: 'flame' }
        )
      : null,
    sheetRow('Exercises', String(summary.exercisesDone), { iconName: 'dumbbell' }),
    sheetRow(
      'Working volume',
      `${trimNumber(displayWeight(summary.volume.workingKg, units), 0)} ${units}`,
      { iconName: 'chart' }
    ),
    summary.volume.warmupKg || summary.volume.intensityKg
      ? sheetRow(
          'Other volume',
          [
            summary.volume.warmupKg
              ? `${trimNumber(displayWeight(summary.volume.warmupKg, units), 0)} warm-up`
              : null,
            summary.volume.intensityKg
              ? `${trimNumber(displayWeight(summary.volume.intensityKg, units), 0)} intensity`
              : null,
          ].filter(Boolean).join(' · ') + ` ${units}`,
          { iconName: 'chart' }
        )
      : null,
    summary.durationSeconds
      ? sheetRow('Duration', formatDuration(summary.durationSeconds), { iconName: 'timer' })
      : null,
  ].filter(Boolean);

  if (summary.painLimited.length) {
    body.push(
      el('p.t-overline', { text: 'Logged discomfort', style: { marginTop: 'var(--s-4)' } }),
      ...summary.painLimited.map((item) =>
        el('div.sheet__row', {}, [
          icon('heart', { size: 16 }),
          el('div', { style: { minWidth: 0 } }, [
            el('div.t-subhead.t-truncate', { text: item.name }),
            el('div.t-caption.t-faint', {
              text: [
                item.pain ? `${item.pain.score}/10` : null,
                item.pain?.location || null,
                item.pain ? PAIN_ACTION_LABELS[item.pain.action] : null,
              ].filter(Boolean).join(' · '),
            }),
          ]),
        ])
      ),
      el('p.t-caption.t-faint', {
        text: 'Not counted as a strength regression. Do not force painful repetitions; seek '
          + 'professional assessment if it persists.',
        style: { marginTop: 'var(--s-2)' },
      })
    );
  }

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
