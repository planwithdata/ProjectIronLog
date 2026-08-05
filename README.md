# Project IronLog

A personal gym companion. Mobile-first Progressive Web App: installable on an
iPhone Home Screen, works offline, stores everything on the device, and never
talks to a server.

**Version 1.4.0 — complete. All five build sessions delivered.**

---

## What it does today

| Area | Status |
|---|---|
| Design system, app shell, navigation | Done |
| Home page | Done |
| Program data parsed from source documents | Done — 37 exercises across 5 training days |
| Progressive overload engine | Done — double progression, deload wave, stall detection |
| Workout history | Done — per-session detail, re-open, delete |
| Workout page | Live set logging, rest timer, completion summary |
| Storage layer with backup & restore | Done |
| Theme (dark / light / system), units (kg / lb) | Done |
| PWA: manifest, icons, offline cache | Done |
| Progress dashboard | Done — weight, composition, strength, volume, consistency, PRs |
| Reports — PDF, CSV, JSON | Done |
| Progress photos, coach notes, recovery, measurements | Done |
| Two-week review generator | Done — rule-based, traceable |
| Install & update prompts | Done |
| Accessibility | Done — audit clean in both themes, all nine routes |
| Exercise illustrations | Done — start/end frames for all 37 |
| Performance | Done — 202 KB shell, lazy route modules |

### By the numbers

| | |
|---|---|
| Shell payload | 243 KB cold (31 requests, incl. the 35 KB program file) · first paint ~70 ms locally |
| Engine tests | 62 assertions (`node --test tools/`) |
| Integration tests | 84 assertions (`tools/e2e.html`) |
| Accessibility audit | clean, both themes, all nine routes |
| Dependencies | 2, both vendored: Chart.js 4.5.1, jsPDF 3.0.1 |
| Illustrations | 74 images, 0.96 MB, public domain, lazy-loaded |
| Build step | none |

---

## Running it

No build step, no dependencies, no toolchain. But it does need to be served
over HTTP — ES modules and service workers do not work from `file://`.

```bash
cd ProjectIronLog
python -m http.server 8000
# open http://127.0.0.1:8000
```

### Deploying to GitHub Pages

```bash
git push origin main
```

Then in the repository: **Settings → Pages → Source: `main` / root**.

Every path in the app is relative (`./css/...`, not `/css/...`), so it works
unchanged from `https://user.github.io/ProjectIronLog/` as well as from a
domain root. This is the single most common way a Pages deploy of a PWA
breaks, and it is why there are no absolute paths anywhere.

### Installing on an iPhone

Open the Pages URL in Safari → Share → **Add to Home Screen**. It launches
standalone, with no browser chrome, and works with no signal.

---

## Architecture

```
UI (pages, components)    never touches storage directly
        ↓
Domain services           program · session · body · notes · pr · settings
        ↓
db.js                     collections, cache, migrations, export/import
        ↓
storage-adapter.js        the ONLY module that knows Local Storage exists
        ↓
Local Storage
```

### The layer rules

1. **A page never reads storage.** It calls a service. A service calls `db`.
   Only `db` calls the adapter. This is what makes the Supabase swap a
   one-line change instead of a rewrite.
2. **The adapter is fully async** even though Local Storage is synchronous.
   Paying the `await` cost now means the real async backend later needs no
   call-site changes.
3. **`db` keeps a hydrated in-memory cache**, so pages read synchronously and
   render in one frame. Writes go straight through and return a promise.
4. **Weights are always stored in kilograms.** kg/lb is a display concern
   (`format.displayWeight`), so switching units never rewrites stored data.
5. **Dates are local calendar days** (`YYYY-MM-DD`), not timestamps. A session
   logged at 22:00 must not become yesterday's after a timezone change.

### Directory map

```
index.html                 shell + anti-flash theme shim
manifest.json              PWA metadata
service-worker.js          precache + offline strategy

css/
  tokens.css               ALL colour, type, space, radius, motion values
  base.css                 reset, element defaults, text utilities, a11y
  layout.css               app shell, header, tab bar → sidebar, grids
  components.css           card, button, pill, stat, ring, list, input, toast
  workout.css              set rows, rest bar, sheets, history chips

js/
  config.js                app name and version
  app.js                   boot sequence
  core/
    dom.js                 el() builder, icon set, escaping
    format.js              dates, numbers, durations, unit conversion
    events.js              pub/sub bus
    router.js              hash router
  services/
    storage-adapter.js     Local Storage implementation of the adapter
    db.js                  repository, cache, migrations, backup
    program-service.js     reads data/workouts.json
    session-service.js     workout sessions and derived stats
    body-service.js        body weight and composition
    notes-service.js       coach notes
    pr-service.js          personal record detection
    settings-service.js    preferences, profile, theme
    rest-timer.js          timestamp-based rest countdown
  engine/
    progression.js         double progression — pure, tested
    one-rep-max.js         Epley estimate — pure, tested
    logs-service.js        recovery, measurements, photos
    photo-store.js         IndexedDB blob store for photos
    review-service.js      gathers figures for the review engine
    pwa-service.js         install and update handling
  engine/
    review.js              two-week review rules — pure, tested
  charts/                  lazy Chart.js loader, palette, theming
  reports/                 PDF builder, CSV, photo embedding
  pages/                   loaded lazily by the router

components/                nav, ring, stat, toast, set-row, rest-bar, sheet,
                           chart-card
data/workouts.json         the training program (replaceable)
icons/                     PWA icons, generated from icon.svg
tools/                     check.py, test.mjs, e2e.html, preview.html, probe.html
```

### Why these choices

**Vanilla ES modules, no bundler.** The app must still run in five years.
A build chain is the part of a project that rots first; native modules are a
browser feature that cannot be abandoned. The cost is more HTTP requests on a
cold load, which the service worker eliminates after the first visit.

**Hash routing (`#/workout`).** GitHub Pages serves static files and cannot
rewrite `/workout` to `index.html`, so a History-API route would 404 on
refresh or on a shared link. Hash routes are resolved in the browser and work
from any host.

**Design tokens as CSS custom properties.** One file defines every colour and
spacing value. Light mode is a token override — no component stylesheet knows
a theme exists. Every text and accent value was **measured** against the
surface it actually renders on and raised until it cleared WCAG AA; Apple's own
iOS alphas do not survive that test here. `tools/audit.html` re-checks it.

**Two accent tokens.** `--c-accent` reads as text on a near-black surface
(5.3:1); `--c-accent-fill` carries white button text (4.9:1). One value cannot
do both jobs, and white on the bright accent measured 3.65:1.

**Lazy route modules.** Pages load on first visit via native `import()`.
Importing all nine up front cost 442 KB before Home drew a pixel; it is now
202 KB. Stylesheets stay eager — splitting CSS per route trades a flash of
unstyled content for a few kilobytes, which is the wrong way round.

**Tab bar becomes a sidebar at 1024px.** A bottom tab bar is a phone pattern;
on a desktop it strands navigation at the far edge of the window.

**One deliberate architecture exception:** a small inline script in
`index.html` reads the theme from Local Storage before first paint. It has to
run before the module graph loads, and without it a light-mode user sees a
black flash on every launch. It only ever reads, and only that one key.

---

## The training program

`data/workouts.json` holds the entire program. Replacing that file replaces
the program — no code changes, and logged history stays intact because
sessions reference exercise `id`s, not names or prescriptions.

Parsed from `Rish Workout Program.docx` (sets, reps, rest, weight increments)
and `Rish_WorkoutRoutine.pdf` (weekly split, per-day focus notes).

| Day | Focus | Exercises | Sets |
|---|---|---|---|
| Monday | Rest | — | — |
| Tuesday | Chest Priority | 9 | 28 |
| Wednesday | Back & Biceps | 8 | 25 |
| Thursday | Legs | 6 | 20 |
| Friday | Recovery | — | — |
| Saturday | Upper | 8 | 26 |
| Sunday | Posterior Chain | 6 | 20 |

Two amendments were applied on request and are recorded in
`program.amendments`:

- Tuesday: **Low-to-High Cable Fly** replaces High-to-Low Cable Fly.
- Saturday: **Cable Lateral Raise** added after Machine Shoulder Press.

### Progressive overload

Double progression, exactly as the source document specifies:

- Work inside a rep range, adding a rep to any set below the top of the range.
- Once **all** working sets hit the top of the range, add that exercise's
  increment and drop back to the bottom.
- If the top of the range was not reached, repeat the same weight. The
  `+X kg` figures are a ceiling, not a schedule.
- Bodyweight lifts marked `reps-first` (Pull-ups, Hanging Knee Raise, Ab Wheel
  Rollout) add reps before any external load.
- 4-week wave, then a deload week: sets cut ~40%, load at 60–70%.
- A lift stalled for 3 sessions drops ~10% and rebuilds.

These rules live as data in `progression` at the top of `workouts.json`, and
are applied by `js/engine/progression.js` — a pure module with no imports,
no storage and no globals, so it can be tested outside a browser. It is the
one place where a quiet mistake would corrupt years of training decisions.

---

## Checking your work

```bash
python tools/check.py     # parses every module; resolves every import,
                          # including dynamic ones, plus HTML and precache refs
node --test tools/        # 62 assertions over the progression, analytics,
                          # 1RM and review engines
```

Then, over HTTP, in a **throwaway browser profile** (these clear Local Storage
on the origin they run against):

| Page | What it proves |
|---|---|
| `tools/e2e.html` | 84 service-layer assertions against real Local Storage: multi-session progression, the deload wave, PR detection, resume guards, set editing, CSV escaping, a real multi-page PDF, backup round trip |
| `tools/audit.html` | accessible names, alt text, labels, duplicate ids, 44px targets, WCAG AA contrast, overflow and heading order — across all nine routes. `?theme=light` for the light palette |
| `tools/perf.html` | shell payload, and that the vendored libraries are not fetched on routes that do not need them |
| `tools/pdf-dump.html` | emits a generated report as base64 so the PDF can be pulled out and actually looked at |

Open `tools/e2e.html` over HTTP for 61 integration assertions against real
Local Storage: multi-session progression, the deload wave, PR detection,
resume guards, set editing, and a backup round trip. It clears Local Storage
on the origin it runs against, so use a throwaway browser profile — never one
holding real training data.

`tools/preview.html` renders the app at phone, iPad and desktop widths side by
side — the fastest way to catch a mobile layout regression. `?theme=light`
switches palette, `?route=workout` switches page, and `?seed=logging` fabricates
a training history and leaves a session open so the logging UI can be reviewed
without lifting anything (it also clears Local Storage).

`tools/probe.html` reports any element wider than a phone viewport, which is
the failure mode that a desktop browser window will never show you.

---

## Data and privacy

Everything lives in this device's Local Storage under the `ironlog:v1:` key
prefix. There is no account, no server, no analytics, and no network request
after the first load.

That also means **this device is the only copy.** Settings → Back up to JSON
writes a complete snapshot; do it before clearing browser data, and keep one
somewhere else.
