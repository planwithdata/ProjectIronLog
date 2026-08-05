/**
 * sheet.js — Bottom sheet modal.
 *
 * Replaces `window.confirm` for anything that matters. A native confirm is
 * unstyled, cannot show a workout summary, and on iOS standalone it renders
 * with the site's URL in it, which looks broken in an installed app.
 *
 * Built on `<dialog>` so the browser handles the top layer, focus trapping,
 * Escape, and inertness of the page behind it — all things that are easy to
 * get subtly wrong by hand and that screen readers depend on.
 */

import { el, icon } from '../js/core/dom.js';

/**
 * Open a sheet.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.text]
 * @param {Node|Node[]} [options.body]      custom content, below the text
 * @param {Array<{label: string, value: any, tone?: 'primary'|'danger'|'plain'}>} options.actions
 * @param {boolean} [options.dismissible]   allow backdrop/Escape close
 * @returns {Promise<any>} the chosen action's `value`, or null if dismissed
 */
export function openSheet({
  title,
  text = '',
  body = null,
  actions = [{ label: 'OK', value: true, tone: 'primary' }],
  dismissible = true,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };

    const buttons = actions.map((action) =>
      el(`button.btn.btn--block${toneClass(action.tone)}`, {
        type: 'button',
        text: action.label,
        on: { click: () => finish(action.value) },
      })
    );

    const dialog = el('dialog.sheet', {
      'aria-labelledby': 'sheet-title',
    }, [
      el('div.sheet__panel', {}, [
        el('div.sheet__grip', { 'aria-hidden': 'true' }),
        el('h2.sheet__title', { id: 'sheet-title', text: title }),
        text ? el('p.sheet__text', { text }) : null,
        body ? el('div.sheet__body', {}, body) : null,
        el('div.sheet__actions', {}, buttons),
      ]),
    ]);

    // Clicking the backdrop resolves as a dismissal. The check compares the
    // target to the dialog itself, since the panel fills the visible area.
    if (dismissible) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) finish(null);
      });
    }

    dialog.addEventListener('cancel', (event) => {
      // `cancel` is the Escape key. Non-dismissible sheets must force a choice.
      if (!dismissible) event.preventDefault();
      else finish(null);
    });

    dialog.addEventListener('close', () => {
      dialog.remove();
      if (!settled) { settled = true; resolve(null); }
    });

    document.body.appendChild(dialog);
    dialog.showModal();

    // Focus the primary action rather than the first focusable node, so a
    // keyboard user's Enter does the expected thing.
    const primary = buttons.find((_, index) => actions[index].tone === 'primary');
    (primary ?? buttons[0])?.focus();
  });
}

function toneClass(tone) {
  if (tone === 'primary') return '.btn--primary';
  if (tone === 'danger') return '.btn--danger';
  return '';
}

/**
 * Yes/no confirmation. Returns true only on explicit confirmation — a
 * dismissal is a "no".
 */
export async function confirmSheet({
  title,
  text = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  const result = await openSheet({
    title,
    text,
    actions: [
      { label: confirmLabel, value: true, tone: danger ? 'danger' : 'primary' },
      { label: cancelLabel, value: false, tone: 'plain' },
    ],
  });
  return result === true;
}

/** A labelled row for use inside a sheet body — used by the workout summary. */
export function sheetRow(label, value, { tone = null, iconName = null } = {}) {
  return el('div.sheet__row', {}, [
    iconName ? icon(iconName, { size: 16 }) : null,
    el('span.t-subhead.t-dim', { text: label }),
    el('span.spacer'),
    el(`span.t-subhead.t-semibold.tnum${tone ? `.stat__delta--${tone}` : ''}`, {
      text: String(value),
    }),
  ]);
}
