/**
 * progress.js — Placeholder until Session 3.
 *
 * The page exists now so navigation is complete and the shell can be judged
 * as a whole. It states plainly what is coming rather than showing a fake
 * chart, and it surfaces the counts already in storage so the data layer is
 * visibly wired up.
 */

import { el, icon } from '../core/dom.js';
import { pluralize } from '../core/format.js';
import * as sessionService from '../services/session-service.js';
import * as bodyService from '../services/body-service.js';
import { sectionHead } from '../../components/stat.js';
import { comingSoon } from './_placeholder.js';

export function render() {
  const sessions = sessionService.getCompletedSessions().length;
  const weighIns = bodyService.getWeightEntries().length;
  const readings = bodyService.getCompositionEntries().length;

  return el('div.page.enter', {}, [

    comingSoon({
      session: 3,
      title: 'Charts and analytics',
      items: [
        'Body weight trend with weekly and monthly averages',
        'Body composition graphs for all ten scale metrics',
        'Strength progress per exercise with estimated 1RM',
        'Volume tracking and workout consistency',
        'Personal record badges',
      ],
    }),

    el('section', {}, [
      sectionHead('Already recorded'),
      el('div.list', {}, [
        dataRow('dumbbell', 'Workout sessions', pluralize(sessions, 'session')),
        dataRow('scale', 'Body weigh-ins', pluralize(weighIns, 'entry', 'entries')),
        dataRow('chart', 'Scale readings', pluralize(readings, 'reading')),
      ]),
      el('p.t-caption.t-faint', {
        text: 'Everything logged from Session 2 onward feeds these charts automatically.',
        style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
      }),
    ]),
  ]);
}

function dataRow(iconName, label, value) {
  return el('div.list__row', {}, [
    el('div.list__icon', {}, [icon(iconName)]),
    el('div.list__body', {}, [el('div.list__title', { text: label })]),
    el('span.list__value', { text: value }),
  ]);
}

export const page = {
  name: 'progress',
  title: 'Progress',
  render,
};
