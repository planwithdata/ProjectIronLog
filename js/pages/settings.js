/**
 * settings.js — Theme, units, profile, backup and reset.
 *
 * Backup arrives in Session 1 rather than later on purpose: real logging
 * starts in Session 2, and data that cannot be exported is data that can be
 * lost by clearing a browser. Everything here is small and finished; the
 * report-flavoured exports (CSV, PDF) belong to Session 4.
 */

import { el, icon } from '../core/dom.js';
import { refresh } from '../core/router.js';
import { toast } from '../core/events.js';
import { trimNumber } from '../core/format.js';
import * as db from '../services/db.js';
import * as settingsService from '../services/settings-service.js';
import { THEMES, UNITS } from '../services/settings-service.js';
import * as programService from '../services/program-service.js';
import { APP_VERSION } from '../config.js';
import { sectionHead } from '../../components/stat.js';

const THEME_LABELS = { dark: 'Dark', light: 'Light', system: 'System' };

export function render() {
  return el('div.page.enter', {}, [
    el('h1.t-title-1', { text: 'Settings' }),
    appearanceSection(),
    profileSection(),
    dataSection(),
    aboutSection(),
  ]);
}

/* --- Appearance --------------------------------------------------------- */

function appearanceSection() {
  const settings = settingsService.getSettings();

  return el('section', {}, [
    sectionHead('Appearance'),
    el('div.card.stack', { style: { gap: 'var(--s-4)' } }, [
      el('div.field', {}, [
        el('span.field__label', { text: 'Theme' }),
        segmented({
          name: 'theme',
          options: THEMES.map((value) => ({ value, label: THEME_LABELS[value] })),
          value: settings.theme,
          onChange: async (value) => {
            await settingsService.set('theme', value);
            toast(`${THEME_LABELS[value]} theme`, 'success');
          },
        }),
      ]),
      el('div.field', {}, [
        el('span.field__label', { text: 'Weight units' }),
        segmented({
          name: 'units',
          options: UNITS.map((value) => ({ value, label: value.toUpperCase() })),
          value: settings.units,
          onChange: async (value) => {
            await settingsService.set('units', value);
            toast(`Showing weights in ${value}`, 'success');
            refresh();
          },
        }),
        el('span.t-caption.t-faint', {
          text: 'Display only. Everything is stored in kilograms, so switching back and forth never alters a logged number.',
        }),
      ]),
    ]),
  ]);
}

/**
 * iOS-style segmented control. Built as a radiogroup so arrow keys and
 * VoiceOver behave the way a native picker does.
 */
function segmented({ name, options, value, onChange }) {
  const group = el('div.segmented', { role: 'radiogroup', 'aria-label': name });
  const buttons = [];

  const select = (selectedValue) => {
    for (const button of buttons) {
      button.setAttribute('aria-checked', button.dataset.value === selectedValue ? 'true' : 'false');
    }
  };

  for (const option of options) {
    const button = el('button.segmented__opt', {
      type: 'button',
      role: 'radio',
      text: option.label,
      dataset: { value: option.value },
      on: {
        click: () => {
          select(option.value);
          onChange(option.value);
        },
      },
    });
    buttons.push(button);
  }

  select(value);
  group.append(...buttons);
  return group;
}

/* --- Profile ------------------------------------------------------------ */

function profileSection() {
  const profile = settingsService.getProfile();
  const settings = settingsService.getSettings();

  const heightInput = el('input.input.input--num', {
    type: 'number',
    inputmode: 'decimal',
    step: '0.5',
    min: '100',
    max: '250',
    placeholder: '—',
    value: profile.heightCm ?? '',
    'aria-label': 'Height in centimetres',
  });

  const goalInput = el('input.input.input--num', {
    type: 'number',
    inputmode: 'decimal',
    step: '0.5',
    min: '30',
    max: '250',
    placeholder: '—',
    value: profile.goalWeightKg ?? '',
    'aria-label': 'Goal weight in kilograms',
  });

  const reviewInput = el('input.input.input--num', {
    type: 'number',
    inputmode: 'numeric',
    step: '1',
    min: '3',
    max: '90',
    value: settings.reviewIntervalDays ?? 14,
    'aria-label': 'Review interval in days',
  });

  // Commit on blur rather than on every keystroke: a partially typed "1"
  // while reaching for "180" is not a height the app should store.
  heightInput.addEventListener('blur', async () => {
    const value = heightInput.value === '' ? null : Number(heightInput.value);
    await settingsService.updateProfile({ heightCm: value });
    toast('Height saved', 'success');
  });

  goalInput.addEventListener('blur', async () => {
    const value = goalInput.value === '' ? null : Number(goalInput.value);
    await settingsService.updateProfile({ goalWeightKg: value });
    toast('Goal weight saved', 'success');
  });

  reviewInput.addEventListener('blur', async () => {
    const value = Math.max(3, Math.min(90, Number(reviewInput.value) || 14));
    reviewInput.value = value;
    await settingsService.set('reviewIntervalDays', value);
    toast('Review interval saved', 'success');
  });

  return el('section', {}, [
    sectionHead('Profile'),
    el('div.card.stack', { style: { gap: 'var(--s-4)' } }, [
      fieldRow('Height', 'cm', heightInput),
      fieldRow('Goal weight', 'kg', goalInput),
      fieldRow('Review every', 'days', reviewInput),
      profile.programStartDate
        ? el('p.t-caption.t-faint', { text: `Program started ${profile.programStartDate}.` })
        : el('p.t-caption.t-faint', {
            text: 'The training week counter starts when you complete your first workout.',
          }),
    ]),
  ]);
}

function fieldRow(label, unit, input) {
  return el('div.row.row--between', { style: { gap: 'var(--s-4)' } }, [
    el('span.t-callout', { text: label }),
    el('div.row', { style: { gap: 'var(--s-2)', flex: '0 0 auto', width: '132px' } }, [
      input,
      el('span.t-footnote.t-dim', { text: unit, style: { flex: '0 0 auto' } }),
    ]),
  ]);
}

/* --- Data --------------------------------------------------------------- */

function dataSection() {
  const usageNode = el('span.list__value', { text: '…' });
  db.usageBytes().then((bytes) => {
    usageNode.textContent = bytes < 1024
      ? `${bytes} B`
      : bytes < 1048576
        ? `${trimNumber(bytes / 1024, 1)} KB`
        : `${trimNumber(bytes / 1048576, 1)} MB`;
  });

  // A hidden file input, triggered by the visible Restore row — the native
  // control cannot be styled, and a bare "Choose file" button next to
  // designed rows looks like a bug.
  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    on: { change: (event) => handleRestore(event.target) },
  });

  return el('section', {}, [
    sectionHead('Data'),
    el('div.list', {}, [
      actionRow('download', 'Back up to JSON', 'Download everything IronLog has stored', handleBackup),
      actionRow('upload', 'Restore from JSON', 'Replaces all current data', () => fileInput.click()),
      el('div.list__row', {}, [
        el('div.list__icon', {}, [icon('info')]),
        el('div.list__body', {}, [
          el('div.list__title', { text: 'Storage used' }),
          el('div.list__sub', {
            text: db.isPersistent()
              ? 'Saved on this device only'
              : 'Private browsing — nothing is being saved',
          }),
        ]),
        usageNode,
      ]),
    ]),
    fileInput,

    el('div.list', { style: { marginTop: 'var(--s-4)' } }, [
      el('button.list__row.list__row--tappable', {
        type: 'button',
        on: { click: handleReset },
      }, [
        el('div.list__icon', { style: { background: 'var(--c-danger-dim)' } }, [icon('info')]),
        el('div.list__body', {}, [
          el('div.list__title', { text: 'Reset app', style: { color: 'var(--c-danger)' } }),
          el('div.list__sub', { text: 'Deletes every logged workout, weigh-in and note' }),
        ]),
      ]),
    ]),
    el('p.t-caption.t-faint', {
      text: 'Back up before you reset. There is no server copy — this device is the only copy.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

function actionRow(iconName, title, sub, onClick) {
  return el('button.list__row.list__row--tappable', { type: 'button', on: { click: onClick } }, [
    el('div.list__icon', {}, [icon(iconName)]),
    el('div.list__body', {}, [
      el('div.list__title', { text: title }),
      el('div.list__sub', { text: sub }),
    ]),
    icon('chevron', { className: 'list__chevron' }),
  ]);
}

/** Download the whole database as a timestamped JSON file. */
function handleBackup() {
  try {
    const snapshot = db.exportAll();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);

    const anchor = el('a', { href: url, download: `ironlog-backup-${stamp}.json` });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking immediately can cancel the download on iOS Safari; a short
    // delay lets the fetch for the blob start first.
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    toast('Backup downloaded', 'success');
  } catch (error) {
    console.error('[settings] backup failed:', error);
    toast('Backup failed', 'danger');
  }
}

async function handleRestore(input) {
  const file = input.files?.[0];
  input.value = '';                 // allow re-picking the same file later
  if (!file) return;

  const proceed = window.confirm(
    `Restore from "${file.name}"?\n\n` +
    'This replaces all data currently in the app. Back up first if you are not sure.'
  );
  if (!proceed) return;

  try {
    const payload = JSON.parse(await file.text());
    await db.importAll(payload);
    toast('Backup restored', 'success');
    refresh();
  } catch (error) {
    console.error('[settings] restore failed:', error);
    toast(error.message || 'That file could not be restored', 'danger');
  }
}

async function handleReset() {
  // Two-step confirmation: the first is easy to dismiss by reflex, the second
  // requires reading. This action is not recoverable.
  if (!window.confirm('Reset IronLog?\n\nThis permanently deletes every workout, weigh-in, photo and note on this device.')) return;
  if (!window.confirm('Last chance — this cannot be undone. Continue?')) return;

  try {
    await db.reset();
    settingsService.applyTheme();
    toast('App reset', 'success');
    refresh();
  } catch (error) {
    console.error('[settings] reset failed:', error);
    toast('Reset failed', 'danger');
  }
}

/* --- About -------------------------------------------------------------- */

function aboutSection() {
  const program = programService.getProgram().program;

  return el('section', {}, [
    sectionHead('About'),
    el('div.list', {}, [
      infoRow('Version', `${APP_VERSION} · Session 1`),
      infoRow('Program', program.name),
      infoRow('Training days', String(programService.getTrainingDays().length)),
      infoRow('Storage', 'Local Storage on this device'),
    ]),
    el('p.t-caption.t-faint', {
      text: 'IronLog runs entirely in your browser. No account, no server, no tracking.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

function infoRow(label, value) {
  return el('div.list__row', {}, [
    el('div.list__body', {}, [el('div.list__title', { text: label })]),
    el('span.list__value', { text: value }),
  ]);
}

export const page = {
  name: 'settings',
  title: 'Settings',
  render,
};
