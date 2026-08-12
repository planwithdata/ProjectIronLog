/**
 * dom.js — Minimal DOM construction helpers.
 *
 * Why not template strings + innerHTML everywhere?
 * ------------------------------------------------
 * Because user-entered text (coach notes, exercise notes) would then need
 * hand-escaping at every call site, and one missed spot is an injection bug
 * in an app that will run for years. `el()` sets text via `textContent`, so
 * escaping is structural rather than remembered.
 *
 * `html()` exists for the small number of places where we genuinely need
 * markup (inline SVG icons we author ourselves). It never takes user input.
 */

/**
 * Create an element.
 *
 * @param {string} tag              Tag name, optionally with `.class` and `#id`
 *                                  shorthand: `el('button.btn.btn--primary')`.
 * @param {object} [props]          Attributes and properties. Special keys:
 *                                  `class`, `text`, `html`, `dataset`, `style`,
 *                                  `on` (event map), plus `aria-*`/`data-*`.
 * @param {Array|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const { name, classes, id } = parseTag(tag);
  const node = document.createElement(name);

  if (classes.length) node.classList.add(...classes);
  if (id) node.id = id;

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      node.classList.add(...String(value).split(/\s+/).filter(Boolean));
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'on' && typeof value === 'object') {
      for (const [type, handler] of Object.entries(value)) {
        node.addEventListener(type, handler);
      }
    } else if (key in node && !key.startsWith('aria-') && !key.startsWith('data-')) {
      // Prefer the property (value, disabled, checked) over the attribute so
      // that form state behaves as expected.
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(node, children);
  return node;
}

/**
 * Split an emmet-style tag string into its parts.
 * `'button.btn.btn--primary#save'` -> `{ name: 'button', classes: ['btn', 'btn--primary'], id: 'save' }`
 *
 * Class names in this codebase contain `--` and `__`, which is why the split
 * is on the `.`/`#` delimiters rather than a character class.
 */
function parseTag(tag) {
  const source = String(tag).trim();
  const match = source.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][^.#]+)*)$/);

  if (!match) {
    throw new Error(`[dom] cannot parse tag "${tag}"`);
  }

  const name = match[1] || 'div';
  const classes = [];
  let id = null;

  for (const token of (match[2] || '').match(/[.#][^.#]+/g) ?? []) {
    if (token[0] === '.') classes.push(token.slice(1));
    else id = token.slice(1);
  }

  return { name, classes, id };
}

/** Append a child, array of children, string, or nested arrays. */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

/** Replace all children of `parent` with `children`. */
export function replace(parent, children) {
  parent.replaceChildren();
  return append(parent, children);
}

/**
 * Build a node from a trusted markup string.
 * Only ever called with markup this codebase authors — never user data.
 */
export function html(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild;
}

/** Escape a string for safe interpolation into a trusted markup template. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export const $  = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/* --- Icons -------------------------------------------------------------
   Inline stroked SVG paths, drawn on a 24x24 grid to match the token sizes.
   Inline (rather than a sprite file or an icon font) so icons paint with the
   first frame and work offline with no extra cache entry. */

const ICON_PATHS = {
  home:      'M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  dumbbell:  'M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11',
  chart:     'M4 20V10M10 20V4M16 20v-7M22 20H2',
  document:  'M14 3v5h5M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM9 13h6M9 17h6',
  settings:  'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2v.17a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 2.83 14H2.6a2 2 0 1 1 0-4h.17A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10.2 2.8V2.6a2 2 0 1 1 4 0v.17a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03h.17a2 2 0 1 1 0 4h-.17a1.7 1.7 0 0 0-1.55 1.03z',
  play:      'M7 4.5 19 12 7 19.5z',
  chevron:   'm9 6 6 6-6 6',
  scale:     'M12 3v3M7 6h10M5.5 6 3 14h7zM18.5 6 16 14h7zM3 14a3.5 3.5 0 0 0 7 0M16 14a3.5 3.5 0 0 0 7 0M9 21h6',
  flame:     'M12 21c3.9 0 6.5-2.5 6.5-6 0-4.5-4-6-4.5-11-2 1.5-3 4-3 6 0 1.5-1 2-1.5 2-1 0-2-1-2-2.5C6 12 5.5 13 5.5 15c0 3.5 2.6 6 6.5 6z',
  trophy:    'M8 3h8v5a4 4 0 0 1-8 0zM8 5H5.5A2.5 2.5 0 0 0 8 9.5M16 5h2.5A2.5 2.5 0 0 1 16 9.5M12 12v4M8.5 21h7M10 16h4l.5 5h-5z',
  calendar:  'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  note:      'M8 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 8v9M10 9h7M10 13h7M10 17h4',
  timer:     'M12 8v5l3 2M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM9 2h6',
  moon:      'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z',
  check:     'm5 13 4.5 4.5L19 7',
  plus:      'M12 5v14M5 12h14',
  download:  'M12 3v12M7.5 10.5 12 15l4.5-4.5M4 20h16',
  upload:    'M12 15V3M7.5 7.5 12 3l4.5 4.5M4 20h16',
  bed:       'M3 19v-7h13a4 4 0 0 1 4 4v3M3 12V7M3 19h18M7 9.5h3.5',
  ruler:     'M3 8h18a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM7 8v3M11 8v4M15 8v3M19 8v4',
  camera:    'M4 8h2.5l1.5-2h8l1.5 2H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  info:      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  close:     'M18 6 6 18M6 6l12 12',
  heart:     'M12 20s-7-4.4-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5c0 5.1-7 9.5-7 9.5z',
};

/**
 * Build an inline SVG icon.
 * @param {keyof ICON_PATHS} name
 * @param {object} [opts]  `className`, `size`, `filled`
 */
export function icon(name, opts = {}) {
  const path = ICON_PATHS[name];
  if (!path) {
    console.warn(`[dom] unknown icon "${name}"`);
    return html('<svg viewBox="0 0 24 24" aria-hidden="true"></svg>');
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (opts.className) svg.setAttribute('class', opts.className);
  if (opts.size) { svg.setAttribute('width', opts.size); svg.setAttribute('height', opts.size); }

  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  if (opts.filled) { p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none'); }
  svg.appendChild(p);
  return svg;
}

export const iconNames = Object.keys(ICON_PATHS);
