# Changelog

All notable changes to Project IronLog. Follows [Semantic Versioning](https://semver.org).

---

## [1.0.0] — 2026-08-05 — Session 1: Architecture

The foundation: design system, storage architecture, navigation, Home page,
and the training program converted to structured data.

### Added

**Design system**
- `css/tokens.css` — every colour, type size, space, radius, shadow and easing
  value in the app, as CSS custom properties. Dark-first, with light mode as a
  pure token override.
- `css/base.css` — reset, element defaults, type utilities, focus handling,
  screen-reader helpers, reduced-motion support.
- `css/layout.css` — fixed app shell with a single scroll region, blurred
  header with scroll-triggered hairline, iOS safe-area insets, tab bar that
  becomes a sidebar at 1024px.
- `css/components.css` — card, hero, button, icon button, pill, stat tile,
  progress ring, bar, grouped list, note, input, segmented control, empty
  state, toast, entrance animations.

**Storage architecture**
- `js/services/storage-adapter.js` — the only module aware of Local Storage.
  Fully async interface, namespaced `ironlog:v1:` keys, quota-error handling,
  corrupt-value quarantine, and an in-memory fallback so Safari Private
  Browsing degrades instead of crashing.
- `js/services/db.js` — repository layer: twelve declared collections with
  defaults, hydrated in-memory cache for synchronous reads, forward-only
  migration runner, whole-database export/import, reset.

**Domain services**
- `program-service.js` — loads and validates `workouts.json`; resolves today's
  day, training week, 4-week wave position, deload set reduction, and the
  two-week review countdown.
- `session-service.js` — session lifecycle (start, resume, log, complete,
  abandon), exercise history, per-session completion and volume, week
  completion, weekly streak.
- `body-service.js` — morning weigh-ins (one per day, replacing), ten
  composition metrics, 7- and 30-day averages, lean bulk rate.
- `notes-service.js` — coach notes with category, source, pinning, archiving,
  and scoping to a day or exercise.
- `pr-service.js` — derived personal records for heaviest weight, most reps,
  best estimated 1RM (Epley) and session volume.
- `settings-service.js` — preferences, profile, theme application, live OS
  theme following.

**Core**
- `dom.js` — `el()` element builder that sets text via `textContent` so
  escaping is structural, plus a 21-icon inline SVG set.
- `format.js` — local-calendar-day date handling, relative dates, clock and
  duration formatting, number trimming, signed deltas, kg/lb conversion.
- `events.js` — pub/sub bus so services can notify the UI without importing it.
- `router.js` — hash router with per-route mount/cleanup and an error boundary.

**Pages**
- Home — today's workout hero with Start Workout, today's focus, week
  completion ring with streak, body metrics, latest PR, coach notes. Every
  tile shows an em dash and a hint rather than a zero when there is no data.
- Workout — read-only program browser: weekday switcher, exercise cards with
  prescription and progression rule, and the program's own progression rules.
- Progress, Reports — honest placeholders naming what each later session
  delivers, plus live counts of what is already stored.
- Settings — theme (dark/light/system), units (kg/lb), height, goal weight,
  review interval, JSON backup, JSON restore, storage usage, app reset.

**Training program**
- `data/workouts.json` — the full program as structured data: 5 training days,
  37 exercises, with sets, rep ranges (including per-side), rest intervals,
  per-exercise weight increments, equipment and load type, muscle tags, form
  cues, plus program-level progression rules, wave/deload policy, stall policy
  and missed-day policy.
- Extracted from `Rish Workout Program.docx` (prescriptions) and
  `Rish_WorkoutRoutine.pdf` (weekly split and per-day focus).

**PWA**
- `manifest.json` — standalone display, app shortcuts, maskable icon.
- `service-worker.js` — cache-first app shell for reliability on gym wifi,
  network-first navigation so deploys are picked up, per-entry precaching so
  one missing file cannot cost offline support, versioned cache cleanup.
- Icons at 192/512/maskable-512/180/32, generated from `icons/icon.svg`.
- iOS standalone meta tags and `viewport-fit=cover` for safe-area layout.

**Tooling**
- `tools/check.py` — parses every module with Node and resolves every relative
  import, `index.html` reference and service-worker precache path. Stands in
  for a compiler, since there is no build step.
- `tools/preview.html` — renders the app at 402/834/1280px simultaneously.
  Headless Chrome ignores `--window-size` when laying out a screenshot, which
  makes it useless for reviewing a mobile-first design; iframes force a real
  device-width layout.
- `tools/probe.html` — reports any element wider than a phone viewport.

### Program amendments

Applied on request and recorded in `program.amendments` in `workouts.json`:

- Tuesday — **Low-to-High Cable Fly** replaces High-to-Low Cable Fly, to bias
  the upper chest.
- Saturday — **Cable Lateral Raise** added after Machine Shoulder Press,
  3 sets, for lateral delt volume.

### Notes

- Weights are stored in kilograms throughout; kg/lb is display-only.
- Dates are stored as local calendar days, never as timestamps.
- All asset paths are relative, so the app deploys to a GitHub Pages
  subdirectory without changes.

---

## Unreleased

Session 2 will add live set logging, the rest timer, workout history and the
progressive overload engine. See `ROADMAP.md`.
