/**
 * stat.js — Stat tile and section header.
 *
 * A tile with no data shows an em dash, never a zero. "0 kg" reads as a
 * measurement; "—" reads as "not recorded yet", which is the truth.
 */

import { el, icon } from '../js/core/dom.js';
import { formatDelta, deltaDirection } from '../js/core/format.js';

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string|number|null} options.value  null renders as an em dash
 * @param {string} [options.unit]
 * @param {number|null} [options.delta]       signed change, colour-coded
 * @param {string} [options.deltaSuffix]      e.g. "this week"
 * @param {string} [options.foot]             replaces the delta line
 * @param {boolean} [options.invertDelta]     true when down is good
 * @param {() => void} [options.onClick]      makes the tile tappable
 */
export function stat({
  label,
  value,
  unit = '',
  delta = null,
  deltaSuffix = '',
  foot = null,
  invertDelta = false,
  onClick = null,
} = {}) {
  const isEmpty = value === null || value === undefined || value === '' || value === '—';

  const children = [
    el('span.stat__label', { text: label }),
    el('span.stat__value', {}, [
      String(isEmpty ? '—' : value),
      !isEmpty && unit ? el('span.stat__unit', { text: unit }) : null,
    ]),
  ];

  if (foot) {
    children.push(el('span.stat__foot', { text: foot }));
  } else if (delta !== null && delta !== undefined && !Number.isNaN(Number(delta))) {
    let direction = deltaDirection(delta);
    if (invertDelta && direction !== 'flat') direction = direction === 'up' ? 'down' : 'up';
    children.push(
      el('span.stat__foot', {}, [
        el(`span.stat__delta--${direction}.t-semibold`, { text: formatDelta(delta) }),
        deltaSuffix ? ` ${deltaSuffix}` : null,
      ])
    );
  }

  const classes = `div.stat${isEmpty ? '.stat--empty' : ''}`;

  if (onClick) {
    return el(
      `button.stat${isEmpty ? '.stat--empty' : ''}`,
      { type: 'button', on: { click: onClick }, style: { textAlign: 'left' } },
      children
    );
  }

  return el(classes, {}, children);
}

/**
 * Section header with an optional trailing action.
 * @param {string} title
 * @param {object} [options]  `action` label + `onAction` handler, or `hint` text
 */
export function sectionHead(title, { action = null, onAction = null, hint = null } = {}) {
  return el('div.section__head', {}, [
    el('h2.t-overline', { text: title }),
    hint ? el('span.t-caption.t-faint', { text: hint }) : null,
    action
      ? el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          text: action,
          on: { click: onAction ?? (() => {}) },
        })
      : null,
  ]);
}

/**
 * Empty-state block.
 * @param {object} options  `title`, `text`, `iconName`, `action`, `onAction`
 */
export function emptyState({ title, text = '', iconName = 'info', action = null, onAction = null } = {}) {
  return el('div.empty', {}, [
    icon(iconName, { className: 'empty__icon' }),
    el('p.empty__title', { text: title }),
    text ? el('p.empty__text', { text }) : null,
    action
      ? el('button.btn.btn--tinted.btn--sm', {
          type: 'button',
          text: action,
          style: { marginTop: '8px' },
          on: { click: onAction ?? (() => {}) },
        })
      : null,
  ]);
}
