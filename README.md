# Project IronLog

A personal gym companion. Mobile-first Progressive Web App: installable on an
iPhone Home Screen, works offline, stores everything on the device, and never
talks to a server.

---

## What it does today

| Area | Status |
|---|---|
| Design system, app shell, navigation | Done |
| Home page | Done |
| Program data parsed from source documents | Done — 38 exercises across 5 training days |
| Progressive overload engine | Done — double progression, deload wave, stall detection, **working sets only**, **repeatable load not heaviest set** |
| Warm-up / working / top / intensity set model | Done — separate in the data model, not just the UI |
| Load conventions (plates, per-hand, raw machine) | Done — display-side, never rewrites stored numbers |
| Machine and attachment context | Done — loads compared only within one machine; untagged jumps flagged, never guessed |
| Substitutions | Done — performed work in a planned slot, with its own load series |
| Flexible scheduling | Done — any day's workout on any day, planned and actual dates both kept |
| Pain-aware logging | Done — optional, non-diagnostic, excluded from stall detection |
| Body weight & scale entry | Done — morning reminder, quick sheet, full Body tab |
| Training Preferences | Done — configurable, not hardcoded |
| Workout history | Done — per-session detail, re-open, delete |
| Workout page | Live set logging, rest timer, completion summary |
| Storage layer with backup & restore | Done |
| Theme (dark / light / system), units (kg / lb) | Done |
| PWA: manifest, icons, offline cache | Done |
| Progress dashboard | Done — the reading first, then strength, adherence, muscle groups, the wave, deload response, volume, consistency, records, body |
| Training insights engine | Done — per-exercise status, load-vs-reps attribution, stall and grind detection — pure, tested |
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
| Engine tests | 207 assertions (`node --test tools/test*.mjs`), including the real training log |
| Integration tests | 117 assertions in a browser (`tools/e2e.html`) plus 21 service-layer flows in Node (`tools/test-flow.mjs`) |
| Accessibility audit | clean, both themes, all nine routes |
| Dependencies | 2, both vendored: Chart.js 4.5.1, jsPDF 3.0.1 |
| Illustrations | 74 images, 0.96 MB, public domain, lazy-loaded |
| Build step | none |

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
    set-model.js           warm-up / working / top / intensity split — pure, tested
    loading.js             what a logged number means — pure, tested
    context.js             which machine a number came off — pure, tested
    insights.js            reading the log, not plotting it — pure, tested
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
tools/                     check.py, check-imports.mjs, test.mjs, test-sets.mjs,
                           test-pyramid.mjs, test-review.mjs, test-migration.mjs,
                           test-flow.mjs, test-real-data.mjs,
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
- Movements marked `maintain` (Pallof Press) hold their load and are never
  progressed, never stalled and never deloaded on. They are quality work, and
  putting them on a ladder turns a 45-second core exercise into a compound.
- 4-week wave, then a deload week: sets cut ~40%, load at 60–70%.
- A lift stalled for 3 sessions drops ~10% and rebuilds. Pain-limited sessions
  are excluded from that count, and so is any session on the far side of a load
  scale change.

**Only prescribed working sets are read by the engine.** Ramp-up sets, drop sets
and failure sets are stored in separate arrays (`warmupSets`, `intensitySets`),
so they cannot reach it — there is no filter to forget. See
[the set model](#the-set-model).

#### The load carried forward is the repeatable one

The single most consequential rule in the engine, and the one that was wrong.

The load the next session is built on is the **repeatable working load**, not
the heaviest set of the day. Those are different numbers, and conflating them
prescribed 72 kg on the flat dumbbell bench against repeatable working sets of
55 kg: the 25 August session was logged `55×9 / 55×8 / 72×5`, the engine
carried the heaviest completed set forward, and 72 became the target for all
three sets of the following week — a load that had never been held twice.

`repeatableLoad` reads it as the **lower median** of the completed working sets,
which is the heaviest load at least half the sets were actually performed at:

| Logged | Read as | Why |
|---|---|---|
| `55 / 55 / 55` | 55 | the ordinary case, unchanged |
| `55 / 55 / 72` | 55 | two working sets and one probe |
| `150 / 180 / 200 / 220` | 180 | a week-one ramp logged as working sets |
| `45 / 55` | 45 | two loads, neither repeated — take the lower |

The lower median rather than the upper, deliberately. Where the sets disagree,
the load you can be sure of is the one you did *at least* half your sets at, and
a prescription that is slightly too light costs one session of rep progress
while one that is too heavy costs a month of grinding and a false stall.

Rep targets follow the same rule: they are built only from the sets performed
**at** that load. Five reps at 72 kg says nothing about what set three at 55 kg
should be, so it is not allowed to set its target.

A set can also be marked explicitly as a **top set**, which excludes it
outright. The median is what protects the sessions nobody remembered to mark.

#### A load is only compared with itself

`engine/context.js`. A cable stack is not a unit of measurement: the log holds
rope pushdowns at `9.1`, then `20`, then `50`, and low-to-high flies going `4.5`
to `10` in a week. Those are different machines reading different numbers for
the same effort, and comparing them turned a walk across the gym floor into a
120% strength gain.

So a load is only ever compared against another from the **same context** — the
same machine, the same attachment. Two mechanisms, deliberately different:

- **A declared tag is a fact.** Tag the machine while logging (pre-filled from
  last time, so the usual case of using the same machine costs nothing) and the
  app compares this week with the right week.
- **A detected jump is a suspicion,** and is worded as one. For history that was
  never tagged, a load moving further than any programmed increment can explain
  is flagged rather than read as progress. The threshold is 1.35× with a 2 kg
  floor, which sits in the empty space between the two populations in the real
  log: a 30 lb pin becoming 35 lb is +17%, and a machine change is +120%.

Nothing is ever converted between machines. The app labels the reading; it does
not pretend to normalise it.

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
| Dumbbell | the **total of both dumbbells** | **both** figures, always: `27.5 kg / hand · 55 kg total (both)` | Per hand is what you pick off the rack, and a dumbbell number with no convention beside it is the one value in this app you cannot check by looking at it |
| Machine / cable | the **raw number on that machine** | exactly that number, `per side` where a movement uses two stacks, with the machine tag beside it | A 20 on one machine is not a 20 on the next one, and the app must not pretend otherwise |
| Bodyweight | **added load only**, blank or 0 for none | `Bodyweight`, or `+5 kg` | Body weight is tracked separately and would otherwise swamp every trend |

Two consequences worth stating plainly:

- **Dumbbell increments are per hand.** The program's `+2.5 kg` means the next
  pair up, so the engine adds **5 kg** to the logged total. Reading it as a total
  would prescribe 52.5 kg — 26.25 per hand, which no rack contains.
- **Dumbbell volume counts once.** An earlier build doubled it, on the assumption
  that the logged figure was per hand. Under this convention that counted every
  dumbbell set twice.
- **Both dumbbell figures are always printed.** `36 kg / hand · 72 kg total
  (both)`, never one of the two on its own, and the qualifier is `total (both)`
  rather than a bare `total`. Every exercise card and history entry also carries
  a one-line statement of what its stored numbers *are*.

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
| Pallof press | MAINTAINED | Two sets, a two-second hold, and no progression ladder |
| Show both dumbbell figures | YES | `36 kg / hand · 72 kg total (both)`, never one alone |
| Tag which machine | YES | Offered on cable and machine work, pre-filled from last time |
| Flag impossible load jumps | YES | On untagged history, a jump no increment explains is flagged, never guessed at |
| Any workout on any day | YES | The split is rolling; the app records planned and actual dates |

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
  context:       null | { machineId, label, attachment, note },
  substitution:  null | { performedId, label, comparableLoad, note },
  notes,
}
```

`sets` holds two kinds of set, not one. Most are `working`. One may be `top`: a
heavier probe taken above the working load, which stays **in place** in the
array — a top set is a working set that happened to be heavier, and moving it
would rewrite the order the session was performed in. It counts everywhere
except in the one place that matters, which is the load the next session is
built on.

`context` records which machine the numbers came off; `substitution` records
that a different movement was performed in a planned slot. Both feed one
comparison key (`engine/context.contextKey`), so the engine needs to know about
neither individually.

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

### Substitutions

A bar triceps pushdown where the program says rope is **performed work in a
planned slot**, not a skipped exercise. `entry.exerciseId` stays pointing at the
planned movement — that is what keeps the session's completion, its day, its
volume and its adherence attached to the program, and it means clearing the
substitution later restores the original reading exactly. The performed movement
is named in `substitution.performedId` and keeps its own load series, because
two attachments on one stack are two scales.

`workouts.json` declares which stand-ins are acceptable for which movements and
whether their loads may be compared (the default is no). An unlisted
substitution is refused rather than invented, and the program fails to load if a
declared substitution has no definition to resolve to.

### Any day's workout, on any day

A session records the workout it *was* (`dayId`) and the day it *happened*
(`date`). Everything about being early, late or on time is derived from those
two, so "Tuesday Chest, performed on Wednesday, 1 day late" is a first-class
outcome rather than a missed session plus a mystery — and every session logged
before the idea existed gets its reading for free.

The week counts a moved session as **done**, reports how many were moved, and
lists what is still outstanding. The program's own missed-day rules describe the
split as rolling rather than calendar-locked, so this matches the plan rather
than bending it.

### Pain-aware logging

Optional and non-diagnostic. It records a 0–10 number, a location, what you
decided to do, and an optional substitution. What it changes is what the engine is
willing to *conclude*: a pain-limited session is excluded from stall detection and
from the review's strength comparison, so stopping a set because your elbow hurts
never reads as getting weaker. The session itself is untouched and still appears
in history, reports and the CSV. The app states that it is not a diagnosis and
points at a professional; it does not offer an opinion of its own.

### Migrations

Run once each, at boot, by `js/services/db.js`. **All of them strictly
additive**, and every one of them refuses to guess.

| From | To | What it does |
|---|---|---|
| v1 | v2 | Splits warm-up, working and intensity work into separate arrays |
| v2 | v3 | Points week one's mislogged back squats at the hack squat that was actually trained |
| v3 | v4 | Gives every entry `context: null` and `substitution: null` |

**v3 → v4 guesses nothing, and that is a decision rather than an omission.** It
would have been easy to walk the rope pushdown's `9.1 → 20 → 50` series, find
the jumps, and stamp "machine A" and "machine B" on either side of each one.
That would be an invention: the app does not know which machine any of those
numbers came off, whether the 20 and the 50 were the same stack on different
pins, or whether one of the jumps was a genuine and hard-won increase. A tag is
a statement of fact by the user, and manufacturing one and then presenting it
back to them as their own record is worse than having none. So the field is left
empty and the *engine* handles the untagged history — flagging, declining to
read it as strength, and saying so in words that ask rather than assert.

#### Migration: schema v1 → v2

**Strictly additive.**

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
exported backup when one is present in the repo root. It asserts
*losslessness* rather than a version number, so a future schema bump does not
break seven passing tests while saying nothing about whether any data was lost.

---

## Reading the log

`js/engine/insights.js`, and the section of Progress that renders it. The
distinction it exists for: the app could already *plot* a training log, which
answers "what did I do" and leaves "am I getting stronger, and where" to the
reader. This layer answers the second question.

Three rules govern every figure in it, and they are why the numbers can be
trusted rather than merely displayed.

1. **Measure the repeatable load, not the heaviest set.** A probe is not a
   working weight.
2. **Never compare across a scale change.** Every trend is measured over a
   *comparable run* — the newest stretch of sessions whose loads mean the same
   thing — and each reading says how long that run was. The gap between an
   exercise's session count and its comparable-session count is the honest
   answer to "how much of my history can actually be read".
3. **Say when there is not enough data.** Four sessions is four sessions. A
   slope fitted to three points with an r² of 0.2 is a decoration, so
   `confidence` and the r² are both reported and the UI defers to them.

Every exercise lands in exactly one pile:

| Status | Means |
|---|---|
| **Progressing** | Estimated strength up, or more reps at the same load |
| **Holding** | Flat, but not for long enough to call it a stall |
| **Losing reps** | The load holds or climbs while the reps underneath it fall away |
| **Stalled** | No load or rep gain across two comparable sessions |
| **Load scale changed** | A different machine, or a jump no increment explains |
| **Maintained** | Held by design, never progressed and never stalled |
| **Too new to read** | One comparable session so far |

**Losing reps** is the status the module was written for. It is the case a
volume chart reads as flat and a top-set chart reads as progress, and it is
neither. It requires *three* comparable sessions, because the session after a
load increase is supposed to come in at the bottom of the rep range — hip
thrusts going 80 kg for 11/11/10 and then 85 kg for 8/8/8 is double progression
working exactly as designed, and flagging it would be the app telling the user
off for following its own prescription.

Estimated 1RM is the **mean across the sets performed at the working load**, not
the best set of the day. Leg extensions went `12/11/11` one week and `13/10/8`
the next: the best set improved, the session got materially worse, and a
max-based series calls that progress. The Progress dashboard and the two-week
review read the same figure, so they cannot disagree about the same fortnight.

Everything else on the page is built from the same readings: **load or reps**
(counted in exercises, because a mean of a squat's percentage and a lateral
raise's percentage refers to nothing), **plan against performance**, **by muscle
group** (a median, since one outlier would otherwise decide a three-exercise
group), **the wave** grouped by wave week rather than calendar week, and
**after the deload**, which is the only figure in the app that checks whether
giving up a training week actually bought anything.

---

## Checking your work

```bash
python tools/check.py            # parses every module; resolves every import,
                                 # including dynamic ones, plus HTML and
                                 # precache refs
node tools/check-imports.mjs     # resolves every *named* import against the
                                 # file it names — the one class of mistake a
                                 # no-build ES-module app is uniquely exposed
                                 # to. Also reports dead imports.
node --test tools/test.mjs tools/test-sets.mjs tools/test-migration.mjs \
           tools/test-pyramid.mjs tools/test-review.mjs \
           tools/test-flow.mjs tools/test-real-data.mjs
                                 # 207 assertions over progression, the set
                                 # model, load conventions, machine context,
                                 # the insights engine, every migration,
                                 # analytics, 1RM, the review engine, the full
                                 # service layer, and the real training log.
                                 # `node --test tools/` does not expand a
                                 # directory on Windows, so the files are
                                 # named explicitly.
```

Two of those run against **real data** rather than fixtures, which is
deliberate: every bug the 1.9.0 release fixed was invisible in a fixture and
obvious in the log.

- `tools/test-real-data.mjs` drives the engine over `ironlog-backup-*.json`. Its
  assertions are about shape and sanity, not figures the next session would
  change: no prescription may exceed what was actually repeated by more than one
  increment, no machine change may be reported as strength, every rep target
  must sit inside its exercise's range.
- `tools/test-flow.mjs` drives the real *services* end to end in Node, with the
  in-memory storage adapter and `fetch` stubbed to read the program from disk.
  It covers starting sessions, logging sets, tagging machines, substituting
  movements, moving a workout to another day, and a backup round trip that has
  to produce the identical recommendation afterwards.

Both skip cleanly when no backup file is present.

Then, over HTTP, in a **throwaway browser profile** (these clear Local Storage
on the origin they run against):

| Page | What it proves |
|---|---|
| `tools/smoke.html` | Every route **renders** against the real backup, mid-workout, on a single session, and on an empty database — plus that `index.html` itself boots. Reports any thrown error, unhandled rejection or `console.error`. This is the cheap one to run first: rendering a page module is not the same as it working, and a page that references a function which no longer exists fails only at runtime |
| `tools/e2e.html` | 121 service-layer assertions against real Local Storage: multi-session progression, the deload wave, PR detection, resume guards, set editing, the warm-up/working/intensity split, pain-aware pull-ups, ab-wheel difficulty progression, load conventions, CSV escaping, a real multi-page PDF, backup round trip |
| `tools/probe.html` | Nothing overflows a 402px viewport, on every route, with real history behind it. `?open=1` adds the Workout page mid-session, which is the tightest layout in the app |
| `tools/audit.html` | accessible names, alt text, labels, duplicate ids, 44px targets, WCAG AA contrast, overflow and heading order — across all nine routes. `?theme=light` for the light palette. Needs a profile with data in it, so load a page that restores a backup first |
| `tools/perf.html` | shell payload, and that the vendored libraries are not fetched on routes that do not need them |
| `tools/pdf-dump.html` | emits a generated report as base64 so the PDF can be pulled out and actually looked at |

Two notes on running these headless, both learned the hard way:

- **Use a fresh `--user-data-dir` each time.** A profile that has loaded the app
  once holds a service worker, and it will serve a cached copy of the build you
  were debugging rather than the one you just changed.
- **Do not wait on a timer.** Under `--virtual-time-budget` a `setTimeout` fires
  immediately while modules are still loading. `probe.html` used to poll on a
  timer, measured an unbooted document, and reported "layout fits" — a pass
  that meant nothing. Wait on a flag the app itself sets, or render the page
  module synchronously.

`tools/preview.html` renders the app at phone, iPad and desktop widths side by
side — the fastest way to catch a mobile layout regression. `?theme=light`
switches palette, `?route=workout` switches page, and `?seed=logging` fabricates
a training history and leaves a session open so the logging UI can be reviewed
without lifting anything (it also clears Local Storage).

`tools/preview.html` and `tools/probe.html` cover the two things a desktop
browser window will never show you: how the layout reads at phone width, and
whether anything overflows it.

---

## Data and privacy

Everything lives in this device's Local Storage under the `ironlog:v1:` key
prefix, at **schema version 4**. There is no account, no server, no analytics,
and no network request after the first load.

That also means **this device is the only copy.** Settings → Back up to JSON
writes a complete snapshot; do it before clearing browser data, and keep one
somewhere else.
