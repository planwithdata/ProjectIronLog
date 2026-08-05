"""Static checks for the IronLog source tree.

There is no build step, so this is the substitute for a compiler: it parses
every module with Node and confirms that every relative import and asset URL
actually resolves. Run it before committing.

    python tools/check.py
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

SKIP_DIRS = {'.git', '.pdfimgs', '.pdfpages', 'node_modules', '.claude', 'tools'}

IMPORT_RE = re.compile(r"""(?:from|import)\s+['"](\.[^'"]+)['"]""")
# Lazy route modules: `load: () => import('./pages/home.js')`. Without this
# pattern a typo in a lazy path would only surface at runtime, on the one route
# nobody clicked before shipping.
DYNAMIC_IMPORT_RE = re.compile(r"""import\(\s*['"](\.[^'"]+)['"]\s*\)""")
URL_RE = re.compile(r"""new URL\(\s*['"](\.[^'"]+)['"]""")
HTML_REF_RE = re.compile(r"""(?:href|src)=["'](\./[^"']+)["']""")


def collect_js(root='.'):
    found = []
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            if name.endswith('.js'):
                found.append(os.path.join(base, name))
    return sorted(found)


def check_syntax(files):
    """Parse each file as an ES module via `node --check`."""
    tmp = tempfile.mkdtemp()
    failures = []
    try:
        for index, path in enumerate(files):
            # .mjs so Node parses `import`/`export` without a package.json.
            dst = os.path.join(tmp, f'{index}_{os.path.basename(path)}.mjs')
            shutil.copy(path, dst)
            result = subprocess.run(['node', '--check', dst],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                failures.append((path, result.stderr.strip()[:600]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return failures


def check_imports(files):
    """Confirm every relative import and `new URL(...)` target exists."""
    missing = []
    for path in files:
        source = open(path, encoding='utf-8').read()
        base = os.path.dirname(path)
        matches = (list(IMPORT_RE.finditer(source))
                   + list(DYNAMIC_IMPORT_RE.finditer(source))
                   + list(URL_RE.finditer(source)))
        for match in matches:
            spec = match.group(1)
            target = os.path.normpath(os.path.join(base, spec))
            if not os.path.exists(target):
                missing.append((path, spec, target))
    return missing


def check_html_refs(html_path='index.html'):
    """Confirm every ./ reference in the shell HTML exists on disk."""
    if not os.path.exists(html_path):
        return [(html_path, '(file missing)', '')]
    source = open(html_path, encoding='utf-8').read()
    missing = []
    for match in HTML_REF_RE.finditer(source):
        spec = match.group(1)
        target = os.path.normpath(spec.lstrip('./'))
        if not os.path.exists(target):
            missing.append((html_path, spec, target))
    return missing


def all_real_paths():
    """Every file in the tree, as forward-slash repo-relative paths."""
    found = set()
    for base, dirs, names in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and d != 'tools']
        for name in names:
            joined = os.path.join(base, name)
            found.add(os.path.normpath(joined).replace(os.sep, '/').lstrip('./'))
    return found


def check_case_sensitivity():
    """Catch imports whose case does not match the file on disk.

    Windows and macOS resolve `./Pages/Home.js` to `./pages/home.js` happily.
    GitHub Pages serves from Linux and does not — so a case slip works
    perfectly in development and 404s only in production.
    """
    real = all_real_paths()
    lowered = {path.lower(): path for path in real}
    problems = []

    for path in sorted(real):
        if not path.endswith(('.js', '.mjs', '.html')):
            continue
        try:
            source = open(path, encoding='utf-8', errors='replace').read()
        except OSError:
            continue

        base = os.path.dirname(path)
        specs = [m.group(1) for m in IMPORT_RE.finditer(source)]
        specs += [m.group(1) for m in DYNAMIC_IMPORT_RE.finditer(source)]
        specs += [m.group(1) for m in URL_RE.finditer(source)]
        if path.endswith('.html'):
            specs += [m.group(1) for m in HTML_REF_RE.finditer(source)]

        for spec in specs:
            target = os.path.normpath(os.path.join(base, spec))
            target = target.replace(os.sep, '/').lstrip('./')
            if target in real:
                continue
            actual = lowered.get(target.lower())
            if actual:
                problems.append((path, spec, actual))

    return problems


def check_jekyll_safe():
    """Files GitHub Pages would silently drop.

    Pages runs Jekyll unless a `.nojekyll` file is present at the root, and
    Jekyll excludes anything whose name begins with an underscore. A module at
    `js/pages/_helper.js` therefore 404s in production while working locally.
    """
    problems = []
    if not os.path.exists('.nojekyll'):
        problems.append(('.nojekyll', 'missing — Jekyll will process the site'))

    for path in sorted(all_real_paths()):
        parts = path.split('/')
        if any(part.startswith('_') for part in parts):
            problems.append((path, 'begins with an underscore; Jekyll excludes it'))

    return problems


def check_orphans():
    """Modules nothing imports — dead weight in the precache list."""
    real = all_real_paths()
    modules = {
        path for path in real
        if path.endswith('.js') and 'vendor' not in path and not path.startswith('tools/')
    }

    referenced = set()
    spec_re = re.compile(r"""['\"](\.[^'\"]+\.js)['\"]""")
    for base, dirs, names in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            if not name.endswith(('.js', '.mjs', '.html')):
                continue
            # The service worker's PRECACHE list names files without importing
            # them. Counting it as a reference would mean anything precached
            # could never be reported as an orphan, which defeats the check.
            if name == 'service-worker.js':
                continue
            path = os.path.join(base, name)
            try:
                source = open(path, encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            for match in spec_re.finditer(source):
                target = os.path.normpath(os.path.join(os.path.dirname(path), match.group(1)))
                referenced.add(target.replace(os.sep, '/').lstrip('./'))

    # Entry points are reached by the browser, not by an import.
    entries = {'js/app.js', 'service-worker.js'}
    return sorted(modules - referenced - entries)


def check_service_worker(path='service-worker.js'):
    """Confirm every precached path exists — a 404 there costs offline support."""
    source = open(path, encoding='utf-8').read()
    block = re.search(r'const PRECACHE = \[(.*?)\];', source, re.S)
    if not block:
        return [(path, '(PRECACHE list not found)', '')]

    missing = []
    for spec in re.findall(r"""['"](\./[^'"]+)['"]""", block.group(1)):
        if spec == './':
            continue
        target = os.path.normpath(spec.lstrip('./'))
        if not os.path.exists(target):
            missing.append((path, spec, target))
    return missing


def main():
    files = collect_js()
    print(f'{len(files)} JavaScript modules\n')

    problems = 0

    syntax_failures = check_syntax(files)
    if syntax_failures:
        problems += len(syntax_failures)
        for path, error in syntax_failures:
            print(f'SYNTAX  {path}\n{error}\n')
    print(f'syntax        {len(files) - len(syntax_failures)}/{len(files)} parse cleanly')

    import_failures = check_imports(files)
    if import_failures:
        problems += len(import_failures)
        for path, spec, target in import_failures:
            print(f'UNRESOLVED  {path} -> {spec}  (no {target})')
    print(f'imports       {"all resolve" if not import_failures else f"{len(import_failures)} broken"}')

    html_failures = check_html_refs()
    if html_failures:
        problems += len(html_failures)
        for path, spec, target in html_failures:
            print(f'MISSING     {path} -> {spec}  (no {target})')
    print(f'index.html    {"all refs exist" if not html_failures else f"{len(html_failures)} missing"}')

    sw_failures = check_service_worker()
    if sw_failures:
        problems += len(sw_failures)
        for path, spec, target in sw_failures:
            print(f'PRECACHE    {spec} does not exist (no {target})')
    print(f'precache      {"all paths exist" if not sw_failures else f"{len(sw_failures)} missing"}')

    # --- Deployment checks. These catch the class of bug that works on
    # Windows and fails only once the app is on GitHub Pages.
    case_failures = check_case_sensitivity()
    if case_failures:
        problems += len(case_failures)
        for path, spec, actual in case_failures:
            print(f'CASE        {path} -> {spec}  (on disk: {actual})')
    print(f'case         {"imports match disk case" if not case_failures else f"{len(case_failures)} mismatched"}')

    jekyll_failures = check_jekyll_safe()
    if jekyll_failures:
        problems += len(jekyll_failures)
        for path, reason in jekyll_failures:
            print(f'PAGES       {path}: {reason}')
    print(f'gh-pages     {"safe to publish" if not jekyll_failures else f"{len(jekyll_failures)} problem(s)"}')

    orphans = check_orphans()
    if orphans:
        # Not fatal — an unused module is waste, not breakage.
        for path in orphans:
            print(f'ORPHAN      {path} is never imported')
    print(f'reachable    {"no orphan modules" if not orphans else f"{len(orphans)} orphan(s)"}')

    print()
    print('OK' if problems == 0 else f'{problems} problem(s) found')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
