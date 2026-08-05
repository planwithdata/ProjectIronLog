/**
 * photo-embed.js — Turns stored photo blobs into data URLs for the PDF.
 *
 * jsPDF's `addImage` needs a data URL or raw bytes and cannot await, so every
 * photo has to be read and re-encoded *before* the document is drawn. That is
 * the only reason this exists as a separate step.
 *
 * Photos are also re-scaled down again here. They are stored at 1280px for
 * on-screen comparison, but a PDF prints them about 60mm wide — 640px is
 * already more than 300dpi at that size, and it keeps a twelve-photo report
 * from becoming a 20 MB file.
 */

import { photos } from '../services/logs-service.js';
import { getBlob } from '../services/photo-store.js';

const PDF_MAX_EDGE = 640;
const PDF_QUALITY = 0.7;

/**
 * Data URLs for every photo taken on the given dates.
 *
 * @param {string[]} dates
 * @returns {Promise<Array<{dataUrl: string, width: number, height: number, label: string, date: string}>>}
 */
export async function photoDataUrls(dates) {
  const wanted = [];

  for (const date of dates) {
    for (const photo of photos.onDate(date)) {
      wanted.push(photo);
    }
  }

  const results = await Promise.all(wanted.map(async (photo) => {
    try {
      const blob = await getBlob(photo.id);
      if (!blob) return null;
      const encoded = await downscaleToDataUrl(blob);
      return {
        ...encoded,
        label: photos.CATEGORIES.find((c) => c.key === photo.category)?.label ?? photo.category,
        date: photo.date,
      };
    } catch (error) {
      // One unreadable photo must not sink the whole report.
      console.warn('[photo-embed] skipping a photo:', error);
      return null;
    }
  }));

  return results.filter(Boolean);
}

async function downscaleToDataUrl(blob) {
  const bitmap = await createBitmap(blob);

  const scale = Math.min(1, PDF_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  // Photos are drawn onto white: a JPEG has no alpha, and an unpainted canvas
  // would encode as black behind any transparency.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  return { dataUrl: canvas.toDataURL('image/jpeg', PDF_QUALITY), width, height };
}

async function createBitmap(blob) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through */
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not decode a stored photo.'));
      image.src = url;
    });
    return image;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
