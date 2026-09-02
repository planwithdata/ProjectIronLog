# TODO

Version 1.9.0 is complete. What follows is what is genuinely open, not a
wish-list. `ROADMAP.md` holds the post-1.0 candidates.

---

## Do this before you next open the app on the phone

- [ ] **Take a backup from the phone first** (Settings → Back up to JSON), if the
      one in the repo root is not already current. The v3 → v4 migration runs
      once, at first boot of the new build — but a backup you hold yourself is
      the one that cannot be affected by a bug in the thing being upgraded.
      `tools/test-flow.mjs` proves the current repo backup restores into this
      build and produces identical recommendations afterwards, so this is
      belt-and-braces rather than a real risk.
- [ ] **Look at Progress once.** It opens with the reading rather than a chart
      now: *am I getting stronger*, which lifts need attention, and where the
      progress is coming from. Four exercises will be listed under **Load scale
      changed** — the low-to-high fly, both rope triceps movements and the
      straight-arm pulldown — because their numbers jump by more than any
      programmed increment can explain. That is correct and it is the point.
- [ ] **Tag the machines as you go.** Nothing needs doing retroactively. The next
      time you log one of those four, tap **Tag machine** on the card and name
      the stack. From then on that machine has its own load history, the flag
      goes away, and the tag pre-fills every subsequent session.
- [ ] **Check the flat bench card.** It should read **55 kg**, not 72. If you
      want the 72 kg set on 25 August marked explicitly, History → that session
      → the set row's ▲ toggle. The prescription is already correct without it —
      the marking only makes the reasoning visible.

## Needs a decision from you

- [ ] **Are the leg press and calf-raise numbers plate loads?** Week one has Leg
      Press at `110 / 160 / 200` kg and Standing Calf Raise topping out at 200,
      while Incline Dumbbell Press tops out at 27.5 kg per hand. Those are hard
      to reconcile on the same lifter, so either they mean something other than
      plates on a bar, or they are a mislog. **The app has changed nothing and
      will change nothing** — it preserves and displays exactly what was entered.
      Editing the session in History fixes it if it is wrong.

      1.9.0 removes most of the sting: the prescription is built on the load at
      least half the sets were performed at, so a single mistyped set no longer
      sets the week, and on a machine-scaled movement an implausible jump is
      flagged rather than obeyed. What it still cannot do is tell a mistype from
      a genuinely heavy machine.
- [ ] **Bar weights.** RDL and Hip Thrust assume a 20 kg Olympic bar, which only
      affects the *estimated total* line. The EZ bar and the Smith machine claim
      no bar weight, because theirs vary and guessing would present a made-up
      number as a measurement. Hack Squat claims none either — a sled's carriage
      weight is a property of that specific machine. Add `barWeightKg` in
      `data/workouts.json` if you want those totals.
- [ ] **Are there other substitutions you actually make?** The program now lists
      four: bar for rope pushdown, bar for overhead rope extension, pec deck for
      the cable fly, and neutral-grip for wide-grip pulldown. Adding one is a
      `substitutions` entry on the exercise plus a definition in
      `substituteExercises`, and the program refuses to load if the second is
      missing. Anything not listed is refused rather than invented.
- [ ] **Is the Pallof press right now?** Two sets, `10-12/side`, 30–45 seconds'
      rest, a two-second hold, and no progression. If you would rather it kept
      progressing, change `progression.mode` back to `weight` in
      `data/workouts.json` — the `maintain` mode is a per-exercise setting, not
      a global policy.

## Before you rely on it

- [ ] **Log one real session on the phone**, end to end, including a ramp, one
      drop set and one machine tag, and confirm the rest timer is still correct
      after the screen locks. This is the one behaviour the automated tests
      cannot cover — they prove the maths, not that iOS suspended the tab the
      way it does in a gym.
- [ ] **Try starting a different day's workout.** Home → *Do a different day's
      workout*, or the day strip on the Workout screen. Finish it and check
      History shows both facts: which workout it was, and that it was performed
      *n* days late.
- [ ] **Confirm the morning reminder appears once and only once.** It fires on a
      training day when the day's weight is missing, and records that it fired on
      render, so a reload should not bring it back.
- [ ] **Deploy and install.** Push, open the URL in Safari, Share → Add to Home
      Screen. Then airplane mode and confirm it launches and logs a set.
- [ ] **Visit every route once while online.** Page modules load on first visit,
      so the service worker only caches a screen after you have opened it.

## Known limitations

- [ ] **Untagged history stays untagged.** The v3 → v4 migration deliberately
      guesses no machine tags — see the README for why at length. So the four
      flagged exercises will keep showing *Load scale changed* until each is
      logged once with a tag. That is a feature, but it does mean the first
      week after this release has four exercises whose trend cannot be read.
- [ ] **Legacy sets are counted as working sets.** They are the only record of
      what was lifted, so discarding them would be worse — but until they are
      classified, week one's ramp sets are inflating that period's working-set
      volume and set counts. Reports label them *unclassified* wherever they
      appear, the review states the count separately, and the insights engine
      refuses to compare an unclassified session against a classified one.
- [ ] **The repeatable-load rule is deliberately conservative.** On a genuine
      ascending scheme — three sets where each is meant to be heavier — it reads
      the middle set rather than the top, and prescribes slightly light. There is
      no such prescription in the current program (the one ascending ladder,
      Cable Lateral Raise, has its own `setPlan` branch), so this is a note
      rather than a bug. If one is ever added, give it a `setPlan`.
- [ ] **`insights` needs two comparable sessions to say anything, and five to be
      confident.** Early in a wave, or right after a machine change, most of the
      page will say "too new to read". That is honest, and it will fill in.
- [ ] **A JSON backup does not contain photo images.** Photos live in IndexedDB,
      deliberately — base64 in Local Storage would exhaust the quota within about
      two months. Photos have to be saved separately.
- [ ] **A running rest timer is not persisted.** If Safari discards the tab
      mid-workout the logged sets survive but the countdown does not. Deliberate:
      a stale timer restored from ten minutes ago is worse than no timer.
- [ ] **Pain logging is a per-exercise note, not a history.** One log per exercise
      per session, overwritten if edited. Enough for "my elbow hurt on pull-ups";
      not a symptom diary.
- [ ] **PR counts look inflated early on.** Every first-ever performance sets
      several records by definition. Inherent to deriving records from the log,
      which is the right trade. The *headline* record is now the heaviest
      repeated load, which moves far less often and means more when it does.
- [ ] **No conflict handling across two devices.** Not a bug today, since storage
      is per-device. It becomes one the moment sync is added.

## Housekeeping

- [ ] Bump `APP_VERSION` in `js/config.js` **and** `CACHE_VERSION` in
      `service-worker.js` together on every deploy, and add any new file to the
      service worker's `PRECACHE` list. `tools/check.py` verifies those paths
      exist and that no module is orphaned, but cannot know a file is missing
      from the list.
- [ ] Before each commit:

      ```
      python tools/check.py
      node tools/check-imports.mjs
      node --test tools/test.mjs tools/test-sets.mjs tools/test-migration.mjs \
                 tools/test-pyramid.mjs tools/test-review.mjs \
                 tools/test-flow.mjs tools/test-real-data.mjs
      ```

      then, in a throwaway browser profile served over HTTP,
      `tools/smoke.html`, `tools/e2e.html` and `tools/probe.html?open=1`.
      `node --test tools/` does not expand the directory on Windows.
- [ ] Use a **fresh** `--user-data-dir` for each headless run. A profile that
      has loaded the app holds a service worker and will serve the build you
      were debugging rather than the one you just changed.
- [ ] Before each release, add `tools/audit.html` (both themes) and
      `tools/perf.html`.
- [ ] The tool pages clear Local Storage on the origin they run against. Use a
      throwaway browser profile, never the one holding real training data.
- [ ] **`js/reports/pdf-report.js` contains a literal NUL byte**, inside the
      character class of the PDF text sanitiser's regex — a real 0x00 in the
      source where the two-character escape `\x00` was meant. Git therefore
      treats the whole file as binary: no diffs, no line-level history, no
      merges. Writing it as that escape would fix it, but the regex decides
      which characters reach a generated PDF, so it wants its own change with
      `tools/pdf-dump.html` checked afterwards. Pre-existing;
      noticed while working nearby.
- [ ] `tools/test-migration.mjs`, `tools/test-real-data.mjs` and
      `tools/test-flow.mjs` use `ironlog-backup-*.json` from the repo root as a
      fixture when one is present, and skip those tests when it is not. The
      backup file is gitignored — keep it local.
