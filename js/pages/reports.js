/**
 * reports.js — The reports hub.
 *
 * Two things live here: the two-week review (generate, read, save, export) and
 * the export list. The data-entry screens it depends on — coach notes, photos,
 * recovery and measurements — are separate routes linked from the top, because
 * a single page that both captured and reported would be unreadable.
 */

import { el, icon } from '../core/dom.js';
import { go } from '../core/router.js';
import { toast } from '../core/events.js';
import { download, stampedName, formatBytes } from '../core/download.js';
import { formatDate, relativeDay, pluralize, trimNumber } from '../core/format.js';
import * as db from '../services/db.js';
import * as reviewService from '../services/review-service.js';
import * as notesService from '../services/notes-service.js';
import { recovery, measurements, photos } from '../services/logs-service.js';
import { DATASETS } from '../reports/csv.js';
import { buildReport, DEFAULT_SECTIONS } from '../reports/pdf-report.js';
import { sectionHead, stat, emptyState } from '../../components/stat.js';
import { openSheet, confirmSheet } from '../../components/sheet.js';

/** Review window, in days. 14 is the program's own review interval. */
let periodDays = 14;

export function render() {
  const review = reviewService.generate(periodDays);
  const saved = reviewService.getSaved();

  return el('div.page.enter', {}, [
    captureLinks(),
    reviewSection(review, saved),
    exportSection(review),
  ]);
}

/* --- Links to the data-entry screens ------------------------------------ */

function captureLinks() {
  const photoStatus = photos.status();

  return el('div.grid.grid--2', {}, [
    linkTile('note', 'Coach notes', pluralize(notesService.countActive(), 'note'), () => go('notes')),
    linkTile('camera', 'Progress photos',
      photoStatus.lastDate
        ? `${photoStatus.complete}/${photoStatus.total} · ${relativeDay(photoStatus.lastDate)}`
        : 'None yet',
      () => go('photos'),
      photoStatus.due),
    linkTile('bed', 'Recovery', pluralize(recovery.count(), 'log'), () => go('logs', { tab: 'recovery' })),
    linkTile('ruler', 'Measurements', pluralize(measurements.count(), 'entry', 'entries'), () => go('logs', { tab: 'measurements' })),
  ]);
}

function linkTile(iconName, title, sub, onClick, flag = false) {
  return el('button.card.card--tappable', {
    type: 'button',
    on: { click: onClick },
    style: { display: 'flex', alignItems: 'center', gap: 'var(--s-3)' },
  }, [
    el('div.list__icon', {}, [icon(iconName)]),
    el('div', { style: { flex: '1 1 auto', minWidth: 0 } }, [
      el('div.t-footnote.t-semibold.t-truncate', { text: title }),
      el('div.t-caption.t-faint.t-truncate', { text: sub }),
    ]),
    flag ? el('span.pill.pill--warning', { text: 'Due' }) : null,
  ].filter(Boolean));
}

/* --- The review --------------------------------------------------------- */

function reviewSection(review, saved) {
  const countdown = reviewService.dueIn();

  return el('section', {}, [
    sectionHead('Two-week review', {
      hint: countdown.daysRemaining === null
        ? null
        : (countdown.isOverdue ? 'Due now' : `Due in ${countdown.daysRemaining} days`),
    }),

    // Period picker. Two weeks is the program's interval; the others exist
    // because a single missed fortnight makes a 14-day window unreadable.
    el('div.segmented', { role: 'radiogroup', 'aria-label': 'Review period' },
      [14, 28, 56].map((days) =>
        el('button.segmented__opt', {
          type: 'button',
          role: 'radio',
          'aria-checked': days === periodDays ? 'true' : 'false',
          text: `${days} days`,
          on: {
            click: () => { periodDays = days; go('reports'); },
          },
        })
      )),

    el('div.card', { style: { marginTop: 'var(--s-3)' } }, [
      el('p.t-caption.t-faint', {
        text: `${formatDate(review.period.start)} — ${formatDate(review.period.end, { withYear: true })}`,
      }),

      // Headline figures.
      review.headline.length
        ? el('div.grid.grid--auto', { style: { marginTop: 'var(--s-3)' } },
            review.headline.map((item) => stat({ label: item.label, value: item.value })))
        : null,

      // The recommendation, which is the point of the whole document.
      el(`div.review-reco.review-reco--${review.recommendation.tone}`, {
        style: { marginTop: 'var(--s-4)' },
      }, [
        el('div.t-overline', { text: 'Recommendation' }),
        el('div.t-title-3', { text: review.recommendation.action, style: { marginTop: '2px' } }),
        el('p.t-subhead.t-dim', { text: review.recommendation.text, style: { marginTop: 'var(--s-2)' } }),
      ]),

      // Findings, each stating the figure it came from.
      el('div.stack', { style: { marginTop: 'var(--s-4)', gap: 'var(--s-3)' } },
        review.findings.map((finding) =>
          el('div.finding', {}, [
            el(`span.finding__dot.finding__dot--${finding.tone}`, { 'aria-hidden': 'true' }),
            el('div', { style: { minWidth: 0 } }, [
              el('div.row.row--between', { style: { gap: 'var(--s-2)' } }, [
                el('span.t-footnote.t-semibold', { text: finding.label }),
                finding.value
                  ? el(`span.t-footnote.t-semibold.finding__value--${finding.tone}`, { text: finding.value })
                  : null,
              ].filter(Boolean)),
              finding.detail
                ? el('div.t-caption.t-faint', { text: finding.detail })
                : null,
              el('p.t-caption.t-dim', { text: finding.text, style: { marginTop: '2px' } }),
            ]),
          ])
        )),

      el('div.row', { style: { marginTop: 'var(--s-5)', gap: 'var(--s-2)', flexWrap: 'wrap' } }, [
        el('button.btn.btn--primary', {
          type: 'button',
          on: { click: () => handlePdf(review) },
        }, [icon('download', { className: 'btn__icon' }), el('span', { text: 'Export PDF' })]),
        el('button.btn.btn--tinted', {
          type: 'button',
          text: 'Save this review',
          on: { click: () => handleSaveReview(review) },
        }),
      ]),
    ]),

    saved.length ? savedReviews(saved) : null,
  ]);
}

function savedReviews(saved) {
  return el('div', { style: { marginTop: 'var(--s-5)' } }, [
    sectionHead('Saved reviews', { hint: pluralize(saved.length, 'review') }),
    el('div.list', {}, saved.map((entry) =>
      el('div.list__row', {}, [
        el('div.list__body', {}, [
          el('div.list__title', { text: entry.recommendation?.action ?? 'Review' }),
          el('div.list__sub', {
            text: `${formatDate(entry.periodStart)} — ${formatDate(entry.date)} · ${entry.periodDays} days`,
          }),
        ]),
        el('button.btn-icon', {
          type: 'button',
          'aria-label': 'Delete this review',
          on: { click: () => handleDeleteReview(entry.id) },
        }, [icon('info')]),
      ])
    )),
    el('p.t-caption.t-faint', {
      text: 'A saved review keeps what was concluded at the time. The figures behind it can always be recomputed from the log; the conclusion cannot.',
      style: { marginTop: 'var(--s-2)', padding: '0 var(--s-1)' },
    }),
  ]);
}

/* --- Exports ------------------------------------------------------------ */

function exportSection(review) {
  return el('section', {}, [
    sectionHead('Export'),

    el('div.list', {}, [
      exportRow('document', 'PDF report', 'Choose which sections to include', () => handlePdf(review, true)),
      exportRow('download', 'Full JSON backup', 'Everything, restorable in Settings', handleJson),
    ]),

    el('div', { style: { marginTop: 'var(--s-4)' } }, [
      el('div.t-overline', { text: 'CSV', style: { padding: '0 var(--s-1)', marginBottom: 'var(--s-2)' } }),
      el('div.list', {}, DATASETS.map((dataset) =>
        exportRow(null, dataset.label, dataset.describe, () => handleCsv(dataset))
      )),
    ]),

    el('p.t-caption.t-faint', {
      text: 'A JSON backup does not include photo images — they live in a separate store because base64 in Local Storage would exhaust the quota within weeks. Export photos from the Progress photos screen.',
      style: { marginTop: 'var(--s-3)', padding: '0 var(--s-1)' },
    }),
  ]);
}

function exportRow(iconName, title, sub, onClick) {
  return el('button.list__row.list__row--tappable', { type: 'button', on: { click: onClick } }, [
    iconName ? el('div.list__icon', {}, [icon(iconName)]) : null,
    el('div.list__body', {}, [
      el('div.list__title', { text: title }),
      el('div.list__sub', { text: sub }),
    ]),
    icon('chevron', { className: 'list__chevron' }),
  ].filter(Boolean));
}

/* --- Actions ----------------------------------------------------------- */

/**
 * Build and download the PDF.
 *
 * With `choose`, a sheet offers the section list first. Generation is
 * genuinely slow (a library load plus photo re-encoding), so the button
 * reports progress rather than appearing to do nothing.
 */
async function handlePdf(review, choose = false) {
  let sections = DEFAULT_SECTIONS.map((section) => section.key);
  let includePhotos = photos.count() > 0;

  if (choose) {
    const picked = await pickSections(sections, includePhotos);
    if (!picked) return;
    sections = picked.sections;
    includePhotos = picked.includePhotos;
  }

  toast('Building the report…');

  try {
    const blob = await buildReport(review, { sections, includePhotos });
    download(blob, stampedName(`report-${review.period.days}d`, 'pdf'));
    toast(`Report ready · ${formatBytes(blob.size)}`, 'success');
  } catch (error) {
    console.error('[reports] PDF failed:', error);
    toast(error.message || 'Could not build the report', 'danger');
  }
}

/** Section chooser. Checkboxes rather than a multi-select: it is a short list. */
function pickSections(defaults, photosAvailable) {
  const chosen = new Set(defaults);
  let includePhotos = photosAvailable;

  const rows = DEFAULT_SECTIONS.map((section) => {
    const box = el('input', {
      type: 'checkbox',
      checked: chosen.has(section.key),
      id: `section-${section.key}`,
      on: {
        change: (event) => {
          if (event.target.checked) chosen.add(section.key);
          else chosen.delete(section.key);
          if (section.key === 'photos') includePhotos = event.target.checked;
        },
      },
    });

    return el('label.check-row', { for: `section-${section.key}` }, [
      box,
      el('span.t-subhead', { text: section.label }),
      section.key === 'photos' && !photosAvailable
        ? el('span.t-caption.t-faint', { text: 'no photos' })
        : null,
    ].filter(Boolean));
  });

  return openSheet({
    title: 'PDF sections',
    text: 'Everything is included by default.',
    body: el('div.stack', { style: { gap: '0' } }, rows),
    actions: [
      { label: 'Build PDF', value: 'go', tone: 'primary' },
      { label: 'Cancel', value: null, tone: 'plain' },
    ],
  }).then((result) =>
    result === 'go' ? { sections: [...chosen], includePhotos } : null
  );
}

function handleJson() {
  try {
    download(
      JSON.stringify(db.exportAll(), null, 2),
      stampedName('backup', 'json'),
      'application/json'
    );
    toast('Backup downloaded', 'success');
  } catch (error) {
    console.error('[reports] JSON export failed:', error);
    toast('Export failed', 'danger');
  }
}

function handleCsv(dataset) {
  try {
    const csv = dataset.build();
    // Header row only means there is nothing to export; a file with one line
    // looks like a bug rather than an empty dataset.
    if (csv.split('\r\n').filter(Boolean).length <= 1) {
      toast(`No ${dataset.label.toLowerCase()} to export yet`);
      return;
    }
    download(csv, stampedName(dataset.key, 'csv'), 'text/csv;charset=utf-8');
    toast(`${dataset.label} exported`, 'success');
  } catch (error) {
    console.error('[reports] CSV export failed:', error);
    toast('Export failed', 'danger');
  }
}

async function handleSaveReview(review) {
  try {
    await reviewService.save(review);
    toast('Review saved', 'success');
    go('reports');
  } catch (error) {
    toast(error.message || 'Could not save the review', 'danger');
  }
}

async function handleDeleteReview(id) {
  const confirmed = await confirmSheet({
    title: 'Delete this review?',
    text: 'The conclusion is removed. Your training log is untouched.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  await reviewService.remove(id);
  toast('Review deleted');
  go('reports');
}

export const page = {
  name: 'reports',
  title: 'Reports',
  render,
};
