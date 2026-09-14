# Character & Style Reference

Use this file to keep the character consistent across scenes. Read it before
every `image_synthesize` call in stage 1.

## What the bundled reference folders actually are

This Plugin ships two folders that work together:

| Folder | What it actually contains | Role in the pipeline |
|---|---|---|
| `examples/<scene>-base.png` | Three complete 3D Squishmallow-style base images produced by `image_synthesize` for prior scenes (stay-late / toilet-slacking / touch-fish). | **The character + style reference.** Pass all three as `input_file_paths` for every new scene; the prompt overrides the scene composition but inherits the Squishmallow style, anatomy, and rendering vibe. |
| `reference/videos/*.mp4` | Two illustrative H3-generated videos (breakdown, treat-milk-tea) showing the animation feel this Plugin targets. | **Animation-feel reference.** Optional; pass the first frame to `image_synthesize` if you want to lock both the character AND the scene composition from a known-good H3 source (see § h3 Source Videos below). |

> **Removed in 0.2.0:** the old `reference/sample_0[1-6].png` and
> `reference/overview.png` files were 6 frame extractions from an unrelated
> "在改了" GIF (a flat-shaded 2D cartoon, not the Squishmallow character this
> skill produces). They were misleading the model toward the wrong style and
> have been deleted from the repository. Do not reintroduce them.

## Anatomy (must match the reference frames exactly)

- **Body color** — uniform coral-pink everywhere on the head. No second tone, no shading patches, no ears in a different color.
- **Eyes** — two large white circles drawn directly on the pink face. Inside each white circle: a black round pupil taking up roughly half the white circle, with a small white highlight dot on the pupil.
- **Upper eyelids** — one short thin black arc above each white circle, horizontal, covering the top 30% of the white. The two arcs are independent (a strip of pink forehead sits between them). Never tilt the outer corners up.
- **Mouth** — small horizontal squiggle or omega-frown, slightly open. No teeth, no tongue.
- **Head bumps** — two small soft ear-like bumps on top of the head. They are part of the body, not protruding.
- **Tentacles** — 8 short stubby tentacles around the bottom.

## Style

- Smooth Squishmallow / Pop Mart 3D render, vibrant coral-pink plush-toy texture, NOT furry, NOT stitched plush.
- Soft warm lighting. Background varies by scene (office desk for work scenes, restroom for toilet scenes, BBQ grill for grill scenes, etc.).
- Cute, not sinister. The whole character reads as a friendly office worker / meme character.

## Reference images

**Always pass the three `examples/*.png` files** as `input_file_paths` to
`image_synthesize` for every new scene. They lock the
Squishmallow style, the 8 tentacles, the eye anatomy, and the head bumps.
The prompt supplies the new scene composition; the references supply the
visual style.

| File | What it shows |
|---|---|
| `examples/02-stay-late-base.png` | Half-lidded eyes, octopus at desk with coffee + monitor |
| `examples/10-toilet-slacking-base.png` | Open-mouth smile, big sparkly eyes, octopus on toilet reading phone |
| `examples/11-touch-fish-base.png` | Side-glance, octopus at desk with salmon |

If you also have a relevant H3 source video (see § h3 Source Videos below),
pass its first frame as an additional `input_file_path` to lock the scene
composition too.

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

This Plugin ships 2 sample videos to keep the package small. They are illustrations of the animation feel, not a required input. Generate the H3 video for your own scene when you reach stage 2.

### When to use an h3 video as the base input

When an H3 video for the target scene already exists (this Plugin's `reference/videos/`, or one you generated), pass it to `image_synthesize` as a `first_frame_image` source: extract the first frame with `ffmpeg -i <path-to-h3>.mp4 -vframes 1 /tmp/<scene>-first.png`, then pass `/tmp/<scene>-first.png` plus the **3 `examples/*.png`** as `input_file_paths`. This locks the Squishmallow style and the scene composition, then stage 1 of the pipeline only needs to vary the pose / expression — not the whole layout.

## Default settings

- Resolution: 2048×2048 (2K 1:1)
- Aspect ratio: 1:1
- Negative prompt: anything that triggers the `issues.md` ban-list (smirk, evil, teeth, tongue, eyebrow, tilted eyelids, missing head bumps)
