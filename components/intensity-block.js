/**
 * intensity-block.js — Optional intensity techniques: drop sets and failure sets.
 *
 * These are deliberately styled as an appendix to the exercise rather than as
 * more of it. A drop-set sequence is one piece of supplementary work with
 * several rungs, not three extra working sets, and the UI has to say so as
 * plainly as the data model does — otherwise the number of "sets" on screen
 * stops matching the number the progression engine is reasoning about.
 *
 * Nothing here is prescribed. The block only appears once the user has added
 * something to it.
 */

import { el, icon, replace } from '../js/core/dom.js';

/**
 * @param {object} options
 * @param {object} options.sequence         { id, type, note, stages: [...] }
 * @param {string} options.units
 * @param {number} options.increment
 * @param {(weightKg: number|null) => string|null} [options.captionFor]
 * @param {(stageIndex: number, patch: object) => void} options.onStageChange
 * @param {() => void} options.onAddStage
 * @param {(stageIndex: number) => void} options.onRemoveStage
 * @param {() => void} options.onRemove
 * @param {(note: string) => void} options.onNoteChange
 * @param {(options: object) => Node} options.renderRow   the setRow factory
 */
export function intensityBlock({
  sequence,
  units = 'kg',
  increment = 2.5,
  captionFor = null,
  onStageChange,
  onAddStage,
  onRemoveStage,
  onRemove,
  onNoteChange,
  renderRow,
}) {
  const isDrop = sequence.type === 'drop';
  const stages = Array.isArray(sequence.stages) ? sequence.stages : [];

  const noteInput = el('input.input', {
    type: 'text',
    value: sequence.note ?? '',
    placeholder: 'Note (optional)',
    'aria-label': `${isDrop ? 'Drop set' : 'Failure set'} note`,
    style: { marginTop: 'var(--s-2)' },
  });
  noteInput.addEventListener('blur', () => onNoteChange(noteInput.value));

  const rows = stages.map((stage, index) => renderRow({
    index,
    set: stage,
    targetReps: null,
    increment,
    units,
    showRpe: false,
    variant: 'drop',
    indexLabel: isDrop ? `S${index + 1}` : 'F',
    captionFor,
    onChange: (patch) => onStageChange(index, patch),
    onRemove: stages.length > 1 ? () => onRemoveStage(index) : null,
  }));

  /**
   * "Reached failure" lives in the header, not in a stage row.
   *
   * Two reasons. It only ever applies to the first rung — that is where the
   * technique's intent lives, and asking it on every rung would imply the later
   * ones are meant to be taken to failure too. And a sixth control inside the
   * row squeezes the weight field below a usable width on a phone: at 390px it
   * rendered "13.6" as "1", which is exactly the kind of number this app cannot
   * afford to get wrong.
   */
  const first = stages[0] ?? {};
  const failureToggle = el('button.set-row__flag', {
    type: 'button',
    'aria-pressed': first.toFailure ? 'true' : 'false',
    'aria-label': isDrop
      ? 'First stage reached failure'
      : 'This set reached failure',
    title: first.toFailure ? 'Reached failure' : 'Did not reach failure',
    on: { click: () => onStageChange(0, { toFailure: !first.toFailure }) },
  }, [
    icon('flame', { size: 12 }),
    el('span', { text: isDrop ? 'Failure on S1' : 'Reached failure' }),
  ]);

  return el('div.intensity', { dataset: { sequenceId: sequence.id } }, [
    el('div.row.row--between', { style: { alignItems: 'center' } }, [
      el('div.row', { style: { gap: 'var(--s-2)', alignItems: 'center', minWidth: 0 } }, [
        el('span.pill.pill--warning', {}, [
          icon('flame', { size: 12 }),
          el('span', { text: isDrop ? 'Drop set' : 'Failure set' }),
        ]),
        el('span.t-caption.t-faint', {
          text: isDrop
            ? `${stages.length} stage${stages.length === 1 ? '' : 's'}`
            : 'supplementary',
        }),
      ]),
      el('button.btn-icon.btn-icon--sm', {
        type: 'button',
        'aria-label': `Remove this ${isDrop ? 'drop set' : 'failure set'}`,
        title: 'Remove',
        on: { click: onRemove },
      }, [icon('close', { size: 15 })]),
    ]),

    el('div', { style: { marginTop: 'var(--s-2)' } }, [failureToggle]),

    el('div.intensity__stages', {}, rows),

    isDrop
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          style: { marginTop: 'var(--s-1)' },
          on: { click: onAddStage },
        }, [icon('plus', { className: 'btn__icon' }), el('span', { text: 'Add drop stage' })])
      : null,

    noteInput,
  ]);
}

/**
 * The "add intensity work" controls, shown only where the program allows the
 * technique and the user has switched it on.
 */
export function intensityActions({ allowDrop, allowFailure, onAddDrop, onAddFailure }) {
  if (!allowDrop && !allowFailure) return null;

  return el('div.row', { style: { gap: 'var(--s-2)', flexWrap: 'wrap' } }, [
    allowDrop
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          on: { click: onAddDrop },
        }, [icon('plus', { className: 'btn__icon' }), el('span', { text: 'Add drop set' })])
      : null,
    allowFailure
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          on: { click: onAddFailure },
        }, [icon('plus', { className: 'btn__icon' }), el('span', { text: 'Add failure set' })])
      : null,
  ]);
}

/** Re-render a mounted block's stage list in place. */
export function repaintStages(host, rows) {
  replace(host, rows);
}
