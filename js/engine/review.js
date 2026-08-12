/**
 * review.js — The two-week review's rule-based training summary.
 *
 * Pure, like the other engine modules: it takes a bundle of already-computed
 * figures and returns findings and a recommendation. No storage, no imports,
 * no clock.
 *
 * Why rules and not prose
 * -----------------------
 * The summary has to be trustworthy enough to act on — "continue current
 * calories" is a real decision. So each finding states the figure it came from
 * and the threshold it was tested against, and the recommendation is the
 * outcome of an explicit, readable ladder rather than a generated sentence.
 * If it says to add calories, you can see exactly why.
 *
 * Every threshold is declared in THRESHOLDS so they can be reviewed in one
 * place instead of being scattered through conditionals.
 */

export const THRESHOLDS = {
  /* Lean bulk rate, kg per week, measured on 7-day averages. */
  gainSlow: 0.15,
  gainFast: 0.6,

  /* Adherence, as a percentage of scheduled sessions completed. */
  adherenceGood: 90,
  adherencePoor: 70,

  /* Share of tracked lifts that improved, as a percentage. */
  strengthGood: 60,
  strengthPoor: 30,

  /* Week-on-week volume change, as a percentage. */
  volumeDropConcerning: -15,
  volumeSpikeConcerning: 25,

  /* Mean sleep hours. */
  sleepLow: 6.5,

  /* Mean soreness / fatigue on a 1–5 scale. */
  sorenessHigh: 3.5,
};

export const TONE = {
  GOOD: 'good',
  WATCH: 'watch',
  BAD: 'bad',
  NEUTRAL: 'neutral',
};

/**
 * Build the review.
 *
 * @param {object} input
 * @param {{start: string, end: string, days: number}} input.period
 * @param {{startAvg: number|null, endAvg: number|null, perWeek: number|null, goalKg: number|null}} [input.weight]
 * @param {{startPercent: number|null, endPercent: number|null}} [input.bodyFat]
 * @param {{done: number, scheduled: number}} [input.adherence]
 * @param {{improved: number, held: number, regressed: number, tracked: number, advancing: string[], stalled: string[]}} [input.strength]
 * @param {{currentKg: number, previousKg: number|null}} [input.volume]
 * @param {{records: number}} [input.records]
 * @param {{meanSleepHours: number|null, meanSoreness: number|null, entries: number}} [input.recovery]
 * @returns {{period: object, findings: object[], recommendation: object, headline: object[]}}
 */
export function buildReview(input) {
  const findings = [];

  addWeightFinding(findings, input);
  addBodyFatFinding(findings, input);
  addAdherenceFinding(findings, input);
  addStrengthFinding(findings, input);
  addVolumeFinding(findings, input);
  addSetTypeFinding(findings, input);
  addIntensityFinding(findings, input);
  addPainFinding(findings, input);
  addRecordsFinding(findings, input);
  addRecoveryFinding(findings, input);

  return {
    period: input.period,
    findings,
    headline: headlineFigures(input),
    recommendation: recommend(findings, input),
  };
}

/* --- Findings ----------------------------------------------------------- */

function addWeightFinding(findings, { weight }) {
  if (!weight || weight.perWeek === null || weight.perWeek === undefined) {
    findings.push({
      key: 'weight',
      label: 'Body weight',
      tone: TONE.NEUTRAL,
      value: null,
      text: 'Not enough weigh-ins to judge a trend. Two weeks of most-morning readings is the minimum.',
    });
    return;
  }

  const perWeek = weight.perWeek;
  // Never substitute zero for a missing average: `end - 0` would report the
  // absolute body weight as if it were the fortnight's gain.
  const change = weight.startAvg !== null && weight.startAvg !== undefined
    && weight.endAvg !== null && weight.endAvg !== undefined
    ? weight.endAvg - weight.startAvg
    : null;

  let tone = TONE.GOOD;
  let text;

  if (perWeek < 0) {
    tone = TONE.WATCH;
    text = `Losing ${fmt(Math.abs(perWeek))} kg/week. On a lean bulk this is a calorie deficit, not a plateau.`;
  } else if (perWeek < THRESHOLDS.gainSlow) {
    tone = TONE.WATCH;
    text = `Gaining ${fmt(perWeek)} kg/week — below the ${THRESHOLDS.gainSlow} kg/week a lean bulk needs to add tissue.`;
  } else if (perWeek > THRESHOLDS.gainFast) {
    tone = TONE.WATCH;
    text = `Gaining ${fmt(perWeek)} kg/week — above ${THRESHOLDS.gainFast} kg/week, so more of it is fat than it needs to be.`;
  } else {
    text = `Gaining ${fmt(perWeek)} kg/week — inside the ${THRESHOLDS.gainSlow}–${THRESHOLDS.gainFast} kg/week lean bulk band.`;
  }

  // The goal is a hard stop that overrides the rate judgement.
  if (weight.goalKg && weight.endAvg && weight.endAvg >= weight.goalKg) {
    tone = TONE.WATCH;
    text += ` You are at or past the ${fmt(weight.goalKg)} kg goal — time to decide whether to hold or cut.`;
  }

  findings.push({
    key: 'weight',
    label: 'Body weight',
    tone,
    // With only one endpoint the rate is still meaningful (it comes from the
    // rolling average), but a start-to-end change is not.
    value: change === null ? `${signed(perWeek)} kg/wk` : `${signed(change)} kg`,
    detail: change === null
      ? `${fmt(weight.endAvg)} kg now — not enough history for a start-of-period average`
      : `${fmt(weight.startAvg)} → ${fmt(weight.endAvg)} kg (7-day averages)`,
    text,
  });
}

function addBodyFatFinding(findings, { bodyFat }) {
  if (!bodyFat || bodyFat.startPercent === null || bodyFat.endPercent === null) return;

  const change = bodyFat.endPercent - bodyFat.startPercent;
  // Scale body-fat readings are noisy; under half a point is not a signal.
  const tone = change > 0.5 ? TONE.WATCH : TONE.GOOD;

  findings.push({
    key: 'bodyFat',
    label: 'Body fat',
    tone,
    value: `${signed(change)} %`,
    detail: `${fmt(bodyFat.startPercent)} → ${fmt(bodyFat.endPercent)} %`,
    text: change > 0.5
      ? 'Body fat is rising faster than the scale noise. Worth watching alongside the gain rate.'
      : 'Body fat is flat or falling while weight rises — that is what a lean bulk should look like.',
  });
}

function addAdherenceFinding(findings, { adherence }) {
  if (!adherence || !adherence.scheduled) return;

  const percent = Math.round((adherence.done / adherence.scheduled) * 100);

  let tone = TONE.WATCH;
  let text = `${adherence.done} of ${adherence.scheduled} scheduled sessions completed.`;

  if (percent >= THRESHOLDS.adherenceGood) {
    tone = TONE.GOOD;
    text += ' Adherence is not the limiting factor.';
  } else if (percent < THRESHOLDS.adherencePoor) {
    tone = TONE.BAD;
    text += ' Below 70% — no programming change is worth making until this is fixed.';
  } else {
    text += ' Enough to progress, but the missed sessions are costing you.';
  }

  findings.push({
    key: 'adherence',
    label: 'Workout completion',
    tone,
    value: `${percent}%`,
    detail: `${adherence.done}/${adherence.scheduled} sessions`,
    text,
  });
}

function addStrengthFinding(findings, { strength }) {
  if (!strength || !strength.tracked) return;

  const percent = Math.round((strength.improved / strength.tracked) * 100);

  let tone = TONE.WATCH;
  let text = `Improved in ${strength.improved} of ${strength.tracked} tracked lifts.`;

  if (percent >= THRESHOLDS.strengthGood) {
    tone = TONE.GOOD;
    text += ' Progression is working.';
  } else if (percent < THRESHOLDS.strengthPoor) {
    tone = TONE.BAD;
    text += ' Widespread stalling usually means recovery or calories, not programming.';
  } else {
    text += ' Mixed — check whether the stalled lifts share a training day.';
  }

  if (strength.stalled?.length) {
    text += ` Stalled: ${strength.stalled.slice(0, 4).join(', ')}${strength.stalled.length > 4 ? '…' : ''}.`;
  }

  // Say so when a lift was left out. A strength verdict computed over four of
  // six lifts should not be read as though it covered all six.
  if (strength.painExcluded?.length) {
    text += ` Excluded as pain-limited: ${strength.painExcluded.slice(0, 3).join(', ')}.`;
  }

  findings.push({
    key: 'strength',
    label: 'Strength',
    tone,
    value: `${strength.improved}/${strength.tracked}`,
    detail: `${percent}% of lifts improved`,
    text,
  });
}

function addVolumeFinding(findings, { volume }) {
  if (!volume || !volume.currentKg) return;

  if (!volume.previousKg) {
    findings.push({
      key: 'volume',
      label: 'Working volume',
      tone: TONE.NEUTRAL,
      value: `${fmt(volume.currentKg, 0)} kg`,
      text: 'First period with working-set volume data — this becomes the baseline for the next review.',
    });
    return;
  }

  const change = ((volume.currentKg - volume.previousKg) / volume.previousKg) * 100;

  let tone = TONE.GOOD;
  // "Working-set volume", not "total load moved": warm-up and intensity work are
  // reported by the set-composition finding and are deliberately not in here.
  let text = `Working-set volume changed by ${signed(change, 0)}% against the previous period.`;

  if (change <= THRESHOLDS.volumeDropConcerning) {
    tone = TONE.WATCH;
    text += ' A drop that size is usually missed sessions or dropped sets rather than lighter weights.';
  } else if (change >= THRESHOLDS.volumeSpikeConcerning) {
    tone = TONE.WATCH;
    text += ' A jump that size outruns recovery — expect it to show up as stalled lifts next period.';
  }

  findings.push({
    key: 'volume',
    label: 'Working volume',
    tone,
    value: `${signed(change, 0)}%`,
    detail: `${fmt(volume.previousKg, 0)} → ${fmt(volume.currentKg, 0)} kg`,
    text,
  });
}

/**
 * How the period's work divided between warm-up, working and intensity sets.
 *
 * Reported as three figures and never as one. A fortnight in which working
 * volume fell while drop-set volume rose is a materially different fortnight
 * from one where the total happened to hold steady, and a single "volume"
 * number cannot tell them apart — which is exactly how someone concludes their
 * training is fine while the sets that drive progression are quietly shrinking.
 *
 * Tone is NEUTRAL by design: none of these splits is good or bad in itself.
 */
function addSetTypeFinding(findings, { setTypes }) {
  if (!setTypes || !setTypes.workingSets) return;

  const parts = [
    `${setTypes.workingSets} programmed working set${setTypes.workingSets === 1 ? '' : 's'}`,
  ];
  if (setTypes.warmupSets) parts.push(`${setTypes.warmupSets} warm-up/ramp`);
  if (setTypes.dropSequences) {
    parts.push(`${setTypes.dropSequences} drop-set sequence${setTypes.dropSequences === 1 ? '' : 's'}`);
  }
  if (setTypes.failureSets) {
    parts.push(`${setTypes.failureSets} failure set${setTypes.failureSets === 1 ? '' : 's'}`);
  }

  let text = `${parts.join(', ')}. Only the working sets drove progression.`;
  if (setTypes.unclassifiedSets) {
    text += ` ${setTypes.unclassifiedSets} set${setTypes.unclassifiedSets === 1 ? '' : 's'} `
      + 'from before warm-up tracking remain unclassified and are counted as working sets.';
  }

  findings.push({
    key: 'setTypes',
    label: 'Set composition',
    tone: TONE.NEUTRAL,
    value: String(setTypes.workingSets),
    detail: [
      `working ${fmt(setTypes.workingVolumeKg, 0)} kg`,
      setTypes.warmupVolumeKg ? `warm-up ${fmt(setTypes.warmupVolumeKg, 0)} kg` : null,
      setTypes.intensityVolumeKg ? `intensity ${fmt(setTypes.intensityVolumeKg, 0)} kg` : null,
    ].filter(Boolean).join(' · '),
    text,
  });
}

/**
 * Intensity techniques used, and a reminder of what they are not.
 *
 * Deliberately never judgemental about the *amount*. The brief is explicit that
 * failure work is the user's choice and must be preserved as a preference
 * rather than treated as a problem to be corrected.
 */
function addIntensityFinding(findings, { setTypes }) {
  if (!setTypes) return;
  const used = (setTypes.dropSequences ?? 0) + (setTypes.failureSets ?? 0);
  if (!used) return;

  findings.push({
    key: 'intensity',
    label: 'Intensity techniques',
    tone: TONE.NEUTRAL,
    value: String(used),
    detail: [
      setTypes.dropSequences ? `${setTypes.dropSequences} drop` : null,
      setTypes.failureSets ? `${setTypes.failureSets} failure` : null,
      setTypes.intensityExercises?.length
        ? `on ${setTypes.intensityExercises.slice(0, 3).join(', ')}`
        : null,
    ].filter(Boolean).join(' · '),
    text: 'Supplementary work by choice. It is excluded from progression and from '
      + 'working-set volume, so it neither earned nor cost you a load increase.',
  });
}

/**
 * Discomfort logged during the period.
 *
 * Informational and non-diagnostic: it reports what was recorded, notes that
 * those sessions were held out of the strength judgement, and points at a
 * professional rather than offering an opinion.
 */
function addPainFinding(findings, { pain }) {
  if (!pain || !pain.count) return;

  const worst = pain.maxScore ?? 0;
  const locations = (pain.locations ?? []).slice(0, 3).join(', ');

  findings.push({
    key: 'pain',
    label: 'Discomfort logged',
    // WATCH rather than BAD: a logged pain note is the user doing the right
    // thing, not a failure in the program.
    tone: worst >= 5 ? TONE.WATCH : TONE.NEUTRAL,
    value: `${pain.count}×`,
    detail: [
      locations || null,
      `peak ${worst}/10`,
      pain.stoppedCount ? `${pain.stoppedCount} stopped early` : null,
    ].filter(Boolean).join(' · '),
    text: `Logged on ${pain.exercises.slice(0, 3).join(', ')}${pain.exercises.length > 3 ? '…' : ''}. `
      + 'Those sessions were excluded from the strength comparison rather than counted as a '
      + 'regression. Do not force painful repetitions, and seek professional assessment if the '
      + 'problem persists.',
  });
}

function addRecordsFinding(findings, { records }) {
  if (!records || !records.records) return;
  findings.push({
    key: 'records',
    label: 'Personal records',
    tone: TONE.GOOD,
    value: String(records.records),
    text: `${records.records} personal record${records.records === 1 ? '' : 's'} set this period.`,
  });
}

function addRecoveryFinding(findings, { recovery }) {
  if (!recovery || !recovery.entries) return;

  const parts = [];
  let tone = TONE.GOOD;

  if (recovery.meanSleepHours !== null && recovery.meanSleepHours !== undefined) {
    parts.push(`${fmt(recovery.meanSleepHours)} h mean sleep`);
    if (recovery.meanSleepHours < THRESHOLDS.sleepLow) {
      tone = TONE.BAD;
      parts.push(`below ${THRESHOLDS.sleepLow} h — the program says sleep decides whether added weight sticks`);
    }
  }

  if (recovery.meanSoreness !== null && recovery.meanSoreness !== undefined) {
    parts.push(`soreness ${fmt(recovery.meanSoreness)}/5`);
    if (recovery.meanSoreness > THRESHOLDS.sorenessHigh) {
      tone = tone === TONE.BAD ? TONE.BAD : TONE.WATCH;
      parts.push('persistently high');
    }
  }

  findings.push({
    key: 'recovery',
    label: 'Recovery',
    tone,
    value: recovery.meanSleepHours !== null && recovery.meanSleepHours !== undefined
      ? `${fmt(recovery.meanSleepHours)} h`
      : `${recovery.entries} logs`,
    detail: `${recovery.entries} log${recovery.entries === 1 ? '' : 's'}`,
    text: parts.join(', ') + '.',
  });
}

/* --- Recommendation ----------------------------------------------------- */

/**
 * The recommendation ladder, in priority order. The first rule that matches
 * wins, so the ordering *is* the policy:
 *
 *   1. Adherence below 70% — nothing else is diagnosable.
 *   2. Sleep below 6.5 h — recovery, not calories, is the limiter.
 *   3. Goal weight reached — the decision is now hold or cut.
 *   4. Gaining too fast — pull calories back.
 *   5. Losing or barely gaining while strength stalls — add calories.
 *   6. Barely gaining but strength is fine — hold and watch.
 *   7. Otherwise — continue.
 */
function recommend(findings, input) {
  const find = (key) => findings.find((finding) => finding.key === key);

  const adherence = find('adherence');
  const strength = find('strength');
  const recovery = find('recovery');
  const perWeek = input.weight?.perWeek ?? null;
  const goalReached = Boolean(
    input.weight?.goalKg && input.weight?.endAvg && input.weight.endAvg >= input.weight.goalKg
  );
  const strengthPercent = input.strength?.tracked
    ? (input.strength.improved / input.strength.tracked) * 100
    : null;

  if (adherence && parseInt(adherence.value, 10) < THRESHOLDS.adherencePoor) {
    return {
      action: 'Fix adherence first',
      tone: TONE.BAD,
      text: 'Completion is under 70%. Hold calories and programming where they are and get the sessions in — changing anything else now just adds a variable you cannot read.',
      basedOn: ['adherence'],
    };
  }

  if (input.recovery?.meanSleepHours !== null
      && input.recovery?.meanSleepHours !== undefined
      && input.recovery.meanSleepHours < THRESHOLDS.sleepLow) {
    return {
      action: 'Prioritise sleep',
      tone: TONE.BAD,
      text: `Mean sleep is ${fmt(input.recovery.meanSleepHours)} h. The program is explicit that sleep and protein decide whether added weight on the bar sticks. Address this before adding calories or volume.`,
      basedOn: ['recovery'],
    };
  }

  if (goalReached) {
    return {
      action: 'Decide: hold or cut',
      tone: TONE.WATCH,
      text: `You have reached the ${fmt(input.weight.goalKg)} kg goal. Either hold weight and keep training for a while, or start a slow cut. Continuing to gain from here is fat, not muscle.`,
      basedOn: ['weight'],
    };
  }

  if (perWeek !== null && perWeek > THRESHOLDS.gainFast) {
    return {
      action: 'Reduce calories slightly',
      tone: TONE.WATCH,
      text: `Gaining ${fmt(perWeek)} kg/week is faster than a lean bulk needs. Cut roughly 200 kcal a day and re-check in two weeks.`,
      basedOn: ['weight'],
    };
  }

  if (perWeek !== null && perWeek < THRESHOLDS.gainSlow
      && strengthPercent !== null && strengthPercent < THRESHOLDS.strengthGood) {
    return {
      action: 'Increase calories',
      tone: TONE.WATCH,
      text: `Weight is ${perWeek < 0 ? 'falling' : 'barely moving'} and strength is not keeping up. Add roughly 200–300 kcal a day, keep protein high, and re-check in two weeks.`,
      basedOn: ['weight', 'strength'],
    };
  }

  if (perWeek !== null && perWeek < THRESHOLDS.gainSlow) {
    return {
      action: 'Hold and watch',
      tone: TONE.NEUTRAL,
      text: 'Weight is barely moving but strength is still improving. Hold calories for one more period — if strength stalls too, add calories then.',
      basedOn: ['weight', 'strength'],
    };
  }

  return {
    action: 'Continue current calories',
    tone: TONE.GOOD,
    text: 'Weight, strength and adherence are all where they should be. Change nothing and repeat.',
    basedOn: ['weight', 'strength', 'adherence'],
  };
}

/* --- Headline ----------------------------------------------------------- */

function headlineFigures(input) {
  const out = [];

  const hasBothEnds = [input.weight?.startAvg, input.weight?.endAvg]
    .every((value) => value !== null && value !== undefined);

  if (hasBothEnds) {
    out.push({ label: 'Weight', value: `${signed(input.weight.endAvg - input.weight.startAvg)} kg` });
  } else if (input.weight?.perWeek !== null && input.weight?.perWeek !== undefined) {
    // Only one endpoint: report the rate, which the rolling average still
    // supports, rather than a change that cannot be computed.
    out.push({ label: 'Weight rate', value: `${signed(input.weight.perWeek)} kg/wk` });
  }

  if (input.strength?.tracked) {
    out.push({ label: 'Strength', value: `${input.strength.improved}/${input.strength.tracked} lifts` });
  }

  if (input.adherence?.scheduled) {
    out.push({
      label: 'Completion',
      value: `${Math.round((input.adherence.done / input.adherence.scheduled) * 100)}%`,
    });
  }

  if (input.records?.records) {
    out.push({ label: 'PRs', value: String(input.records.records) });
  }

  return out;
}

/* --- Formatting --------------------------------------------------------- */

function fmt(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return String(Number(Number(value).toFixed(decimals)));
}

function signed(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const body = fmt(Math.abs(n), decimals);
  if (Number(body) === 0) return '0';
  return `${n > 0 ? '+' : '−'}${body}`;
}
