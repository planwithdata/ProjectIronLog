/**
 * workout.js — Session 1: read-only program browser.
 *
 * Set logging, the rest timer and the progression engine arrive in Session 2.
 * What this page does today is show the parsed program exactly as it will be
 * trained, which is how the extraction from the source documents gets checked
 * against the real thing before any logging is built on top of it.
 *
 * The exercise card markup here is deliberately the shape Session 2 will
 * extend: heading, illustration slot, prescription row, set rows.
 */

import { el, icon } from '../core/dom.js';
import { go } from '../core/router.js';
import { today, isoWeekday, pluralize } from '../core/format.js';
import * as programService from '../services/program-service.js';
import * as notesService from '../services/notes-service.js';
import { sectionHead } from '../../components/stat.js';

export function render(params = {}) {
  const dayKey = today();
  const selectedId = params.day ?? params[0] ?? programService.getTodayDay(dayKey)?.id;
  const day = programService.getDayById(selectedId) ?? programService.getTodayDay(dayKey);
  const wave = programService.getTrainingWeek(dayKey);

  return el('div.page.enter', {}, [
    daySwitcher(day, dayKey),
    day ? dayHeader(day, wave) : null,
    day?.type === 'training'
      ? el('div.stack.enter-stagger', {},
          day.exercises.map((exercise) => exerciseCard(exercise, day, wave)))
      : restDayPanel(day),
    day?.type === 'training' ? progressionPanel() : null,
  ]);
}

/* --- Day switcher ------------------------------------------------------- */

/**
 * A horizontal weekday strip. Scrolls on a phone, fits on a tablet, and the
 * current calendar day is marked so the app never loses the user's place.
 */
function daySwitcher(selected, dayKey) {
  const currentWeekday = isoWeekday(dayKey);

  return el('div', {
    style: {
      display: 'flex', gap: 'var(--s-2)', overflowX: 'auto',
      paddingBottom: 'var(--s-1)', marginInline: 'calc(var(--gutter) * -1)',
      paddingInline: 'var(--gutter)', scrollbarWidth: 'none',
    },
  }, programService.getDays().map((day) => {
    const isSelected = day.id === selected?.id;
    const isToday = day.weekday === currentWeekday;
    const trainable = day.type === 'training';

    return el('button', {
      type: 'button',
      'aria-current': isSelected ? 'true' : null,
      style: {
        flex: '0 0 auto',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
        minWidth: '52px', minHeight: '58px', padding: 'var(--s-2)',
        borderRadius: 'var(--r-md)',
        background: isSelected ? 'var(--c-accent)' : 'var(--c-surface-1)',
        color: isSelected ? 'var(--c-accent-text)' : (trainable ? 'var(--c-text)' : 'var(--c-text-3)'),
        border: `1px solid ${isToday && !isSelected ? 'var(--c-accent)' : 'var(--c-hairline)'}`,
      },
      on: { click: () => go('workout', { day: day.id }) },
    }, [
      el('span.t-micro.t-semibold', {
        text: day.day.slice(0, 3).toUpperCase(),
        style: { opacity: isSelected ? '0.85' : '0.55' },
      }),
      el('span.t-callout.t-semibold', {
        text: trainable ? String(day.exercises.length) : '—',
      }),
    ]);
  }));
}

/* --- Day header --------------------------------------------------------- */

function dayHeader(day, wave) {
  const setCount = wave.isDeload
    ? day.exercises.reduce((sum, ex) => sum + programService.deloadSets(ex.sets), 0)
    : programService.countSets(day);

  return el('section', {}, [
    el('div.row.row--between', { style: { alignItems: 'flex-start' } }, [
      el('div', { style: { minWidth: 0 } }, [
        el('h1.t-title-1', { text: day.label }),
        el('p.t-footnote.t-dim', { text: day.day }),
      ]),
      day.type === 'training'
        ? el('div.row', { style: { gap: 'var(--s-1)', flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
            el('span.pill', { text: pluralize(day.exercises.length, 'exercise') }),
            el('span.pill', { text: pluralize(setCount, 'set') }),
            wave.isDeload ? el('span.pill.pill--warning', { text: 'Deload' }) : null,
          ])
        : null,
    ]),
    day.type === 'training'
      ? el('p.t-footnote.t-faint', {
          text: 'Logging arrives in Session 2. This is the prescription as parsed from your program.',
          style: { marginTop: 'var(--s-3)' },
        })
      : null,
  ]);
}

/* --- Exercise card ----------------------------------------------------- */

function exerciseCard(exercise, day, wave) {
  const sets = wave.isDeload ? programService.deloadSets(exercise.sets) : exercise.sets;
  const notes = notesService.getNotesFor({ dayId: day.id, exerciseId: exercise.id })
    .filter((note) => note.exerciseId === exercise.id);

  return el('article.card', {}, [
    // Heading row: order badge, name, equipment
    el('div.row', { style: { alignItems: 'flex-start', gap: 'var(--s-3)' } }, [
      el('span.t-caption.t-semibold', {
        text: String(exercise.order),
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '24px', height: '24px', borderRadius: '50%', flex: '0 0 auto',
          background: 'var(--c-surface-3)', color: 'var(--c-text-2)', marginTop: '1px',
        },
      }),
      el('div', { style: { flex: '1 1 auto', minWidth: 0 } }, [
        el('h3.t-callout.t-semibold', { text: exercise.name }),
        el('p.t-caption.t-faint', {
          text: [exercise.equipment, exercise.category, ...(exercise.primaryMuscles ?? [])]
            .filter(Boolean).join(' · '),
          style: { marginTop: '1px' },
        }),
      ]),
    ]),

    // Illustration slot. A labelled placeholder rather than a broken <img>:
    // the source documents ship photo collages, not per-exercise art, so
    // artwork is a deliberate later step (see TODO.md).
    el('div', {
      'aria-hidden': 'true',
      style: {
        marginTop: 'var(--s-3)', height: '96px', borderRadius: 'var(--r-md)',
        background: 'var(--c-surface-3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 'var(--s-2)', color: 'var(--c-text-3)',
        border: '1px dashed var(--c-hairline-firm)',
      },
    }, [
      icon('dumbbell', { size: 20 }),
      el('span.t-caption', { text: 'Illustration' }),
    ]),

    // Prescription
    el('div.grid.grid--3', { style: { marginTop: 'var(--s-3)' } }, [
      prescription('Sets', String(sets), wave.isDeload && sets !== exercise.sets ? `was ${exercise.sets}` : null),
      prescription('Reps', exercise.reps.label, exercise.reps.perSide ? 'each side' : null),
      prescription('Rest', exercise.rest.label, null),
    ]),

    // Progression rule for this lift
    el('div.row.row--between', {
      style: {
        marginTop: 'var(--s-3)', paddingTop: 'var(--s-3)',
        borderTop: '1px solid var(--c-hairline)', gap: 'var(--s-2)',
      },
    }, [
      el('span.t-caption.t-dim', {
        text: exercise.progression.mode === 'reps-first'
          ? 'Add reps before adding weight'
          : `Top of range on all sets → ${exercise.progression.label}`,
      }),
      el('span.pill' + (exercise.progression.mode === 'reps-first' ? '.pill--warning' : '.pill--accent'), {
        text: exercise.progression.mode === 'reps-first' ? 'reps first' : exercise.progression.label,
      }),
    ]),

    // Cues
    exercise.cues?.length
      ? el('ul', { style: { marginTop: 'var(--s-3)', display: 'grid', gap: 'var(--s-1)' } },
          exercise.cues.map((cue) =>
            el('li.t-caption.t-dim', { text: `· ${cue}` })
          ))
      : null,

    // Programme note attached to the exercise itself
    exercise.notes
      ? el('p.t-caption.t-faint', { text: exercise.notes, style: { marginTop: 'var(--s-2)' } })
      : null,

    // Coach notes scoped to this exercise
    notes.length
      ? el('div.stack', { style: { marginTop: 'var(--s-3)', gap: 'var(--s-2)' } },
          notes.map((note) => el('div.note', {}, [el('span.t-footnote', { text: note.text })])))
      : null,
  ]);
}

function prescription(label, value, hint) {
  return el('div', {
    style: {
      background: 'var(--c-surface-3)', borderRadius: 'var(--r-md)',
      padding: 'var(--s-2) var(--s-3)', minWidth: 0,
    },
  }, [
    el('div.t-micro.t-faint', { text: label.toUpperCase() }),
    el('div.t-callout.t-semibold.tnum', { text: value }),
    hint ? el('div.t-micro.t-faint', { text: hint }) : null,
  ]);
}

/* --- Rest / recovery day ----------------------------------------------- */

function restDayPanel(day) {
  if (!day) return null;
  return el('div.card', {}, [
    el('div.row', { style: { gap: 'var(--s-3)', marginBottom: 'var(--s-3)' } }, [
      el('div.list__icon', {}, [icon(day.type === 'recovery' ? 'flame' : 'bed')]),
      el('div', {}, [
        el('div.t-callout.t-semibold', { text: day.type === 'recovery' ? 'Active recovery' : 'Full rest' }),
        el('div.t-caption.t-dim', { text: 'No lifting scheduled' }),
      ]),
    ]),
    el('ul.stack', { style: { gap: 'var(--s-2)' } },
      (day.focus ?? []).map((line) => el('li.t-subhead.t-dim', { text: `· ${line}` }))),
  ]);
}

/* --- Progression reference --------------------------------------------- */

/** The program's own progression rules, kept one tap from the exercises. */
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
};
