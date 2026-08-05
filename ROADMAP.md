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

## Session 2 — Workout engine

- [ ] Workout screen with live set logging
- [ ] Exercise cards: target weight, last workout, target reps, rep range
- [ ] Per-set entry: weight, reps, completed, optional RPE
- [ ] Rest timer — per-exercise duration, auto-start, background-safe
- [ ] Workout completion flow and summary
- [ ] Workout history
- [ ] Edit or delete a past session
- [ ] **Progressive overload engine** — double progression as pure functions
      over the session log:
  - [ ] Recommend hold vs. advance from the previous session
  - [ ] Per-set rep targets, not just a weight
  - [ ] Handle `reps-first` bodyweight lifts
  - [ ] Deload week set/load adjustment
  - [ ] Stall detection at 3 sessions → drop ~10%
  - [ ] Support dumbbell, barbell, machine, cable, smith and bodyweight
- [ ] Resume a session Safari discarded mid-workout

## Session 3 — Progress dashboard

- [ ] Chart.js integration, themed from the design tokens
- [ ] Body weight: daily entries, 7-day and 30-day averages, trend graph
- [ ] Lean bulk rate readout
- [ ] Body composition — all ten scale metrics, each with a graph
- [ ] PR engine surfaced: badges for weight, reps, estimated 1RM, volume
- [ ] Strength progress per exercise
- [ ] Volume tracking by muscle group and by week
- [ ] Workout consistency and streak history

## Session 4 — Reports

- [ ] jsPDF report generator: cover, body metrics, weight trend, composition,
      strength progress, completion, volume, overload summary, PRs, recovery,
      measurements, photos, coach notes, training summary
- [ ] JSON export
- [ ] CSV export
- [ ] Progress photos — front, back, side, relaxed, flexed; every two weeks
- [ ] Swipe comparison between photo dates
- [ ] Coach notes editor with scoping to a day or exercise
- [ ] Recovery logs — sleep, soreness, energy
- [ ] Tape measurements
- [ ] Two-week review generator with a rule-based training summary

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
