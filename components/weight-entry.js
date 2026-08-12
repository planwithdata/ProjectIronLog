/**
 * weight-entry.js — Logging a morning weigh-in.
 *
 * `body-service` has been able to store weigh-ins and full scale readings since
 * Session 1, but nothing in the app ever called it: there was no screen to type
 * a number into, so the body-weight series could only be populated by restoring
 * a backup. This is that screen, in its smallest useful form.
 *
 * A sheet rather than a page, because the morning reminder has to be answerable
 * in two taps without losing where the user was.
 */

import { el } from '../js/core/dom.js';
import { toast } from '../js/core/events.js';
import { today, formatDate, trimNumber, displayWeight, storeWeight } from '../js/core/format.js';
import * as bodyService from '../js/services/body-service.js';
import * as settingsService from '../js/services/settings-service.js';
import { openSheet } from './sheet.js';

/**
 * Prompt for today's body weight.
 *
 * @param {object} [options]
 * @param {string} [options.dayKey]  defaults to today
 * @param {string} [options.title]
 * @param {string} [options.text]
 * @returns {Promise<boolean>} true when a weight was saved
 */
export async function openWeightSheet({
  dayKey = today(),
  title = 'Log body weight',
  text = 'Weigh yourself first thing, after the bathroom and before eating — that is the reading the trend is built on.',
} = {}) {
  const units = settingsService.getUnits();
  const existing = bodyService.getWeightOn(dayKey);
  const latest = bodyService.getLatestWeight();

  // Pre-filled with the most recent reading. Body weight moves by grams
  // day to day, so the last value is almost always one nudge away from today's.
  const seed = existing?.weightKg ?? latest?.weightKg ?? null;

  const input = el('input.input.input--num', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    enterkeyhint: 'done',
    value: seed === null ? '' : trimNumber(displayWeight(seed, units), 1),
    placeholder: '—',
    'aria-label': `Body weight in ${units}`,
    style: { fontSize: 'var(--t-title-2)', minHeight: '56px' },
  });

  const noteInput = el('input.input', {
    type: 'text',
    value: existing?.note ?? '',
    placeholder: 'Note (optional)',
    'aria-label': 'Note about this weigh-in',
  });

  // Focus lands on the field with the value selected, so typing replaces it.
  requestAnimationFrame(() => { input.focus(); input.select(); });

  const choice = await openSheet({
    title,
    text,
    body: el('div.stack', { style: { gap: 'var(--s-3)' } }, [
      el('div.row', { style: { gap: 'var(--s-2)', alignItems: 'center' } }, [
        input,
        el('span.t-callout.t-dim', { text: units, style: { flex: '0 0 auto' } }),
      ]),
      existing
        ? el('span.t-caption.t-faint', {
            text: `Replaces the ${trimNumber(displayWeight(existing.weightKg, units), 1)} ${units} `
              + `already logged for ${formatDate(dayKey)}. One reading per day.`,
          })
        : el('span.t-caption.t-faint', { text: `For ${formatDate(dayKey)}.` }),
      noteInput,
    ]),
    actions: [
      { label: 'Save', value: 'save', tone: 'primary' },
      { label: 'Cancel', value: false, tone: 'plain' },
    ],
  });

  if (choice !== 'save') return false;

  const raw = input.value.replace(',', '.').trim();
  if (raw === '' || Number.isNaN(Number(raw))) {
    toast('Enter a weight to save it', 'danger');
    return false;
  }

  try {
    await bodyService.logWeight(storeWeight(Number(raw), units), dayKey, noteInput.value);
    toast('Weight logged', 'success');
    return true;
  } catch (error) {
    console.error('[weight-entry] could not save:', error);
    toast(error.message || 'Could not save that weight', 'danger');
    return false;
  }
}
