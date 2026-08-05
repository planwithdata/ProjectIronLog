/**
 * app.js — Application bootstrap.
 *
 * Boot order matters and is enforced here:
 *   1. Theme, from raw storage — before anything paints, so there is no
 *      light-to-dark flash on a cold start.
 *   2. db.init()  — hydrates the cache; every service read depends on it.
 *   3. program load — fetches workouts.json; the app cannot run without it.
 *   4. Shell, routes, router.
 *   5. Service worker — registered last, because a failure there must never
 *      stop the app from starting.
 */

import { el, icon, $ } from './core/dom.js';
import * as router from './core/router.js';
import { EVENTS, on } from './core/events.js';
import * as db from './services/db.js';
import * as settingsService from './services/settings-service.js';
import * as programService from './services/program-service.js';
import { nav } from '../components/nav.js';
import { mountToastHost } from '../components/toast.js';
import { APP_VERSION } from './config.js';

import { page as homePage } from './pages/home.js';
import { page as workoutPage } from './pages/workout.js';
import { page as historyPage } from './pages/history.js';
import { page as progressPage } from './pages/progress.js';
import { page as reportsPage } from './pages/reports.js';
import { page as settingsPage } from './pages/settings.js';

const PAGES = [homePage, workoutPage, historyPage, progressPage, reportsPage, settingsPage];

async function boot() {
  const root = $('#root');

  try {
    await db.init();
    settingsService.applyTheme();
    settingsService.watchSystemTheme();

    await programService.load();

    root.replaceChildren(buildShell());
    mountToastHost();

    for (const page of PAGES) router.route(page);
    router.fallback(() => notFoundPage());

    const outlet = $('#outlet');
    wireHeader(outlet);
    router.start(outlet);

    // Re-render the current page whenever persisted data changes, so a write
    // made from one page is reflected on another without manual plumbing.
    on(EVENTS.DATA_RESTORED, () => router.refresh());
    on(EVENTS.DATA_RESET, () => router.refresh());

    document.documentElement.dataset.booted = 'true';
    registerServiceWorker();
  } catch (error) {
    console.error('[app] boot failed:', error);
    root.replaceChildren(bootErrorPage(error));
  }
}

/* --- Shell -------------------------------------------------------------- */

function buildShell() {
  const header = el('header.app-header', {}, [
    el('div.app-header__inner', {}, [
      el('h1.app-header__title', { id: 'page-title', text: 'IronLog' }),
      el('div.app-header__actions', {}, [
        el('a.btn-icon', {
          href: '#/settings',
          'aria-label': 'Settings',
        }, [icon('settings')]),
      ]),
    ]),
  ]);

  const main = el('main.app-main', { id: 'outlet', tabindex: '-1' });

  // On wide screens the sidebar sits beside a header+main column, so those
  // two are wrapped together. Below 1024px the wrapper is `display: contents`
  // (see layout.css) so it adds nothing to the phone layout.
  const shell = el('div.app-shell', {}, [header, main]);

  return el('div.app', {}, [
    el('a.skip-link', { href: '#outlet', text: 'Skip to content' }),
    shell,
    nav(),
  ]);
}

/**
 * Keep the header title in step with the route, and toggle its hairline once
 * content has scrolled underneath it.
 */
function wireHeader(outlet) {
  const header = $('.app-header');
  const title = $('#page-title');

  on(EVENTS.ROUTE_CHANGED, ({ name }) => {
    const page = PAGES.find((candidate) => candidate.name === name);
    title.textContent = page?.title ?? 'IronLog';
    header.dataset.scrolled = 'false';
  });

  // rAF-throttled: scroll fires far more often than a paint can use.
  let queued = false;
  outlet.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      header.dataset.scrolled = outlet.scrollTop > 4 ? 'true' : 'false';
      queued = false;
    });
  }, { passive: true });
}

/* --- Failure states ----------------------------------------------------- */

function notFoundPage() {
  return el('div.page.enter', {}, [
    el('div.card', {}, [
      el('div.card__title', { text: 'Page not found' }),
      el('p.t-subhead.t-dim', { text: 'That link does not point anywhere in IronLog.', style: { marginTop: '8px' } }),
      el('a.btn.btn--tinted', { href: '#/home', text: 'Go home', style: { marginTop: 'var(--s-4)' } }),
    ]),
  ]);
}

/**
 * Shown when boot itself fails — a missing or malformed workouts.json, or
 * storage throwing. States what broke, and makes clear that logged data has
 * not been touched.
 */
function bootErrorPage(error) {
  return el('div.page', { style: { paddingTop: 'var(--s-12)' } }, [
    el('div.card', {}, [
      el('div.card__title', { text: 'IronLog could not start' }),
      el('p.t-subhead.t-dim', {
        text: String(error?.message || error),
        style: { marginTop: 'var(--s-2)' },
      }),
      el('p.t-caption.t-faint', {
        text: 'Your saved data has not been changed. Reload to try again — if this keeps happening, check that /data/workouts.json is present and valid JSON.',
        style: { marginTop: 'var(--s-3)' },
      }),
      el('button.btn.btn--tinted', {
        type: 'button',
        text: 'Reload',
        style: { marginTop: 'var(--s-4)' },
        on: { click: () => window.location.reload() },
      }),
    ]),
  ]);
}

/* --- Service worker ----------------------------------------------------- */

/**
 * Registered with a relative path so the app works from a GitHub Pages
 * subdirectory (`/ProjectIronLog/`) as well as from a domain root. An
 * absolute `/service-worker.js` would 404 on Pages.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;   // no SW without http(s)

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./service-worker.js')
      .then((registration) => {
        console.info(`[app] IronLog ${APP_VERSION} ready (offline capable).`);
        registration.addEventListener('updatefound', () => {
          console.info('[app] a new version is downloading.');
        });
      })
      .catch((error) => {
        // Offline support is an enhancement; losing it must not break the app.
        console.warn('[app] service worker registration failed:', error);
      });
  });
}

boot();
