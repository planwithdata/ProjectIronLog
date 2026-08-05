/**
 * ring.js — Circular progress ring (Apple Fitness style).
 *
 * Drawn as an SVG circle whose `stroke-dasharray` is the full circumference
 * and whose `stroke-dashoffset` is the unfilled remainder. Animating the
 * offset gives the fill a single-property CSS transition, which the compositor
 * can run on the GPU — smooth on an iPhone without a JS animation loop.
 */

import { el } from '../js/core/dom.js';

/**
 * @param {object} options
 * @param {number} options.percent    0–100
 * @param {number} [options.size]     outer diameter in px
 * @param {number} [options.stroke]   ring thickness in px
 * @param {string} [options.color]    CSS colour for the fill
 * @param {Node|string} [options.label]      centre content
 * @param {string} [options.ariaLabel]       accessible description
 * @returns {HTMLElement}
 */
export function ring({
  percent = 0,
  size = 72,
  stroke = 7,
  color = null,
  label = null,
  ariaLabel = null,
} = {}) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('class', 'ring__track');
  track.setAttribute('cx', size / 2);
  track.setAttribute('cy', size / 2);
  track.setAttribute('r', radius);
  track.setAttribute('stroke-width', stroke);

  const fill = document.createElementNS(svgNS, 'circle');
  fill.setAttribute('class', 'ring__fill');
  fill.setAttribute('cx', size / 2);
  fill.setAttribute('cy', size / 2);
  fill.setAttribute('r', radius);
  fill.setAttribute('stroke-width', stroke);
  fill.setAttribute('stroke-dasharray', circumference.toFixed(2));
  // Start empty, then fill on the next frame so the transition actually runs
  // on first paint instead of the ring appearing already complete.
  fill.setAttribute('stroke-dashoffset', circumference.toFixed(2));
  if (color) fill.setAttribute('stroke', color);

  svg.append(track, fill);

  requestAnimationFrame(() => {
    fill.setAttribute('stroke-dashoffset', offset.toFixed(2));
  });

  const children = [svg];
  if (label !== null) {
    children.push(el('div.ring-wrap__label', {}, label));
  }

  return el(
    'div.ring-wrap',
    {
      role: 'img',
      'aria-label': ariaLabel ?? `${Math.round(value)} percent complete`,
      style: { width: `${size}px`, height: `${size}px` },
    },
    children
  );
}

/**
 * A ring with a large percentage in the middle — the Home completion dial.
 */
export function percentRing({ percent = 0, size = 72, sub = null, ...rest } = {}) {
  const value = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
  return ring({
    percent: value,
    size,
    label: [
      el('span', {
        text: String(value),
        style: {
          fontSize: `${Math.round(size * 0.27)}px`,
          fontWeight: '700',
        },
      }),
      sub ? el('span.t-micro.t-faint', { text: sub, style: { marginTop: '2px' } }) : null,
    ],
    ...rest,
  });
}
