/**
 * _placeholder.js — Shared "arriving in a later session" panel.
 *
 * Deliberately explicit about what is not built yet. A page that pretends to
 * be finished is harder to review than one that says what it owes.
 */

import { el, icon } from '../core/dom.js';

/**
 * @param {object} options
 * @param {number} options.session  the session that will deliver this
 * @param {string} options.title
 * @param {string[]} options.items  what is coming
 */
export function comingSoon({ session, title, items = [] }) {
  return el('div.card.card--raised', {}, [
    el('div.row', { style: { gap: 'var(--s-3)', marginBottom: 'var(--s-3)' } }, [
      el('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '38px', height: '38px', borderRadius: 'var(--r-md)', flex: '0 0 auto',
          background: 'var(--c-accent-dim)', color: 'var(--c-accent)',
        },
      }, [icon('timer', { size: 20 })]),
      el('div', { style: { minWidth: 0 } }, [
        el('div.t-callout.t-semibold', { text: title }),
        el('div.t-caption.t-dim', { text: `Arriving in Session ${session}` }),
      ]),
    ]),
    items.length
      ? el('ul.stack', { style: { gap: 'var(--s-2)' } },
          items.map((item) =>
            el('li.row', { style: { alignItems: 'flex-start', gap: 'var(--s-2)' } }, [
              icon('check', { size: 14, className: 'btn__icon' }),
              el('span.t-footnote.t-dim', { text: item }),
            ])
          ))
      : null,
  ]);
}
