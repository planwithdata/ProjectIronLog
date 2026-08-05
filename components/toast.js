/**
 * toast.js — Transient confirmations.
 *
 * Listens on the event bus rather than exporting a function services call
 * directly, so a service can confirm a save (`toast('Saved')`) without
 * importing anything from the UI layer.
 *
 * The host is an aria-live region: a sighted user sees the pill, a
 * VoiceOver user hears the same message. `polite` rather than `assertive`
 * because these confirm an action the user just took — they should not
 * interrupt what is already being read.
 */

import { el, icon } from '../js/core/dom.js';
import { EVENTS, on } from '../js/core/events.js';

const DURATION_MS = 2400;
const MAX_VISIBLE = 3;

let host = null;

/** Create the toast host and start listening. Called once from app.js. */
export function mountToastHost(parent = document.body) {
  if (host) return host;

  host = el('div.toast-host', {
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'false',
  });
  parent.appendChild(host);

  on(EVENTS.TOAST, ({ message, tone }) => show(message, tone));
  return host;
}

/**
 * @param {string} message
 * @param {'default'|'success'|'danger'} [tone]
 */
export function show(message, tone = 'default') {
  if (!host || !message) return;

  // Cap the stack so a burst of writes cannot bury the tab bar.
  while (host.children.length >= MAX_VISIBLE) host.firstElementChild.remove();

  const iconName = tone === 'success' ? 'check' : tone === 'danger' ? 'info' : null;

  const node = el(`div.toast${tone !== 'default' ? `.toast--${tone}` : ''}`, {}, [
    iconName ? icon(iconName, { size: 16 }) : null,
    el('span', { text: message }),
  ]);

  host.appendChild(node);

  const dismiss = () => {
    if (!node.isConnected) return;
    node.dataset.leaving = 'true';
    node.addEventListener('animationend', () => node.remove(), { once: true });
    // Belt and braces: if the animation never fires (reduced motion collapses
    // it to ~0ms and the event can be missed), remove it anyway.
    setTimeout(() => node.remove(), 400);
  };

  setTimeout(dismiss, DURATION_MS);
}
