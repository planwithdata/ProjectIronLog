/**
 * reports.js — Placeholder until Session 4.
 */

import { el } from '../core/dom.js';
import { comingSoon } from './_placeholder.js';

export function render() {
  return el('div.page.enter', {}, [

    comingSoon({
      session: 4,
      title: 'Coaching reports',
      items: [
        'PDF report with cover, metrics, charts and coach notes',
        'JSON and CSV export',
        'Progress photos with swipe comparison',
        'Coach notes editor',
        'Recovery logs and tape measurements',
        'Two-week review generator with a rule-based training summary',
      ],
    }),

    el('p.t-caption.t-faint', {
      text: 'A full JSON backup is already available from Settings, so no data is at risk before this page lands.',
      style: { padding: '0 var(--s-1)' },
    }),
  ]);
}

export const page = {
  name: 'reports',
  title: 'Reports',
  render,
};
