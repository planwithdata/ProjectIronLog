/**
 * notes.js — The coach notes editor.
 *
 * These are the instructions that actually change how a session is run, so the
 * scoping controls matter as much as the text: a note attached to an exercise
 * appears on that exercise's card mid-workout, which is the only moment it can
 * usefully be read.
 */

import { el, icon } from '../core/dom.js';
import { go, refresh } from '../core/router.js';
import { toast } from '../core/events.js';
import { relativeDay, formatDate, today, pluralize } from '../core/format.js';
import * as notesService from '../services/notes-service.js';
import { NOTE_CATEGORIES } from '../services/notes-service.js';
import * as programService from '../services/program-service.js';
import { sectionHead, emptyState } from '../../components/stat.js';
import { confirmSheet } from '../../components/sheet.js';

let showArchived = false;

export function render() {
  const notes = notesService.getNotes({ includeArchived: showArchived });

  return el('div.page.enter', {}, [
    backLink(),
    composer(),
    el('section', {}, [
      sectionHead(showArchived ? 'All notes' : 'Active notes', {
        action: showArchived ? 'Hide archived' : 'Show archived',
        onAction: () => { showArchived = !showArchived; refresh(); },
      }),
      notes.length
        ? el('div.stack', {}, notes.map(noteCard))
        : el('div.card.card--quiet', {}, [
            emptyState({
              iconName: 'note',
              title: 'No coach notes',
              text: 'Paste the advice you receive here. Notes show on Home, on the workout screen, and in every report.',
            }),
          ]),
    ]),
  ]);
}

function backLink() {
  return el('button.btn.btn--ghost.btn--sm', {
    type: 'button',
    style: { paddingLeft: '0' },
    on: { click: () => go('reports') },
  }, [
    icon('chevron', { className: 'btn__icon', style: 'transform:rotate(180deg)' }),
    el('span', { text: 'Reports' }),
  ]);
}

/* --- Composer ----------------------------------------------------------- */

function composer() {
  const text = el('textarea.input', {
    rows: '3',
    placeholder: 'e.g. Replace High-to-Low Fly with Low-to-High Fly',
    'aria-label': 'Note text',
  });

  const category = el('select.input', { 'aria-label': 'Category' },
    NOTE_CATEGORIES.map((entry) =>
      el('option', { value: entry.key, text: entry.label, selected: entry.key === 'general' })
    ));

  const source = el('input.input', {
    type: 'text',
    value: 'ChatGPT',
    placeholder: 'Source',
    'aria-label': 'Where this advice came from',
  });

  // Scope: unscoped, a training day, or a specific exercise. An exercise-scoped
  // note is the one that shows up on the card while you are standing at the rack.
  const scope = el('select.input', { 'aria-label': 'Where this note applies' }, [
    el('option', { value: '', text: 'Everywhere' }),
    ...programService.getTrainingDays().map((day) =>
      el('option', { value: `day:${day.id}`, text: `Day — ${day.label}` })),
    ...programService.getAllExercises().map((exercise) =>
      el('option', { value: `ex:${exercise.id}`, text: `Exercise — ${exercise.name}` })),
  ]);

  const pinned = el('input', { type: 'checkbox', id: 'note-pinned' });

  const submit = el('button.btn.btn--primary.btn--block', {
    type: 'submit',
    text: 'Add note',
  });

  const form = el('form.card.stack', { style: { gap: 'var(--s-3)' } }, [
    el('div.t-overline', { text: 'New note' }),
    text,
    el('div.grid.grid--2', {}, [category, source]),
    scope,
    el('label.check-row', { for: 'note-pinned' }, [
      pinned,
      el('span.t-subhead', { text: 'Pin to the top of Home' }),
    ]),
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const value = text.value.trim();
    if (!value) { text.focus(); toast('Write the note first'); return; }

    const raw = scope.value;
    try {
      await notesService.addNote({
        text: value,
        category: category.value,
        source: source.value.trim() || 'Coach',
        dayId: raw.startsWith('day:') ? raw.slice(4) : null,
        exerciseId: raw.startsWith('ex:') ? raw.slice(3) : null,
        pinned: pinned.checked,
        date: today(),
      });
      toast('Note added', 'success');
      refresh();
    } catch (error) {
      toast(error.message || 'Could not add that note', 'danger');
    }
  });

  return form;
}

/* --- Note card ---------------------------------------------------------- */

function noteCard(note) {
  const scopeLabel = note.exerciseId
    ? programService.getExercise(note.exerciseId)?.name ?? note.exerciseId
    : note.dayId
      ? programService.getDayById(note.dayId)?.label ?? note.dayId
      : null;

  return el(`div.note${note.archived ? '.note--archived' : ''}`, {}, [
    el('p', { text: note.text }),

    el('div.row', { style: { gap: 'var(--s-1)', marginTop: 'var(--s-2)', flexWrap: 'wrap' } }, [
      el('span.pill', { text: categoryLabel(note.category) }),
      scopeLabel ? el('span.pill.pill--accent', { text: scopeLabel }) : null,
      note.pinned ? el('span.pill.pill--pr', { text: 'Pinned' }) : null,
      note.archived ? el('span.pill.pill--rest', { text: 'Archived' }) : null,
    ].filter(Boolean)),

    el('div.row.row--between', { style: { marginTop: 'var(--s-2)' } }, [
      el('span.note__meta', {
        text: [note.source, formatDate(note.date), relativeDay(note.date)]
          .filter(Boolean).join(' · '),
      }),
      el('div.row', { style: { gap: '0' } }, [
        iconAction(note.pinned ? 'check' : 'plus', note.pinned ? 'Unpin' : 'Pin', async () => {
          await notesService.togglePinned(note.id);
          refresh();
        }),
        iconAction('note', note.archived ? 'Restore' : 'Archive', async () => {
          await notesService.setArchived(note.id, !note.archived);
          toast(note.archived ? 'Note restored' : 'Note archived');
          refresh();
        }),
        iconAction('info', 'Delete', async () => {
          const confirmed = await confirmSheet({
            title: 'Delete this note?',
            text: 'Archiving keeps it out of the way but leaves it available to older reports.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!confirmed) return;
          await notesService.deleteNote(note.id);
          toast('Note deleted');
          refresh();
        }),
      ]),
    ]),
  ]);
}

function iconAction(iconName, label, onClick) {
  return el('button.btn-icon', {
    type: 'button',
    'aria-label': label,
    title: label,
    style: { width: '36px', height: '36px' },
    on: { click: onClick },
  }, [icon(iconName, { size: 17 })]);
}

function categoryLabel(key) {
  return NOTE_CATEGORIES.find((entry) => entry.key === key)?.label ?? key;
}

export const page = {
  name: 'notes',
  title: 'Coach notes',
  render,
};
