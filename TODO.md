# TODO

Version 1.8.0 is complete. What follows is what is genuinely open, not a
wish-list. `ROADMAP.md` holds the post-1.0 candidates.

---

## Do this before you next open the app on the phone

- [ ] **Take a backup from the phone first** (Settings → Back up to JSON), if the
      one in the repo root is not already current. The v1 → v2 migration runs
      once, at first boot of the new build, and writes its own parachute — but a
      backup you hold yourself is the one that cannot be affected by a bug in the
      thing being upgraded.
- [ ] **After the first launch, check Settings → Data.** It should offer
      *Download pre-upgrade snapshot*. Pull that file off the phone and keep it
      with the backup. Once you are satisfied the history looks right, it can be
      deleted from Settings — nothing deletes it automatically.
- [ ] **Look at week one in History.** Every entry will read *unclassified*, which
      is correct: the app will not guess which of `150×12, 180×10, 200×8, 220×6`
      were ramp sets. If you want those five sessions split properly, each entry
      has **Classify these sets**. Ignoring it entirely is also fine — legacy sets
      keep feeding progression either way.

## Needs a decision from you

- [ ] **Are the leg press and calf-raise numbers plate loads?** Week one has Leg
      Press at `110 / 160 / 200` kg and Standing Calf Raise topping out at 200,
      while Incline Dumbbell Press tops out at 27.5 kg per hand. Those are hard
      to reconcile on the same lifter, so either they mean something other than
      plates on a bar, or they are a mislog. **The app has changed nothing and
      will change nothing** — it preserves and displays exactly what was entered.
      Editing the session in History fixes it if it is wrong. 1.8.0 takes some of
      the sting out of this: the coming week is baselined from the *second*
      working set rather than the heaviest, so a single mistyped top set no
      longer sets the whole week's prescription.
      (The same question hung over Back Squat at `150 / 180 / 200 / 220`. That
      movement has since been replaced by Hack Squat, which starts its own load
      history, so the question is now moot for legs.)
- [ ] **Bar weights.** RDL and Hip Thrust assume a 20 kg Olympic bar, which only
      affects the *estimated total* line. The EZ bar and the Smith machine claim
      no bar weight, because theirs vary and guessing would present a made-up
      number as a measurement. Hack Squat claims none either — a sled's carriage
      weight is a property of that specific machine. Add `barWeightKg` in
      `data/workouts.json` if you want those totals.
- [ ] **Height** is set (177.8 cm), so BMI works. Nothing else is outstanding.

## Before you rely on it

- [ ] **Log one real session on the phone**, end to end, including a ramp and one
      drop set, and confirm the rest timer is still correct after the screen
      locks. This is the one behaviour the automated tests cannot cover — they
      prove the maths, not that iOS suspended the tab the way it does in a gym.
- [ ] **Confirm the morning reminder appears once and only once.** It fires on a
      training day when the day's weight is missing, and records that it fired on
      render, so a reload should not bring it back.
- [ ] **Deploy and install.** Push, open the URL in Safari, Share → Add to Home
      Screen. Then airplane mode and confirm it launches and logs a set.
- [ ] **Visit every route once while online.** Page modules load on first visit,
      so the service worker only caches a screen after you have opened it.

## Known limitations

- [ ] **Legacy sets are counted as working sets.** They are the only record of
      what was lifted, so discarding them would be worse — but until they are
      classified, week one's ramp sets are inflating that period's working-set
      volume and set counts. Reports label them *unclassified* wherever they
      appear, and the review states the count separately.
- [ ] **Dumbbell and cable-fly volume figures changed with this release.** No
      stored number was touched; the multipliers were wrong relative to how you
      log. Volume for those lifts is now roughly half what it read before, so
      the first review after this upgrade will show a volume "drop" that is an
      accounting correction, not lost work.
- [ ] **`workingWeight` takes the heaviest completed working set.** Correct for
      working up to a top set, but a mistyped heavy weight still anchors the
      engine to it. A sanity warning on an implausible jump would be better —
      see the leg press question above for why this is not theoretical.
      `WORKING_SET_REBASELINE` in `js/config.js` is a one-week override of this,
      not a fix for it: it expires after five completed sessions and the default
      goes back to the heaviest set.
- [ ] **A JSON backup does not contain photo images.** Photos live in IndexedDB,
      deliberately — base64 in Local Storage would exhaust the quota within about
      two months. Photos have to be saved separately.
- [ ] **A running rest timer is not persisted.** If Safari discards the tab
      mid-workout the logged sets survive but the countdown does not. Deliberate:
      a stale timer restored from ten minutes ago is worse than no timer.
- [ ] **Pain logging is a per-exercise note, not a history.** One log per exercise
      per session, overwritten if edited. Enough for "my elbow hurt on pull-ups";
      not a symptom diary.
- [ ] **PR counts look inflated early on.** Every first-ever performance sets four
      records by definition. Inherent to deriving records from the log, which is
      the right trade.
- [ ] **No conflict handling across two devices.** Not a bug today, since storage
      is per-device. It becomes one the moment sync is added.

## Housekeeping

- [ ] Bump `APP_VERSION` in `js/config.js` **and** `CACHE_VERSION` in
      `service-worker.js` together on every deploy, and add any new file to the
      service worker's `PRECACHE` list. `tools/check.py` verifies those paths
      exist and that no module is orphaned, but cannot know a file is missing
      from the list.
- [ ] Before each commit: `python tools/check.py`, then
      `node --test tools/test.mjs tools/test-sets.mjs tools/test-migration.mjs
      tools/test-pyramid.mjs tools/test-review.mjs`, then `tools/e2e.html`.
      `node --test tools/` does not expand the directory on Windows.
- [ ] Before each release, add `tools/audit.html` (both themes) and
      `tools/perf.html`.
- [ ] The tool pages clear Local Storage on the origin they run against. Use a
      throwaway browser profile, never the one holding real training data.
- [ ] `tools/test-migration.mjs` uses `ironlog-backup-*.json` from the repo root
      as a fixture when one is present, and skips that test when it is not. The
      backup file is gitignored — keep it local.
