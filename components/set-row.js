/**
 * set-row.js — One logged set.
 *
 * Design constraints this component is built around:
 *
 *   - It is used mid-set, one-handed, with chalky or sweaty hands. Every
 *     target is at least 44px, and the commit action (the checkmark) is the
 *     largest thing in the row.
 *   - The common case is "same as prescribed". Fields arrive pre-filled from
 *     the engine, so a normal set is one tap, not four inputs.
 *   - Steppers exist alongside the keypad because opening the iOS numeric
 *     keyboard to change 30 to 32.5 is slower than two taps.
 *   - Nothing is committed on keystroke. Values commit on blur or on tick,
 *     so a half-typed "3" on the way to "30" is never stored.
 *
 * Layout: [ # ] [ − weight + ] [ − reps + ] [ RPE ] [ ✓ ]
 */

import { el, icon } from '../js/core/dom.js';
import { trimNumber, displayWeight, storeWeight } from '../js/core/format.js';

/**
 * @param {object} options
 * @param {number} options.index            zero-based set index
 * @param {object} options.set              { weightKg, reps, completed, rpe }
 * @param {number} options.targetReps       what the engine asked for
 * @param {number} options.increment        weight step for the +/− buttons
 * @param {string} options.units            'kg' | 'lb' for display
 * @param {boolean} options.showRpe
 * @param {boolean} options.perSide         reps are per side
 * @param {string} [options.variant]        'working' | 'warmup' | 'drop'
 * @param {string} [options.indexLabel]     overrides the set number ("W1", "D2")
 * @param {boolean} [options.showWeight]    false for movements logged as reps only
 * @param {(weightKg: number|null) => string|null} [options.captionFor]
 *        Derived reading of the entered load — "27.5 kg / hand" under a logged
 *        55. Recomputed live as the field changes, because the whole point of
 *        the caption is to confirm that the number you typed means what you
 *        think it means.
 * @param {Node} [options.extra]            appended after the RPE control
 * @param {(patch: object) => void} options.onChange
 * @param {() => void} [options.onRemove]
 */
export function setRow({
  index,
  set,
  targetReps,
  increment = 2.5,
  units = 'kg',
  showRpe = false,
  perSide = false,
  variant = 'working',
  indexLabel = null,
  showWeight = true,
  captionFor = null,
  extra = null,
  onChange,
  onRemove = null,
}) {
  const isDone = Boolean(set.completed);

  /* --- Weight ---------------------------------------------------------- */

  const weightInput = numberInput({
    value: set.weightKg === null || set.weightKg === undefined
      ? ''
      : trimNumber(displayWeight(set.weightKg, units), 2),
    ariaLabel: `Set ${index + 1} weight in ${units}`,
    step: increment,
    onCommit: (raw) => {
      const weightKg = raw === '' ? null : storeWeight(Number(raw), units);
      onChange({ weightKg });
    },
  });

  const weightGroup = stepperGroup({
    input: weightInput,
    label: units,
    // Bodyweight lifts legitimately sit at 0 added load, so the floor is 0.
    onStep: (direction) => {
      const current = Number(weightInput.value) || 0;
      const next = Math.max(0, roundStep(current + direction * increment, increment));
      weightInput.value = trimNumber(next, 2);
      onChange({ weightKg: storeWeight(next, units) });
    },
  });

  /* --- Reps ------------------------------------------------------------ */

  const repsInput = numberInput({
    value: set.reps === null || set.reps === undefined ? '' : String(set.reps),
    ariaLabel: `Set ${index + 1} reps`,
    step: 1,
    integer: true,
    onCommit: (raw) => onChange({ reps: raw === '' ? null : Math.round(Number(raw)) }),
  });

  const repsGroup = stepperGroup({
    input: repsInput,
    label: perSide ? '/side' : 'reps',
    onStep: (direction) => {
      const current = Math.round(Number(repsInput.value) || 0);
      const next = Math.max(0, current + direction);
      repsInput.value = String(next);
      onChange({ reps: next });
    },
  });

  /* --- Commit ---------------------------------------------------------- */

  const check = el('button.set-row__check', {
    type: 'button',
    'aria-pressed': isDone ? 'true' : 'false',
    'aria-label': isDone ? `Undo set ${index + 1}` : `Complete set ${index + 1}`,
    on: {
      click: () => {
        // Ticking a set commits whatever is on screen, including a value the
        // user typed and never blurred out of.
        const weightRaw = weightInput.value;
        const repsRaw = repsInput.value;
        onChange({
          weightKg: weightRaw === '' ? null : storeWeight(Number(weightRaw), units),
          reps: repsRaw === '' ? null : Math.round(Number(repsRaw)),
          completed: !isDone,
        });
      },
    },
  }, [icon('check', { size: 20 })]);

  /* --- RPE ------------------------------------------------------------- */

  const rpe = showRpe
    ? el('select.set-row__rpe', {
        'aria-label': `Set ${index + 1} RPE`,
        on: { change: (event) => onChange({ rpe: event.target.value === '' ? null : Number(event.target.value) }) },
      }, [
        el('option', { value: '', text: 'RPE', selected: set.rpe === null || set.rpe === undefined }),
        ...[6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10].map((value) =>
          el('option', {
            value: String(value),
            text: String(value),
            selected: Number(set.rpe) === value,
          })
        ),
      ])
    : null;

  /* --- Derived load caption -------------------------------------------- */

  const caption = captionFor
    ? el('span.set-row__caption', { text: captionFor(set.weightKg) ?? '' })
    : null;

  if (caption) {
    const repaint = () => {
      const raw = weightInput.value.replace(',', '.');
      const value = raw === '' ? null : storeWeight(Number(raw), units);
      caption.textContent = (Number.isNaN(Number(raw)) ? null : captionFor(value)) ?? '';
    };
    weightInput.addEventListener('input', repaint);
    // The steppers set `.value` directly, which fires no input event.
    weightGroup.addEventListener('click', () => requestAnimationFrame(repaint));
  }

  /* --- Row ------------------------------------------------------------- */

  const classes = ['set-row'];
  if (isDone) classes.push('set-row--done');
  if (variant && variant !== 'working') classes.push(`set-row--${variant}`);

  const row = el(`div.${classes.join('.')}`, {
    dataset: { setIndex: String(index), variant },
  }, [
    el('div.set-row__index', {}, [
      el('span.t-caption.t-semibold', { text: indexLabel ?? String(index + 1) }),
      targetReps
        ? el('span.set-row__target', {
            text: `×${targetReps}`,
            title: `Target ${targetReps} reps`,
          })
        : null,
    ]),
    showWeight ? weightGroup : null,
    repsGroup,
    rpe,
    extra,
    check,
  ]);

  // Long-press to remove an extra set. A visible delete button on every row
  // would be four more targets competing with the checkmark.
  if (onRemove) attachLongPress(row.querySelector('.set-row__index'), onRemove);

  if (!caption) return row;

  // The caption sits beneath the controls rather than inside them: the row is
  // already at the limit of what fits across a phone.
  return el('div.set-row-group', {}, [row, el('div.set-row__captions', {}, [caption])]);
}

/* --- Building blocks ---------------------------------------------------- */

function numberInput({ value, ariaLabel, step, integer = false, onCommit }) {
  const input = el('input.set-row__input.tnum', {
    type: 'text',
    // `inputmode` rather than `type=number`: it brings up the numeric keypad
    // on iOS without the spinner, the scroll-wheel hazard, or the locale
    // quirks of a number field.
    inputmode: integer ? 'numeric' : 'decimal',
    autocomplete: 'off',
    enterkeyhint: 'done',
    value,
    'aria-label': ariaLabel,
    dataset: { step: String(step) },
  });

  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => onCommit(sanitise(input, integer)));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
  });

  return input;
}

/** Strip anything that is not a number, and normalise the comma decimal. */
function sanitise(input, integer) {
  const cleaned = input.value.replace(',', '.').replace(/[^0-9.]/g, '');
  if (cleaned === '' || Number.isNaN(Number(cleaned))) {
    input.value = '';
    return '';
  }
  const value = integer ? String(Math.round(Number(cleaned))) : String(Number(cleaned));
  input.value = value;
  return value;
}

function stepperGroup({ input, label, onStep }) {
  return el('div.set-row__group', {}, [
    el('button.set-row__step', {
      type: 'button',
      'aria-label': `Decrease ${label}`,
      tabindex: '-1',
      on: { click: () => onStep(-1) },
    }, ['−']),
    el('div.set-row__field', {}, [input, el('span.set-row__unit', { text: label })]),
    el('button.set-row__step', {
      type: 'button',
      'aria-label': `Increase ${label}`,
      tabindex: '-1',
      on: { click: () => onStep(1) },
    }, ['+']),
  ]);
}

function roundStep(value, step) {
  if (!step) return value;
  return Math.round((value + Number.EPSILON) / step) * step;
}

/** Fire `action` after a 550ms press, cancelling on movement or release. */
function attachLongPress(node, action) {
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };

  node.addEventListener('pointerdown', () => {
    timer = setTimeout(() => { timer = null; action(); }, 550);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
    node.addEventListener(type, cancel);
  }

  node.setAttribute('title', 'Press and hold to remove this set');
}
