/**
 * chart-theme.js — Chart palette and Chart.js defaults.
 *
 * The categorical palette
 * -----------------------
 * The app's UI accent alone cannot carry a multi-series chart, so charts get
 * their own eight-slot categorical palette. The slots are assigned in fixed
 * order and never cycled: a ninth series folds into "Other" or becomes a small
 * multiple instead.
 *
 * Both columns were validated against *this app's* surfaces (dark #0e0e11,
 * light #ffffff) rather than trusted from a reference table:
 *
 *   dark   all 8 pass — worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.3,
 *          every slot ≥ 3:1 on the dark surface
 *   light  all 8 pass, with a contrast WARN: aqua, yellow and magenta sit
 *          below 3:1 on white
 *
 * That WARN is why **every chart in this app ships a table view**. It is the
 * documented relief for sub-3:1 series colors, not an optional extra — see
 * `components/chart-card.js`, which builds the toggle for all of them.
 *
 * The chrome (ink, grid, surface) is read from the CSS custom properties at
 * runtime instead of being duplicated here, so a token change in tokens.css
 * moves the charts with it and light mode needs no second definition.
 */

/** Fixed categorical order. Index 0 is the default single-series color. */
const CATEGORICAL = {
  dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
};

/** Single-hue ramp for magnitude, light → dark. Used by the muscle-group bars. */
const SEQUENTIAL = {
  dark:  ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95'],
  light: ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95'],
};

/** Whether the document is currently rendering dark. */
export function isDark() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light') return false;
  if (attr === 'dark') return true;
  // 'system' or unset: ask the OS.
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** Read a CSS custom property off <html>. */
function token(name, fallback = '') {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * The current chart theme. Rebuilt on demand rather than cached, because the
 * user can change theme at any moment and a stale palette is worse than a
 * getComputedStyle call.
 */
export function chartTheme() {
  const dark = isDark();

  return {
    dark,
    series: CATEGORICAL[dark ? 'dark' : 'light'],
    sequential: SEQUENTIAL[dark ? 'dark' : 'light'],

    // Chrome, straight from the design tokens.
    surface:   token('--c-surface-1', dark ? '#0e0e11' : '#ffffff'),
    ink:       token('--c-text', dark ? '#f5f5f7' : '#1c1c1e'),
    inkDim:    token('--c-text-2', 'rgba(235,235,245,0.62)'),
    inkMuted:  token('--c-text-3', 'rgba(235,235,245,0.34)'),
    grid:      token('--c-hairline', 'rgba(255,255,255,0.09)'),
    axis:      token('--c-hairline-firm', 'rgba(255,255,255,0.16)'),
    accent:    token('--c-accent', '#0a84ff'),
    success:   token('--c-success', '#30d158'),
    warning:   token('--c-warning', '#ff9f0a'),
    danger:    token('--c-danger', '#ff453a'),

    font: token('--font-sans', 'system-ui, sans-serif'),
  };
}

/**
 * Resolve a colour for canvas use.
 *
 * Chart.js paints to a canvas, and a canvas cannot resolve `var(--token)` —
 * `strokeStyle = 'var(--c-text-3)'` is silently invalid and falls back to
 * black, which is all but invisible on the dark surface. So any token
 * reference has to be turned into a real colour before it reaches Chart.js.
 *
 * Accepts `var(--name)`, `var(--name, fallback)`, or a literal colour.
 */
export function resolveColor(color, theme = chartTheme()) {
  if (typeof color !== 'string') return color;

  const match = color.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (!match) return color;

  const [, name, fallback] = match;
  return token(name, fallback?.trim() || theme.inkMuted);
}

/** Categorical color for slot `index`. Never cycles past eight. */
export function seriesColor(index, theme = chartTheme()) {
  if (index < theme.series.length) return theme.series[index];
  // A ninth series is a design error, not something to paper over with a
  // generated hue — make it obvious in review rather than shipping a
  // colour that is indistinguishable under CVD.
  console.warn(`[chart-theme] series slot ${index} exceeds the 8-hue palette; fold into "Other" or facet.`);
  return theme.inkMuted;
}

/** A step from the sequential ramp, given a 0–1 position. */
export function sequentialColor(position, theme = chartTheme()) {
  const ramp = theme.sequential;
  const clamped = Math.max(0, Math.min(1, position));
  return ramp[Math.round(clamped * (ramp.length - 1))];
}

/**
 * Apply global Chart.js defaults from the tokens.
 * Called once per chart build, since the theme may have changed since the last.
 */
export function applyChartDefaults(Chart, theme = chartTheme()) {
  Chart.defaults.font.family = theme.font;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = theme.inkDim;

  // Recessive, solid hairlines. Dashed gridlines read as a threshold or a
  // projection when they are only a grid.
  Chart.defaults.scale.grid.color = theme.grid;
  Chart.defaults.scale.grid.lineWidth = 1;
  Chart.defaults.scale.grid.drawTicks = false;
  Chart.defaults.scale.border.color = theme.axis;
  Chart.defaults.scale.ticks.color = theme.inkMuted;
  Chart.defaults.scale.ticks.padding = 8;

  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.line.tension = 0.25;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 5;
  // A 2px ring in the surface colour separates an overlapping marker from the
  // line beneath it without drawing a border around the mark.
  Chart.defaults.elements.point.hoverBorderWidth = 2;
  Chart.defaults.elements.point.hoverBorderColor = theme.surface;

  Chart.defaults.elements.bar.borderRadius = 4;
  Chart.defaults.elements.bar.borderSkipped = 'bottom';

  Chart.defaults.plugins.legend.display = false;   // legends are rendered in HTML
  Chart.defaults.plugins.tooltip.backgroundColor = theme.dark ? '#2a2a33' : '#1c1c1e';
  Chart.defaults.plugins.tooltip.titleColor = '#ffffff';
  Chart.defaults.plugins.tooltip.bodyColor = 'rgba(255,255,255,0.8)';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.displayColors = true;
  Chart.defaults.plugins.tooltip.boxWidth = 8;
  Chart.defaults.plugins.tooltip.boxHeight = 8;
  Chart.defaults.plugins.tooltip.usePointStyle = true;

  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.responsive = true;
  // The app's own motion token; also respects reduced-motion below.
  Chart.defaults.animation.duration =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400;
}

/**
 * A horizontal reference line — a goal weight, a target.
 *
 * Drawn as a plugin rather than a flat dataset so it never appears in the
 * legend or the tooltip: it is a threshold, not a series.
 */
export function referenceLinePlugin(value, label, theme = chartTheme()) {
  return {
    id: `reference-${label}`,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const y = scales.y?.getPixelForValue(value);
      if (y === undefined || Number.isNaN(y)) return;
      if (y < chartArea.top || y > chartArea.bottom) return;

      ctx.save();
      ctx.strokeStyle = theme.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();

      ctx.fillStyle = theme.inkMuted;
      ctx.font = `500 10px ${theme.font}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, chartArea.right, y - 3);
      ctx.restore();
    },
  };
}
