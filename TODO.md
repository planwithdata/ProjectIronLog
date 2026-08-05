# TODO

Version 1.0 is complete. What follows is what is genuinely open, not a
wish-list. `ROADMAP.md` holds the post-1.0 candidates.

---

## Needs a decision from you

- [ ] **Cable Lateral Raise prescription.** You specified 3 sets. Reps, rest
      and increment are not in the source document, so it currently mirrors
      the Dumbbell Lateral Raise tier: **12–15 per side, 60 s rest, +1–2 kg**.
      Change it in `data/workouts.json` if you want something different.
- [ ] **Height and goal weight.** Settings → Profile. Height enables BMI; goal
      weight enables the "to goal" tile on Home, the reference line on the
      weight chart, and the review's hold-or-cut rule. You mentioned bulking to
      79 kg — entering it makes all four live.

## Before you rely on it

- [ ] **Log one real session on the phone**, end to end, and confirm the rest
      timer is still correct after the screen locks. This is the one behaviour
      the automated tests cannot cover — they prove the maths, not that iOS
      suspended the tab the way it does in a gym.
- [ ] **Deploy and install.** Push, enable Pages, open the URL in Safari,
      Share → Add to Home Screen. Then turn on airplane mode and confirm it
      launches and logs a set.
- [ ] **Take one backup** (Settings → Back up to JSON) and keep it somewhere
      other than the phone. This device is the only copy.
- [ ] **Visit every route once while online.** Page modules load on first
      visit, so the service worker only caches a screen after you have opened
      it. A route never visited online will not open offline — it fails with an
      explanation rather than a blank page, but it will not work.

## Known limitations

- [ ] **Exercise illustrations are placeholders.** The source PDF contains
      third-party photo collages, three images per card, with the detail text
      cropped out — not usable as per-exercise artwork. Needs licensed art or
      hand-drawn SVGs. The card layout already reserves the slot.
- [ ] **A JSON backup does not contain photo images.** Photos live in
      IndexedDB, deliberately — base64 in Local Storage would exhaust the
      quota within about two months. Bundling 40 MB of base64 into the backup
      would make the one export that must always work slow and fragile. Photos
      have to be saved separately.
- [ ] **A running rest timer is not persisted.** If Safari discards the tab
      mid-workout the logged sets survive but the countdown does not. This is
      deliberate: a stale timer restored from ten minutes ago is worse than no
      timer. Revisit only if it proves annoying in practice.
- [ ] **Volume treats dumbbell load as per-hand × 2** and counts only added
      weight for bodyweight lifts, so cross-exercise volume comparisons are
      approximate. Volume by muscle group credits a set's full load to each
      primary muscle and none to secondaries — relative emphasis, not a
      physiological total. Both are stated on the cards that show them.
- [ ] **`workingWeight` takes the heaviest completed set.** Correct for working
      up to a top set, but a mistyped heavy weight will anchor the engine to
      it. Session detail allows editing, so the fix exists; a sanity warning on
      an implausible jump would be better.
- [ ] **PR counts look inflated early on.** Every first-ever performance of a
      lift sets four records by definition (weight, reps, 1RM, volume), so the
      first fortnight reports dozens. It settles once there is history. This is
      inherent to deriving records from the log rather than storing them, which
      is the right trade — deleting a mislogged session correctly removes the
      record it created.
- [ ] **No conflict handling across two devices.** Not a bug today, since
      storage is per-device. It becomes one the moment Supabase sync is added.

## Housekeeping

- [ ] Bump `APP_VERSION` in `js/config.js` **and** `CACHE_VERSION` in
      `service-worker.js` together on every deploy, and add any new file to the
      service worker's `PRECACHE` list. `tools/check.py` verifies those paths
      exist but cannot know a file is missing from the list.
- [ ] Before each commit: `python tools/check.py`, `node --test tools/`, and
      `tools/e2e.html`. Before each release, add `tools/audit.html` (both
      themes) and `tools/perf.html`.
- [ ] The tool pages clear Local Storage on the origin they run against. Use a
      throwaway browser profile, never the one holding real training data.
