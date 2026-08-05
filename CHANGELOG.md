# Changelog

All notable changes to Project IronLog. Follows [Semantic Versioning](https://semver.org).

---

## [1.1.0] — 2026-08-05 — Session 2: Workout engine

Live set logging, the rest timer, workout history, and the progressive
overload engine.

### Added

**Progressive overload engine** (`js/engine/progression.js`)
- Double progression implemented exactly as the source program specifies:
  add a rep to any set below the top of the range; once every working set
  reaches the top, add that exercise's increment and drop back to the bottom.
- The increment defaults to the **bottom** of the prescribed range, because
  the source document is explicit that `+X kg` is a ceiling, not a schedule.
- `reps-first` handling for Pull-ups, Hanging Knee Raise and Ab Wheel Rollout:
  no external load until the top of the range is comfortable, then one
  increment via belt or vest.
- Stall detection — three sessions with no rep or weight increase drops the
  load ~10% and rebuilds.
- Scheduled Week 5 deload: sets cut ~40%, load at ~65%. Deload sessions are
  excluded when judging the next real session, so the wave cannot ratchet the
  whole program downwards every fifth week.
- `workingWeight` takes the heaviest completed set, not the first, so working
  up across sets does not stall the lifter.
- The module is pure — no imports, no storage, no globals — so it is testable
  outside a browser.

**Estimated 1RM** (`js/engine/one-rep-max.js`)
- Epley, extracted from pr-service so it is pure and testable. `loadForReps`
  inverts it for the reports layer.

**Logging UI**
- Set rows with weight and rep steppers either side of a numeric field, an
  RPE picker, and a large commit checkmark. Fields arrive pre-filled from the
  engine, so a set that goes to plan is one tap.
- Values commit on blur or on tick, never on keystroke, so a half-typed number
  is never stored.
- Add a set inline; press and hold a set number to remove an extra one.
- Ticking a set patches only that card — the page is not re-rendered, so the
  scroll position and any focused field survive.
- Last-session line per exercise, with a marker when the top of the range was
  reached.
- Finish panel with live completion, plus early-finish and discard flows.
- Completion sheet: sets, exercises, volume, duration, which lifts earned an
  increase, and any records set.

**Rest timer** (`js/services/rest-timer.js`, `components/rest-bar.js`)
- Timestamp-based rather than tick-based: iOS suspends timers when the screen
  locks, so remaining time is always recomputed from the clock. Pocket the
  phone for two minutes and the countdown is correct on return.
- Auto-starts on set completion, per-exercise duration from the program.
- Floating bar above the tab bar with +30s and Skip, colour shift under 10s.
- WebAudio beep synthesised at runtime — no asset to cache or 404 offline.

**Workout history** (`js/pages/history.js`)
- Sessions grouped by month with per-session completion and volume.
- Session detail: logged sets as chips, marked when at the top of the range,
  records set, and totals.
- Re-open a completed session for editing, or delete it.

**Sheets** (`components/sheet.js`)
- `<dialog>`-based bottom sheet replacing `window.confirm`, which cannot show
  a summary and renders with the site URL in an installed PWA.

**Session service**
- Engine recommendation frozen into the session at start, so a report can say
  what was prescribed as well as what was done, and the target cannot shift
  under the user mid-session.
- `getSessionSummary`, `isSessionComplete`, `reopenSession`, `addSet`,
  `removeSet`, `getRecommendation`.

**Testing**
- `tools/test.mjs` — 28 assertions over the engine via `node --test`,
  including the worked example from the brief (6–8 range at 27.5 kg logged
  8/8/7/6 → hold 27.5, target 8/8/8/7).
- `tools/e2e.html` — 61 assertions driving the service layer against real
  Local Storage in a real browser: multi-session progression, deload wave,
  PR detection, resume guards, set editing, body and notes services, and a
  backup round trip.
- `tools/preview.html?seed=logging` seeds a plausible training history and
  leaves a session open, so the logging UI can be reviewed without lifting.

### Fixed

- `card.append()` rendered the literal text "null" for absent optional
  children; the native DOM method stringifies null, unlike the `append`
  helper in dom.js.
- The set row grid declared four columns but rendered five children when the
  RPE picker was shown, wrapping the commit checkmark onto its own line.
- "Latest PR" tie-broke arbitrarily when a session set several records on one
  day. It now prefers estimated 1RM, then the heaviest, so the headline is the
  day's biggest lift rather than whichever exercise sorted first.
- Page titles were duplicated: the app header and the page body both rendered
  the route name, and both as `<h1>`. Redundant page titles are removed and
  the remaining content headings demoted to `<h2>`.

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
