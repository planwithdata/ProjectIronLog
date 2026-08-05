/**
 * chart-card.js — A chart, its legend, its headline number, and its table.
 *
 * Every chart in the app is built through here, which is what guarantees three
 * things hold everywhere rather than per call site:
 *
 *   - **A table view exists.** Three light-mode series colors sit below 3:1 on
 *     white, and the documented relief for that is visible labels or a table.
 *     It also means no value is reachable only by hovering — which matters on a
 *     phone, where there is no hover at all.
 *   - **A legend is present for two or more series, absent for one.** With one
 *     series the title already names it; a legend box would be noise.
 *   - **The container is sized to include the x-axis band**, so the axis labels
 *     never get cropped into a nested scrollbar.
 *
 * Returns `{ node, destroy }`. The caller must call `destroy()` on teardown —
 * Chart.js holds a canvas and a resize observer, and leaking one per route
 * change would eventually stall the page.
 */

import { el, icon } from '../js/core/dom.js';
import { formatDelta, deltaDirection } from '../js/core/format.js';
import { loadChart } from '../js/charts/chart-loader.js';
import {
  chartTheme, applyChartDefaults, referenceLinePlugin, resolveColor,
} from '../js/charts/chart-theme.js';
import { emptyState } from './stat.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {object} [options.headline]      { value, unit, delta, deltaSuffix, invertDelta }
 * @param {'line'|'bar'} [options.type]
 * @param {Array<{label: string, points: Array<{date: string, value: number}>, color?: string, dashed?: boolean, showPoints?: boolean}>} options.series
 * @param {number} [options.height]        plot height in px, axis band excluded
 * @param {{min: number, max: number}|'zero'} [options.yBounds]
 * @param {(value: number) => string} [options.formatValue]
 * @param {(dateKey: string) => string} [options.formatLabel]
 * @param {{value: number, label: string}} [options.reference]
 * @param {string} [options.emptyText]
 * @param {string} [options.valueHeader]   column header for the table view
 */
export function chartCard(options) {
  const {
    title,
    subtitle = '',
    headline = null,
    type = 'line',
    series = [],
    height = 200,
    yBounds = null,
    formatValue = (value) => String(Math.round(value * 100) / 100),
    formatLabel = (key) => key,
    reference = null,
    emptyText = 'No data yet.',
    valueHeader = 'Value',
  } = options;

  const hasData = series.some((entry) => entry.points.length > 0);
  let chart = null;

  const card = el('article.chart-card');

  /* --- Header ---------------------------------------------------------- */

  const tableToggle = el('button.chart-card__toggle', {
    type: 'button',
    'aria-pressed': 'false',
    title: 'Show the numbers as a table',
  }, [icon('document', { size: 15 }), el('span', { text: 'Table' })]);

  card.append(
    el('div.chart-card__head', {}, [
      el('div', { style: { minWidth: 0 } }, [
        el('h3.chart-card__title', { text: title }),
        subtitle ? el('p.chart-card__sub', { text: subtitle }) : null,
      ].filter(Boolean)),
      hasData ? tableToggle : null,
    ].filter(Boolean))
  );

  if (headline) card.append(headlineBlock(headline));

  /* --- Empty state ----------------------------------------------------- */

  if (!hasData) {
    card.append(emptyState({ iconName: 'chart', title: 'Nothing to chart yet', text: emptyText }));
    return { node: card, destroy() {} };
  }

  /* --- Legend (two or more series only) -------------------------------- */

  const theme = chartTheme();
  // Slots are assigned in fixed order. A caller-supplied colour may be a design
  // token, which has to become a real colour before Chart.js paints it.
  const resolved = series.map((entry, index) => ({
    ...entry,
    color: entry.color
      ? resolveColor(entry.color, theme)
      : theme.series[index % theme.series.length],
  }));

  if (resolved.length >= 2) {
    card.append(
      el('ul.chart-legend', {}, resolved.map((entry) =>
        el('li.chart-legend__item', {}, [
          el('span.chart-legend__swatch', {
            style: { background: entry.color },
            'aria-hidden': 'true',
          }),
          // The label wears text ink, never the series colour — the swatch
          // beside it carries the identity.
          el('span.chart-legend__label', { text: entry.label }),
        ])
      ))
    );
  }

  /* --- Plot ------------------------------------------------------------ */

  const canvas = el('canvas', {
    role: 'img',
    'aria-label': `${title}. ${resolved.map((s) => s.label).join(', ')}. The same figures are available in the table view.`,
  });

  const plot = el('div.chart-card__plot', {
    // Height covers the plot plus the x-axis band, so axis labels are never
    // cropped into a nested scrollbar.
    style: { height: `${height + 28}px` },
  }, [canvas]);

  const table = buildTable(resolved, { formatValue, formatLabel, valueHeader });
  table.hidden = true;

  card.append(plot, table);

  tableToggle.addEventListener('click', () => {
    const showing = table.hidden;
    table.hidden = !showing;
    plot.hidden = showing;
    tableToggle.setAttribute('aria-pressed', showing ? 'true' : 'false');
  });

  /* --- Build the chart ------------------------------------------------- */

  loadChart()
    .then((Chart) => {
      if (!canvas.isConnected) return;   // route changed while loading
      applyChartDefaults(Chart, theme);
      chart = new Chart(canvas, buildConfig({
        Chart, type, series: resolved, yBounds, formatValue, formatLabel, reference, theme,
      }));
    })
    .catch((error) => {
      console.error('[chart-card] could not render:', error);
      // Degrade to the table rather than leaving an empty box: the numbers are
      // the point, the plot is the presentation.
      plot.replaceChildren(
        el('p.t-caption.t-faint.t-center', {
          text: 'Chart could not load — showing the numbers instead.',
          style: { padding: 'var(--s-4)' },
        })
      );
      table.hidden = false;
      plot.hidden = true;
    });

  return {
    node: card,
    destroy() {
      if (chart) { chart.destroy(); chart = null; }
    },
  };
}

/* --- Pieces ------------------------------------------------------------- */

function headlineBlock({ value, unit = '', delta = null, deltaSuffix = '', invertDelta = false }) {
  let direction = deltaDirection(delta);
  if (invertDelta && direction !== 'flat') direction = direction === 'up' ? 'down' : 'up';

  return el('div.chart-card__headline', {}, [
    // Proportional figures, not tabular: tabular-nums makes a large standalone
    // number look loose. Tabular is for columns that must align.
    el('span.chart-card__value', { text: String(value) }),
    unit ? el('span.chart-card__unit', { text: unit }) : null,
    delta !== null && delta !== undefined && !Number.isNaN(Number(delta))
      ? el(`span.chart-card__delta.stat__delta--${direction}`, {
          text: `${formatDelta(delta, 2)}${deltaSuffix ? ` ${deltaSuffix}` : ''}`,
        })
      : null,
  ].filter(Boolean));
}

/**
 * The table twin. A real `<table>` with proper headers, so it is navigable and
 * announced correctly rather than being a grid of divs.
 */
function buildTable(series, { formatValue, formatLabel, valueHeader }) {
  // Union of every series' dates, newest first — most recent is what gets read.
  const dates = [...new Set(series.flatMap((entry) => entry.points.map((p) => p.date)))]
    .sort((a, b) => b.localeCompare(a));

  const lookup = series.map((entry) => new Map(entry.points.map((p) => [p.date, p.value])));

  return el('div.chart-table', {}, [
    el('table', {}, [
      el('caption.sr-only', { text: `${valueHeader} by date` }),
      el('thead', {}, [
        el('tr', {}, [
          el('th', { scope: 'col', text: 'Date' }),
          ...series.map((entry) => el('th', { scope: 'col', text: entry.label })),
        ]),
      ]),
      el('tbody', {}, dates.slice(0, 120).map((date) =>
        el('tr', {}, [
          el('th', { scope: 'row', text: formatLabel(date) }),
          ...lookup.map((map) =>
            el('td.tnum', {
              text: map.has(date) ? formatValue(map.get(date)) : '—',
            })
          ),
        ])
      )),
    ]),
    dates.length > 120
      ? el('p.t-caption.t-faint', {
          text: `Showing the most recent 120 of ${dates.length} rows.`,
          style: { marginTop: 'var(--s-2)' },
        })
      : null,
  ].filter(Boolean));
}

function buildConfig({ type, series, yBounds, formatValue, formatLabel, reference, theme }) {
  // A shared, sorted label axis so multiple series line up.
  const labels = [...new Set(series.flatMap((entry) => entry.points.map((p) => p.date)))].sort();

  const datasets = series.map((entry) => {
    const lookup = new Map(entry.points.map((p) => [p.date, p.value]));
    const data = labels.map((date) => (lookup.has(date) ? lookup.get(date) : null));

    if (type === 'bar') {
      return {
        label: entry.label,
        data,
        backgroundColor: entry.color,
        // A 2px gap in the surface colour separates adjacent bars without
        // drawing a border around them.
        borderColor: theme.surface,
        borderWidth: { top: 0, right: 1, bottom: 0, left: 1 },
        borderRadius: 4,
        borderSkipped: 'bottom',
        maxBarThickness: 34,
      };
    }

    return {
      label: entry.label,
      data,
      borderColor: entry.color,
      backgroundColor: entry.color,
      borderWidth: entry.dashed ? 1.5 : 2,
      borderDash: entry.dashed ? [4, 4] : undefined,
      pointRadius: entry.showPoints ? 2.5 : 0,
      pointHoverRadius: 5,
      pointBackgroundColor: entry.color,
      spanGaps: true,
      tension: 0.25,
      fill: false,
    };
  });

  const scales = {
    x: {
      grid: { display: false },
      border: { display: true, color: theme.axis },
      ticks: {
        color: theme.inkMuted,
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 6,
        callback(index) {
          return formatLabel(labels[index] ?? '');
        },
      },
    },
    y: {
      grid: { color: theme.grid, drawTicks: false },
      border: { display: false },
      ticks: {
        color: theme.inkMuted,
        maxTicksLimit: 5,
        callback: (value) => formatValue(value),
      },
      // Bars encode magnitude by length, so they must start at zero. Lines in
      // a narrow band (body weight, 1RM) must not — a forced zero flattens a
      // real move into a straight line.
      beginAtZero: type === 'bar' || yBounds === 'zero',
      ...(yBounds && yBounds !== 'zero' ? { min: yBounds.min, max: yBounds.max } : {}),
    },
  };

  return {
    type,
    data: { labels, datasets },
    options: {
      layout: { padding: { top: 8, right: 4, bottom: 0, left: 0 } },
      // A crosshair-style read: hovering anywhere in a column reports every
      // series at that date, without needing to hit a 2px point.
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      scales,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => formatLabel(labels[items[0].dataIndex] ?? ''),
            label: (item) => `${item.dataset.label}: ${formatValue(item.parsed.y)}`,
          },
        },
      },
    },
    plugins: reference ? [referenceLinePlugin(reference.value, reference.label, theme)] : [],
  };
}
