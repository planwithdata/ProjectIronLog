/**
 * photo-store.js — Binary storage for progress photos.
 *
 * Why this is the one thing that does NOT go in Local Storage
 * ----------------------------------------------------------
 * Local Storage holds ~5 MB per origin, stores strings only, and is
 * synchronous. A progress photo base64-encoded into it costs ~33% more than
 * the file itself, and the program calls for five angles every two weeks —
 * 130 photos a year. That fills the quota within about two months and, worse,
 * a quota error on a photo write can take the *whole* database write with it.
 *
 * So photos live in IndexedDB, which stores Blobs natively, is asynchronous,
 * and gets a much larger quota. The metadata (date, category, dimensions)
 * stays in the normal Local Storage collection, so the rest of the app,
 * including backup and restore, keeps working exactly as before — a photo
 * record is just a pointer.
 *
 * The trade this makes explicit: **a JSON backup does not contain the image
 * data.** Photos are exported separately as files. Bundling 40 MB of base64
 * into the backup would make the one thing that must always work — exporting
 * your training history — slow and fragile.
 */

const DB_NAME = 'ironlog-photos';
const DB_VERSION = 1;
const STORE = 'photos';

let dbPromise = null;

/** Open (and if needed create) the database. */
function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser cannot store photos.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);   // keyed by the photo record's id
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;   // let a later call retry
      reject(request.error ?? new Error('Could not open the photo store.'));
    };
  });

  return dbPromise;
}

function transact(mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = work(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Photo write aborted — storage may be full.'));
  }));
}

/** Store a Blob under `id`. */
export function putBlob(id, blob) {
  return transact('readwrite', (store) => store.put(blob, id));
}

/** Retrieve a Blob, or null. */
export async function getBlob(id) {
  const result = await transact('readonly', (store) => store.get(id));
  return result ?? null;
}

export function deleteBlob(id) {
  return transact('readwrite', (store) => store.delete(id));
}

export function clearAll() {
  return transact('readwrite', (store) => store.clear());
}

/**
 * An object URL for a stored photo. The caller **must** revoke it when the
 * image is removed from the DOM, or the blob stays pinned in memory — with
 * full-size photos that adds up fast on a phone.
 */
export async function getObjectUrl(id) {
  const blob = await getBlob(id);
  return blob ? URL.createObjectURL(blob) : null;
}

/**
 * Downscale and re-encode an image file before storing it.
 *
 * A modern phone camera produces 4000px, 4–8 MB files. For side-by-side
 * comparison on a 400pt screen, 1280px is already generous, and JPEG at 0.72
 * lands most photos between 100 and 250 KB. Doing this at import time rather
 * than at display time means the storage cost is paid once and stays bounded.
 *
 * @param {File|Blob} file
 * @param {object} [options]
 * @returns {Promise<{blob: Blob, width: number, height: number, bytes: number}>}
 */
export async function prepareImage(file, { maxEdge = 1280, quality = 0.72 } = {}) {
  if (!file.type?.startsWith('image/')) {
    throw new Error('That file is not an image.');
  }

  const bitmap = await decode(file);

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Could not process that image.'))),
      'image/jpeg',
      quality
    );
  });

  return { blob, width, height, bytes: blob.size };
}

/**
 * Decode a file to something drawable.
 * `createImageBitmap` handles EXIF orientation and decodes off the main
 * thread; the <img> path is the fallback for older WebKit.
 */
async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to the <img> path.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not read that image.'));
      image.src = url;
    });
    return image;
  } finally {
    // The bitmap has been drawn by the time this runs in the happy path.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Best-effort estimate of how much space the origin is using overall. */
export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/**
 * Ask the browser to make this origin's storage persistent, so it is not
 * evicted under pressure. Safari grants this based on its own heuristics
 * (an installed PWA usually qualifies); a refusal is not an error.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
