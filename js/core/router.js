/**
 * router.js — Hash-based client-side router.
 *
 * Why the hash and not the History API?
 * -------------------------------------
 * The app is hosted on GitHub Pages, which serves static files only and
 * cannot rewrite `/progress` back to `index.html`. With the History API a
 * hard refresh or a shared deep link would 404. Hash routes (`#/progress`)
 * are handled entirely in the browser, so every URL works on a cold load
 * from any host and from the installed Home Screen shortcut.
 *
 * Routes are registered as `{ name, title, render, mount }`, or as
 * `{ name, title, load }` where `load` is a function returning a dynamic
 * `import()` of the page module.
 *
 *   render(params) -> Node            builds the page content
 *   mount(node, params) -> cleanup?   optional; runs after insertion, may
 *                                     return a teardown function
 *   load() -> Promise<{ page }>       lazy alternative to render/mount
 *
 * Why lazy pages
 * --------------
 * Importing all nine page modules from app.js meant Home paid for the chart
 * card, the PDF builder and the photo store before drawing a single pixel —
 * 442 KB of JavaScript for a screen that needs about a third of it. Native
 * `import()` fixes that with no build step: a route's code arrives the first
 * time it is visited and is cached from then on.
 *
 * `title` stays eager, because the header and the tab bar need to label a
 * route without loading it.
 */

import { EVENTS, emit } from './events.js';

const routes = new Map();
let outlet = null;
let notFound = null;
let current = null;      // { name, params }
let cleanup = null;      // teardown from the active route's mount()

/**
 * Guards against a slow module resolving after the user has moved on: each
 * resolve() takes a ticket, and a stale one discards its own result.
 */
let navigationToken = 0;

/** Register a route, eagerly or lazily. */
export function route({ name, title, render, mount, load }) {
  if (!render && !load) {
    throw new Error(`[router] route "${name}" needs either render() or load()`);
  }
  routes.set(name, { name, title, render, mount, load, module: null });
}

/**
 * Resolve a route's page module, loading it on first use.
 * A failed import is not cached, so a flaky first fetch can be retried.
 */
async function pageFor(target) {
  if (target.render) return target;          // eagerly registered
  if (target.module) return target.module;

  const imported = await target.load();
  const page = imported.page ?? imported.default ?? imported;
  target.module = page;
  return page;
}

/** Register the fallback used when a hash matches no route. */
export function fallback(handler) {
  notFound = handler;
}

/**
 * Parse `#/workout/tuesday-chest?set=2` into
 * `{ name: 'workout', params: { 0: 'tuesday-chest', set: '2' } }`.
 */
function parseHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const name = segments.shift() || 'home';

  const params = {};
  segments.forEach((segment, index) => {
    params[index] = decodeURIComponent(segment);
  });

  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) {
      params[key] = value;
    }
  }

  return { name, params };
}

/** Navigate. Setting the hash triggers `hashchange`, which renders. */
export function go(name, params = {}) {
  const query = new URLSearchParams(params).toString();
  const next = `#/${name}${query ? `?${query}` : ''}`;
  if (window.location.hash === next) resolve();   // same route: force a re-render
  else window.location.hash = next;
}

export function currentRoute() {
  return current;
}

/** Render whatever the current hash points at. */
async function resolve() {
  const token = ++navigationToken;
  const { name, params } = parseHash(window.location.hash);
  const target = routes.get(name);

  // Tear down the outgoing page before the new one mounts, so timers and
  // listeners from the previous route never outlive it.
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (error) { console.error('[router] cleanup failed:', error); }
    cleanup = null;
  }

  if (!target) {
    const node = notFound ? notFound(name) : document.createTextNode('');
    outlet.replaceChildren(node);
    current = { name, params };
    emit(EVENTS.ROUTE_CHANGED, current);
    return;
  }

  // Announce the route before awaiting the module, so the header and tab bar
  // update immediately rather than lagging a network fetch.
  if (target.title) document.title = `${target.title} · IronLog`;
  current = { name, params };
  emit(EVENTS.ROUTE_CHANGED, current);

  let page;
  try {
    page = await pageFor(target);
  } catch (error) {
    console.error(`[router] "${name}" failed to load:`, error);
    if (token === navigationToken) outlet.replaceChildren(loadErrorPage(name, error));
    return;
  }

  // The user navigated again while the module was in flight.
  if (token !== navigationToken) return;

  let node;
  try {
    node = page.render(params);
  } catch (error) {
    console.error(`[router] "${name}" failed to render:`, error);
    node = errorPage(error);
  }

  outlet.replaceChildren(node);

  // Each route change starts at the top; the scroll container is .app-main.
  outlet.scrollTop = 0;

  if (typeof page.mount === 'function') {
    try {
      cleanup = page.mount(node, params) || null;
    } catch (error) {
      console.error(`[router] "${name}" failed to mount:`, error);
    }
  }
}

/** Re-render the current route in place, keeping its params. */
export function refresh() {
  if (current) resolve();
}

/**
 * Shown when a page module could not be fetched — offline on a route that has
 * never been visited, so the service worker has nothing cached for it.
 */
function loadErrorPage(name, error) {
  const wrap = document.createElement('div');
  wrap.className = 'page';
  wrap.innerHTML = `
    <div class="card">
      <div class="card__title">Could not open this page</div>
      <p class="t-subhead t-dim" style="margin-top:8px">
        The code for this screen could not be fetched. If you are offline, it
        should work once you have opened it online at least once.
      </p>
      <p class="t-caption t-faint" style="margin-top:12px">Nothing you have logged is affected.</p>
      <a class="btn btn--tinted" href="#/home" style="margin-top:16px">Go home</a>
    </div>`;
  console.warn(`[router] could not load "${name}":`, error);
  return wrap;
}

function errorPage(error) {
  const wrap = document.createElement('div');
  wrap.className = 'page';
  wrap.innerHTML = `
    <div class="card">
      <div class="card__title">Something went wrong</div>
      <p class="t-subhead t-dim" style="margin-top:8px">
        This page failed to load. Your saved data is untouched.
      </p>
      <pre class="t-caption t-faint" style="margin-top:12px;white-space:pre-wrap"></pre>
    </div>`;
  // Message set via textContent — an error string can contain anything.
  wrap.querySelector('pre').textContent = String(error?.message || error);
  return wrap;
}

/** Start the router against a container element. */
export function start(outletElement) {
  outlet = outletElement;
  window.addEventListener('hashchange', resolve);
  if (!window.location.hash) window.location.replace('#/home');
  else resolve();
}
