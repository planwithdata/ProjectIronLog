/**
 * exercise-art.js — The exercise illustration.
 *
 * Two frames, start and end position, side by side. One still image of a
 * movement is close to useless; two read as a sequence and actually tell you
 * what the lift is.
 *
 * Paths are derived by convention from the exercise id
 * (`assets/exercises/<id>-1.webp`) rather than listed in workouts.json. That
 * keeps program data free of asset bookkeeping: adding artwork for a new
 * exercise is dropping two files in, and an exercise with no artwork falls back
 * to the placeholder on its own via the image error handler. No manifest to
 * fetch, nothing to keep in sync.
 *
 * Images are lazy and are NOT in the service worker's precache list — see
 * tools/fetch_illustrations.py for why. The cache-first handler stores each one
 * the first time it is actually shown, so it is offline from then on.
 */

import { el, icon } from '../js/core/dom.js';
import { openSheet } from './sheet.js';

const DIR = 'assets/exercises';
const FRAMES = [
  { suffix: 1, position: 'start' },
  { suffix: 2, position: 'end' },
];

/**
 * Build the illustration block for an exercise.
 *
 * @param {object} exercise  an entry from workouts.json
 * @returns {HTMLElement}
 */
export function exerciseArt(exercise) {
  // Relative to the document, which is what keeps a GitHub Pages
  // subdirectory deploy working.
  const src = (suffix) => `./${DIR}/${exercise.id}-${suffix}.webp`;

  const placeholder = el('div.ex-art__fallback', { 'aria-hidden': 'true' }, [
    icon('dumbbell', { size: 20 }),
    el('span.t-caption', { text: 'No illustration' }),
  ]);

  const images = FRAMES.map(({ suffix, position }) =>
    el('img.ex-art__frame', {
      src: src(suffix),
      alt: `${exercise.name}, ${position} position`,
      loading: 'lazy',
      decoding: 'async',
      width: 440,
      height: 294,
    })
  );

  const grid = el('button.ex-art', {
    type: 'button',
    'aria-label': `Enlarge the ${exercise.name} illustration`,
    on: { click: () => enlarge(exercise, src) },
  }, images);

  const wrap = el('div', {}, [grid]);

  // If the artwork is missing, swap in the placeholder rather than leaving a
  // broken-image glyph. Counted so one missing frame does not blank the pair.
  let failed = 0;
  for (const image of images) {
    image.addEventListener('error', () => {
      image.remove();
      failed += 1;
      if (failed === images.length) wrap.replaceChildren(placeholder);
    }, { once: true });
  }

  return wrap;
}

/**
 * Full-width view of both frames plus the form cues.
 *
 * Worth having mid-workout: the card's illustration is small enough to identify
 * the movement but not to check a position against.
 */
function enlarge(exercise, src) {
  const body = el('div.stack', { style: { gap: 'var(--s-3)' } }, [
    ...FRAMES.map(({ suffix, position }) =>
      el('figure', { style: { margin: '0' } }, [
        el('img', {
          src: src(suffix),
          alt: `${exercise.name}, ${position} position`,
          loading: 'eager',
          style: { width: '100%', borderRadius: 'var(--r-md)', display: 'block' },
        }),
        el('figcaption.t-caption.t-faint', {
          text: position === 'start' ? 'Start' : 'End',
          style: { marginTop: 'var(--s-1)' },
        }),
      ])
    ),
    exercise.cues?.length
      ? el('ul.stack', { style: { gap: 'var(--s-1)', marginTop: 'var(--s-2)' } },
          exercise.cues.map((cue) => el('li.t-footnote.t-dim', { text: `· ${cue}` })))
      : null,
  ].filter(Boolean));

  openSheet({
    title: exercise.name,
    text: [exercise.equipment, exercise.reps?.label ? `${exercise.sets} × ${exercise.reps.label}` : null]
      .filter(Boolean).join(' · '),
    body,
    actions: [{ label: 'Close', value: true, tone: 'primary' }],
  });
}
