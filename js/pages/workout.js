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
  today, addDays, isoWeekday, pluralize, trimNumber, displayWeight,
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
  difficultyLadder, difficultyRung, repeatableLoad,
} from '../engine/progression.js';
import { describeLoad, loadBasisLabel } from '../engine/loading.js';
import { describeContext } from '../engine/context.js';
import {
  normalizeEntry,
  workingSets,
  warmupSets,
  intensitySequences,
  topSets,
  isLegacyEntry,
  isTopSet,
  describeComposition,
  PAIN_ACTION,
  PAIN_ACTION_LABELS,
} from '../engine/set-model.js';
import { setRow } from '../../components/set-row.js';
import { intensityBlock, intensityActions } from '../../components/intensity-block.js';
import { exerciseArt } from '../../components/exercise-art.js';
import { mountRestBar } from '../../components/rest-bar.js';
import { openSheet, confirmSheet, sheetRow, openChoiceSheet } from '../../components/sheet.js';
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

  const wave = active ?? programService.getTrainingWeek(dayKey);
  const session = active && active.dayId === day.id ? active : null;

  return el('div.page.enter', {}, [
    daySwitcher(day, dayKey, Boolean(active)),
    dayHeader(day, wave, session),
    planningControls(day, session),
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

  // How training this workout today sits against the schedule. Stated on the
  // header rather than buried, because the whole feature is that the answer is
  // allowed to be "one day late" and nothing bad happens.
  const fit = session
    ? sessionService.getSchedule(session)
    : programService.getScheduleFit(day.id, today());
  if (day.type === 'training' && fit && fit.offsetDays !== 0) {
    pills.push(el('span.pill.pill--accent', {
      text: fit.label,
      title: `Scheduled for ${day.day}. Recorded as performed today, and counted as done.`,
    }));
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
    sessionService.getCompletedSessions().length
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          style: { paddingLeft: '0', marginTop: 'var(--s-2)' },
          on: { click: () => go('history') },
        }, [
          icon('calendar', { className: 'btn__icon' }),
          el('span', { text: `Workout history (${sessionService.getCompletedSessions().length})` }),
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

    loadBasisNote(exercise),
    tempoNote(exercise),

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
    // Both figures for a dumbbell pair, always: "36 kg / hand · 72 kg total".
    // A single dumbbell number is the one value in this app that cannot be
    // checked by looking at it, and the brief's third point is exactly that.
    return secondary ? `${primary} · ${secondary}` : primary;
  };

  const card = el('article.card', { dataset: { exerciseId: exercise.id } });
  const contextHost = el('div');
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

    paintContext(contextHost, { exercise, entry: live, session, paintCard, warmupOnly });
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
    warmupOnly ? null : loadBasisNote(exercise),
    warmupOnly ? null : tempoNote(exercise),
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
    contextHost,
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

/* --- What the numbers mean --------------------------------------------- */

/**
 * One line stating the loading convention, on every card that has one.
 *
 * The brief's third point is that a dumbbell figure is misleading unless it
 * says which figure it is. The answer is not a cleverer number — it is a label
 * that is always there, so "55" is never read as one dumbbell and "36 kg /
 * hand" is never read as the pair. The same line does the same job for plates
 * (the bar is excluded) and for a cable stack (this machine only).
 */
function loadBasisNote(exercise) {
  if (programService.isWarmupOnly(exercise)) return null;
  const label = loadBasisLabel(exercise, trainingPrefs.getLoadPrefs());
  if (!label) return null;

  return el('p.ex-card__basis', {}, [
    icon('info', { size: 13 }),
    el('span', { text: label }),
  ]);
}

/** Tempo guidance, where the program gives any. Only the Pallof press, today. */
function tempoNote(exercise) {
  const tempo = programService.getTempo(exercise);
  if (!tempo?.label) return null;

  return el('p.ex-card__basis', {}, [
    icon('timer', { size: 13 }),
    el('span', { text: tempo.label }),
  ]);
}

/* --- Which machine, and which movement --------------------------------
   Two controls that answer the same underlying question: are today's numbers
   on the same scale as last week's? A machine tag and a substitution both
   change the answer, and both are one tap.
   ====================================================================== */

function paintContext(host, { exercise, entry, session, paintCard, warmupOnly }) {
  const wantsMachine = !warmupOnly
    && programService.supportsLoadContext(exercise)
    && trainingPrefs.machineContextEnabled();
  const substitutions = warmupOnly ? [] : programService.getSubstitutions(exercise);

  if (!wantsMachine && !substitutions.length) {
    replace(host, []);
    return;
  }

  const contextLabel = describeContext(entry);
  const substitution = entry.substitution ?? null;

  replace(host, [
    el('div.ex-card__context', {}, [
      wantsMachine
        ? el('button.tag-btn', {
            type: 'button',
            'aria-current': contextLabel ? 'true' : null,
            title: contextLabel
              ? 'Change or clear the machine tag'
              : 'Tag which machine this is, so the history compares like with like',
            on: { click: () => openContextSheet(session.id, exercise, entry, paintCard) },
          }, [
            icon('dumbbell', { size: 13 }),
            el('span', { text: contextLabel ?? 'Tag machine' }),
          ])
        : null,

      substitutions.length
        ? el('button.tag-btn', {
            type: 'button',
            'aria-current': substitution ? 'true' : null,
            title: substitution
              ? 'Change or clear the substitution'
              : 'Log a different movement in this slot without it counting as skipped',
            on: { click: () => openSubstitutionSheet(session.id, exercise, entry, paintCard) },
          }, [
            icon('swap', { size: 13 }),
            el('span', { text: substitution ? substitution.label : 'Substitute' }),
          ])
        : null,
    ].filter(Boolean)),

    // A substitution changes what the card is *about*, so it says so in a
    // sentence rather than only in a tag. The slot still counts as completed —
    // that is the whole point — and the load keeps its own history because two
    // attachments on one stack are two scales.
    substitution
      ? el('p.ex-card__basis', {}, [
          icon('info', { size: 13 }),
          el('span', {
            text: `Performing ${substitution.label} in place of ${exercise.name}. `
              + 'This counts as the exercise done, not skipped'
              + (substitution.comparableLoad
                ? '.'
                : ', and its loads progress on their own since the two readings are not '
                  + 'comparable.'),
          }),
        ])
      : null,
  ].filter(Boolean));
}

/**
 * Pick which machine this is.
 *
 * The options are the machines this exercise has actually been logged against,
 * because in one gym that list *is* the list of machines. A free-text row
 * covers the first time and anything new. Nothing is ever inferred: an untagged
 * entry stays untagged, and the engine handles it by flagging rather than
 * guessing.
 */
async function openContextSheet(sessionId, exercise, entry, paintCard) {
  const known = sessionService.getKnownContexts(exercise.id);
  const attachments = programService.getAttachments(exercise);
  const current = entry.context ?? null;
  const currentKey = current ? `${current.machineId ?? ''}|${current.attachment ?? ''}` : null;

  const choices = [
    ...known.map((context) => ({
      value: { kind: 'known', context },
      label: [context.label || context.machineId, context.attachment].filter(Boolean).join(' · '),
      sub: `last used ${relativeDay(context.lastUsed)}`,
      selected: `${context.machineId ?? ''}|${context.attachment ?? ''}` === currentKey,
      iconName: 'dumbbell',
    })),
    { value: { kind: 'new' }, label: 'A different machine…', sub: 'Name it, and its loads get their own history', iconName: 'plus' },
    ...(current ? [{ value: { kind: 'clear' }, label: 'Remove the tag', sub: 'Back to an untagged reading', iconName: 'close' }] : []),
  ];

  const picked = await openChoiceSheet({
    title: 'Which machine?',
    text: 'Cable and machine readings are not comparable between machines — 4.5 on one stack can '
      + 'be 10 on the next. Tagging it lets the app compare this week with the right week.',
    choices,
  });

  if (!picked) return;

  try {
    if (picked.kind === 'clear') {
      await sessionService.clearEntryContext(sessionId, exercise.id);
    } else if (picked.kind === 'known') {
      await sessionService.setEntryContext(sessionId, exercise.id, picked.context);
    } else {
      const named = await promptForMachine(attachments, current);
      if (!named) return;
      await sessionService.setEntryContext(sessionId, exercise.id, named);
    }
    paintCard();
    // The prescription is frozen at the start of a session by design, so
    // changing the machine offers the re-read rather than performing it: a
    // target that moves under the user between sets is worse than a stale one.
    await offerReanchor(sessionId, exercise, paintCard);
  } catch (error) {
    toast(error.message || 'Could not save that', 'danger');
  }
}

/** Name a machine, and pick its attachment where the movement has a choice. */
async function promptForMachine(attachments, current) {
  const labelInput = el('input.input', {
    type: 'text',
    value: current?.label ?? '',
    placeholder: 'e.g. Corner stack, Machine 2, Blue frame',
    'aria-label': 'Machine name',
    maxlength: '60',
  });

  const attachmentSelect = attachments.length
    ? el('select.input', { 'aria-label': 'Attachment' }, [
        el('option', { value: '', text: 'No attachment', selected: !current?.attachment }),
        ...attachments.map((item) => el('option', {
          value: item, text: item, selected: item === current?.attachment,
        })),
      ])
    : null;

  const choice = await openSheet({
    title: 'Name this machine',
    text: 'Any name that means something to you. It is only ever compared with itself.',
    body: el('div.stack', { style: { gap: 'var(--s-3)' } }, [
      el('div', {}, [el('span.field__label', { text: 'Machine' }), labelInput]),
      attachmentSelect
        ? el('div', {}, [
            el('span.field__label', { text: 'Attachment' }),
            attachmentSelect,
            el('span.t-caption.t-faint', {
              text: 'A rope and a straight bar on one stack are two different scales.',
            }),
          ])
        : null,
    ].filter(Boolean)),
    actions: [
      { label: 'Save', value: 'save', tone: 'primary' },
      { label: 'Cancel', value: false, tone: 'plain' },
    ],
  });

  if (choice !== 'save') return null;
  const label = labelInput.value.trim();
  const attachment = attachmentSelect?.value ?? '';
  if (!label && !attachment) return null;
  return { label, machineId: label, attachment };
}

/**
 * Offer to re-read the target now that the machine is known.
 *
 * Offered, not applied. The session's prescription is deliberately frozen at
 * start, and rewriting it under the user's thumb — possibly after they have
 * already logged two sets — would be worse than leaving a stale figure on a
 * card that now carries the correct machine tag.
 */
async function offerReanchor(sessionId, exercise, paintCard) {
  const session = sessionService.getSessionById(sessionId);
  const entry = session?.entries.find((item) => item.exerciseId === exercise.id);
  if (!entry) return;

  const plan = sessionService.getRecommendation(exercise, today(), { context: entry.context });
  const current = entry.targetWeightKg ?? null;
  if (plan.weightKg === null || plan.weightKg === current) return;

  // Do not offer to overwrite a target the user has already trained against.
  if (workingSets(normalizeEntry(entry)).some((set) => set.completed)) return;

  const accepted = await confirmSheet({
    title: 'Update today\'s target?',
    text: `With this machine, the history reads ${trimNumber(plan.weightKg, 2)} kg rather than `
      + `${current === null ? 'nothing' : `${trimNumber(current, 2)} kg`}. ${plan.reason}`,
    confirmLabel: 'Use the new target',
    cancelLabel: 'Keep what is on the card',
  });
  if (!accepted) return;

  try {
    await sessionService.updateEntry(sessionId, exercise.id, {
      targetWeightKg: plan.weightKg,
      targetReps: plan.perSetReps,
      plannedAction: plan.action,
      planReason: plan.reason,
    });
    // The set rows carry the target as their pre-filled load, so they are
    // re-seeded too — but only the ones not yet logged.
    const live = sessionService.getSessionById(sessionId)
      ?.entries.find((item) => item.exerciseId === exercise.id);
    for (const [index, set] of (live?.sets ?? []).entries()) {
      if (set.completed) continue;
      await sessionService.updateSet(sessionId, exercise.id, index, {
        weightKg: plan.perSetWeights ? plan.perSetWeights[index] ?? plan.weightKg : plan.weightKg,
        reps: plan.perSetReps[index] ?? set.reps,
      });
    }
    refresh();
  } catch (error) {
    toast(error.message || 'Could not update the target', 'danger');
  }
}

/** Log a listed substitute in this slot. */
async function openSubstitutionSheet(sessionId, exercise, entry, paintCard) {
  const options = programService.getSubstitutions(exercise);
  const current = entry.substitution?.performedId ?? null;

  const choices = [
    {
      value: { kind: 'clear' },
      label: exercise.name,
      sub: 'As programmed',
      selected: !current,
      iconName: 'check',
    },
    ...options.map((option) => ({
      value: { kind: 'use', id: option.id },
      label: option.label,
      sub: option.note
        ?? (option.comparableLoad
          ? 'Loads are comparable'
          : 'Keeps its own load history'),
      selected: option.id === current,
      iconName: 'swap',
    })),
  ];

  const picked = await openChoiceSheet({
    title: 'What are you actually doing?',
    text: 'A substitute counts as the exercise done, not skipped. Its loads keep their own '
      + 'history where the two readings are not comparable.',
    choices,
  });

  if (!picked) return;

  try {
    if (picked.kind === 'clear') await sessionService.clearSubstitution(sessionId, exercise.id);
    else await sessionService.substituteEntry(sessionId, exercise.id, picked.id);
    paintCard();
  } catch (error) {
    toast(error.message || 'Could not save that', 'danger');
  }
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
  const repeatable = repeatableLoad(entry);
  const tops = topSets(entry).length;
  const maintained = programService.isMaintained(exercise);

  replace(host, [
    setGroupHead(
      legacy ? 'Logged sets (unclassified)' : 'Working sets',
      tops ? `${done}/${sets.length} · ${tops} top` : `${done}/${sets.length}`,
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
      variant: isTopSet(set) ? 'top' : 'working',
      indexLabel: isTopSet(set) ? `T${index + 1}` : null,
      // A heavier set marked as a probe. Offered on every working set, because
      // which one it was is not knowable in advance — and it never appears on a
      // maintained movement, where there is no working load to probe past.
      onToggleTop: maintained || legacy
        ? null
        : () => handleToggleTop(session.id, exercise.id, index, !isTopSet(set), paintCard),
      isTop: isTopSet(set),
      onChange: (patch) => handleSetChange(session.id, exercise, index, patch, paintCard),
      // Only sets beyond the prescription can be removed, and only then.
      onRemove: index >= exercise.sets
        ? () => handleRemoveSet(session.id, exercise.id, index, paintCard)
        : null,
    })),

    // Says what the marking actually did. Without this the toggle is a mystery
    // badge; with it, the reason the next session will read 55 and not 72 is on
    // the screen where the decision was made.
    tops
      ? el('p.ex-card__basis', {}, [
          icon('info', { size: 13 }),
          el('span', {
            text: `${tops === 1 ? 'One set is' : `${tops} sets are`} marked as a heavier top set. `
              + `Still logged, still counted in volume, and still eligible for a heaviest-set `
              + `record — but next session is built on `
              + `${repeatable === null ? 'the repeatable sets' : `${trimNumber(displayWeight(repeatable, units), 2)} ${units}`}, `
              + 'the load you actually repeated.',
          }),
        ])
      : null,
  ].filter(Boolean));
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

  // The load actually *repeated* last time, which is what today is built on.
  // The heaviest set is shown beside it only when the two differ — which is
  // precisely the session where reading the heaviest one was the bug.
  const lastRepeatable = last && last.sets.length ? repeatableLoad(last) : null;
  const lastTop = last && last.sets.length
    ? Math.max(...last.sets.map((set) => set.weightKg ?? 0)) || null
    : null;

  const lastDescriptor = lastRepeatable === null
    ? null
    : describeLoad(exercise, lastRepeatable, loadPrefs);
  const topDescriptor = lastTop !== null && lastTop !== lastRepeatable
    ? describeLoad(exercise, lastTop, loadPrefs)
    : null;
  const todayDescriptor = target === null || target === undefined
    ? null
    : describeLoad(exercise, target, loadPrefs);

  return el('div.plan-compare', {}, [
    el('div.plan-compare__col', {}, [
      el('div.plan-compare__label', {
        text: topDescriptor ? 'Last working load' : 'Last session',
      }),
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
      // "top set 72 kg" — kept visible so a probe is never lost, and never
      // mistaken for the working load again.
      topDescriptor
        ? el('div.t-micro', {
            text: `top set ${formatLoad(topDescriptor, units)}`,
            style: { marginTop: '2px', color: 'var(--c-warning, var(--c-text-3))' },
          })
        : null,
      last
        ? el('div.t-micro.t-faint', {
            text: [
              relativeDay(last.date),
              last.contextLabel ? `on ${last.contextLabel}` : null,
              last.substituted && last.substitution
                ? `as ${last.substitution.label}` : null,
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
      // What the app asked for last time, next to what was done. Both are kept
      // and neither overwrites the other — the brief's eighth point.
      last && last.targetWeightKg !== null && last.targetWeightKg !== undefined
        && lastRepeatable !== null
        && Math.abs(last.targetWeightKg - lastRepeatable) > 0.01
        ? el('div.t-micro.t-faint', {
            text: `planned ${formatLoad(describeLoad(exercise, last.targetWeightKg, loadPrefs), units)}`,
            style: { marginTop: '2px' },
          })
        : null,
    ].filter(Boolean)),
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

/**
 * Mark or unmark a set as a heavier top set.
 *
 * The set does not move and its numbers do not change. What changes is whether
 * the progression engine counts it when deciding the next working load — see
 * `engine/progression.repeatableLoad`.
 */
function handleToggleTop(sessionId, exerciseId, setIndex, isTop, paintCard) {
  sessionService.setTopSet(sessionId, exerciseId, setIndex, isTop)
    .then(() => {
      paintCard();
      updateFinishPanel(sessionId);
      toast(isTop
        ? 'Marked as a top set — it will not set next session\'s working load'
        : 'Back to a working set');
    })
    .catch((error) => toast(error.message || 'Could not save that', 'danger'));
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
    if ((session.plannedDeload ?? session.isDeload) && session.actualDeload == null) {
      const intensity = await openChoiceSheet({ title: 'How did you perform this workout?',
        text: 'A planned deload counts as recovery only if you actually reduced the loading and volume.',
        choices: [{ value: 'deload', label: 'Reduced loading / volume' }, { value: 'normal', label: 'Normal / heavy intensity' }] });
      if (!intensity) return;
      await sessionService.setSessionIntensity(sessionId, intensity === 'deload');
    }
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
    // Which day's workout this was, when that is not the day it happened on.
    // First in the list, because it is the thing about this session that the
    // reader is most likely to be surprised by later.
    summary.schedule && summary.schedule.offsetDays !== 0
      ? sheetRow('Schedule', `${summary.dayLabel} · ${summary.schedule.label}`, { iconName: 'calendar' })
      : null,
    summary.topSetCount
      ? sheetRow('Heavier top sets', String(summary.topSetCount), { iconName: 'warning' })
      : null,
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

  if (summary.substitutions.length) {
    body.push(
      el('p.t-overline', { text: 'Performed as a substitute', style: { marginTop: 'var(--s-4)' } }),
      ...summary.substitutions.map((item) =>
        el('div.sheet__row', {}, [
          icon('swap', { size: 16 }),
          el('div', { style: { minWidth: 0 } }, [
            el('div.t-subhead.t-truncate', { text: item.performedName }),
            el('div.t-caption.t-faint', {
              text: `in place of ${item.plannedName}`
                + (item.comparableLoad ? '' : ' · keeps its own load history'),
            }),
          ]),
        ])
      ),
      el('p.t-caption.t-faint', {
        text: 'Counted as the exercise done, not skipped.',
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
          el('div', { style: { minWidth: 0 } }, [
            el('div.t-subhead.t-truncate', { text: item.name }),
            // The load the increase applies *to*, when the session also
            // contained a heavier probe. Without it "next session" is ambiguous
            // between the 55 kg that was earned and the 72 kg that was touched.
            item.topSets
              ? el('div.t-caption.t-faint', {
                  text: `from ${trimNumber(displayWeight(item.workingWeightKg, units), 2)} ${units} `
                    + `— the top set at ${trimNumber(displayWeight(item.topWeightKg, units), 2)} ${units} `
                    + 'is not the base',
                })
              : null,
          ].filter(Boolean)),
          el('span.spacer'),
          el('span.t-subhead.t-semibold.stat__delta--up', { text: 'next session' }),
        ])
      )
    );
  }

  if (summary.maintained.length) {
    body.push(
      el('p.t-overline', { text: 'Held by design', style: { marginTop: 'var(--s-4)' } }),
      ...summary.maintained.map((item) =>
        el('div.sheet__row', {}, [
          icon('check', { size: 16 }),
          el('span.t-subhead.t-truncate', { text: item.name }),
          el('span.spacer'),
          el('span.t-caption.t-faint', { text: 'not progressed' }),
        ])
      )
    );
  }

  if (records.length) {
    body.push(
      el('p.t-overline', { text: pluralize(records.length, 'new record'), style: { marginTop: 'var(--s-4)' } }),
      ...records.slice(0, 6).map((record) =>
        el('div.sheet__row', {}, [
          icon(record.unverified ? 'warning' : 'trophy', { size: 16 }),
          el('div', { style: { minWidth: 0 } }, [
            el('div.t-subhead.t-truncate', { text: record.exerciseName }),
            el('div.t-caption.t-faint', { text: `${record.label} · ${prService.describeRecord(record)}` }),
            // A record standing on a load-scale change is reported, because the
            // set was performed — and labelled, because the number is not
            // comparable with the one it beat.
            record.unverified
              ? el('div.t-caption', {
                  text: record.caveat ?? '',
                  style: { color: 'var(--c-warning)' },
                })
              : null,
          ].filter(Boolean)),
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

function planningControls(day, session) {
  const button = (text, click) => el('button.btn.btn--ghost.btn--sm', { type: 'button', text, on: { click: async () => {
    try { await click(); } catch (error) { toast(error.message); }
  } } });
  return el('div.row', { style: { flexWrap: 'wrap' } }, [
    !session ? el('p.t-footnote.t-dim', { text: programService.getScheduleChanges().filter((item) => item.dayId === day.id && (item.targetDate >= today() || item.scheduledDate >= today())).map((item) => `${item.scheduledDate}: ${item.status === 'skipped' ? 'skipped' : 'moved to ' + item.targetDate}`).join(' ? ') }) : null,
    !session && day.type === 'training' ? button('Postpone / reschedule / skip', async () => {
      const fit = programService.getScheduleFit(day.id);
      const original = el('input.input', { type: 'date', value: fit.scheduledDate, 'aria-label': 'Original scheduled date' });
      const target = el('input.input', { type: 'date', value: addDays(today(), 1), 'aria-label': 'New workout date' });
      const action = await openSheet({ title: 'Adjust this workout', text: 'Moves keep their original slot. Skipped slots are excluded from adherence; no workout history or progression is changed.',
        body: [el('label', { text: 'Original scheduled date' }), original, el('label', { text: 'New date (tomorrow to postpone)' }), target],
        actions: [{ label: 'Move workout', value: 'rescheduled', tone: 'primary' }, { label: 'Skip this occurrence', value: 'skipped' }, { label: 'Restore original schedule', value: 'reset' }, { label: 'Cancel', value: null }] });
      if (!action) return;
      await programService.changeSchedule(day.id, original.value, target.value, action);
      refresh();
    }) : null,
    button('Deload controls', async () => {
      const period = programService.getDeloadPeriod();
      const action = await openChoiceSheet({ title: 'Deload plan',
        text: `${period?.isDeload ? `Recovery: ${period.start} through ${period.end}. ` : ''}Dates follow the day you train, including moved workouts. The automatic wave does not end a manual recovery period.`,
        choices: [
          { value: 'start', label: 'Start deload / choose dates' },
          { value: 'postpone', label: 'Postpone one week' },
          { value: 'extend', label: 'Extend seven days' },
          { value: 'end', label: 'End deload today' },
          { value: 'october', label: 'Use October 13?19, 2026 / review history' },
        ] });
      if (!action) return;
      if (action === 'october') {
        const corrections = sessionService.getOctoberDeloadCorrections();
        const confirmed = await confirmSheet({ title: 'Confirm October recovery period',
          text: `Set October 13?19, 2026 as recovery. Based on your reported intensity, classify these existing workouts: ${corrections.map(({ session: item, isDeload }) => `${item.date} ${programService.getDayById(item.dayId)?.label ?? item.dayId}: ${isDeload ? 'actual deload' : 'normal intensity'}`).join('; ') || 'No matching completed workouts found'}. Recorded sets, weights, dates and original flags are preserved.`,
          confirmLabel: 'Apply period and classifications', cancelLabel: 'Cancel' });
        if (!confirmed) return;
        await programService.setDeloadPlan('start', '2026-10-13', '2026-10-19');
        for (const item of corrections) await sessionService.setSessionIntensity(item.session.id, item.isDeload);
      } else if (action === 'start') {
        const start = el('input.input', { type: 'date', value: today(), 'aria-label': 'Deload start' });
        const end = el('input.input', { type: 'date', value: addDays(today(), 6), 'aria-label': 'Deload end' });
        const confirmed = await openSheet({ title: 'Recovery dates (inclusive)', text: 'Changes prescriptions for new workouts. Historical classifications are unchanged.',
          body: [el('label', { text: 'Start' }), start, el('label', { text: 'End' }), end],
          actions: [{ label: 'Start deload', value: true, tone: 'primary' }, { label: 'Cancel', value: null }] });
        if (!confirmed) return;
        await programService.setDeloadPlan('start', start.value, end.value);
      } else await programService.setDeloadPlan(action);
      const active = sessionService.getActiveSession();
      if (active && !active.editingCompletedAt && active.date === today()) {
        if (sessionService.getSessionCompletion(active).done === 0) {
          await sessionService.refreshUnloggedPrescription(active.id);
        } else toast('Plan saved. Logged workout prescriptions stay intact; confirm actual intensity when finishing.');
      }
      refresh();
    }),
    session ? button(session.actualDeload == null ? 'Confirm actual intensity' : (session.isDeload ? 'Performed: deload' : 'Performed: normal intensity'), async () => {
      const action = await openChoiceSheet({ title: 'Actual workout intensity',
        text: 'Confirm how this workout was performed. Changes its classification for progression and reports; recorded sets, weights and original metadata are preserved.',
        choices: [{ value: 'normal', label: 'Normal / heavy intensity' }, { value: 'deload', label: 'Reduced load / volume (deload)' }] });
      if (!action) return;
      await sessionService.setSessionIntensity(session.id, action === 'deload');
      refresh();
    }) : null,
  ].filter(Boolean));
}
