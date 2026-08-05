# TODO

Open items, ordered by when they need attention. `ROADMAP.md` holds the
feature plan; this file holds the loose ends.

---

## Needs a decision from you

- [ ] **Cable Lateral Raise prescription.** You specified 3 sets. Reps, rest
      and increment are not in the source document, so it currently mirrors
      the Dumbbell Lateral Raise tier: **12–15 per side, 60 s rest, +1–2 kg**.
      Correct it in `data/workouts.json` if you want something different.
- [ ] **Height and goal weight.** Settings → Profile. Height enables BMI;
      goal weight enables the "to goal" tile on Home. The prompt mentioned
      bulking to 79 kg — enter it and it becomes live.
- [ ] **Starting weights.** The program says to pick a weight where the last
      1–2 reps of the first set are genuinely hard. Nothing to enter yet —
      Session 2's logging screen captures these on the first session of each
      lift.

## Before Session 2

- [ ] Confirm the parsed program against the real thing — open
      `#/workout` and step through all five training days.
- [ ] Push to GitHub and confirm the Pages URL installs on the iPhone Home
      Screen and launches offline.

## Session 2 work

- [ ] Progression engine as pure functions in `js/engine/` so it is testable
      without a DOM.
- [ ] Rest timer must survive the screen locking. `setInterval` is throttled
      or suspended in a backgrounded tab — compute remaining time from a
      stored start timestamp rather than counting ticks.
- [ ] Numeric set entry needs to be usable with sweaty thumbs: large targets,
      stepper buttons as well as a keypad, and no accidental page zoom.
- [ ] Decide how a mid-workout exercise substitution is recorded, so a
      swapped lift does not silently break that exercise's history.

## Known limitations

- [ ] **Exercise illustrations are placeholders.** The source PDF contains
      third-party photo collages, three images per card, with the detail text
      cropped out — not usable as per-exercise artwork. Needs either licensed
      art or hand-drawn SVGs. The card layout already reserves the slot.
- [ ] **Volume treats dumbbell load as per-hand × 2** and counts only added
      weight for bodyweight lifts. Reasonable, but it makes cross-exercise
      volume comparisons approximate. Revisit when the Session 3 charts make
      the effect visible.
- [ ] **No conflict handling for two devices.** Not a bug today — storage is
      per-device. It becomes one the moment Supabase sync is added.
- [ ] **Photos will dominate the storage quota.** Local Storage is ~5 MB per
      origin, and base64 inflates images ~33%. Session 4 needs a resize step
      on import, and Session 5 should consider IndexedDB for blobs. The
      adapter boundary means only `storage-adapter.js` would change.

## Housekeeping

- [ ] `js/engine/` is empty until Session 2 — Git will not track it, so it
      appears on the first engine commit.
- [ ] Bump `APP_VERSION` in `js/config.js` **and** `CACHE_VERSION` in
      `service-worker.js` together on every deploy. They are duplicated
      because a service worker cannot import a module.
- [ ] Run `python tools/check.py` before each commit.
