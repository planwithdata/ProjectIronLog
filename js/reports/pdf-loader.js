/**
 * pdf-loader.js — Lazy loader for the vendored jsPDF.
 *
 * Same reasoning as chart-loader.js: vendored so the app can generate a report
 * with no signal, and loaded on demand because it is ~366 KB that only one
 * button needs.
 */

const SRC = new URL('../../assets/vendor/jspdf.umd.min.js', import.meta.url);

let loading = null;

/**
 * Resolve to the jsPDF namespace (`{ jsPDF }`).
 * @returns {Promise<{jsPDF: any}>}
 */
export function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC.href;
    script.async = true;

    script.onload = () => {
      if (window.jspdf?.jsPDF) resolve(window.jspdf);
      else reject(new Error('jsPDF loaded but did not register.'));
    };

    script.onerror = () => {
      loading = null;   // allow a retry on a later attempt
      reject(new Error('Could not load the PDF library.'));
    };

    document.head.appendChild(script);
  });

  return loading;
}
