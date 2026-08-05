/**
 * pwa-service.js — Install and update handling.
 *
 * Two jobs, both of which are easy to get subtly wrong:
 *
 * **Install.** Chrome fires `beforeinstallprompt` and hands over a prompt that
 * can be shown later. Safari on iOS fires nothing and has no API at all — the
 * only route is Share → Add to Home Screen — so iOS gets written instructions
 * instead. Neither is offered once the app is already running standalone.
 *
 * **Update.** A service worker that has fetched a new version sits in
 * `waiting` until the old one is gone. Reloading the page is *not* enough,
 * because the old worker still controls the client. The new worker has to be
 * told to `skipWaiting()`, and only then does reloading pick up the new build.
 * Getting this wrong is why PWAs are famous for serving stale code for days.
 */

import { EVENTS, emit } from '../core/events.js';
import * as db from './db.js';
import { COLLECTIONS } from './db.js';

/** Emitted when an update has downloaded and is ready to apply. */
export const UPDATE_READY = 'pwa:update-ready';
/** Emitted when the browser offers a native install prompt. */
export const INSTALL_AVAILABLE = 'pwa:install-available';

let deferredPrompt = null;
let waitingWorker = null;

/* --- Environment -------------------------------------------------------- */

/** Already installed and running without browser chrome. */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    // Safari's own non-standard flag, which is what iOS actually sets.
    || window.navigator.standalone === true;
}

export function isIos() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    // iPadOS 13+ reports as a Mac; the touch-point count gives it away.
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Whether an install path exists worth surfacing to the user. */
export function canOfferInstall() {
  if (isStandalone()) return false;
  return Boolean(deferredPrompt) || isIos();
}

export function hasNativePrompt() {
  return Boolean(deferredPrompt);
}

/* --- Install ------------------------------------------------------------ */

/**
 * Show the browser's install prompt.
 * @returns {Promise<'accepted'|'dismissed'|'unavailable'>}
 */
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';

  const prompt = deferredPrompt;
  // Single-use: the browser will not let the same event be prompted twice.
  deferredPrompt = null;

  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}

/** Record that the user has been asked, so the nudge is not shown every visit. */
export async function markInstallDismissed() {
  await db.update(COLLECTIONS.SETTINGS, (settings) => ({
    ...settings,
    installPromptDismissedAt: new Date().toISOString(),
  }));
}

/**
 * Whether to nudge about installing. Suppressed once dismissed, and for a
 * fortnight afterwards — an install banner on every launch is an advert.
 */
export function shouldNudgeInstall() {
  if (!canOfferInstall()) return false;
  const dismissedAt = db.read(COLLECTIONS.SETTINGS).installPromptDismissedAt;
  if (!dismissedAt) return true;
  const days = (Date.now() - new Date(dismissedAt).getTime()) / 86400000;
  return days > 14;
}

/* --- Update ------------------------------------------------------------- */

/**
 * Apply a waiting update.
 *
 * The reload is triggered by `controllerchange` rather than immediately: the
 * new worker needs to take control first, otherwise the reload is served by
 * the old one and nothing appears to change.
 */
export function applyUpdate() {
  if (!waitingWorker) {
    window.location.reload();
    return;
  }

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  waitingWorker.postMessage('SKIP_WAITING');
}

/* --- Registration ------------------------------------------------------- */

/**
 * Register the service worker and wire up install/update detection.
 * Failures are logged, never thrown: offline support is an enhancement, and
 * losing it must not stop the app from running.
 */
export function init() {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the browser's own mini-infobar so the app can choose the moment.
    event.preventDefault();
    deferredPrompt = event;
    emit(INSTALL_AVAILABLE, {});
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit(EVENTS.TOAST, { message: 'IronLog installed', tone: 'success' });
  });

  if (!('serviceWorker' in navigator)) return;
  if (window.location.protocol === 'file:') return;

  navigator.serviceWorker
    .register('./service-worker.js')
    .then((registration) => {
      // A worker already waiting from a previous visit.
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting;
        emit(UPDATE_READY, {});
      }

      registration.addEventListener('updatefound', () => {
        const incoming = registration.installing;
        if (!incoming) return;

        incoming.addEventListener('statechange', () => {
          // `controller` being set means this is an update rather than the
          // very first install — there is no point announcing the latter.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = incoming;
            emit(UPDATE_READY, {});
          }
        });
      });

      // Check once on launch. The browser also checks periodically, but a
      // gym app may be left open on the same tab for days.
      registration.update().catch(() => { /* offline — nothing to check */ });
    })
    .catch((error) => {
      console.warn('[pwa] service worker registration failed:', error);
    });
}

/** Written instructions for iOS, which offers no install API. */
export const IOS_INSTALL_STEPS = [
  'Tap the Share button at the bottom of Safari.',
  'Scroll down and choose "Add to Home Screen".',
  'Tap Add. IronLog then opens like an app, full screen and offline.',
];
