/**
 * rest-bar.js — The floating rest countdown.
 *
 * Sits just above the tab bar while resting and is otherwise absent from the
 * DOM. Deliberately *not* inside the exercise card: rest happens while the
 * user is scrolling to check the next lift or reading a coach note, and a
 * timer that scrolls out of view is a timer that gets missed.
 *
 * It renders from the timer service's tick events rather than owning any
 * countdown state of its own — see rest-timer.js for why the timer is
 * timestamp-based.
 */

import { el, icon } from '../js/core/dom.js';
import { on } from '../js/core/events.js';
import { formatClock } from '../js/core/format.js';
import * as restTimer from '../js/services/rest-timer.js';
import { REST_TICK } from '../js/services/rest-timer.js';

/**
 * Mount the bar into a container.
 * @returns {() => void} teardown, to be called by the route's cleanup
 */
export function mountRestBar(parent) {
  const clock = el('span.rest-bar__clock.tnum', { text: '0:00' });
  const label = el('span.rest-bar__label.t-truncate', { text: '' });
  const fill = el('div.bar__fill');

  const bar = el('div.rest-bar', {
    role: 'timer',
    // The countdown updates five times a second; announcing every change
    // would make VoiceOver unusable. The bar is labelled, not live.
    'aria-live': 'off',
    hidden: true,
  }, [
    el('div.rest-bar__body', {}, [
      el('div.rest-bar__row', {}, [
        icon('timer', { size: 17 }),
        clock,
        label,
        el('span.spacer'),
        el('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          text: '+30s',
          'aria-label': 'Add 30 seconds to the rest timer',
          on: { click: () => restTimer.extend(30) },
        }),
        el('button.btn.btn--sm.btn--tinted', {
          type: 'button',
          text: 'Skip',
          'aria-label': 'Skip the rest timer',
          on: { click: () => restTimer.stop() },
        }),
      ]),
      el('div.bar', { style: { marginTop: '8px' } }, [fill]),
    ]),
  ]);

  parent.appendChild(bar);

  const paint = (state) => {
    if (!state.running) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    clock.textContent = formatClock(state.remaining);
    label.textContent = state.label ? `· ${state.label}` : '';
    fill.style.width = `${state.percent}%`;

    // Colour shifts as the interval runs out, so a glance is enough.
    const nearlyDone = state.remaining <= 10;
    fill.className = nearlyDone ? 'bar__fill bar__fill--warning' : 'bar__fill';
    bar.dataset.urgent = nearlyDone ? 'true' : 'false';
  };

  paint(restTimer.snapshot());
  const unsubscribe = on(REST_TICK, paint);
  const unwatch = restTimer.watchVisibility();

  return () => {
    unsubscribe();
    unwatch();
    bar.remove();
  };
}
