/**
 * tools/check-imports.mjs — Does every import actually exist?
 *
 *     node tools/check-imports.mjs
 *
 * The app has no build step, which is most of why it is pleasant to work on:
 * the files in the repo are the files the browser runs. The cost is that a
 * renamed export fails at runtime, in the browser, on whichever route happens
 * to touch it — and a page that is only reached after a workout is started can
 * stay broken for a week.
 *
 * So this walks every `.js` file, parses its static imports and exports by
 * regex, and asserts that each named import resolves to a real export in the
 * file it names. It is not a type checker and does not pretend to be; it
 * catches the one class of mistake that a no-build ES-module app is uniquely
 * exposed to, and it runs in under a second.
 *
 * Regex rather than a parser because there is no dependency to add: this
 * codebase writes one import statement per module in a consistent style, and
 * the patterns below cover all of it. Anything they cannot read is reported as
 * unparsed rather than silently skipped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_DIRS = ['js', 'components'];

/* --- Collect the files -------------------------------------------------- */

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

const files = SEARCH_DIRS.flatMap((dir) => walk(join(ROOT, dir)));

/* --- Parse exports ------------------------------------------------------ */

/** Named exports of one file. */
function exportsOf(source) {
  const names = new Set();

  // export function foo / export const foo / export class foo / export let foo
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  // export { a, b as c }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/\bas\s+([A-Za-z0-9_$]+)$/);
      names.add(asMatch ? asMatch[1] : piece);
    }
  }
  // export default
  if (/^export\s+default\b/m.test(source)) names.add('default');

  return names;
}

/* --- Parse imports ----------------------------------------------------- */

/**
 * Static imports of one file.
 * @returns {Array<{specifier: string, names: string[], namespace: boolean, line: number}>}
 */
function importsOf(source) {
  const out = [];
  const pattern = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm;

  for (const match of source.matchAll(pattern)) {
    const clause = match[1].trim();
    const specifier = match[2];
    const line = source.slice(0, match.index).split('\n').length;

    // import * as ns from '...'
    if (/^\*\s+as\s+/.test(clause)) {
      out.push({ specifier, names: [], locals: [], namespace: true, line });
      continue;
    }

    const braced = clause.match(/\{([\s\S]*)\}/);
    const names = [];
    const locals = [];
    if (braced) {
      for (const part of braced[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        // `a as b` imports `a` from the source module and binds it as `b`.
        // Both matter, and to different checks: resolution needs the exported
        // name, the unused check needs the local one. Conflating them reported
        // every aliased import in the app as dead.
        const [imported, local] = piece.split(/\s+as\s+/).map((token) => token.trim());
        names.push(imported);
        locals.push(local || imported);
      }
    }

    // A default import (`import x from`) is not used anywhere in this codebase,
    // but count it rather than pretend the clause was empty.
    const defaultName = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (defaultName && !braced) { names.push('default'); locals.push(defaultName); }

    out.push({ specifier, names, locals, namespace: false, line });
  }

  return out;
}

/* --- Resolve and check ------------------------------------------------- */

const cache = new Map();

function exportsFor(path) {
  if (!cache.has(path)) {
    cache.set(path, exportsOf(readFileSync(path, 'utf8')));
  }
  return cache.get(path);
}

const problems = [];
let checked = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');

  for (const entry of importsOf(source)) {
    // Only relative imports can be checked; there are no bare specifiers in
    // this app, and a CDN URL is not ours to verify.
    if (!entry.specifier.startsWith('.')) continue;

    const target = resolve(dirname(file), entry.specifier);
    let available;
    try {
      available = exportsFor(target);
    } catch {
      problems.push(`${relative(ROOT, file)}:${entry.line} imports "${entry.specifier}", which does not exist`);
      continue;
    }

    if (entry.namespace) { checked += 1; continue; }

    for (const name of entry.names) {
      checked += 1;
      if (!available.has(name)) {
        problems.push(
          `${relative(ROOT, file)}:${entry.line} imports { ${name} } from "${entry.specifier}", `
          + `which does not export it`
        );
      }
    }
  }
}

/* --- Unused-import check -----------------------------------------------
   A named import whose local binding never appears outside the import block
   is a refactor leftover. Not an error — it breaks nothing — but it is the
   cheapest possible signal that a rename was only half finished.

   This check has to be *conservative*, because acting on a false positive
   deletes working code. It already did once: an earlier version matched with
   `\b<name>\b`, and `\b` is defined against word characters, so `\b$\b`
   can never match the identifier `$`. It reported `$` as unused in `app.js`,
   the import was removed, and the whole app failed to boot with a
   ReferenceError on the first line of `boot()`.

   So the boundary is asserted explicitly: the character on either side of a
   match must not be one that could continue a JavaScript identifier. That
   handles `$` and `_` correctly, where `\b` does not.
   ====================================================================== */

/** Characters that can appear in a JS identifier, for boundary checks. */
const IDENT = /[A-Za-z0-9_$]/;

/** Does `name` appear in `body` as a standalone identifier? */
function isUsed(body, name) {
  let from = 0;
  for (;;) {
    const at = body.indexOf(name, from);
    if (at === -1) return false;
    const before = at > 0 ? body[at - 1] : '';
    const after = body[at + name.length] ?? '';
    if (!IDENT.test(before) && !IDENT.test(after)) return true;
    from = at + 1;
  }
}

const unused = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const body = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '');

  for (const entry of importsOf(source)) {
    if (entry.namespace || !entry.specifier.startsWith('.')) continue;
    for (const name of entry.locals ?? []) {
      if (name === 'default') continue;
      if (!isUsed(body, name)) {
        unused.push(`${relative(ROOT, file)}: { ${name} } is imported but never used`);
      }
    }
  }
}

/* --- Report ------------------------------------------------------------- */

console.log(`checked ${checked} named imports across ${files.length} files`);

if (unused.length) {
  console.log(`\n${unused.length} unused import${unused.length === 1 ? '' : 's'}:`);
  for (const line of unused) console.log(`  ${line}`);
}

if (problems.length) {
  console.error(`\n${problems.length} broken import${problems.length === 1 ? '' : 's'}:`);
  for (const line of problems) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log('\nevery named import resolves.');
}
