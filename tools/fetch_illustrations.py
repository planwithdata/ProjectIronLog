"""Fetch and optimise exercise illustrations.

    python tools/match_exercises.py exercises.json    # produces the map
    python tools/fetch_illustrations.py               # then this

Source: the Free Exercise DB (https://github.com/yuhonas/free-exercise-db),
released into the public domain under the Unlicense. Two frames per exercise —
start and end position — which is what makes a still image useful for a
movement rather than merely decorative.

Why re-encode rather than hotlink
--------------------------------
Hotlinking would break the entire point of the app: no signal in a basement gym
means no pictures. So the images are committed. That makes their size the
app's problem, hence the downscale: 850px originals at ~73 KB become 440px WebP
at ~16 KB, which is still sharp at 2x on the widest card the layout allows.

Why they are NOT in the service worker's precache list
-----------------------------------------------------
Precaching 74 images would add ~1.2 MB to the first install for pictures the
user may never scroll to. The service worker's cache-first handler already
stores any same-origin GET it serves, so each image is cached the first time it
is actually displayed and is offline from then on.
"""

import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

from PIL import Image

RAW_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/'
OUT_DIR = 'assets/exercises'
MAP_PATH = 'tools/exercise-image-map.json'

# 440px stays sharp at 2x on the widest card the layout produces, and the pair
# sits side by side so each frame only ever needs half the card width.
TARGET_WIDTH = 440
WEBP_QUALITY = 76


def fetch(url, attempts=3):
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'ironlog-build'})
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as error:
            if attempt == attempts - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    return None


def optimise(raw, out_path):
    image = Image.open(io.BytesIO(raw)).convert('RGB')

    if image.width > TARGET_WIDTH:
        height = round(image.height * TARGET_WIDTH / image.width)
        image = image.resize((TARGET_WIDTH, height), Image.LANCZOS)

    image.save(out_path, 'WEBP', quality=WEBP_QUALITY, method=6)
    return image.size, os.path.getsize(out_path)


def main():
    if not os.path.exists(MAP_PATH):
        print(f'{MAP_PATH} not found — run tools/match_exercises.py first.')
        return 1

    mapping = json.load(io.open(MAP_PATH, encoding='utf-8'))
    os.makedirs(OUT_DIR, exist_ok=True)

    manifest = {}
    total_bytes = 0
    failures = []

    for index, (exercise_id, info) in enumerate(mapping.items(), 1):
        frames = []
        for frame_index, remote in enumerate(info['images'][:2], 1):
            out_name = f'{exercise_id}-{frame_index}.webp'
            out_path = os.path.join(OUT_DIR, out_name)

            if os.path.exists(out_path):
                frames.append(out_name)
                total_bytes += os.path.getsize(out_path)
                continue

            try:
                raw = fetch(RAW_BASE + remote)
                size, written = optimise(raw, out_path)
                total_bytes += written
                frames.append(out_name)
                print(f'  [{index:2d}/{len(mapping)}] {out_name:44s} {size[0]}x{size[1]}  {written // 1024} KB')
            except Exception as error:                      # noqa: BLE001
                failures.append((exercise_id, remote, str(error)))
                print(f'  [{index:2d}/{len(mapping)}] FAILED {exercise_id}: {error}')

        if frames:
            manifest[exercise_id] = {
                'frames': frames,
                'source': info['source_name'],
            }

    # Provenance, so the licence question is answerable a year from now.
    io.open(os.path.join(OUT_DIR, 'CREDITS.md'), 'w', encoding='utf-8', newline='\n').write(
        '# Exercise illustration credits\n\n'
        'Source: [Free Exercise DB](https://github.com/yuhonas/free-exercise-db)\n\n'
        'Released into the public domain under [the Unlicense]'
        '(http://unlicense.org/). No attribution is required; it is recorded '
        'here so the provenance stays answerable.\n\n'
        f'Images were downscaled to {TARGET_WIDTH}px wide and re-encoded as '
        f'WebP (quality {WEBP_QUALITY}) so they can be committed and served '
        'offline. Two frames per exercise: start and end position.\n\n'
        '## Mapping\n\n'
        '| Exercise in this program | Source exercise |\n|---|---|\n'
        + ''.join(
            f'| {exercise_id} | {info["source"]} |\n'
            for exercise_id, info in sorted(manifest.items())
        )
    )

    io.open(os.path.join(OUT_DIR, 'manifest.json'), 'w', encoding='utf-8', newline='\n').write(
        json.dumps(manifest, indent=2, sort_keys=True) + '\n')

    print()
    print(f'{len(manifest)} exercises, '
          f'{sum(len(v["frames"]) for v in manifest.values())} images, '
          f'{total_bytes / 1024 / 1024:.2f} MB total')
    if failures:
        print(f'{len(failures)} failure(s):')
        for exercise_id, remote, error in failures:
            print(f'  {exercise_id} <- {remote}: {error}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
