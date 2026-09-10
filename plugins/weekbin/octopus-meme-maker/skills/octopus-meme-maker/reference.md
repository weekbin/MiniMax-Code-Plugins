# Character Reference

Use this file to keep the character consistent across scenes. Read it before every `image_synthesize` call in stage 1.

## Anatomy (must match the reference frames exactly)

- **Body color** — uniform coral-pink everywhere on the head. No second tone, no shading patches, no ears in a different color.
- **Eyes** — two large white circles drawn directly on the pink face. Inside each white circle: a black round pupil taking up roughly half the white circle, with a small white highlight dot on the pupil.
- **Upper eyelids** — one short thin black arc above each white circle, horizontal, covering the top 30% of the white. The two arcs are independent (a strip of pink forehead sits between them). Never tilt the outer corners up.
- **Mouth** — small horizontal squiggle or omega-frown, slightly open. No teeth, no tongue.
- **Head bumps** — two small soft ear-like bumps on top of the head. They are part of the body, not protruding.
- **Tentacles** — 8 short stubby tentacles around the bottom.

## Style

- Smooth Squishmallow / Pop Mart 3D render, vibrant coral-pink plush-toy texture, NOT furry, NOT stitched plush.
- Soft warm lighting. Office setting: desk + lamp + monitor + 1 keyboard (background may vary by scene).
- Cute, not sinister. The whole character reads as a friendly office worker.

## Reference images

The 6 frames below are the ground truth. Pass all 6 to `image_synthesize` as `input_file_paths` every time you generate a base pose. One reference is not enough; the model needs the full set to lock the anatomy.

| File | What it shows |
|---|---|
| `reference/sample_01.png` | Front-on office, neutral face |
| `reference/sample_02.png` | Coffee mug, half-lidded eyes |
| `reference/sample_03.png` | Phone-in-tentacle, looking down |
| `reference/sample_04.png` | Smug horizontal smirk (NOT upturned) |
| `reference/sample_05.png` | Sprawled on desk, sleepy |
| `reference/sample_06.png` | Back-view, 8 tentacles visible |
| `reference/overview.png` | 6-up contact sheet for quick visual scan |

## Prompt template (paste into image_synthesize)

```text
A cute pink octopus mascot plush toy character in [SCENE_POSE].
Round coral-pink head with TWO small soft ear-like bumps on top.
8 stubby pink tentacles total.

[Concrete action / expression / prop description for this scene]

CRITICAL EYE ANATOMY (must match the reference exactly):
- The whole head and face is the SAME coral-pink plush body color.
- The eyes are LARGE WHITE CIRCLES drawn DIRECTLY on the pink face.
- Inside each white eyeball there is a BLACK ROUND PUPIL taking up about HALF of the white eyeball, with a small white highlight dot on the pupil.
- A SHORT THIN BLACK UPPER EYELID ARC sits just above each individual white eyeball, covering roughly the top 30% of the white circle.
- The eyelid arc is HORIZONTAL — never tilts upward at the outer corners (NEVER smirk, NEVER evil).
- Both arcs are the same length and mirror each other.
- Plenty of WHITE EYEBALL VISIBLE around the black pupil and under the eyelid.

MOUTH: small horizontal squiggly line or omega-frown, slightly open. No teeth, no tongue.

EXPRESSION: [scene-specific emotion], cute, not sinister.

[Pose / background / KEEP / NO list per scene]

Style: high-quality 3D character render, vibrant coral-pink plush-toy texture (Squishmallow / Pop Mart), soft warm lighting, [scene background]. The character is the same pink octopus mascot from the reference images.
```

## h3 Source Videos

`reference/videos/` holds 2 illustrative H3-generated videos — one expressive-anxiety scene and one multi-tentacle-coordination scene — selected as samples of the animation feel (tentacle weight, eye-blink timing, prop interaction). Both are 768×768, 24 fps, 6.58 s, 158 frames, h264 + aac.

| File | Size | Scene | Notes |
|---|---|---|---|
| `breakdown-h3.mp4` | 478 KB | 我裂开了 | Both hands on the head, eyes spiraling |
| `treat-milk-tea-h3.mp4` | 631 KB | 请大家喝奶茶 | All 8 tentacles holding a colorful cup |

The maintainer's full H3 collection lives in `~/Documents/cute/app/public/assets/octopus/_h3-source/` (9 videos covering the existing scene set). This Plugin only ships 2 to keep the package small — pick whichever scene the user is making, extract its first frame, and feed it to stage 1 as one of the `image_synthesize` `input_file_paths`.

### When to use the h3 video as the base input

When the user already has an h3 video for the scene they want (either from this Plugin's `reference/videos/` or from the maintainer's full collection), pass that video to `image_synthesize` as a `first_frame_image` source: extract the first frame with `ffmpeg -i <path-to-h3>.mp4 -vframes 1 /tmp/<scene>-first.png`, then pass `/tmp/<scene>-first.png` plus the 6 `sample_0*.png` as `input_file_paths`. This locks the character and the scene composition, then stage 1 of the pipeline only needs to vary the pose / expression — not the whole layout.

## Default settings

- Resolution: 2048×2048 (2K 1:1)
- Aspect ratio: 1:1
- Negative prompt: anything that triggers the `issues.md` ban-list (smirk, evil, teeth, tongue, eyebrow, tilted eyelids, missing head bumps)
