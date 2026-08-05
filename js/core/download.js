/**
 * download.js — Save a generated file to the device.
 *
 * Extracted so the JSON backup, the CSV exports and the PDF report share one
 * implementation. Three copies of this is three places for the iOS revoke bug
 * below to be forgotten.
 */

/**
 * Trigger a download.
 *
 * @param {Blob|string} content   a Blob, or a string to wrap in one
 * @param {string} filename
 * @param {string} [mime]         used when `content` is a string
 */
export function download(content, filename, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  // Must be in the document for the click to register in some browsers.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoking immediately cancels the download on iOS Safari — the fetch for
  // the blob has not started yet when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** A filename-safe timestamp: `2026-08-05`. */
export function dateStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `ironlog-sets-2026-08-05.csv` */
export function stampedName(base, extension) {
  return `ironlog-${base}-${dateStamp()}.${extension}`;
}

/** Human-readable byte count. */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
