# Changelog

All notable changes to Project IronLog. Follows [Semantic Versioning](https://semver.org).

---

## [1.8.0] — 2026-08-13 — Second-set baseline, and Hack Squat

Changes to what gets prescribed, and one correction to what was logged. Not a
single weight, rep count, completion flag, RPE, date or note is altered
anywhere; the one thing that moves is which exercise a set of week-one entries
says it belongs to, and that is a schema migration with its own tests.

### Changed

**The coming week is baselined from the second working set**
(`js/config.js` → `WORKING_SET_REBASELINE`, `engine/progression.baselineWeight`)

- Week 1 was logged as a ramp *inside* the working sets — `150/180/200/220` on
  the squat, `43/57/63` on a row — because the top set was being used to find a
  limit rather than to train at. `workingWeight` carries the heaviest completed
  working set forward, so left alone the engine would have prescribed that
  one-off probe as the load for *every* set of the coming week.
- For the first five sessions from 2026-08-13, the load is measured from working
  set **2** of the previous performance instead. On Thursday's legs that is
  180 kg on the hack squat rather than 220 and 160 kg on the leg press rather
  than 200; on Saturday, 57 kg on the seated row rather than 70.
- **It expires by itself.** After those five completed sessions the rule stops
  applying and ordinary double progression resumes, from whatever was logged
  under it — which by then is a repeatable working load rather than a probe.
  Nothing has to be remembered or removed.
- Scoped tightly on purpose. Rep targets, stall detection, deload arithmetic,
  PRs, volume and history are all unchanged: the override moves *where the next
  load is measured from*, and nothing else. A card whose load moved says so, in
  words, rather than quietly showing a smaller number.
- Pyramid prescriptions (Cable Lateral Raise) are unaffected — they already
  carry a load per rung, so there is no top set standing in for the others.

**Hack Squat replaces Back Squat** (`data/workouts.json`, Thursday)

- Logged as a raw machine value with no bar weight, per the loading conventions:
  a sled's carriage weight is a property of that specific machine, and inventing
  a 20 kg bar for it would present a guess as a measurement.
- Two illustrations, from the same public-domain source as the other 36.

**Week one's squats were hack squats** — schema **v2 → v3**
(`db.migrateV2ToV3`)

- They were trained as hack squats and logged under Back Squat, which was the
  movement occupying the Thursday slot at the time. The migration points those
  entries at `hack-squat`.
- **A relabel, not a recalculation.** Every load, rep, tick, RPE, note and
  ordering survives byte for byte; only the `exerciseId` moves. What changes is
  what that id *means*: `150` stops being labelled `+150 kg plates · est. total
  170 kg` and reads as the raw machine value it always was.
- It runs at boot **and on import**, so restoring the existing `ironlog-backup-*`
  JSON — which still says `back-squat` — lands as Hack Squat either way. The
  usual pre-migration parachute is written first, and is downloadable from
  Settings → Data.
- Applied to sessions, coach notes and the PR cache. Not to `reviews`: a
  generated review is a dated snapshot of what the app said at the time, and
  editing one after the fact makes it a record of nothing.
- Idempotent, and it refuses to collide: a session somehow holding both ids
  keeps the old entry exactly where it is and logs a warning, rather than
  producing a duplicate the rest of the app would silently mis-read.
- Consequence worth knowing: Hack Squat now *has* history, so Thursday is
  prescribed rather than a blank first session — 180 kg for 8/8/8/7 under the
  second-set baseline above.

### Added

**Retired exercises** (`data/workouts.json` → `retiredExercises`, optional)

- A movement dropped from the split keeps its definition in a separate list, and
  `programService.getExercise` falls back to it.
- With the relabel above nothing should resolve there any more. It stays as a
  fallback: a stale id arriving from an old export, or an entry the migration
  declined to touch, still reads as a named barbell lift rather than a bare
  `back-squat` slug with unlabelled numbers.
- Retired movements are excluded from `getAllExercises`, from every day, and
  from the program browser — they are history, not prescription — but they stay
  in the PR feed. Dropping a lift does not un-lift the heaviest set of it.

### Fixed

- `tools/fetch_illustrations.py` now crops a source frame to 3:2 before
  downscaling, biased a quarter of the way down. The card pins artwork to 3:2
  with `object-fit: cover`, so a square source was going to be cropped
  regardless; doing it at bake time chooses where, instead of letting the
  browser take the top of someone's head off.

---

## [1.7.0] — 2026-08-12 — Warm-up, working and intensity sets

Session 6. The app now distinguishes the three kinds of work in a session, and
knows how the person using it actually writes down a load. Nothing was rebuilt:
every existing session, weigh-in, photo, note and record is preserved, and the
migration that made room for this is asserted against the real exported backup.

### Added

**A set model with three parts** (`js/engine/set-model.js`, pure and tested)

- `entry.sets` now means **working sets and nothing else**. Ramp-up work lives in
  `warmupSets`; drop sets and failure sets live in `intensitySets` as sequences
  with stages.
- Separate arrays rather than a `kind` tag on one list, deliberately. Seven
  modules read `entry.sets`; a tag would need a filter in each, and one forgotten
  filter would feed warm-ups to the double-progression engine — the exact failure
  this change exists to prevent. With separate arrays the default reading is the
  correct one, and the extras have to be asked for by name.
- A drop-set sequence is reported as **one** piece of supplementary work:
  "3 working sets + 1 drop-set sequence", never as six sets.
- Warm-up sets can be added to **any** exercise. Where the program prescribes a
  ramp (Squat, RDL, both incline presses, flat dumbbell bench, machine chest
  press) the rungs are pre-filled at 40/60/80% of the working weight, rounded to
  something loadable, with a **Suggest ramp** action to rebuild them.

**Load conventions** (`js/engine/loading.js`, pure and tested)

- One module now owns what a logged number *means*: plates for a barbell, the
  total of both dumbbells for a dumbbell, the raw reading for a machine or cable,
  added load only for bodyweight.
- Display follows the equipment: `+40 kg plates` with an estimated total where the
  bar weight is known, `27.5 kg / hand` under a logged 55, `8 kg per side` for a
  two-stack cable movement, `Bodyweight`. The set row shows the derived reading
  live beneath the field as it is typed.
- **Dumbbell increments are per hand.** "+2.5 kg" in the program means the next
  pair up, so the engine steps the logged total by 5 kg. It previously suggested
  52.5 kg — 26.25 per hand, a dumbbell that exists on no rack.

**Optional intensity techniques**

- **Add drop set** (multi-stage, seeded from the heaviest completed working set,
  every rung editable, "reached failure" recorded on the first stage) and
  **Add failure set**. Offered on isolation and accessory work by default,
  withheld from the main compounds, and overridable per exercise via
  `intensityTechniquesAllowed`.
- Failure training is neither prohibited nor nagged about. It is recorded as its
  own kind of work and kept out of the progression arithmetic. That is the whole
  of the app's opinion.

**Pain-aware logging**

- Optional 0–10 score, location, note, what you did (completed / fewer reps /
  stopped / skipped), and an optional substitution chosen from the program's own
  alternatives. Nothing is substituted automatically.
- A pain-limited session is excluded from stall detection and from the review's
  strength comparison, so stopping a set because your elbow hurts never reads as
  a strength regression. The session itself is untouched and still appears in
  history, reports and the CSV.
- Non-diagnostic by design: it states that it is not a diagnosis and points at a
  professional assessment rather than offering an opinion.

**Difficulty progression for the ab wheel**

- `progression.mode: 'difficulty-first'` with a five-rung ladder: standard → slow
  eccentric → longer range → advanced variation → weighted. Hitting 12 reps now
  earns the next rung, not a plate; external resistance is the last rung, and the
  wording says so.

**Push-ups before chest**

- An optional pre-workout warm-up on Tuesday: 1–2 sets, 8–15 reps, not to
  failure. Modelled as a real exercise with `role: 'pre-workout-warmup'` and no
  working sets, so it contributes zero to progression, volume, completion and the
  prescribed set count *by construction* rather than by special-casing.
- Logged as reps only — no weight field.

**Morning weigh-in reminder, and somewhere to answer it**

- A dismissible banner on Home: "Good morning. Log today's weight?" with
  **Enter Weight** and **Skip**. Only on a training day, only when today's weight
  is missing, at most once per calendar day, and never over the Start Workout
  button.
- **`body-service` had been able to store weigh-ins and full scale readings since
  Session 1, but nothing in the app ever called it.** There was no screen to type
  a number into, so the body-weight series could only be filled by restoring a
  backup — which is why the real database had zero weigh-ins. Session 6 adds the
  two-tap weight sheet and a **Body** tab in Logs for all ten scale metrics.

**Training Preferences** (Settings → Training preferences)

- Fourteen conventions — load display, increment basis, warm-up separation,
  intensity techniques, push-ups, pull-up handling, ab-wheel progression — stored
  in a new `trainingPrefs` collection and read on the display side. Changing one
  never rewrites a stored number.

**Backup safety**

- **Last backup** date in Settings, stamped only after the download call returns
  without throwing, and a warning when logged sessions have never been backed up.
- **Download pre-upgrade snapshot**: the verbatim v1 copy taken before the
  migration, shaped like a normal backup so it restores through the same Restore
  row. Never overwritten, never auto-deleted.

**Reports**

- Warm-up, working and intensity volume are reported as **three figures and never
  as one**. A fortnight where working volume fell while drop-set volume rose is
  not the same fortnight as one where the total held steady, and a single number
  cannot tell them apart.
- New review findings: set composition, intensity techniques, discomfort notes.
  New PDF sections for the same. The strength finding now names any lift excluded
  as pain-limited, so a verdict computed over four of six lifts does not read as
  though it covered all six.
- `sets.csv` gains `set_kind`, `drop_sequence`, `drop_stage`, `to_failure`,
  `load_entry`, `weight_display`, pain columns and `difficulty`, so a spreadsheet
  can filter to working sets and reproduce exactly what the engine saw.
  `sessions.csv` splits its counts and volume by set type. A new
  **Discomfort log** dataset exports every pain note.

### Changed

- **Dumbbell volume is no longer doubled.** The previous build multiplied
  per-hand-tagged loads by two, on the assumption that the logged figure was per
  hand. Under the convention actually used — the total of both dumbbells — that
  counted every dumbbell set twice. Historical *stored* data is untouched;
  derived volume figures for dumbbell lifts drop by about half, and some volume
  PRs recompute.
- **Low-to-High Cable Fly** is a raw machine value, labelled *per side*, rather
  than a per-hand load. Its historical volume contribution halves for the same
  reason.
- **Incline Smith Machine Press** is treated as plates, not as a machine stack.
  Its bar weight varies by machine and is often counterbalanced, so none is
  claimed.
- Session completion, week completion and the prescribed set count all count
  **working sets only**. Ticking three ramp sets no longer reads as 30% of the
  session done, and adding a drop set no longer pushes a finished session below
  100%.
- The narrow-phone set-row grid gained a column for the optional failure flag.
  Without it the commit button was pushed off a drop-set row.
- `js/engine/progression.js` now imports one pure sibling (`loading.js`). It
  remains free of storage, globals and the clock.

### Fixed

- A session containing only a pre-workout warm-up could never satisfy "all sets
  logged", because the finish check required every entry to have at least one
  ticked set. Entries with no working sets are now skipped.
- The completion summary filed a pain-limited exercise under "held", which reads
  as a stall. It now has its own bucket.

### Migration — schema v1 to v2

Strictly additive, and asserted against the real exported backup
(`tools/test-migration.mjs`, 16 assertions).

- The whole v1 database is copied verbatim to a reserved `__premigration` key
  **before anything is touched**, and stays downloadable from Settings.
- Each entry gains `setModel: 'legacy'`, empty `warmupSets` / `intensitySets` and
  `pain: null`; each set gains `kind: 'legacy'`. No weight, rep count, completion
  flag, RPE, date, note or ordering is altered.
- Idempotent. A second pass, or importing an already-migrated backup, is a no-op.
  A v1 backup still restores and is migrated on the way in.
- A database holding sessions but no `meta` record is treated as v1 rather than
  assumed current, which would have skipped the migration entirely.
- **Nothing is reclassified by guesswork.** Week one is, on almost every exercise,
  a rising-weight falling-rep ladder — 150×12, 180×10, 200×8, 220×6 on the squat.
  That looks like a ramp; it also looks exactly like a pyramid, or like working up
  to a top single, and the app cannot tell which. Legacy sets keep feeding
  progression, because they are the only record of what was lifted, and they are
  labelled "unclassified" wherever they appear. History → session detail offers
  **Classify these sets** for when you want to say what they were.

### Tests

- `tools/test-sets.mjs` — 31 new assertions: load conventions, the set model, and
  the negative guarantees that a warm-up, a drop set and a failure set cannot
  move a prescribed load, plus the progression table from the brief, verbatim.
- `tools/test-migration.mjs` — 16 assertions, including a lossless round trip of
  the real exported backup.
- `tools/e2e.html` — 117 assertions, up from 84.
- Engine suite — 121 assertions, up from 62.

---

## [1.6.0] — 2026-08-05 — Exercise illustrations

### Added

**Real artwork for all 37 exercises**, two frames each — start and end position.
One still of a movement says almost nothing; a pair reads as a sequence.

- Source: the [Free Exercise DB](https://github.com/yuhonas/free-exercise-db),
  released into the public domain under the Unlicense. Chosen over the images
  embedded in the source PDF, which are third-party photo collages, three
  photos per card, with the detail text cropped off — and over hotlinking, which
  would mean no pictures in a basement gym.
- Downscaled to 440px and re-encoded as WebP: 74 images, **0.96 MB total**
  (WebP was 36% smaller than JPEG at the same quality).
- **Not precached.** Adding ~1 MB to the first install for pictures the user may
  never scroll to is the wrong trade. The service worker's cache-first handler
  stores each image the first time it is actually shown, so it is offline from
  then on — and artwork is now exempt from stale-while-revalidate, since it
  never changes without its filename changing.
- Paths are derived by convention from the exercise id, so program data carries
  no asset bookkeeping and a missing image falls back to the placeholder on its
  own.
- Tapping the illustration opens both frames full width with the form cues —
  the card version is big enough to identify a movement, not to check a
  position against.
- Provenance and the full mapping are recorded in
  `assets/exercises/CREDITS.md`.

### Matching was verified, not trusted

`tools/match_exercises.py` matched all 37 by alias and fuzzy name, then the
results were rendered as a contact sheet and looked at. Three were wrong in ways
no name check would catch — and a picture of the wrong movement is worse than no
picture:

| Exercise | Matched to | Actually showed |
|---|---|---|
| Ab Wheel Rollout | "Ab Roller" | a dumbbell plank |
| Cable Lateral Raise | "Cable Seated Lateral Raise" | a bent-over *rear* delt raise |
| Neutral Grip Lat Pulldown | "V-Bar Pulldown" | a standing pull, not seated |

All three were re-pointed. Two remaining compromises are documented rather than
hidden: Cable Lateral Raise shares the dumbbell artwork (the only cable options
in the dataset are both rear-delt movements — wrong implement, right movement),
and Bulgarian Split Squat shows a dumbbell split squat with the rear foot on the
floor rather than elevated.

### Tooling

- `tools/match_exercises.py` — maps program exercises to the dataset, with an
  explicit alias table, and reports what it could not match rather than
  guessing.
- `tools/fetch_illustrations.py` — fetches, downscales, re-encodes, and writes
  `CREDITS.md` plus a manifest. Idempotent: existing files are left alone.

---

## [1.5.0] — 2026-08-05 — Pyramid sets, goal weight, deploy hardening

### Added

**Pyramid (ramped) set prescriptions.** Cable Lateral Raise is 10/15/20 kg for
12/10/8 reps — a different load *and* rep target per set, which the uniform-set
model could not express. Rather than flatten it, exercises may now carry a
`setPlan` array, and the engine gains a pyramid branch:

- Each rung has its own load and its own rep target.
- A rung below target gains one rep, capped at that rung's target — with no
  shared minimum floor, since `reps.min` here is the *top* rung's target and
  clamping to it would jump a 6 straight to 8.
- The whole ladder advances by one increment only once **every** rung is met.
- Progression works from what was actually lifted, so the ladder does not reset
  to the JSON values after it has moved up.
- Deload scales every rung, and a deload session never becomes the baseline.
- `earnedAdvance` judges rung by rung: the middle rung's 10 reps must not be
  allowed to satisfy the top rung's target of 8.

**Body-weight goal in the program.** `program.goals.bodyWeightKg` is now 85 kg.
The goal belongs in the program document — it is part of the plan, not a device
preference — and Settings still overrides it. Home, the weight chart's reference
line and the review's hold-or-cut rule all read through
`settingsService.getGoalWeightKg()`.

### Fixed

- **GitHub Pages would have silently dropped a module.** Pages runs Jekyll
  unless a `.nojekyll` file exists, and Jekyll excludes anything whose name
  begins with an underscore — so `js/pages/_placeholder.js` would have 404'd in
  production while working locally. `.nojekyll` added; the module turned out to
  be dead code (Sessions 3 and 4 replaced both pages that used it) and was
  removed.
- **Per-side rep labels were doubled.** Bulgarian Split Squat rendered
  "8-10/leg/side" and Pallof Press "12/side/side": the JSON label already
  carries the per-side wording from the source document, so appending it again
  duplicated it. Went unnoticed because the only day screenshotted during
  Session 2 had no per-side exercises.

### Tooling

`tools/check.py` gained three deployment checks, all for bugs that pass locally
and fail only in production:

- **case sensitivity** — Windows resolves `./Pages/Home.js` to `./pages/home.js`;
  Pages serves from Linux and does not
- **Jekyll safety** — a missing `.nojekyll`, or any underscore-prefixed path
- **orphan modules** — unreferenced files still sitting in the precache list
  (the service worker is excluded from the reference scan, or anything precached
  could never be reported)

---

## [1.4.0] — 2026-08-05 — Session 5: Polish

Accessibility, PWA install and update handling, performance, and a final
audit pass. Version 1.0 is complete.

### Added

**PWA install and update** (`js/services/pwa-service.js`)
- Install offer in Settings, shown only when installing is actually possible
  and hidden once the app is running standalone.
- Chrome's `beforeinstallprompt` is captured and deferred so the app chooses
  the moment. iOS has no install API at all, so it gets written Share → Add to
  Home Screen steps rather than a button that cannot work.
- The nudge is suppressed for a fortnight once dismissed; an install banner on
  every launch is an advert.
- Update detection with an explicit prompt. A waiting worker is told to
  `skipWaiting()` and the reload waits for `controllerchange` — reloading
  without that is served by the *old* worker, which is why PWAs are famous for
  shipping stale code for days. The prompt is deliberate rather than automatic:
  reloading out from under someone mid-set would be worse than running
  yesterday's build for another twenty minutes.

**Route announcements**
- A polite live region announces each view change. A hash change moves no
  focus and fires no navigation, so a screen reader otherwise gets no
  indication that anything happened.

**Audit tooling**
- `tools/audit.html` walks all nine routes in a phone-width frame and checks
  accessible names, alt text, form labels, duplicate ids, touch-target sizes,
  WCAG AA contrast against the real composited backdrop, horizontal overflow
  and heading order — in both themes.
- `tools/perf.html` measures the shell payload and asserts that the vendored
  libraries are *not* fetched on routes that do not need them.

### Changed

**Lazy route modules.** Page modules now load on first visit via native
`import()` rather than being imported up front. Home was paying for the chart
card, the PDF builder and the photo store before drawing a pixel.

| | before | after |
|---|---|---|
| Shell payload | 442.2 KB | **202.4 KB** |
| JavaScript | 378.5 KB | **138.7 KB** |
| Requests | 56 | **31** |

`tools/check.py` now validates dynamic import paths too, so a typo in a lazy
route cannot become a runtime-only failure on the one screen nobody clicked.

**Design tokens re-derived from measured contrast.** The audit found 228
issues, almost all tracing to two causes:

- `--c-text-3` measured **2.6–2.8:1** — well below AA — and it carries real
  content: stat labels, captions, section headings, tab bar labels. Apple's
  iOS alphas (0.62 / 0.34) do not survive on this surface. All three text tiers
  were raised until measured ≥ 4.5:1 in both themes, keeping the tier gap.
- White on `--c-accent` measured **3.65:1**. One accent cannot do both jobs, so
  there are now two: `--c-accent` for text and icons (5.3:1 on dark),
  `--c-accent-fill` for filled buttons (4.9:1 under white text).
- Light-mode `--c-success` sat at 4.40:1 and was darkened to 5.4:1.

**Touch targets.** Compact controls (34px segmented options, the 30px table
toggle, 36px icon buttons) keep their visual size but gain a transparent
`::after` that stretches the hit area to the 44px HIG minimum without moving a
pixel of layout.

### Fixed

- Home rendered a second `<h1>` alongside the app header's, so every view had
  two top-level headings.
- Hidden file inputs for photos and backup restore had no accessible name.
- The day-strip's selected chip and the photo angle switcher painted white text
  on the bright accent at 3.65:1.

### Audit result

Clean in both themes across all nine routes: no contrast failures, no unlabelled
controls, no undersized targets, no overflow, no heading jumps.

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

Version 1.0 is complete across all five sessions. Post-1.0 candidates are
recorded in `ROADMAP.md` under "Beyond 1.0"; known limitations and open items
are in `TODO.md`.
