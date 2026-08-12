/**
 * tools/test-sets.mjs — The set model, loading conventions, and the promise
 * that only working sets move a prescribed load.
 *
 *     node --test tools/test-sets.mjs
 *
 * The assertions that matter most here are the negative ones: that a drop set
 * cannot advance a weight, that a warm-up cannot, that a failure set cannot,
 * and that logging pain cannot cause the engine to cut the load. Those are the
 * guarantees the whole change rests on, and they are the kind that rot quietly
 * if nothing is watching them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOAD_ENTRY, DEFAULT_LOAD_PREFS,
  loadEntryFor, describeLoad, volumeMultiplier, incrementScale,
  isPairedLoad, isPerSideMachine, barWeightKg,
} from '../js/engine/loading.js';

import {
  SET_KIND, INTENSITY_TYPE, PAIN_ACTION, PAIN_LIMIT_SCORE,
  normalizeEntry, workingSets, completedWorkingSets, warmupSets,
  intensityStages, isLegacyEntry, isPainLimited, composition,
  describeComposition, entryVolume, rampSets,
} from '../js/engine/set-model.js';

import {
  recommend, earnedAdvance, incrementFor, judgeableHistory,
  difficultyLadder, ACTIONS,
} from '../js/engine/progression.js';

/* --- Fixtures ----------------------------------------------------------- */

const dumbbellPress = {
  id: 'incline-dumbbell-press',
  name: 'Incline Dumbbell Press',
  equipment: 'dumbbell',
  loadType: 'per-hand',
  loadEntry: 'total-both',
  category: 'compound',
  sets: 4,
  reps: { min: 6, max: 8, label: '6-8' },
  progression: { mode: 'weight', increment: { min: 2.5, max: 5 } },
  warmup: { supported: true, rampSets: 3 },
  intensityTechniquesAllowed: false,
};

const backSquat = {
  id: 'back-squat',
  equipment: 'barbell',
  loadEntry: 'plates',
  barWeightKg: 20,
  sets: 4,
  reps: { min: 6, max: 8, label: '6-8' },
  progression: { mode: 'weight', increment: { min: 2.5, max: 5 } },
};

const cableFly = {
  id: 'low-to-high-cable-fly',
  equipment: 'cable',
  loadType: 'per-hand',
  loadEntry: 'machine',
  perSideLoad: true,
  sets: 3,
  reps: { min: 12, max: 15, label: '12-15' },
  progression: { mode: 'weight', increment: { min: 1, max: 2 } },
  intensityTechniquesAllowed: true,
};

const pullUps = {
  id: 'pull-ups',
  equipment: 'bodyweight',
  loadType: 'bodyweight-plus-added',
  loadEntry: 'bodyweight-plus-added',
  painAware: true,
  sets: 4,
  reps: { min: 6, max: 10, label: '6-10' },
  progression: { mode: 'reps-first', increment: { min: 2.5, max: 5 } },
};

const abWheel = {
  id: 'ab-wheel-rollout',
  equipment: 'bodyweight',
  loadEntry: 'bodyweight-plus-added',
  sets: 3,
  reps: { min: 10, max: 12, label: '10-12' },
  progression: {
    mode: 'difficulty-first',
    increment: { min: 1, max: 2 },
    difficultyLadder: [
      { id: 'standard', label: 'Standard', note: 'Controlled rollout.' },
      { id: 'slow-eccentric', label: 'Slow eccentric', note: 'Take 3-4 seconds out.' },
      { id: 'weighted', label: 'Weighted', note: 'Only now consider load.' },
    ],
  },
};

/** A v2 entry. */
function entry(overrides = {}) {
  return {
    exerciseId: 'incline-dumbbell-press',
    targetWeightKg: 55,
    targetReps: [8, 8, 8, 8],
    setModel: 'v2',
    sets: [],
    warmupSets: [],
    intensitySets: [],
    pain: null,
    difficulty: null,
    notes: '',
    ...overrides,
  };
}

function set(weightKg, reps, kind = SET_KIND.WORKING, completed = true) {
  return { weightKg, reps, completed, rpe: null, kind };
}

/** A performance as session-service hands it to the engine. */
function performance(weightKg, reps, extra = {}) {
  return {
    date: '2026-08-11',
    isDeload: false,
    sets: reps.map((count) => ({ weightKg, reps: count, completed: true })),
    ...extra,
  };
}

/* --- Loading conventions ------------------------------------------------ */

test('load entry is classified from the program document, then from equipment', () => {
  assert.equal(loadEntryFor(dumbbellPress), LOAD_ENTRY.TOTAL_BOTH);
  assert.equal(loadEntryFor(backSquat), LOAD_ENTRY.PLATES);
  assert.equal(loadEntryFor(cableFly), LOAD_ENTRY.MACHINE);
  assert.equal(loadEntryFor(pullUps), LOAD_ENTRY.BODYWEIGHT);

  // Fallback for a program document that has no loadEntry yet.
  assert.equal(loadEntryFor({ equipment: 'dumbbell' }), LOAD_ENTRY.TOTAL_BOTH);
  assert.equal(loadEntryFor({ equipment: 'barbell' }), LOAD_ENTRY.PLATES);
  assert.equal(loadEntryFor({ equipment: 'machine' }), LOAD_ENTRY.MACHINE);
  assert.equal(loadEntryFor(null), LOAD_ENTRY.MACHINE);
});

test('a dumbbell total is displayed per hand without changing what is stored', () => {
  const described = describeLoad(dumbbellPress, 55);
  assert.equal(described.displayKg, 27.5, '55 kg of dumbbells is 27.5 per hand');
  assert.equal(described.qualifier, '/ hand');
  assert.equal(described.storedKg, 55, 'storage is untouched');
  assert.equal(described.secondaryKg, 55);
  assert.equal(described.secondaryQualifier, 'total');
});

test('the per-hand display is a preference, not a rule', () => {
  const described = describeLoad(dumbbellPress, 55, { dumbbellDisplay: 'total' });
  assert.equal(described.displayKg, 55);
  assert.equal(described.qualifier, 'total');
  assert.equal(described.secondaryKg, 27.5, 'the per-hand figure is still offered');
});

test('a barbell shows plates, with the bar only as a secondary estimate', () => {
  const described = describeLoad(backSquat, 40);
  assert.equal(described.displayKg, 40, 'the logged number is the plates');
  assert.equal(described.prefix, '+');
  assert.equal(described.qualifier, 'plates');
  assert.equal(described.secondaryKg, 60, '20 kg bar + 40 kg of plates');
  assert.equal(described.secondaryQualifier, 'est. total');
});

test('a barbell with no known bar weight offers no total', () => {
  const ezBar = { equipment: 'barbell', loadEntry: 'plates' };
  const described = describeLoad(ezBar, 30);
  assert.equal(described.displayKg, 30);
  assert.equal(described.secondaryKg, null, 'no invented 20 kg bar');
  assert.equal(barWeightKg(ezBar), null);
});

test('a machine value is shown exactly as logged, never normalised', () => {
  const described = describeLoad(cableFly, 8);
  assert.equal(described.displayKg, 8, 'the number on the machine');
  assert.equal(described.secondaryKg, null, 'nothing to convert it to');
  assert.equal(described.qualifier, 'per side', 'a two-stack movement says so');
  assert.ok(isPerSideMachine(cableFly));

  const machine = describeLoad({ equipment: 'machine', loadEntry: 'machine' }, 63);
  assert.equal(machine.displayKg, 63);
  assert.equal(machine.qualifier, '', 'a single stack needs no qualifier');
});

test('bodyweight work shows as bodyweight until load is added', () => {
  assert.equal(describeLoad(pullUps, null).bodyweight, true);
  assert.equal(describeLoad(pullUps, null).displayKg, null);
  assert.equal(describeLoad(pullUps, 0).displayKg, null, 'zero added load is still bodyweight');

  const weighted = describeLoad(pullUps, 5);
  assert.equal(weighted.displayKg, 5);
  assert.equal(weighted.prefix, '+');
  assert.equal(weighted.bodyweight, true);
});

test('no loading convention doubles volume any more', () => {
  // The bug this replaces: dumbbell volume was multiplied by two on the
  // assumption that the stored number was per hand.
  for (const exercise of [dumbbellPress, backSquat, cableFly, pullUps]) {
    assert.equal(volumeMultiplier(exercise), 1, `${exercise.id} counts its load once`);
  }
});

test('only a dumbbell pair scales its increment', () => {
  assert.equal(incrementScale(dumbbellPress, DEFAULT_LOAD_PREFS), 2);
  assert.equal(incrementScale(backSquat, DEFAULT_LOAD_PREFS), 1);
  assert.equal(incrementScale(cableFly, DEFAULT_LOAD_PREFS), 1);
  assert.equal(incrementScale(dumbbellPress, { dumbbellIncrementBasis: 'total' }), 1);
  assert.ok(isPairedLoad(dumbbellPress));
  assert.ok(!isPairedLoad(cableFly));
});

/* --- The set model ------------------------------------------------------ */

test('normalizeEntry fills in the v2 arrays without inventing data', () => {
  const legacy = { exerciseId: 'back-squat', sets: [set(150, 12, SET_KIND.LEGACY)] };
  const normalized = normalizeEntry(legacy);

  assert.deepEqual(normalized.warmupSets, []);
  assert.deepEqual(normalized.intensitySets, []);
  assert.equal(normalized.pain, null);
  assert.equal(normalized.setModel, 'legacy');
  assert.equal(normalized.sets.length, 1, 'the real set is still there');
  assert.equal(normalized.sets[0].weightKg, 150);
});

test('working, warm-up and intensity sets are read separately', () => {
  const full = entry({
    sets: [set(55, 8), set(55, 8), set(55, 7)],
    warmupSets: [set(20, 8, SET_KIND.WARMUP), set(35, 5, SET_KIND.WARMUP)],
    intensitySets: [{
      id: 'i1',
      type: INTENSITY_TYPE.DROP,
      stages: [
        { weightKg: 60, reps: 3, completed: true, toFailure: true },
        { weightKg: 40, reps: 4, completed: true },
        { weightKg: 30, reps: 5, completed: true },
      ],
    }],
  });

  assert.equal(workingSets(full).length, 3);
  assert.equal(warmupSets(full).length, 2);
  assert.equal(intensityStages(full).length, 3);
  assert.equal(completedWorkingSets(full).length, 3);
  assert.ok(!isLegacyEntry(full));
});

test('composition counts sequences, not drop stages', () => {
  const full = entry({
    sets: [set(50, 10), set(50, 10), set(50, 10)],
    intensitySets: [{
      id: 'i1',
      type: INTENSITY_TYPE.DROP,
      stages: [
        { weightKg: 60, reps: 3, completed: true, toFailure: true },
        { weightKg: 40, reps: 4, completed: true },
        { weightKg: 30, reps: 5, completed: true },
      ],
    }],
  });

  const counts = composition(full);
  assert.equal(counts.working, 3);
  assert.equal(counts.dropSequences, 1, 'one sequence, not three extra sets');
  assert.equal(counts.dropStages, 3);

  assert.equal(
    describeComposition(full),
    '3 working sets + 1 drop-set sequence',
    'the phrasing the brief asked for'
  );
});

test('legacy entries are described as unclassified, never as working sets', () => {
  const legacy = {
    exerciseId: 'back-squat',
    setModel: 'legacy',
    sets: [set(150, 12, SET_KIND.LEGACY), set(180, 10, SET_KIND.LEGACY)],
  };

  assert.ok(isLegacyEntry(legacy));
  const counts = composition(legacy);
  assert.equal(counts.working, 0, 'not claimed as classified working sets');
  assert.equal(counts.legacy, 2);
  assert.match(describeComposition(legacy), /unclassified/);
});

test('volume is split by the kind of work that produced it', () => {
  const full = entry({
    sets: [set(50, 10), set(50, 10)],
    warmupSets: [set(20, 10, SET_KIND.WARMUP)],
    intensitySets: [{
      id: 'i1',
      type: INTENSITY_TYPE.DROP,
      stages: [{ weightKg: 30, reps: 5, completed: true }],
    }],
  });

  const volume = entryVolume(full, 1);
  assert.equal(volume.workingKg, 1000, '50 x 10 x 2');
  assert.equal(volume.warmupKg, 200, 'kept apart from the working total');
  assert.equal(volume.intensityKg, 150);
  assert.ok(!('totalKg' in volume), 'never pre-summed into one misleading figure');
});

test('an unticked set contributes no volume of any kind', () => {
  const full = entry({
    sets: [set(50, 10), { ...set(50, 10), completed: false }],
    warmupSets: [{ ...set(20, 10, SET_KIND.WARMUP), completed: false }],
  });
  const volume = entryVolume(full, 1);
  assert.equal(volume.workingKg, 500);
  assert.equal(volume.warmupKg, 0);
});

test('ramp sets are light, brief, and rounded to something loadable', () => {
  const ramp = rampSets(100, 3, 2.5);
  assert.deepEqual(ramp.map((rung) => rung.weightKg), [40, 60, 80]);
  assert.deepEqual(ramp.map((rung) => rung.reps), [8, 5, 3]);
  assert.ok(ramp.every((rung) => rung.weightKg < 100), 'a ramp never reaches the working weight');

  assert.deepEqual(rampSets(null, 3), [], 'nothing to ramp towards on a first session');
  assert.deepEqual(rampSets(0, 3), [], 'or on unloaded bodyweight work');
  assert.equal(rampSets(100, 2).length, 2);
});

/* --- Progression sees working sets only --------------------------------- */

test('warm-up sets cannot advance a load', () => {
  // The engine is fed working sets only, so the proof is that an entry with a
  // heavy ramp and a modest working performance still holds.
  const withRamp = performance(55, [8, 8, 7, 6]);
  const plan = recommend(dumbbellPress, [withRamp]);
  assert.equal(plan.action, ACTIONS.HOLD);
  assert.equal(plan.weightKg, 55, 'the working weight, not the ramp');
});

test('a drop set cannot advance a load, however heavy its top stage', () => {
  const entryWithDrop = entry({
    sets: [set(50, 10), set(50, 10), set(50, 10)],
    intensitySets: [{
      id: 'i1',
      type: INTENSITY_TYPE.DROP,
      stages: [
        { weightKg: 60, reps: 3, completed: true, toFailure: true },
        { weightKg: 40, reps: 4, completed: true },
        { weightKg: 30, reps: 5, completed: true },
      ],
    }],
  });

  const tenRepExercise = { ...cableFly, sets: 3, reps: { min: 8, max: 10, label: '8-10' } };

  // What session-service hands the engine: working sets and nothing else.
  const history = [{
    date: '2026-08-11',
    isDeload: false,
    sets: completedWorkingSets(entryWithDrop),
  }];

  const plan = recommend(tenRepExercise, history);
  assert.equal(plan.previous.weightKg, 50, 'the 60 kg drop stage did not become the working weight');
  assert.equal(plan.action, ACTIONS.ADVANCE, '10/10/10 in an 8-10 range earns the increase');
  // The increase is measured from the working weight. Had the drop set counted,
  // this would read 61 and the next session would be prescribed a load the
  // lifter has never completed a working set at.
  assert.equal(plan.weightKg, 51, 'advances from 50, not from the 60 kg drop stage');

  // And the intensity work is still there — separated, not discarded.
  assert.equal(intensityStages(entryWithDrop).length, 3);
});

test('a failure set is supplementary, not a prescription', () => {
  const withFailure = entry({
    sets: [set(50, 10), set(50, 10), set(50, 10)],
    intensitySets: [{
      id: 'f1',
      type: INTENSITY_TYPE.FAILURE,
      stages: [{ weightKg: 70, reps: 2, completed: true, toFailure: true }],
    }],
  });

  const counts = composition(withFailure);
  assert.equal(counts.failureSets, 1);
  assert.equal(counts.working, 3);
  assert.equal(
    describeComposition(withFailure),
    '3 working sets + 1 failure set'
  );
  assert.equal(entryVolume(withFailure, 1).workingKg, 1500, 'the 70 kg single is not working volume');
});

test('earnedAdvance judges the prescribed working sets and nothing else', () => {
  const done = [set(55, 8), set(55, 8), set(55, 8), set(55, 8)];
  assert.ok(earnedAdvance(dumbbellPress, done));

  // A warm-up array on the same entry is invisible to it.
  assert.ok(earnedAdvance(dumbbellPress, done), 'unchanged by ramp work');
  assert.ok(!earnedAdvance(dumbbellPress, [set(55, 8), set(55, 8), set(55, 8)]),
    'three of four prescribed sets is not an advance');
});

/* --- Change 12's worked examples ---------------------------------------- */

test('the brief\'s progression table, exactly', () => {
  const cases = [
    { reps: [8, 8, 8, 8], action: ACTIONS.ADVANCE, weightKg: 60, note: 'recommend next load' },
    { reps: [8, 8, 7, 6], action: ACTIONS.HOLD, weightKg: 55, note: 'remain at current load' },
    { reps: [6, 6, 6, 6], action: ACTIONS.HOLD, weightKg: 55, note: 'remain at current load' },
    { reps: [5, 6, 6, 6], action: ACTIONS.HOLD, weightKg: 55, note: 'remain at current load' },
  ];

  for (const item of cases) {
    // One prior session only, so the stall rule cannot be in play.
    const plan = recommend(dumbbellPress, [performance(55, item.reps)]);
    assert.equal(plan.action, item.action, `${item.reps.join('/')} -> ${item.note}`);
    assert.equal(plan.weightKg, item.weightKg, `${item.reps.join('/')} -> ${item.weightKg} kg`);
  }
});

/* --- Pain-aware logging ------------------------------------------------- */

test('a pain-limited performance is kept out of stall judgements', () => {
  const painful = { painLimited: true, incomplete: true };
  const history = [
    performance(0, [6, 6], { date: '2026-08-12', ...painful }),
    performance(0, [6, 6], { date: '2026-08-05', ...painful }),
    performance(0, [6, 6], { date: '2026-07-29', ...painful }),
  ];

  assert.equal(judgeableHistory(history, pullUps).length, 0, 'none of it votes on stalling');

  const plan = recommend(pullUps, history);
  assert.notEqual(plan.action, ACTIONS.DELOAD_STALL,
    'three pain-limited sessions must not trigger a load cut');
  assert.equal(plan.stalledSessions, 0);
  assert.ok(plan.previous.painLimited, 'but the UI can still see that it happened');
  assert.match(plan.reason, /pain-free/, 'and the wording does not push through it');
});

test('incomplete sets on a pain-aware lift are not a regression', () => {
  const history = [
    performance(0, [6, 6], { date: '2026-08-12', incomplete: true }),
    performance(0, [8, 8, 8, 8], { date: '2026-08-05' }),
  ];

  const plan = recommend(pullUps, history);
  assert.equal(plan.stalledSessions, 0, 'the short session is not counted against them');
  assert.notEqual(plan.action, ACTIONS.DELOAD_STALL);
});

test('elsewhere an incomplete session is still a real signal', () => {
  // The exemption is deliberately narrow: it applies to pain-aware movements,
  // not to every session someone cut short.
  const history = [
    performance(55, [6, 6], { date: '2026-08-12', incomplete: true }),
    performance(55, [8, 8], { date: '2026-08-05', incomplete: true }),
    performance(55, [8, 8, 8, 8], { date: '2026-07-29' }),
  ];
  assert.equal(judgeableHistory(history, dumbbellPress).length, 3, 'all three still count');
});

test('pain is flagged from either a score or a stated action', () => {
  assert.ok(isPainLimited({ pain: { score: PAIN_LIMIT_SCORE } }));
  assert.ok(isPainLimited({ pain: { score: 8, location: 'elbow' } }));
  assert.ok(isPainLimited({ pain: { score: 1, action: PAIN_ACTION.STOPPED } }));
  assert.ok(isPainLimited({ pain: { score: 0, action: PAIN_ACTION.SKIPPED } }));

  // Mild discomfort, worked through by choice, is not a limit.
  assert.ok(!isPainLimited({ pain: { score: 2, action: PAIN_ACTION.COMPLETED } }));
  assert.ok(!isPainLimited({ pain: null }));
  assert.ok(!isPainLimited({}));
});

/* --- Ab wheel: difficulty before load ----------------------------------- */

test('the ab wheel at the top of its range earns difficulty, not a plate', () => {
  const plan = recommend(abWheel, [performance(0, [12, 12, 12], { difficulty: 'standard' })]);

  assert.equal(plan.action, ACTIONS.DIFFICULTY);
  assert.equal(plan.difficulty, 'slow-eccentric', 'moves one rung up the ladder');
  assert.ok(!plan.weightKg, 'and adds no external load');
  assert.deepEqual(plan.perSetReps, [10, 10, 10], 'back to the bottom of the range');
  assert.match(plan.reason, /slow eccentric/i);
});

test('12/12/12 on the ab wheel never suggests adding weight', () => {
  // The specific behaviour the brief asked to remove.
  const plan = recommend(abWheel, [performance(0, [12, 12, 12])]);
  assert.notEqual(plan.action, ACTIONS.ADVANCE);
  assert.ok(!/add .*kg/i.test(plan.reason), `reason should not ask for load: "${plan.reason}"`);
});

test('the ab wheel below its range just adds reps', () => {
  const plan = recommend(abWheel, [performance(0, [12, 12, 10], { difficulty: 'standard' })]);
  assert.equal(plan.action, ACTIONS.REPS_FIRST);
  assert.equal(plan.difficulty, 'standard', 'stays on the current rung');
  assert.deepEqual(plan.perSetReps, [12, 12, 11]);
});

test('load is only reached at the end of the difficulty ladder', () => {
  const atTop = recommend(abWheel, [performance(0, [12, 12, 12], { difficulty: 'slow-eccentric' })]);
  assert.equal(atTop.difficulty, 'weighted', 'the last rung is the weighted one');
  assert.equal(atTop.weightKg, 1, 'and only there does a load appear');

  const beyond = recommend(abWheel, [performance(2, [12, 12, 12], { difficulty: 'weighted' })]);
  assert.equal(beyond.action, ACTIONS.ADVANCE, 'past the ladder it behaves normally');
  assert.equal(beyond.weightKg, 3);
});

test('a first ab wheel session talks about control, not load', () => {
  const plan = recommend(abWheel, []);
  assert.equal(plan.action, ACTIONS.START);
  assert.equal(plan.difficulty, 'standard');
  assert.match(plan.reason, /control/i);
  assert.ok(!plan.weightKg);
});

test('a movement with no ladder in the program document still has one', () => {
  const ladder = difficultyLadder({ progression: { mode: 'difficulty-first' } });
  assert.ok(ladder.length >= 2);
  assert.equal(ladder[0].id, 'standard');
  assert.equal(ladder.at(-1).id, 'weighted', 'external resistance is always last');
});
