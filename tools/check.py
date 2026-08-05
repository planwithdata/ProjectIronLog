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

    print()
    print('OK' if problems == 0 else f'{problems} problem(s) found')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
