# Roadmap

Five build sessions to version 1.0, then Session 6 to make the app match how
its user actually trains. Each one ships something that works on its own and is
committed separately.

---

## Session 1 — Architecture ✅ complete

- [x] Folder structure
- [x] Design system: tokens, base, layout, components
- [x] Navigation — tab bar on phone, sidebar from 1024px
- [x] Home page
- [x] Responsive layout — iPhone, iPad, desktop
- [x] Storage architecture — adapter → db → services
- [x] Parse `Rish_WorkoutRoutine.pdf` and `Rish Workout Program.docx`
- [x] Structured `data/workouts.json` (37 exercises, 5 training days)
- [x] PWA — manifest, icons, offline cache
- [x] Backup & restore (brought forward: real logging starts next session,
      and data that cannot be exported is data that can be lost)
- [x] Theme and units
- [x] README, ROADMAP, CHANGELOG, TODO
- [x] Static check tooling and a responsive preview harness
- [x] Git initialised

## Session 2 — Workout engine ✅ complete

- [x] Workout screen with live set logging
- [x] Exercise cards: target weight, last workout, target reps, rep range
- [x] Per-set entry: weight, reps, completed, optional RPE
- [x] Rest timer — per-exercise duration, auto-start, survives a screen lock
- [x] Workout completion flow and summary sheet
- [x] Workout history with per-session detail
- [x] Edit or delete a past session (re-open, then change)
- [x] **Progressive overload engine** — double progression as pure functions:
  - [x] Recommend hold vs. advance from the previous session
  - [x] Per-set rep targets, not just a weight
  - [x] `reps-first` bodyweight lifts
  - [x] Deload week set and load adjustment
  - [x] Stall detection at 3 sessions → drop ~10%
  - [x] Dumbbell, barbell, machine, cable, smith and bodyweight
- [x] Resume a session Safari discarded mid-workout
- [x] Add or remove sets mid-workout
- [x] Engine unit tests (28) and service integration tests (61)

## Session 3 — Progress dashboard ✅ complete

- [x] Chart.js vendored (not CDN), lazy-loaded, themed from the design tokens
- [x] Categorical chart palette, validated against both app surfaces
- [x] A table view on every chart (the contrast relief, and hover-free access)
- [x] Body weight: daily entries, 7-day and 30-day averages, trend graph
- [x] Goal weight as a reference line
- [x] Lean bulk rate readout
- [x] Body composition — all ten metrics as small multiples, one axis each
- [x] PR badges for estimated 1RM, with a "New" marker
- [x] Strength progress per exercise (estimated 1RM + top set)
- [x] Volume tracking: weekly volume, sets per week, volume by muscle group
- [x] Workout consistency per week
- [x] Analytics engine, pure and tested (14 further assertions)

## Session 4 — Reports ✅ complete

- [x] jsPDF report generator: cover, body metrics, weight trend, composition,
      strength progress, completion, volume, overload summary, PRs, recovery,
      measurements, photos, coach notes, training summary
- [x] Selectable PDF sections
- [x] JSON export
- [x] CSV export — seven datasets, RFC 4180 escaped
- [x] Progress photos — five angles, IndexedDB blob store, downscaled on import
- [x] Swipe comparison between photo dates
- [x] Coach notes editor with day/exercise scoping, pin and archive
- [x] Recovery logs — sleep, soreness, energy, stress
- [x] Tape measurements — eleven sites with change-vs-last
- [x] Two-week review generator with a rule-based training summary
- [x] Review engine tests (20) and a PDF integration test

## Session 5 — Polish ✅ complete

- [x] Motion pass — entrance stagger, spring presses, sheet transitions,
      ring fills, reduced-motion honoured throughout
- [x] Install prompt (native on Chrome, written steps on iOS) and an
      update-available prompt that actually applies the update
- [x] Offline hardening — complete precache, graceful failure for a route
      whose module was never fetched
- [x] Performance — lazy route modules: shell 442 KB → 202 KB, JS 378 → 139 KB
- [x] Accessibility — all three text tiers and both accents re-derived from
      measured contrast; 44px hit areas; route announcements; audit clean in
      both themes across all nine routes
- [x] Bug fixing — see the CHANGELOG's Fixed sections for each session
- [x] Documentation — README, ROADMAP, CHANGELOG, TODO
- [x] Final review

## Session 6 — How Rish actually trains ✅ complete

Version 1.0 was a faithful implementation of the program document. Session 6 is
where the app stopped assuming the document was the whole story. Driven entirely
by how the first week of real logging actually looked.

- [x] **Warm-up / working / intensity split in the data model**, not just the UI —
      `warmupSets`, `sets`, `intensitySets` as separate arrays, so the
      progression engine cannot see anything but working sets
- [x] Ramp-up sets, pre-filled at 40/60/80% for the compounds the program
      prescribes them for, addable to any exercise
- [x] Drop-set sequences (multi-stage, failure recorded on the first rung) and
      single failure sets — optional, per-exercise, never prescribed
- [x] **Load conventions**: plates for a barbell, total-of-both for dumbbells
      shown per hand, raw values for machines and cables, added load only for
      bodyweight — all display-side, none rewriting a stored number
- [x] Dumbbell increments applied per hand, so recommendations land on real pairs
- [x] Pain-aware logging: score, location, action, substitution — excluded from
      stall detection and from the review's strength comparison
- [x] Difficulty-first progression for the ab wheel, with load as the last rung
- [x] Optional push-up warm-up before chest, contributing nothing to working
      volume by construction
- [x] Morning weigh-in reminder — and the **weight entry UI that had been missing
      since Session 1**, plus a Body tab for all ten scale metrics
- [x] Training Preferences: fourteen conventions, stored and editable
- [x] Reports that keep warm-up, working and intensity volume apart
- [x] Backup safety: last-backup date, and a pre-upgrade parachute
- [x] **Schema v1 → v2 migration**, strictly additive, idempotent, and asserted
      against the real exported backup
- [x] Manual reclassification for pre-upgrade sets, because the app refuses to
      guess which of them were ramps
- [x] 121 engine assertions, 117 integration assertions

---

## Version 1.0 — complete

All five sessions delivered. What ships:

- 37 exercises across 5 training days, parsed from the source documents
- Double progression engine with deload waves and stall detection
- Live set logging, a rest timer that survives a screen lock, workout history
- Charts for weight, composition, strength, volume, consistency; PR badges
- PDF/CSV/JSON export, progress photos, coach notes, recovery, measurements
- A rule-based two-week review with a traceable recommendation
- Installable, offline-capable, no backend, no account, no tracking
- 62 engine assertions, 84 integration assertions, a clean accessibility audit
  (121 and 117 respectively as of Session 6)

## Beyond 1.0

Not committed to, recorded so the decisions are not re-litigated later:

- **Supabase sync.** The adapter boundary exists for this. Would add
  multi-device access at the cost of an account and a network dependency.
- **Exercise illustrations.** The source documents contain photo collages
  rather than per-exercise artwork. Would need either licensed art or
  hand-drawn SVGs.
- **Alternate programs.** Already supported by the data model — a second
  `workouts.json` and a program picker is all it needs.
- ~~**Warm-up set tracking.** Deliberately excluded for now: the program says
  ramp-up sets are not counted, and logging them would dilute volume trends.~~
  **Done in Session 6** — and the reasoning above turned out to be the wrong
  conclusion from the right premise. Ramp-up sets genuinely must not count
  towards volume or progression; that is an argument for tracking them
  *separately*, not for not tracking them. Logging them into their own array
  dilutes nothing.
- **A plausibility warning on a logged load.** `workingWeight` anchors the engine
  to the heaviest completed working set, so one mistyped number quietly becomes
  the prescription. Week one contains a 220 kg squat next to a 27.5 kg/hand
  incline press — whether or not that is a mislog, the app should be able to
  say "that is a 40% jump, is it right?" without refusing the entry.
- **Pain history rather than a pain note.** Today it is one log per exercise per
  session. A trend line for a recurring elbow would be more useful, and would
  need its own collection.
- **Plate calculator** for barbell lifts — now that the app knows a logged
  barbell number is plates and what the bar weighs, this is a small addition.
- **Apple Health import** for body weight, so the morning weigh-in is not typed
  twice.
