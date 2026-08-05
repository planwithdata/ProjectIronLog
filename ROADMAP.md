# Roadmap

Five build sessions to version 1.0. Each one ships something that works on its
own and is committed separately.

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

## Session 5 — Polish

- [ ] Motion pass — sheet transitions, ring fills, press feedback
- [ ] Install prompt and update-available prompt
- [ ] Offline hardening and cache-size management for photos
- [ ] Performance: first paint, long-list rendering
- [ ] Accessibility: focus order, VoiceOver labels, contrast audit, reduced motion
- [ ] Bug fixing pass
- [ ] Documentation finalised
- [ ] Final review

---

## Beyond 1.0

Not committed to, recorded so the decisions are not re-litigated later:

- **Supabase sync.** The adapter boundary exists for this. Would add
  multi-device access at the cost of an account and a network dependency.
- **Exercise illustrations.** The source documents contain photo collages
  rather than per-exercise artwork. Would need either licensed art or
  hand-drawn SVGs.
- **Apple Health import** for body weight, so the morning weigh-in is not
  typed twice.
- **Plate calculator** for barbell lifts.
- **Alternate programs.** Already supported by the data model — a second
  `workouts.json` and a program picker is all it needs.
- **Warm-up set tracking.** Deliberately excluded for now: the program says
  ramp-up sets are not counted, and logging them would dilute volume trends.
