# Project IronLog

A personal gym companion. Mobile-first Progressive Web App: installable on an
iPhone Home Screen, works offline, stores everything on the device, and never
talks to a server.

<<<<<<< HEAD
=======
**Version 1.7.0 — six build sessions delivered.** Session 6 separates warm-up,
working and intensity sets, and teaches the app how Rish actually logs a load.
See [Rish's Training Preferences](#rishs-training-preferences).

---

## What it does today

| Area | Status |
|---|---|
| Design system, app shell, navigation | Done |
| Home page | Done |
| Program data parsed from source documents | Done — 38 exercises across 5 training days |
| Progressive overload engine | Done — double progression, deload wave, stall detection, **working sets only** |
| Warm-up / working / intensity set model | Done — separate in the data model, not just the UI |
| Load conventions (plates, per-hand, raw machine) | Done — display-side, never rewrites stored numbers |
| Pain-aware logging | Done — optional, non-diagnostic, excluded from stall detection |
| Body weight & scale entry | Done — morning reminder, quick sheet, full Body tab |
| Training Preferences | Done — configurable, not hardcoded |
| Workout history | Done — per-session detail, re-open, delete |
| Workout page | Live set logging, rest timer, completion summary |
| Storage layer with backup & restore | Done |
| Theme (dark / light / system), units (kg / lb) | Done |
| PWA: manifest, icons, offline cache | Done |
| Progress dashboard | Done — weight, composition, strength, volume, consistency, PRs |
| Reports — PDF, CSV, JSON | Done |
| Progress photos, coach notes, recovery, measurements | Done |
| Two-week review generator | Done — rule-based, traceable |
| Install & update prompts | Done |
| Accessibility | Done — audit clean in both themes, all nine routes |
| Exercise illustrations | Done — start/end frames for all 37 loaded lifts |
| Performance | Done — 202 KB shell, lazy route modules |

### By the numbers

| | |
|---|---|
| Shell payload | 243 KB cold (31 requests, incl. the 35 KB program file) · first paint ~70 ms locally |
| Engine tests | 121 assertions (`node --test tools/test*.mjs`) |
| Integration tests | 117 assertions (`tools/e2e.html`) |
| Accessibility audit | clean, both themes, all nine routes |
| Dependencies | 2, both vendored: Chart.js 4.5.1, jsPDF 3.0.1 |
| Illustrations | 74 images, 0.96 MB, public domain, lazy-loaded |
| Build step | none |

>>>>>>> c1ebcf1 (Session 6: warm-up / working / intensity sets, and Rish's load conventions)
---

## Running it

No build step, no dependencies, no toolchain. But it does need to be served
over HTTP — ES modules and service workers do not work from `file://`.

### Installing on an iPhone

Open the Pages URL in Safari → Share → **Add to Home Screen**. It launches
standalone, with no browser chrome, and works with no signal.

---

## Architecture

```
UI (pages, components)    never touches storage directly
        ↓
Domain services           program · session · body · notes · pr · settings
        ↓
db.js                     collections, cache, migrations, export/import
        ↓
storage-adapter.js        the ONLY module that knows Local Storage exists
        ↓
Local Storage
```

### The layer rules

1. **A page never reads storage.** It calls a service. A service calls `db`.
   Only `db` calls the adapter. This is what makes the Supabase swap a
   one-line change instead of a rewrite.
2. **The adapter is fully async** even though Local Storage is synchronous.
   Paying the `await` cost now means the real async backend later needs no
   call-site changes.
3. **`db` keeps a hydrated in-memory cache**, so pages read synchronously and
   render in one frame. Writes go straight through and return a promise.
4. **Weights are always stored in kilograms.** kg/lb is a display concern
   (`format.displayWeight`), so switching units never rewrites stored data.
5. **Dates are local calendar days** (`YYYY-MM-DD`), not timestamps. A session
   logged at 22:00 must not become yesterday's after a timezone change.

### Directory map

```
index.html                 shell + anti-flash theme shim
manifest.json              PWA metadata
service-worker.js          precache + offline strategy

css/
  tokens.css               ALL colour, type, space, radius, motion values
  base.css                 reset, element defaults, text utilities, a11y
  layout.css               app shell, header, tab bar → sidebar, grids
  components.css           card, button, pill, stat, ring, list, input, toast
  workout.css              set rows, rest bar, sheets, history chips

js/
  config.js                app name and version
  app.js                   boot sequence
  core/
    dom.js                 el() builder, icon set, escaping
    format.js              dates, numbers, durations, unit conversion
    events.js              pub/sub bus
    router.js              hash router
  services/
    storage-adapter.js     Local Storage implementation of the adapter
    db.js                  repository, cache, migrations, backup
    program-service.js     reads data/workouts.json
    session-service.js     workout sessions and derived stats
    body-service.js        body weight and composition
    notes-service.js       coach notes
    pr-service.js          personal record detection
    settings-service.js    preferences, profile, theme
    training-prefs-service.js  how this user trains (conventions, not taste)
    reminder-service.js    the once-a-day morning weigh-in prompt
    rest-timer.js          timestamp-based rest countdown
  engine/
    progression.js         double progression — pure, tested
    set-model.js           warm-up / working / intensity split — pure, tested
    loading.js             what a logged number means — pure, tested
    one-rep-max.js         Epley estimate — pure, tested
    logs-service.js        recovery, measurements, photos
    photo-store.js         IndexedDB blob store for photos
    review-service.js      gathers figures for the review engine
    pwa-service.js         install and update handling
  engine/
    review.js              two-week review rules — pure, tested
  charts/                  lazy Chart.js loader, palette, theming
  reports/                 PDF builder, CSV, photo embedding
  pages/                   loaded lazily by the router

components/                nav, ring, stat, toast, set-row, rest-bar, sheet,
                           chart-card, intensity-block, weight-entry
data/workouts.json         the training program (replaceable)
icons/                     PWA icons, generated from icon.svg
tools/                     check.py, test.mjs, test-sets.mjs, test-migration.mjs,
                           e2e.html, preview.html, probe.html
```

### Why these choices

**Vanilla ES modules, no bundler.** The app must still run in five years.
A build chain is the part of a project that rots first; native modules are a
browser feature that cannot be abandoned. The cost is more HTTP requests on a
cold load, which the service worker eliminates after the first visit.

**Hash routing (`#/workout`).** GitHub Pages serves static files and cannot
rewrite `/workout` to `index.html`, so a History-API route would 404 on
refresh or on a shared link. Hash routes are resolved in the browser and work
from any host.

**Design tokens as CSS custom properties.** One file defines every colour and
spacing value. Light mode is a token override — no component stylesheet knows
a theme exists. Every text and accent value was **measured** against the
surface it actually renders on and raised until it cleared WCAG AA; Apple's own
iOS alphas do not survive that test here. `tools/audit.html` re-checks it.

**Two accent tokens.** `--c-accent` reads as text on a near-black surface
(5.3:1); `--c-accent-fill` carries white button text (4.9:1). One value cannot
do both jobs, and white on the bright accent measured 3.65:1.

**Lazy route modules.** Pages load on first visit via native `import()`.
Importing all nine up front cost 442 KB before Home drew a pixel; it is now
202 KB. Stylesheets stay eager — splitting CSS per route trades a flash of
unstyled content for a few kilobytes, which is the wrong way round.

**Tab bar becomes a sidebar at 1024px.** A bottom tab bar is a phone pattern;
on a desktop it strands navigation at the far edge of the window.

**One deliberate architecture exception:** a small inline script in
`index.html` reads the theme from Local Storage before first paint. It has to
run before the module graph loads, and without it a light-mode user sees a
black flash on every launch. It only ever reads, and only that one key.

---

## The training program

`data/workouts.json` holds the entire program. Replacing that file replaces
the program — no code changes, and logged history stays intact because
sessions reference exercise `id`s, not names or prescriptions.

Parsed from `Rish Workout Program.docx` (sets, reps, rest, weight increments)
and `Rish_WorkoutRoutine.pdf` (weekly split, per-day focus notes).

| Day | Focus | Exercises | Sets |
|---|---|---|---|
| Monday | Rest | — | — |
| Tuesday | Chest Priority | 9 + warm-up | 28 |
| Wednesday | Back & Biceps | 8 | 25 |
| Thursday | Legs | 6 | 20 |
| Friday | Recovery | — | — |
| Saturday | Upper | 8 | 26 |
| Sunday | Posterior Chain | 6 | 20 |

Amendments applied on request, all recorded in `program.amendments`:

- Tuesday: **Low-to-High Cable Fly** replaces High-to-Low Cable Fly.
- Saturday: **Cable Lateral Raise** added after Machine Shoulder Press.
- Tuesday: **Push-ups** added as an optional pre-workout warm-up — 1–2 sets of
  8–15, never to failure. Not a chest working set, and excluded from
  progression and from hypertrophy volume.
- **Ab Wheel Rollout** progresses by difficulty, not by load.
- **Pull-ups** are logged pain-aware.
- Ramp-up, drop and failure sets are recorded separately from working sets.

### Progressive overload

Double progression, exactly as the source document specifies:

- Work inside a rep range, adding a rep to any set below the top of the range.
- Once **all** working sets hit the top of the range, add that exercise's
  increment and drop back to the bottom.
- If the top of the range was not reached, repeat the same weight. The
  `+X kg` figures are a ceiling, not a schedule.
- Bodyweight lifts marked `reps-first` (Pull-ups, Hanging Knee Raise) add reps
  before any external load.
- Movements marked `difficulty-first` (Ab Wheel Rollout) climb a difficulty
  ladder — control, then range, then a harder variation — and reach external
  resistance last, if ever.
- 4-week wave, then a deload week: sets cut ~40%, load at 60–70%.
- A lift stalled for 3 sessions drops ~10% and rebuilds. Pain-limited sessions
  are excluded from that count.

**Only prescribed working sets are read by the engine.** Ramp-up sets, drop sets
and failure sets are stored in separate arrays (`warmupSets`, `intensitySets`),
so they cannot reach it — there is no filter to forget. See
[the set model](#the-set-model).

These rules live as data in `progression` at the top of `workouts.json`, and
are applied by `js/engine/progression.js` — a pure module with no imports,
no storage and no globals, so it can be tested outside a browser. It is the
one place where a quiet mistake would corrupt years of training decisions.

---

## Rish's Training Preferences

These are **conventions, not mistakes.** They describe how the person using this
app actually trains and logs. A future session that "corrects" one of them will
silently misread a database that already holds real training, so read this first.

### How a load is logged

| Equipment | What gets typed in | What the app shows | Why |
|---|---|---|---|
| Barbell | the **plates only** — the bar is not included | `+40 kg plates`, with `est. total 60 kg` where the bar weight is known | It is what you load and what you read off the bar |
| Dumbbell | the **total of both dumbbells** | `27.5 kg / hand` under a logged `55` | Per hand is what you pick off the rack |
| Machine / cable | the **raw number on that machine** | exactly that number, `per side` where a movement uses two stacks | A 20 on one machine is not a 20 on the next one, and the app must not pretend otherwise |
| Bodyweight | **added load only**, blank or 0 for none | `Bodyweight`, or `+5 kg` | Body weight is tracked separately and would otherwise swamp every trend |

Two consequences worth stating plainly:

- **Dumbbell increments are per hand.** The program's `+2.5 kg` means the next
  pair up, so the engine adds **5 kg** to the logged total. Reading it as a total
  would prescribe 52.5 kg — 26.25 per hand, which no rack contains.
- **Dumbbell volume counts once.** An earlier build doubled it, on the assumption
  that the logged figure was per hand. Under this convention that counted every
  dumbbell set twice.

Storage is never rewritten to suit a display choice. Every one of these is applied
on the read side, which is what makes changing one safe on a database that already
holds a month of training.

### Everything else

| Preference | Setting | Meaning |
|---|---|---|
| Morning weight reminder | ON | Once per training day, only if today's weight is missing, never blocking |
| Warm-up sets separate | YES | Ramp-ups excluded from progression, volume and completion |
| Working sets separate | YES | The only sets the engine reads |
| Drop sets | ALLOWED | Offered on isolation and accessory work |
| Failure techniques | OPTIONAL | Available when chosen; never prescribed, never required |
| Drop sets affect overload | **NO** | Structural, not a toggle-with-consequences |
| Push-ups before chest | YES | Optional, 1–2 sets, 8–15 reps, not to failure |
| Push-ups count as volume | NO | Logged as reps, not as chest volume |
| Pull-ups | PAIN-AWARE | Fewer pain-free reps, an early stop or a substitution are all valid |
| Ab wheel | DIFFICULTY PROGRESSION | Reps → control → range → variation → load, in that order |

All of them live in the `trainingPrefs` collection and are editable in
Settings → Training preferences. None is hardcoded.

### Failure training is not discouraged

The app does not prohibit training to failure and does not nag about it. It
records it as a distinct kind of work and keeps it out of the progression
arithmetic. That is the whole of its opinion.

---

## The set model

A session entry holds three kinds of work in three separate arrays:

```js
entry = {
  exerciseId, targetWeightKg, targetReps, plannedAction, planReason,
  setModel: 'v2' | 'legacy',
  sets:          [ { weightKg, reps, completed, rpe, kind } ],  // WORKING SETS
  warmupSets:    [ { weightKg, reps, completed, kind } ],       // ramp-up work
  intensitySets: [ { id, type: 'drop'|'failure', note, stages: [...] } ],
  pain:          null | { score, location, note, action, alternativeId },
  difficulty:    null | 'standard' | 'slow-eccentric' | ... ,
  notes,
}
```

**Why separate arrays rather than a `kind` tag on one list.** Seven modules read
`entry.sets` — the progression engine, the PR detector, the CSV export, the
analytics service, two pages. A tag would mean a filter in each of them, and a
filter forgotten in any one would feed warm-ups to the double-progression engine,
which is the exact failure this change exists to prevent. With separate arrays,
`entry.sets` keeps its original name and its original meaning, code that predates
the change reads working sets by default, and warm-up and intensity work have to
be asked for by name.

A drop-set sequence is **one** piece of intensity work with several stages, and is
reported that way: *"3 working sets + 1 drop-set sequence"*, never as six sets.

### Pain-aware logging

Optional and non-diagnostic. It records a 0–10 number, a location, what you
decided to do, and an optional substitution. What it changes is what the engine is
willing to *conclude*: a pain-limited session is excluded from stall detection and
from the review's strength comparison, so stopping a set because your elbow hurts
never reads as getting weaker. The session itself is untouched and still appears
in history, reports and the CSV. The app states that it is not a diagnosis and
points at a professional; it does not offer an opinion of its own.

### Migration: schema v1 → v2

Run once, at boot, by `js/services/db.js`. **Strictly additive.**

1. **A parachute first.** The entire v1 database is copied verbatim to a reserved
   `__premigration` key before anything is touched, and is downloadable from
   Settings for as long as it exists. It is never overwritten and never
   auto-deleted.
2. Each entry gains `setModel: 'legacy'`, empty `warmupSets` / `intensitySets`,
   and `pain: null`. Each existing set gains `kind: 'legacy'`. **No weight, rep
   count, completion flag, RPE, date, note or ordering is altered.**
3. `trainingPrefs` is seeded with the conventions above.
4. Idempotent: a second pass, or importing an already-migrated backup, is a no-op.
5. A v1 backup still imports and is migrated on the way in.

**Nothing is reclassified by guesswork.** Week one's real data is, on almost every
exercise, a rising-weight falling-rep ladder — `150×12, 180×10, 200×8, 220×6` on
the squat. That looks like three ramp sets and a working set. It also looks exactly
like a pyramid, or like working up to a top single, and the app cannot tell which.
So legacy sets keep feeding progression, because they are the only record of what
was lifted, and they are labelled *"unclassified"* everywhere they surface.
History → session detail offers **Classify these sets** for whenever you want to
tell the app what they actually were, one deliberate decision per set.

`tools/test-migration.mjs` asserts all of the above, and runs against the real
exported backup when one is present in the repo root.

---

## Checking your work

```bash
python tools/check.py     # parses every module; resolves every import,
                          # including dynamic ones, plus HTML and precache refs
node --test tools/test.mjs tools/test-sets.mjs tools/test-migration.mjs              tools/test-pyramid.mjs tools/test-review.mjs
                          # 121 assertions over progression, the set model,
                          # load conventions, the v1 to v2 migration, analytics,
                          # 1RM and the review engine.
                          # `node --test tools/` does not expand a directory on
                          # Windows, so the files are named explicitly.
```

Then, over HTTP, in a **throwaway browser profile** (these clear Local Storage
on the origin they run against):

| Page | What it proves |
|---|---|
| `tools/e2e.html` | 117 service-layer assertions against real Local Storage: multi-session progression, the deload wave, PR detection, resume guards, set editing, the warm-up/working/intensity split, pain-aware pull-ups, ab-wheel difficulty progression, load conventions, CSV escaping, a real multi-page PDF, backup round trip |
| `tools/audit.html` | accessible names, alt text, labels, duplicate ids, 44px targets, WCAG AA contrast, overflow and heading order — across all nine routes. `?theme=light` for the light palette |
| `tools/perf.html` | shell payload, and that the vendored libraries are not fetched on routes that do not need them |
| `tools/pdf-dump.html` | emits a generated report as base64 so the PDF can be pulled out and actually looked at |

`tools/preview.html` renders the app at phone, iPad and desktop widths side by
side — the fastest way to catch a mobile layout regression. `?theme=light`
switches palette, `?route=workout` switches page, and `?seed=logging` fabricates
a training history and leaves a session open so the logging UI can be reviewed
without lifting anything (it also clears Local Storage).

`tools/probe.html` reports any element wider than a phone viewport, which is
the failure mode that a desktop browser window will never show you.

---

## Data and privacy

Everything lives in this device's Local Storage under the `ironlog:v1:` key
prefix, at **schema version 2**. There is no account, no server, no analytics,
and no network request after the first load.

That also means **this device is the only copy.** Settings → Back up to JSON
writes a complete snapshot; do it before clearing browser data, and keep one
somewhere else.
