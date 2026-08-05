/**
 * nav.js — Primary navigation.
 *
 * One component renders both the phone tab bar and the desktop sidebar; the
 * difference is entirely in layout.css. Keeping it as a single component means
 * the two can never drift out of step as pages are added.
 *
 * Tabs are anchors, not buttons: they carry a real `href`, so long-press and
 * "open in new tab" behave, and the browser handles history for free.
 */

import { el, icon } from '../js/core/dom.js';
import { EVENTS, on } from '../js/core/events.js';

export const TABS = [
  { name: 'home',     label: 'Home',     iconName: 'home' },
  { name: 'workout',  label: 'Workout',  iconName: 'dumbbell' },
  { name: 'progress', label: 'Progress', iconName: 'chart' },
  { name: 'reports',  label: 'Reports',  iconName: 'document' },
  { name: 'settings', label: 'Settings', iconName: 'settings' },
];

/**
 * Build the navigation element. It subscribes to route changes and keeps
 * `aria-current` in step, which is what both the styling and the screen
 * reader rely on to identify the active tab.
 */
export function nav() {
  const links = new Map();

  const items = TABS.map((tab) => {
    const link = el(
      'a.tab',
      { href: `#/${tab.name}` },
      [
        icon(tab.iconName, { className: 'tab__icon' }),
        el('span', { text: tab.label }),
      ]
    );
    links.set(tab.name, link);
    return link;
  });

  const root = el('nav.tabbar', { 'aria-label': 'Primary' }, [
    el('div.tabbar__inner', {}, items),
  ]);

  const setActive = (name) => {
    for (const [tabName, link] of links) {
      if (tabName === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };

  on(EVENTS.ROUTE_CHANGED, ({ name }) => setActive(name));

  return root;
}
