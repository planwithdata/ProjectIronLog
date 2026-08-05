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
 * Routes are registered as `{ name, title, render, mount }`:
 *   render(params) -> Node            builds the page content
 *   mount(node, params) -> cleanup?   optional; runs after insertion, may
 *                                     return a teardown function
 */

import { EVENTS, emit } from './events.js';

const routes = new Map();
let outlet = null;
let notFound = null;
let current = null;      // { name, params }
let cleanup = null;      // teardown from the active route's mount()

/** Register a route. */
export function route({ name, title, render, mount }) {
  routes.set(name, { name, title, render, mount });
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
function resolve() {
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

  let node;
  try {
    node = target.render(params);
  } catch (error) {
    console.error(`[router] "${name}" failed to render:`, error);
    node = errorPage(error);
  }

  outlet.replaceChildren(node);

  // Each route change starts at the top; the scroll container is .app-main.
  outlet.scrollTop = 0;

  if (target.title) document.title = `${target.title} · IronLog`;

  current = { name, params };

  if (typeof target.mount === 'function') {
    try {
      cleanup = target.mount(node, params) || null;
    } catch (error) {
      console.error(`[router] "${name}" failed to mount:`, error);
    }
  }

  emit(EVENTS.ROUTE_CHANGED, current);
}

/** Re-render the current route in place, keeping its params. */
export function refresh() {
  if (current) resolve();
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
