/**
 * logs.js — Recovery logs and tape measurements.
 *
 * One route with two tabs, because they are the same interaction — a dated form
 * of numeric fields plus a history list — and two near-identical pages would be
 * two places to fix the same bug.
 *
 * Both forms commit on submit rather than on change: these are deliberate
 * entries, not live edits, and a half-typed waist measurement should not land
 * in the log.
 */

import { el, icon, replace } from '../core/dom.js';
import { go, refresh } from '../core/router.js';
import { toast } from '../core/events.js';
import { formatDate, relativeDay, today, trimNumber, pluralize } from '../core/format.js';
import { recovery, measurements, RECOVERY_FIELDS, MEASUREMENT_FIELDS } from '../services/logs-service.js';
import * as bodyService from '../services/body-service.js';
import { COMPOSITION_FIELDS } from '../services/body-service.js';
import { sectionHead, stat, emptyState } from '../../components/stat.js';
import { confirmSheet } from '../../components/sheet.js';
import { openWeightSheet } from '../../components/weight-entry.js';

/**
 * Body weight and scale readings, adapted to the same interface the recovery and
 * measurement logs use.
 *
 * `body-service` has always been able to store these; until now nothing called
 * it, so the weight series could only be filled by restoring a backup. Weight
 * itself also has a two-tap sheet (see components/weight-entry.js) because it is
 * logged every morning; this tab is for the full ten-metric scale reading and
 * for correcting history.
 */
const bodyLog = {
  all: () => bodyService.getCompositionEntries(),
  latest: () => bodyService.getLatestComposition(),
  log: (payload, dayKey, note) => bodyService.logComposition({ ...payload, note }, dayKey),
  remove: (id) => bodyService.deleteComposition(id),
};

const TABS = {
  body: {
    label: 'Body',
    service: bodyLog,
    fields: COMPOSITION_FIELDS,
    blurb: 'Weigh in first thing, after the bathroom and before eating. Weight alone is enough — the other nine come from a smart scale if you have one.',
    emptyText: 'Log weight most mornings. Daily readings swing a kilo on water alone, which is why the app reads the 7-day average and not any single number.',
    icon: 'scale',
    // Weight is the one field that matters daily, so the tab offers the same
    // quick sheet the morning reminder uses rather than making it a form field.
    quickAction: 'Log weight only',
  },
  recovery: {
    label: 'Recovery',
    service: recovery,
    fields: RECOVERY_FIELDS,
    blurb: 'Sleep and how you feel. The program is explicit that sleep and protein decide whether added weight on the bar actually sticks.',
    emptyText: 'Log sleep and soreness daily, or at least on training days — it is what the two-week review uses to tell recovery problems from calorie problems.',
  },
  measurements: {
    label: 'Measurements',
    service: measurements,
    fields: MEASUREMENT_FIELDS,
    blurb: 'Tape measurements in centimetres. Measure cold, same time of day, same tape tension.',
    emptyText: 'Measurements every two to four weeks show where the weight is actually going — which the scale cannot.',
  },
};

let activeTab = 'body';

export function render(params = {}) {
  const requested = params.tab ?? params[0];
  if (requested && TABS[requested]) activeTab = requested;

  const tab = TABS[activeTab];

  return el('div.page.enter', {}, [
    backLink(),
    tabBar(),
    el('p.t-caption.t-faint', { text: tab.blurb, style: { padding: '0 var(--s-1)' } }),
    entryForm(tab),
    latestSummary(tab),
    historySection(tab),
  ]);
}

function backLink() {
  return el('button.btn.btn--ghost.btn--sm', {
    type: 'button',
    style: { paddingLeft: '0' },
    on: { click: () => go('reports') },
  }, [
    icon('chevron', { className: 'btn__icon', style: 'transform:rotate(180deg)' }),
    el('span', { text: 'Reports' }),
  ]);
}

function tabBar() {
  return el('div.segmented', { role: 'radiogroup', 'aria-label': 'Log type' },
    Object.entries(TABS).map(([key, tab]) =>
      el('button.segmented__opt', {
        type: 'button',
        role: 'radio',
        'aria-checked': key === activeTab ? 'true' : 'false',
        text: tab.label,
        on: { click: () => { activeTab = key; go('logs', { tab: key }); } },
      })
    ));
}

/* --- Entry form --------------------------------------------------------- */

function entryForm(tab) {
  const dateInput = el('input.input', {
    type: 'date',
    value: today(),
    max: today(),
    'aria-label': 'Entry date',
  });

  const inputs = new Map();

  // Prefill from the most recent entry. Measurements barely move week to week,
  // so retyping eleven sites from scratch is the fastest way to stop logging.
  const previous = tab.service.latest();

  const fieldRows = tab.fields.map((field) => {
    const input = el('input.input.input--num', {
      type: 'number',
      inputmode: 'decimal',
      step: field.decimals ? '0.1' : '1',
      min: field.min ?? 0,
      max: field.max ?? 9999,
      placeholder: previous?.[field.key] !== undefined ? String(previous[field.key]) : '—',
      'aria-label': `${field.label} in ${field.unit || 'units'}`,
    });
    inputs.set(field.key, input);

    return el('div.row.row--between', { style: { gap: 'var(--s-3)' } }, [
      el('span.t-callout', { text: field.label }),
      el('div.row', { style: { gap: 'var(--s-2)', flex: '0 0 auto', width: '124px' } }, [
        input,
        el('span.t-footnote.t-dim', { text: field.unit, style: { flex: '0 0 auto', minWidth: '2ch' } }),
      ]),
    ]);
  });

  const note = el('input.input', {
    type: 'text',
    placeholder: 'Note (optional)',
    'aria-label': 'Note',
  });

  const form = el('form.card.stack', { style: { gap: 'var(--s-3)' } }, [
    el('div.row.row--between', {}, [
      el('div.t-overline', { text: `New ${tab.label.toLowerCase()} entry` }),
      tab.quickAction
        ? el('button.btn.btn--sm.btn--tinted', {
            type: 'button',
            text: tab.quickAction,
            on: { click: async () => { if (await openWeightSheet()) refresh(); } },
          })
        : null,
      previous
        ? el('button.btn.btn--sm.btn--ghost', {
            type: 'button',
            text: 'Copy last',
            title: 'Fill every field from the most recent entry',
            on: {
              click: () => {
                for (const [key, input] of inputs) {
                  if (previous[key] !== undefined) input.value = previous[key];
                }
              },
            },
          })
        : null,
    ].filter(Boolean)),
    dateInput,
    ...fieldRows,
    note,
    el('button.btn.btn--primary.btn--block', { type: 'submit', text: 'Save entry' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {};
    for (const [key, input] of inputs) {
      if (input.value !== '') payload[key] = input.value;
    }

    try {
      await tab.service.log(payload, dateInput.value || today(), note.value.trim());
      toast(`${tab.label} entry saved`, 'success');
      refresh();
    } catch (error) {
      toast(error.message || 'Could not save that entry', 'danger');
    }
  });

  return form;
}

/* --- Latest ------------------------------------------------------------- */

function latestSummary(tab) {
  const latest = tab.service.latest();
  if (!latest) return null;

  const entries = tab.service.all();
  const previous = entries.length > 1 ? entries[entries.length - 2] : null;

  return el('section', {}, [
    sectionHead('Latest', { hint: relativeDay(latest.date) }),
    el('div.grid.grid--auto', {}, tab.fields
      .filter((field) => latest[field.key] !== undefined)
      .map((field) => {
        const now = latest[field.key];
        const before = previous?.[field.key];
        const delta = before !== undefined ? now - before : null;

        return stat({
          label: field.label,
          value: trimNumber(now, field.decimals),
          unit: field.unit,
          delta: delta === null ? null : Number(delta.toFixed(field.decimals || 1)),
          deltaSuffix: delta === null ? '' : 'vs last',
          // Less soreness and less stress are improvements; more of everything
          // else is. Sleep and size go up.
          invertDelta: field.key === 'soreness' || field.key === 'stress'
            || field.key === 'waist',
        });
      })),
  ]);
}

/* --- History ------------------------------------------------------------ */

function historySection(tab) {
  const entries = [...tab.service.all()].reverse();

  if (!entries.length) {
    return el('div.card.card--quiet', {}, [
      emptyState({
        iconName: tab.icon ?? (activeTab === 'recovery' ? 'bed' : 'ruler'),
        title: `No ${tab.label.toLowerCase()} logged yet`,
        text: tab.emptyText,
      }),
    ]);
  }

  return el('section', {}, [
    sectionHead('History', { hint: pluralize(entries.length, 'entry', 'entries') }),
    el('div.list', {}, entries.slice(0, 60).map((entry) =>
      el('div.list__row', {}, [
        el('div.list__body', {}, [
          el('div.list__title', { text: formatDate(entry.date, { withYear: true }) }),
          el('div.list__sub', {
            text: tab.fields
              .filter((field) => entry[field.key] !== undefined)
              .map((field) => `${field.label} ${trimNumber(entry[field.key], field.decimals)}${field.unit}`)
              .join(' · ') || 'No values',
          }),
          entry.note ? el('div.t-caption.t-faint', { text: entry.note }) : null,
        ].filter(Boolean)),
        el('button.btn-icon', {
          type: 'button',
          'aria-label': `Delete the entry for ${entry.date}`,
          style: { width: '36px', height: '36px' },
          on: { click: () => handleDelete(tab, entry) },
        }, [icon('info', { size: 17 })]),
      ])
    )),
    entries.length > 60
      ? el('p.t-caption.t-faint', {
          text: `Showing the most recent 60 of ${entries.length}. Export the CSV for the full history.`,
          style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
        })
      : null,
  ].filter(Boolean));
}

async function handleDelete(tab, entry) {
  const confirmed = await confirmSheet({
    title: 'Delete this entry?',
    text: `The ${tab.label.toLowerCase()} entry for ${formatDate(entry.date, { withYear: true })} will be removed.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  await tab.service.remove(entry.id);
  toast('Entry deleted');
  refresh();
}

export const page = {
  name: 'logs',
  title: 'Logs',
  render,
};
