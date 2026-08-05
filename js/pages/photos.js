/**
 * photos.js — Progress photos: capture, browse and compare.
 *
 * The comparison view is the reason this feature exists. A single photo tells
 * you nothing; the same angle eight weeks apart tells you everything the scale
 * cannot. So the compare view pins one date against another and lets you swipe
 * between angles, rather than presenting a gallery to scroll.
 *
 * Object URL discipline: every URL created here is revoked on teardown. A
 * full-size blob stays pinned in memory for as long as its URL lives, and
 * leaking one per photo per visit is how a phone tab gets killed.
 */

import { el, icon, replace } from '../core/dom.js';
import { go, refresh } from '../core/router.js';
import { toast } from '../core/events.js';
import { formatDate, relativeDay, today, daysBetween, pluralize } from '../core/format.js';
import { formatBytes } from '../core/download.js';
import { photos, PHOTO_CATEGORIES } from '../services/logs-service.js';
import * as photoStore from '../services/photo-store.js';
import { sectionHead, stat, emptyState } from '../../components/stat.js';
import { confirmSheet } from '../../components/sheet.js';

/** Every object URL this page has created, revoked on teardown. */
let liveUrls = [];

/** Compare state: which two dates and which angle. */
let compare = { left: null, right: null, category: PHOTO_CATEGORIES[0].key };

export function render() {
  revokeAll();

  const dates = photos.dates();
  const status = photos.status();

  if (dates.length && !compare.right) {
    compare.right = dates[0];
    compare.left = dates[dates.length - 1] === dates[0] ? dates[0] : dates[dates.length - 1];
  }

  return el('div.page.enter', {}, [
    backLink(),
    captureCard(status),
    dates.length >= 2 ? compareSection(dates) : null,
    dates.length ? timelineSection(dates) : null,
    dates.length ? storageNote() : null,
  ].filter(Boolean));
}

export function mount() {
  return () => revokeAll();
}

function revokeAll() {
  for (const url of liveUrls) URL.revokeObjectURL(url);
  liveUrls = [];
}

/** Track a URL so teardown can revoke it. */
function trackUrl(url) {
  if (url) liveUrls.push(url);
  return url;
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

/* --- Capture ------------------------------------------------------------ */

function captureCard(status) {
  const dateInput = el('input.input', {
    type: 'date',
    value: today(),
    max: today(),
    'aria-label': 'Photo date',
  });

  const slots = el('div.photo-slots');

  const paintSlots = () => {
    const date = dateInput.value || today();
    replace(slots, PHOTO_CATEGORIES.map((category) => slot(category, date, paintSlots)));
  };

  dateInput.addEventListener('change', paintSlots);
  paintSlots();

  return el('div.card', {}, [
    el('div.row.row--between', { style: { alignItems: 'flex-start' } }, [
      el('div', {}, [
        el('div.t-callout.t-semibold', { text: 'Capture a set' }),
        el('div.t-caption.t-faint', {
          text: status.lastDate
            ? `Last set ${relativeDay(status.lastDate)} · ${status.complete}/${status.total} angles`
            : 'The program asks for a set every two weeks',
        }),
      ]),
      status.due
        ? el('span.pill.pill--warning', { text: 'Due' })
        : el('span.pill.pill--success', { text: 'Up to date' }),
    ]),
    el('div', { style: { marginTop: 'var(--s-3)' } }, [dateInput]),
    slots,
    el('p.t-caption.t-faint', {
      text: 'Photos are downscaled to 1280px and stored on this device only. Same light, same time of day and same distance makes the comparison worth having.',
      style: { marginTop: 'var(--s-3)' },
    }),
  ]);
}

/**
 * One capture slot. Shows the thumbnail if a photo exists for that
 * date/category, otherwise a labelled file picker.
 */
function slot(category, date, onChange) {
  const existing = photos.find(date, category.key);

  const input = el('input', {
    type: 'file',
    accept: 'image/*',
    // `capture` hints the rear camera on a phone without blocking the library.
    capture: 'environment',
    style: { display: 'none' },
    id: `photo-${category.key}`,
  });

  input.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const stored = await photos.add(file, { category: category.key, date });
      toast(`${category.label} saved · ${formatBytes(stored.bytes)}`, 'success');
      onChange();
    } catch (error) {
      console.error('[photos] import failed:', error);
      toast(error.message || 'Could not save that photo', 'danger');
    }
  });

  const tile = el('button.photo-slot', {
    type: 'button',
    'aria-label': existing ? `Replace ${category.label}` : `Add ${category.label}`,
    on: { click: () => input.click() },
  }, [
    existing
      ? el('img.photo-slot__img', { alt: '', loading: 'lazy' })
      : el('span.photo-slot__empty', {}, [icon('camera', { size: 20 })]),
    el('span.photo-slot__label', { text: category.label }),
  ]);

  if (existing) {
    const img = tile.querySelector('img');
    photos.url(existing.id).then((url) => {
      if (url) img.src = trackUrl(url);
    });
  }

  return el('div.photo-slots__cell', {}, [tile, input]);
}

/* --- Compare ------------------------------------------------------------ */

function compareSection(dates) {
  const pane = el('div.compare');

  const paint = () => {
    replace(pane, [
      comparePane(compare.left, compare.category, 'Before'),
      comparePane(compare.right, compare.category, 'After'),
    ]);
  };

  const datePicker = (side) =>
    el('select.input', {
      'aria-label': `${side === 'left' ? 'Before' : 'After'} date`,
      on: {
        change: (event) => { compare[side] = event.target.value; paint(); },
      },
    }, dates.map((date) =>
      el('option', {
        value: date,
        text: `${formatDate(date, { withYear: true })}`,
        selected: date === compare[side],
      })
    ));

  // Angle switcher — the "swipe" between categories. Buttons rather than a
  // gesture so it works with a mouse and a keyboard too; the row scrolls
  // horizontally on a phone.
  const angleRow = el('div.angle-row', {}, PHOTO_CATEGORIES.map((category) =>
    el('button.angle-row__opt', {
      type: 'button',
      'aria-pressed': category.key === compare.category ? 'true' : 'false',
      text: category.label,
      on: {
        click: (event) => {
          compare.category = category.key;
          for (const button of event.currentTarget.parentElement.children) {
            button.setAttribute('aria-pressed',
              button.textContent === category.label ? 'true' : 'false');
          }
          paint();
        },
      },
    })
  ));

  paint();

  const gap = compare.left && compare.right
    ? Math.abs(daysBetween(compare.left, compare.right))
    : 0;

  return el('section', {}, [
    sectionHead('Compare', { hint: gap ? `${gap} days apart` : null }),
    el('div.card', {}, [
      el('div.grid.grid--2', {}, [datePicker('left'), datePicker('right')]),
      angleRow,
      pane,
    ]),
  ]);
}

function comparePane(date, category, label) {
  const photo = date ? photos.find(date, category) : null;

  const figure = el('figure.compare__pane', {}, [
    photo
      ? el('img.compare__img', { alt: `${label}: ${category} on ${date}`, loading: 'lazy' })
      : el('div.compare__missing', {}, [
          icon('camera', { size: 20 }),
          el('span.t-caption', { text: 'Not taken' }),
        ]),
    el('figcaption.compare__caption', {}, [
      el('span.t-caption.t-semibold', { text: label }),
      el('span.t-caption.t-faint', { text: date ? formatDate(date, { withYear: true }) : '—' }),
    ]),
  ]);

  if (photo) {
    const img = figure.querySelector('img');
    photos.url(photo.id).then((url) => {
      if (url) img.src = trackUrl(url);
    });
  }

  return figure;
}

/* --- Timeline ----------------------------------------------------------- */

function timelineSection(dates) {
  return el('section', {}, [
    sectionHead('All sets', { hint: pluralize(dates.length, 'set') }),
    el('div.stack', {}, dates.map((date) => {
      const set = photos.onDate(date);

      return el('div.card', {}, [
        el('div.row.row--between', {}, [
          el('div', {}, [
            el('div.t-footnote.t-semibold', { text: formatDate(date, { withYear: true }) }),
            el('div.t-caption.t-faint', {
              text: `${relativeDay(date)} · ${set.length}/${PHOTO_CATEGORIES.length} angles`,
            }),
          ]),
          el('button.btn.btn--sm.btn--ghost', {
            type: 'button',
            text: 'Delete set',
            style: { color: 'var(--c-danger)' },
            on: { click: () => handleDeleteSet(date, set) },
          }),
        ]),
        el('div.photo-strip', {}, set.map((photo) => {
          const img = el('img.photo-strip__img', {
            alt: photo.category,
            loading: 'lazy',
          });
          photos.url(photo.id).then((url) => { if (url) img.src = trackUrl(url); });
          return el('div.photo-strip__cell', {}, [
            img,
            el('span.t-micro.t-faint', {
              text: PHOTO_CATEGORIES.find((c) => c.key === photo.category)?.label ?? photo.category,
            }),
          ]);
        })),
      ]);
    })),
  ]);
}

async function handleDeleteSet(date, set) {
  const confirmed = await confirmSheet({
    title: `Delete ${formatDate(date, { withYear: true })}?`,
    text: `${pluralize(set.length, 'photo')} will be permanently removed from this device.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;

  for (const photo of set) await photos.remove(photo.id);
  toast('Photo set deleted');
  refresh();
}

/* --- Storage ------------------------------------------------------------ */

function storageNote() {
  const node = el('p.t-caption.t-faint', {
    text: `${pluralize(photos.count(), 'photo')} · ${formatBytes(photos.totalBytes())} stored`,
    style: { padding: '0 var(--s-1)' },
  });

  // The browser's own estimate covers the whole origin, which is the number
  // that actually matters for eviction.
  photoStore.estimateUsage().then((estimate) => {
    if (!estimate?.quota) return;
    const percent = Math.round((estimate.usage / estimate.quota) * 100);
    node.textContent =
      `${pluralize(photos.count(), 'photo')} · ${formatBytes(photos.totalBytes())} stored · `
      + `${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} used on this device (${percent}%)`;
  });

  return node;
}

export const page = {
  name: 'photos',
  title: 'Progress photos',
  render,
  mount,
};
