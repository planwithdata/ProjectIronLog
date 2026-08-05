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

## Before Session 3

- [ ] Log one real session end to end on the phone and confirm the rest timer
      behaves after the screen locks. This is the one behaviour the automated
      tests cannot cover — they can prove the maths, not that iOS suspended
      the tab the way it does in a gym.
- [ ] Push to GitHub and confirm the Pages URL installs on the iPhone Home
      Screen and launches offline.

## Session 3 work

- [ ] Chart.js must be vendored into `assets/`, not loaded from a CDN — a CDN
      script breaks offline and adds a third-party dependency to a app that
      currently has none. Add it to the service worker precache list.
- [ ] Charts need to read colours from the design tokens rather than
      hardcoding hex values, so light mode does not produce unreadable plots.
- [ ] Volume by muscle group needs a decision on how to attribute a compound
      lift across `primaryMuscles` and `secondaryMuscles`.

## Known limitations

- [ ] **Exercise illustrations are placeholders.** The source PDF contains
      third-party photo collages, three images per card, with the detail text
      cropped out — not usable as per-exercise artwork. Needs either licensed
      art or hand-drawn SVGs. The card layout already reserves the slot.
- [ ] **A running rest timer is not persisted.** If Safari discards the tab
      mid-workout the logged sets survive, but the countdown does not. This is
      deliberate: a stale timer restored from ten minutes ago would be worse
      than no timer. Revisit only if it turns out to be annoying in practice.
- [ ] **Volume treats dumbbell load as per-hand × 2** and counts only added
      weight for bodyweight lifts. Reasonable, but it makes cross-exercise
      volume comparisons approximate. The Session 3 charts will make the
      effect visible — reassess then.
- [ ] **`workingWeight` takes the heaviest completed set.** Correct for
      working up to a top set, but if a set is logged at a mistyped heavy
      weight the engine will anchor to it. Session detail allows editing, so
      the fix exists; a sanity warning on an implausible jump might be better.
- [ ] **No conflict handling for two devices.** Not a bug today — storage is
      per-device. It becomes one the moment Supabase sync is added.
- [ ] **Photos will dominate the storage quota.** Local Storage is ~5 MB per
      origin, and base64 inflates images ~33%. Session 4 needs a resize step
      on import, and Session 5 should consider IndexedDB for blobs. The
      adapter boundary means only `storage-adapter.js` would change.

## Housekeeping

- [ ] Bump `APP_VERSION` in `js/config.js` **and** `CACHE_VERSION` in
      `service-worker.js` together on every deploy, and add any new file to
      the service worker's `PRECACHE` list. `tools/check.py` verifies the
      paths exist but cannot know a file is missing from the list.
- [ ] Run all three before each commit:
      `python tools/check.py`, `node --test tools/test.mjs`, and `tools/e2e.html`.
