/**
 * settings.js — Theme, units, profile, backup and reset.
 *
 * Backup arrives in Session 1 rather than later on purpose: real logging
 * starts in Session 2, and data that cannot be exported is data that can be
 * lost by clearing a browser. Everything here is small and finished; the
 * report-flavoured exports (CSV, PDF) belong to Session 4.
 */

import { el, icon, replace } from '../core/dom.js';
import { refresh } from '../core/router.js';
import { toast } from '../core/events.js';
import { formatDate, relativeDay } from '../core/format.js';

import { download, stampedName, formatBytes } from '../core/download.js';
import * as db from '../services/db.js';
import * as settingsService from '../services/settings-service.js';
import { THEMES, UNITS } from '../services/settings-service.js';
import * as trainingPrefs from '../services/training-prefs-service.js';
import * as programService from '../services/program-service.js';
import { APP_VERSION, BUILD_SESSION } from '../config.js';
import * as pwa from '../services/pwa-service.js';
import { IOS_INSTALL_STEPS } from '../services/pwa-service.js';
import { sectionHead } from '../../components/stat.js';
import { openSheet } from '../../components/sheet.js';

const THEME_LABELS = { dark: 'Dark', light: 'Light', system: 'System' };

export function render() {
  return el('div.page.enter', {}, [
    installSection(),
    appearanceSection(),
    trainingSection(),
    profileSection(),
    dataSection(),
    aboutSection(),
  ]);
}

/* --- Training preferences ----------------------------------------------
   How this user trains. Rendered from the declarative list in
   training-prefs-service so the explanation of each convention lives next to
   the convention rather than in the markup.

   Booleans use a two-option segmented control rather than a switch: the app has
   no switch component, and inventing one here would look like a different app.
   ====================================================================== */

function trainingSection() {
  const prefs = trainingPrefs.getPrefs();
  const groups = [];

  for (const preference of trainingPrefs.PREFERENCES) {
    const last = groups[groups.length - 1];
    if (!last || last.name !== preference.group) {
      groups.push({ name: preference.group, items: [preference] });
    } else {
      last.items.push(preference);
    }
  }

  return el('section', {}, [
    sectionHead('Training preferences'),
    el('p.t-caption.t-faint', {
      text: 'These describe how you train, not how the app would prefer you to. '
        + 'They are read when displaying and interpreting your log — changing one never rewrites a stored number.',
      style: { marginBottom: 'var(--s-3)', padding: '0 var(--s-1)' },
    }),
    ...groups.map((group) => el('div', { style: { marginBottom: 'var(--s-4)' } }, [
      el('div.t-overline', { text: group.name, style: { marginBottom: 'var(--s-2)' } }),
      el('div.card.stack', { style: { gap: 'var(--s-4)' } },
        group.items.map((preference) => preferenceField(preference, prefs))),
    ])),
    el('div.list', {}, [
      actionRow(
        'info',
        'Restore training defaults',
        'Back to the documented conventions',
        handleResetPrefs
      ),
    ]),
  ]);
}

function preferenceField(preference, prefs) {
  const value = prefs[preference.key];

  const control = (() => {
    if (preference.type === 'readonly') {
      return el('span.pill', { text: preference.display ?? String(value) });
    }

    if (preference.type === 'number') {
      const input = el('input.input.input--num', {
        type: 'number',
        inputmode: 'numeric',
        step: '1',
        min: String(preference.min ?? 0),
        max: String(preference.max ?? 99),
        value: String(value ?? ''),
        'aria-label': preference.label,
        style: { width: '84px' },
      });
      input.addEventListener('blur', async () => {
        const next = Math.min(
          preference.max ?? 99,
          Math.max(preference.min ?? 0, Number(input.value) || (preference.min ?? 1))
        );
        input.value = String(next);
        await trainingPrefs.set(preference.key, next);
        toast('Saved', 'success');
      });
      return input;
    }

    const options = preference.type === 'toggle'
      ? [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]
      : preference.options;

    const current = preference.type === 'toggle'
      ? (value ? 'on' : 'off')
      : String(value);

    return segmented({
      name: preference.label,
      options,
      value: current,
      onChange: async (next) => {
        const stored = preference.type === 'toggle' ? next === 'on' : next;
        await trainingPrefs.set(preference.key, stored);

        // Two preferences are load-bearing enough to warn about rather than
        // silently accept: switching either one changes what the progression
        // engine is allowed to conclude.
        if (preference.warnOn && stored === true) {
          toast(`${preference.label} is on — this changes how progression is calculated`, 'warning');
        } else {
          toast('Saved', 'success');
        }
        refresh();
      },
    });
  })();

  return el('div.field', {}, [
    el('span.field__label', { text: preference.label }),
    control,
    el('span.t-caption.t-faint', { text: preference.help ?? '' }),
  ]);
}

async function handleResetPrefs() {
  const confirmed = window.confirm(
    'Restore the documented training conventions?\n\n'
    + 'This resets the preferences only. No logged workout, weigh-in or note is touched.'
  );
  if (!confirmed) return;
  await trainingPrefs.reset();
  toast('Training preferences restored', 'success');
  refresh();
}

/* --- Install ------------------------------------------------------------ */

/**
 * Only rendered when installing is actually possible. Once the app is running
 * standalone there is nothing to offer, and a permanent "install me" row in an
 * already-installed app is just noise.
 */
function installSection() {
  if (pwa.isStandalone()) {
    return el('div.card.row', { style: { gap: 'var(--s-3)' } }, [
      el('div.list__icon', { style: { background: 'var(--c-success-dim)' } }, [icon('check')]),
      el('div', { style: { minWidth: 0 } }, [
        el('div.t-footnote.t-semibold', { text: 'Installed' }),
        el('div.t-caption.t-faint', { text: 'Running from your Home Screen, offline capable' }),
      ]),
    ]);
  }

  if (!pwa.canOfferInstall()) return null;

  return el('section', {}, [
    sectionHead('Install'),
    el('div.card', {}, [
      el('p.t-subhead', {
        text: 'Add IronLog to your Home Screen to launch it full screen and use it with no signal.',
      }),
      el('button.btn.btn--primary.btn--block', {
        type: 'button',
        text: pwa.hasNativePrompt() ? 'Install IronLog' : 'How to install',
        style: { marginTop: 'var(--s-4)' },
        on: { click: handleInstall },
      }),
    ]),
  ]);
}

async function handleInstall() {
  if (pwa.hasNativePrompt()) {
    const outcome = await pwa.promptInstall();
    if (outcome === 'accepted') toast('Installing…', 'success');
    else if (outcome === 'dismissed') await pwa.markInstallDismissed();
    refresh();
    return;
  }

  // iOS has no install API at all — Share -> Add to Home Screen is the only
  // route, so the honest thing is to say so.
  await openSheet({
    title: 'Add to Home Screen',
    text: 'Safari has no install button, so this is done from the Share menu.',
    body: el('ol.stack', { style: { gap: 'var(--s-2)', paddingLeft: 'var(--s-5)' } },
      IOS_INSTALL_STEPS.map((step, index) =>
        el('li.t-subhead.t-dim', { text: `${index + 1}. ${step}` }))),
    actions: [{ label: 'Got it', value: true, tone: 'primary' }],
  });
  await pwa.markInstallDismissed();
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
      profile.goalWeightKg === null || profile.goalWeightKg === undefined
        ? el('p.t-caption.t-faint', {
            text: `Using the program's target of ${settingsService.getGoalWeightKg() ?? '—'} kg. Enter a value here to override it.`,
          })
        : null,
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
  db.usageBytes().then((bytes) => { usageNode.textContent = formatBytes(bytes); });

  // A hidden file input, triggered by the visible Restore row — the native
  // control cannot be styled, and a bare "Choose file" button next to
  // designed rows looks like a bug.
  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    'aria-label': 'Choose a backup file to restore',
    on: { change: (event) => handleRestore(event.target) },
  });

  const lastBackupAt = db.getLastBackupAt();

  // The parachute written before the v1 -> v2 upgrade. Offered as a download for
  // as long as it exists, and never deleted automatically.
  const snapshotRow = el('div');
  db.getPreMigrationSnapshot().then((snapshot) => {
    if (!snapshot) return;
    replace(snapshotRow, [
      actionRow(
        'download',
        'Download pre-upgrade snapshot',
        `Your data exactly as it was before the ${snapshot.schemaVersion} → ${db.SCHEMA_VERSION} upgrade`
          + `${snapshot.capturedAt ? ` · ${formatDate(snapshot.capturedAt.slice(0, 10), { withYear: true })}` : ''}`,
        () => handleSnapshotDownload(snapshot)
      ),
    ]);
  });

  return el('section', {}, [
    sectionHead('Data', {
      hint: lastBackupAt
        ? `Last backup ${relativeDay(lastBackupAt.slice(0, 10))}`
        : 'Never backed up',
    }),
    el('div.list', {}, [
      actionRow(
        'download',
        'Back up to JSON',
        lastBackupAt
          ? `Everything IronLog has stored · last ${formatDate(lastBackupAt.slice(0, 10), { withYear: true })}`
          : 'Download everything IronLog has stored',
        handleBackup
      ),
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
    snapshotRow,

    !lastBackupAt && db.read(db.COLLECTIONS.SESSIONS).length
      ? el('div.note', { style: { marginTop: 'var(--s-3)' } }, [
          el('span.t-footnote.t-semibold', { text: 'No backup taken yet' }),
          el('span.note__meta', {
            text: `${db.read(db.COLLECTIONS.SESSIONS).length} logged sessions live only on this device. `
              + 'Back up now and keep the file somewhere else.',
          }),
        ])
      : null,

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

/**
 * Download the whole database as a timestamped JSON file.
 *
 * "Last backup" is stamped only after the download call returns without
 * throwing. Recording it optimistically would put a reassuring date next to a
 * backup that never reached the disk, in the one place the user has to be able
 * to trust.
 */
async function handleBackup() {
  try {
    download(
      JSON.stringify(db.exportAll(), null, 2),
      stampedName('backup', 'json'),
      'application/json'
    );
    await db.markBackupTaken();
    toast('Backup downloaded', 'success');
    refresh();
  } catch (error) {
    console.error('[settings] backup failed:', error);
    toast('Backup failed', 'danger');
  }
}

/** Download the pre-upgrade parachute exactly as it was captured. */
function handleSnapshotDownload(snapshot) {
  try {
    download(
      JSON.stringify(
        // Shaped like a normal backup so it can be restored through the same
        // Restore row without any special handling.
        {
          app: 'Project IronLog',
          schemaVersion: snapshot.schemaVersion,
          exportedAt: snapshot.capturedAt,
          note: 'Pre-upgrade snapshot, captured automatically before the schema migration.',
          data: snapshot.data,
        },
        null,
        2
      ),
      stampedName(`pre-upgrade-v${snapshot.schemaVersion}`, 'json'),
      'application/json'
    );
    toast('Snapshot downloaded', 'success');
  } catch (error) {
    console.error('[settings] snapshot download failed:', error);
    toast('Could not download the snapshot', 'danger');
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
      infoRow('Version', `${APP_VERSION} · Session ${BUILD_SESSION}`),
      infoRow('Program', program.name),
      infoRow('Training days', String(programService.getTrainingDays().length)),
      infoRow('Storage', 'Local Storage on this device'),
      infoRow('Data schema', `v${db.SCHEMA_VERSION}`),
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
