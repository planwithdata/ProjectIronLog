# Changelog

All notable changes to Project IronLog. Follows [Semantic Versioning](https://semver.org).

---

## [1.3.0] — 2026-08-05 — Session 4: Reports

The coaching report, exports, progress photos, coach notes editor, recovery
logs and tape measurements.

### Added

**Two-week review engine** (`js/engine/review.js`)
- Pure and tested. Takes computed figures, returns findings and a
  recommendation — each finding stating the figure it came from and the
  threshold it was tested against, so "continue current calories" can be
  traced rather than trusted.
- The recommendation is an explicit priority ladder, and the *order* is the
  policy: adherence below 70% outranks everything (nothing else is
  diagnosable), then sleep below 6.5 h, then the goal weight being reached,
  then the calorie rules.
- Every threshold is declared in one `THRESHOLDS` object rather than scattered
  through conditionals, with a test that asserts none has drifted back inline.

**PDF report** (`js/reports/pdf-report.js`)
- jsPDF 3.0.1 vendored with its licence and lazy-loaded, same reasoning as
  Chart.js: it must work offline, and ~366 KB should not load for every route.
- Built like print, not like a screenshot of the app: A4, light ground, ink
  type, a reserved x-axis band, and a `reserve()` primitive that page-breaks
  before a heading can be orphaned at the foot of a page.
- Charts are drawn with jsPDF vector primitives rather than rasterised from
  Chart.js — a canvas screenshot looks soft at print resolution and would bake
  in the dark theme.
- Thirteen sections: cover, training summary, body metrics, weight trend,
  strength progress, workout completion, volume analysis, progressive overload,
  personal records, recovery, measurements, progress photos and coach notes.
  All selectable before export.

**Progress photos**
- Stored in **IndexedDB, not Local Storage** — the one thing that does not go
  through the normal collection. Five angles a fortnight is ~130 photos a year;
  base64 in a ~5 MB Local Storage quota fills up in about two months, and a
  quota error on a photo write could take the whole database write with it.
  Metadata stays in the normal collection, so a photo record is just a pointer.
- Downscaled to 1280px JPEG at import, so the storage cost is paid once and
  stays bounded, and re-encoded again to 640px for the PDF.
- Compare view pins two dates side by side with an angle switcher — buttons
  rather than a swipe gesture so it works with a mouse and a keyboard too.
- Every object URL is revoked on teardown; a pinned blob per photo per visit
  is how a phone tab gets killed.

**Coach notes editor** (`js/pages/notes.js`)
- Scoping to a training day or a specific exercise, so an exercise-scoped note
  appears on that card mid-workout — the only moment it can usefully be read.
- Pin, archive and delete. Archiving rather than deleting keeps a note
  available to reports covering the period when it applied.

**Recovery and measurements** (`js/services/logs-service.js`)
- Sleep hours plus soreness, energy and stress on a 1–5 scale; eleven tape
  measurement sites. Both built on one factory rather than two near-identical
  CRUD modules.
- Values outside a plausible range are refused rather than stored — a
  fat-fingered 40-hour sleep would otherwise quietly wreck every average.
- "Copy last" prefill, because retyping eleven sites is the fastest way to
  stop logging.

**CSV export** (`js/reports/csv.js`)
- Seven datasets, one file each rather than one wide sheet.
- RFC 4180 escaping, and a UTF-8 BOM so Excel on Windows reads accented
  exercise names correctly.

**Shared download helper** (`js/core/download.js`)
- Extracted from Settings so the JSON backup, CSVs and the PDF share one
  implementation — including the iOS revoke delay that all three need.

### Fixed

- The review reported the absolute body weight as the period's gain
  ("+76.88 kg" on the report cover) when the starting average was missing:
  `end - (start ?? 0)`. Missing endpoints now yield no change figure, falling
  back to the rate. Regression test added.
- The start-of-period weight average was anchored to a window *ending* on the
  period's first day, so it needed a week of readings from before the review
  began — the first fortnight of logging could never report a change. Both
  windows now sit inside the period: its first week against its last.
- Non-WinAnsi characters (`→`, `−`) rendered as garbage in the PDF *and* were
  mis-measured, so `splitTextToSize` stopped wrapping and lines ran off the
  right margin. Every string is now mapped to WinAnsi at a single patched entry
  point, which keeps the app's on-screen typography unchanged.
- Section headings could be left orphaned at the foot of a page with their
  content starting overleaf.

---

## [1.2.0] — 2026-08-05 — Session 3: Progress dashboard

Charts, analytics and the personal-record badges.

### Added

**Charting foundation**
- Chart.js 4.5.1 **vendored** into `assets/vendor/` with its licence, not
  loaded from a CDN: a CDN script breaks offline, which is the one condition
  the app is guaranteed to run in. Precached by the service worker.
- Loaded lazily on the Progress route rather than at boot — it is ~208 KB and
  Home, Workout and Settings never draw a chart.
- `js/charts/chart-theme.js` reads chrome colours from the CSS custom
  properties at runtime, so a token change moves the charts and light mode
  needs no second definition.

**Chart palette, validated rather than eyeballed**
- An eight-slot categorical palette, assigned in fixed order and never cycled;
  a ninth series logs a warning instead of generating a hue.
- Validated against *this app's* surfaces in both modes: dark passes every gate
  (worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.3, all slots ≥ 3:1); light
  passes with three slots below 3:1 on white.
- **That contrast warning is why every chart ships a table view.** It is the
  documented relief, and it also means no value is reachable only by hovering —
  which matters on a phone, where there is no hover.

**Progress dashboard**
- One filter row (range: 30d / 90d / 1y / All, plus the strength exercise)
  above everything it scopes, rather than filters inside individual cards.
- Body weight: daily weigh-ins plus a 7-day rolling average, with the goal
  weight as a reference line. The average is computed over full history before
  windowing, so the leftmost visible point already has a full window behind it.
- 7-day and 30-day averages and the lean bulk rate as supporting stats.
- Strength per exercise: estimated 1RM and top-set load, both in kg on one
  axis. Defaults to the most-logged compound.
- Weekly volume and sets per week as bars from a zero baseline.
- Volume by muscle group as an HTML bar list — fifteen groups need their full
  names more than they need a canvas.
- Workout consistency per week, with the in-flight week prorated against the
  days scheduled so far.
- Personal record badges, ranked by estimated 1RM, with a "New" pill on records
  set in the last three weeks.
- Body composition as **small multiples** — one card and one axis per metric.
  Weight is in kilograms, body fat in percent, BMR in kilocalories; combining
  them on one plot would need several y-axes whose alignment would be arbitrary.

**Analytics engine** (`js/engine/analytics.js`)
- Pure and tested: rolling averages, weekly and monthly bucketing, gap filling,
  windowing, summary statistics and axis bounds.
- Rolling averages window by **calendar days, not sample count** — weight is
  logged most mornings but not all, and a 7-sample mean over gappy data
  silently compares this week with a fortnight ago.
- Line axes are not forced to zero; bar axes are. A zero baseline flattens a
  real 3 kg move into a straight line, while a bar's length *is* its value.

### Fixed

- Series colours passed as design tokens rendered black on canvas: Chart.js
  paints to a canvas, which cannot resolve `var(--token)`, so the invalid value
  silently fell back to black — all but invisible on the dark surface. Tokens
  are now resolved to real colours before they reach Chart.js.
- `niceBounds` widened the padding but not the axis for a flat series, giving a
  0.48 kg span that magnified scale noise into an apparent trend. Caught by a
  test, not by looking at it.
- The strength chart defaulted to whichever exercise sorted first
  alphabetically; it now prefers the most-logged compound.

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
