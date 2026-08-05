/**
 * chart-loader.js — Lazy loader for the vendored Chart.js.
 *
 * Two decisions worth stating:
 *
 * 1. **Vendored, not from a CDN.** A CDN script would break the app offline —
 *    which is the one condition it is guaranteed to run in, in a basement gym.
 *    `assets/vendor/chart.umd.js` is committed and precached by the service
 *    worker. Version and licence are recorded alongside it.
 *
 * 2. **Loaded on first use, not at boot.** It is ~208 KB, and Home, Workout
 *    and Settings never draw a chart. Injecting it when the Progress page
 *    mounts keeps every other route's first paint unaffected.
 *
 * The UMD build is used rather than the ESM one because it is self-contained;
 * the ESM build expects a bundler to resolve its dependencies, and this project
 * deliberately has no build step.
 */

const SRC = new URL('../../assets/vendor/chart.umd.js', import.meta.url);

let loading = null;

/**
 * Resolve to the `Chart` constructor, loading it on first call.
 * @returns {Promise<any>}
 */
export function loadChart() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC.href;
    script.async = true;

    script.onload = () => {
      if (window.Chart) resolve(window.Chart);
      else reject(new Error('Chart.js loaded but did not register.'));
    };

    script.onerror = () => {
      // Reset so a later visit can retry — a failed load on a flaky first
      // visit should not permanently disable the charts.
      loading = null;
      reject(new Error('Could not load the charting library.'));
    };

    document.head.appendChild(script);
  });

  return loading;
}

export function isChartReady() {
  return Boolean(window.Chart);
}
