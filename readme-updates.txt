# IronLog — Problems, Issues & Desired Changes

Please review the app and the attached `ironlog-backup-2026-09-02.json` kept in the working directory carefully. The points below describe the problems I am experiencing and the behavior I want from the app. **Please investigate the underlying app logic/code and determine the appropriate way to fix these issues rather than assuming the fixes described below are implementation instructions.**

---

## 1. Flat Dumbbell Bench Press is giving an incorrect progression recommendation

The app is currently recommending **72 kg** for flat dumbbell bench press even though my recent repeatable working sets have been around **55 kg total**.

The important distinction is that I have performed a heavier **72 kg total / 36 kg per dumbbell** set before, but that was not my normal repeatable working load.

The app appears to be treating that heavier set as though it represents my normal working capacity and is therefore recommending 72 kg as the next target.

This does not make sense for my actual progression.

The JSON contains enough historical data to see the difference between my normal working sets and heavier sets, so please inspect how the recommendation was generated and why the app arrived at 72 kg.

---

## 2. The app sometimes appears to confuse heavy/top/intensity sets with normal working sets

This seems to be related to the flat dumbbell bench issue, but I want the editor to investigate whether this is a broader problem.

There are exercises where I perform:

* normal repeatable working sets
* occasional heavier/top sets
* intensity/failure sets

I have noticed that the app's recommendations can appear to treat the heavier performance as representative of my normal working capacity.

Please inspect the JSON and the recommendation behavior across exercises to determine whether this is happening elsewhere as well.

The intended concept from my perspective is that a weight I briefly push for a heavy set should not automatically mean that I should perform that weight for all my normal working sets.

---

## 3. Dumbbell weights can be confusing

For dumbbell exercises, the app needs to make it very clear whether the displayed weight is:

* weight of **one dumbbell**, or
* **total weight of both dumbbells**.

For example:

> 72 kg flat dumbbell bench = 36 kg in each hand.

This distinction is important because otherwise the displayed numbers can be misleading when looking at historical progression.

Please inspect how dumbbell weights are currently represented and displayed.

---

## 4. Cable-machine weights are not directly comparable

I use different cable machines, and their displayed resistance numbers are not equivalent.

For example, approximately:

> **4.5 kg on one cable machine can feel/represent roughly 10 kg on another machine.**

Therefore, seeing a change such as 4.5 kg → 10 kg does not necessarily represent a real strength increase.

This is particularly relevant for cable exercises such as:

* cable fly
* rope pushdown
* overhead rope extension
* rows
* face pulls
* etc.

The app currently has historical data where the same exercise appears with substantially different numerical loads, and this can make the progression recommendations misleading.

Please inspect how the app currently interprets these numbers and how this is affecting the analytics/recommendations.

---

## 5. Cable-machine changes should not make my progression history misleading

If I perform the same exercise on a different cable machine, I don't want the app to interpret the different machine's number as though my strength suddenly increased or decreased by that amount.

This is especially important because I may move between machines depending on what is available in the gym.

The app should still understand that the underlying exercise is the same while recognizing that the displayed resistance may not be directly comparable.

Please inspect the existing JSON/history and determine how this should be represented in the app's analytics and recommendations.

---

## 6. Rope and bar triceps pushdowns should be treated sensibly when I substitute one for the other

My programmed exercise may be:

> Rope triceps pushdown

but sometimes I perform:

> Bar triceps pushdown

because of equipment availability or preference.

I don't want this to be treated as though I simply skipped the planned exercise.

I want the app to understand that this is a meaningful substitution and retain the workout/performance information appropriately.

At the same time, I recognize that the resistance numbers between different attachments/machines may not be directly comparable.

Please inspect how this currently behaves and account for this in the app.

---

## 7. Pallof Press is too time-consuming/fatiguing in its current implementation

I currently have Pallof press as the final/core exercise.

The current setup makes it unnecessarily slow and tiring, particularly because of the slow tempo.

I don't want it to be treated like one of my major compound/progressive-overload exercises.

### My requested change:

**Pallof Press: 2 sets instead of 3.**

I also don't want an excessively slow tempo to make this exercise unnecessarily time-consuming.

Please make the workout experience consistent with that preference.

---

## 8. The app should not assume that the programmed target and the actual performed weight are always the same

There are examples in the JSON where I have performed a different weight from the app's programmed target.

For example, the Aug 29 incline Smith machine press shows a programmed target of 40 kg while I actually performed 45 kg for some/all working sets.

I want the app to preserve the distinction between:

> what the app planned

and

> what I actually did.

The recommendation/analytics should use that information intelligently rather than simply overwriting one with the other or assuming that any deviation means the programmed progression should immediately change.

Please inspect how this currently works.

---

## 9. Progression recommendations need to be consistent with my actual multi-set performance

The app generally uses a rep-first progression system, which I like.

However, I want the editor to inspect whether recommendations are being generated consistently across all sets.

For example, there is an important difference between:

> 12, 12, 12

and:

> 12, 8, 8

even though both contain a set of 12.

The recommendation should reflect the performance of the workout as a whole rather than being overly influenced by one unusually strong set.

Please inspect the recommendation logic using the actual workout history in the JSON.

---

## 10. Warm-up sets should not distort my progression history

The JSON contains separate warm-up sets, which is good.

However, please verify that these are not being interpreted as meaningful working performance by the recommendation or analytics systems.

I want the historical record to distinguish between:

* warm-up
* working set
* heavy/top set
* intensity/failure set

because these represent very different things.

---

# 11. IMPORTANT: I should be able to do a different day's workout whenever necessary

The app currently does a good job of telling me which workout is **next according to my planned schedule**.

However, there is a problem if I miss a workout.

For example:

> Monday = Rest
> Tuesday = Chest
> Wednesday = Back & Biceps

If I miss Tuesday's Chest workout, I don't necessarily want Wednesday's screen to behave as though Chest no longer exists simply because Wednesday is technically the next scheduled day.

I need the app to support real-life schedule changes.

### Desired behavior

**On any day, I should be able to select a different day's workout and start it.**

For example:

* Today is Wednesday.
* I missed Tuesday Chest.
* I should be able to select Tuesday Chest and perform it today.
* The app should record that I performed Tuesday Chest on Wednesday.
* The normal planned schedule should still remain understandable.
* The app should not lose track of the fact that Chest was originally scheduled for Tuesday.

This should work for any workout in the program, not just the immediately previous day.

I should be able to say, in effect:

> "I want to do this workout today."

without breaking the underlying schedule.

### Analytics should also understand this intelligently

If I perform a Tuesday workout on Wednesday, the analytics should not treat it as though I performed the wrong workout or simply missed Tuesday.

It should be able to distinguish:

* **planned workout date**
* **actual workout date**
* whether the workout was completed late/early
* actual performance

The editor should determine the best way to handle this within the existing architecture.

---

# 12. I want significantly better workout analytics

The current analytics are not sufficient for what I want from IronLog.

I want the app to provide much more useful insight into how my training is actually progressing.

**Please inspect the attached JSON in detail and use my actual workout history to determine what the most useful analytics would be for me.**

I don't want generic bodybuilding charts simply added for the sake of having more charts.

I want analytics that actually answer useful questions such as:

* Am I getting stronger?
* Which exercises are progressing fastest?
* Which exercises are stalled?
* Where am I adding reps versus adding load?
* How is my performance changing over time?
* Which muscle groups/exercises are progressing well?
* Where am I plateauing?
* What is my actual training volume trend?
* How consistent is my training?
* How are working-set loads changing?
* How is my performance changing across the different weeks of the program?
* What happens after deloads?
* Are there exercises where my performance is falling despite maintaining/increasing load?
* What are my meaningful PRs?
* How is my estimated strength/performance changing where appropriate?
* Which exercises have the clearest upward trajectory?
* Which ones need attention?

These are examples rather than a rigid list.

**Please look at the actual structure and history in the JSON and decide what analytics would be most valuable based on the way I train and the data IronLog already records.**

The analytics should help me understand my training, not just display raw workout history.

---

# 13. The app should intelligently use all this information together

The bigger issue is that IronLog should understand the context of my training rather than treating every logged number as equivalent.

The system has information about:

* planned workouts
* actual workouts
* dates
* exercises
* working sets
* warm-up sets
* intensity sets
* weights
* reps
* progression recommendations
* workout weeks
* deload status
* substitutions
* etc.

The app should use this information intelligently when generating recommendations and analytics.

Please review the JSON as a real-world example of how I actually train and identify **any other recommendation, progression, scheduling, analytics, or data-model problems you notice**, even if I have not explicitly listed them above.

If you find something else that appears wrong or inconsistent, please fix it rather than limiting the review strictly to the issues listed here.

---

# Overall goal

I want IronLog to behave like a genuinely intelligent training log:

**It should understand what I planned, what I actually did, how I am progressing, what equipment/context I used, and how my schedule actually unfolded.**

It should then use that information to provide sensible progression recommendations and genuinely useful analytics.

Finally, make sure this works - I currently can backup the app data using the json and load it back again after making changes in the app. Make sure this functionality stays intact as after editing I'd like it to get all the data from my past workouts logged back in there via the json file.