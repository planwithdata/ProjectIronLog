"""Match this program's exercises against the free-exercise-db dataset.

Run once, before fetching artwork:

    python tools/match_exercises.py /path/to/exercises.json

Prints a proposed mapping and, importantly, what it could NOT match — so the
gaps are dealt with deliberately rather than silently ending up with a picture
of the wrong movement, which is worse than no picture at all.
"""

import io
import json
import re
import sys
import difflib

# Synonyms the source program uses that the dataset names differently.
# Kept explicit rather than relying on fuzzy matching alone: "Hip Thrust" and
# "Hip Extension" score similarly and are not the same lift.
ALIASES = {
    'incline-dumbbell-press': ['Incline Dumbbell Press'],
    'flat-dumbbell-bench-press': ['Dumbbell Bench Press'],
    'machine-chest-press': ['Machine Bench Press', 'Leverage Chest Press'],
    'low-to-high-cable-fly': ['Low Cable Crossover'],
    'dumbbell-lateral-raise': ['Side Lateral Raise'],
    'rope-triceps-pushdown': ['Triceps Pushdown - Rope Attachment', 'Triceps Pushdown'],
    'overhead-rope-extension': ['Cable Rope Overhead Triceps Extension'],
    'hanging-knee-raise': ['Hanging Leg Raise', 'Hanging Pike'],
    'pallof-press': ['Pallof Press'],

    'pull-ups': ['Pullups', 'Wide-Grip Pullup'],
    'wide-grip-lat-pulldown': ['Wide-Grip Lat Pulldown'],
    'chest-supported-row': ['Leverage Iso Row', 'Seated Cable Rows'],
    'one-arm-cable-row': ['Seated One-arm Cable Pulley Rows'],
    'straight-arm-pulldown': ['Straight-Arm Pulldown', 'Straight-Arm Dumbbell Pullover'],
    'incline-dumbbell-curl': ['Incline Dumbbell Curl'],
    'hammer-curl': ['Hammer Curls', 'Cross Body Hammer Curl'],
    'face-pull': ['Face Pull'],

    'hack-squat': ['Hack Squat', 'Narrow Stance Hack Squats'],
    'bulgarian-split-squat': ['Split Squat with Dumbbells', 'One Leg Barbell Squat'],
    'leg-press': ['Leg Press', 'Narrow Stance Leg Press'],
    'leg-extension': ['Leg Extensions'],
    'standing-calf-raise': ['Standing Calf Raises', 'Calf Press'],
    'cable-crunch': ['Cable Crunch', 'Kneeling Cable Crunch'],

    'incline-smith-machine-press': ['Smith Machine Incline Bench Press'],
    'seated-cable-row': ['Seated Cable Rows'],
    'neutral-grip-lat-pulldown': ['Close-Grip Front Lat Pulldown'],
    'machine-shoulder-press': ['Machine Shoulder (Military) Press'],
    'cable-lateral-raise': ['Side Lateral Raise'],
    'reverse-pec-deck': ['Reverse Machine Flyes'],
    'ez-bar-curl': ['EZ-Bar Curl', 'Barbell Curl'],
    'ez-bar-skull-crusher': ['EZ-Bar Skullcrusher'],

    'romanian-deadlift': ['Romanian Deadlift', 'Stiff-Legged Barbell Deadlift'],
    'hip-thrust': ['Barbell Hip Thrust'],
    'lying-leg-curl': ['Lying Leg Curls'],
    'walking-lunges': ['Dumbbell Lunges', 'Barbell Lunge'],
    'seated-calf-raise': ['Seated Calf Raise'],
    'ab-wheel-rollout': ['Barbell Ab Rollout - On Knees', 'Barbell Ab Rollout'],
}


def normalise(text):
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def main(db_path):
    db = json.load(io.open(db_path, encoding='utf-8'))
    by_name = {normalise(entry['name']): entry for entry in db}
    names = list(by_name)

    program = json.load(io.open('data/workouts.json', encoding='utf-8'))

    mapping = {}
    unmatched = []

    for day in program['days']:
        for exercise in day['exercises']:
            candidates = ALIASES.get(exercise['id'], []) + [exercise['name']]

            chosen = None
            for candidate in candidates:
                key = normalise(candidate)
                if key in by_name and by_name[key].get('images'):
                    chosen = by_name[key]
                    break

            if not chosen:
                # Last resort: closest name, but only if it is a strong match.
                close = difflib.get_close_matches(
                    normalise(exercise['name']), names, n=1, cutoff=0.82)
                if close and by_name[close[0]].get('images'):
                    chosen = by_name[close[0]]

            if chosen:
                mapping[exercise['id']] = {
                    'source_id': chosen['id'],
                    'source_name': chosen['name'],
                    'images': chosen['images'],
                    'equipment_ours': exercise.get('equipment'),
                    'equipment_theirs': chosen.get('equipment'),
                }
            else:
                unmatched.append((exercise['id'], exercise['name']))

    print(f'matched {len(mapping)} of {len(mapping) + len(unmatched)}\n')
    for our_id, info in mapping.items():
        flag = '' if (info['equipment_ours'] or '') in (info['equipment_theirs'] or '') \
            or (info['equipment_theirs'] or '') in (info['equipment_ours'] or '') else '  <-- equipment differs'
        print(f'  {our_id:30s} -> {info["source_name"]}{flag}')

    if unmatched:
        print('\nUNMATCHED — needs a decision, not a guess:')
        for our_id, name in unmatched:
            print(f'  {our_id:30s} ({name})')

    io.open('tools/exercise-image-map.json', 'w', encoding='utf-8', newline='\n').write(
        json.dumps(mapping, indent=2) + '\n')
    print('\nwrote tools/exercise-image-map.json')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'exercises.json')
