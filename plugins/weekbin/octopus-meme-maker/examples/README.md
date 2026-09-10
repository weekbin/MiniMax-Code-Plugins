# Examples — base pose samples

This directory holds `base.png` samples that the maintainer has successfully extracted. They serve two purposes:

1. **抽卡的基础图** — pass them as `input_file_paths` to `image_synthesize` together with `reference/sample_0*.png` to lock the character anatomy and the scene layout, then vary only the pose / expression.
2. **Reference for the scene table** — the file naming matches the maintainer's external scene table, e.g. `<works>/octopus-worker-meme/<scene-number>-<scene-name>/`, so consumers can cross-reference.

| File | Source | Use as `image_synthesize` input_file_path? |
|---|---|---|
| `02-stay-late-base.png` | image_synthesize (seeded with maintainer's external H3 first frame) | yes — locks coffee + half-lidded eyes |
| `10-toilet-slacking-base.png` | image_synthesize (no matching H3 source) | yes — locks toilet tiles + phone + open-mouth smile |
| `11-touch-fish-base.png` | image_synthesize (seeded with maintainer's external H3 first frame) | yes — locks desk + salmon + side-glance |

When adding a new base, follow the `<scene-number>-<scene-name>-base.png` convention. The matching H3 source video (if any) lives in the maintainer's external collection at `~/Documents/cute/app/public/assets/octopus/_h3-source/`; this Plugin only ships 2 illustrative H3 videos in `reference/videos/` (`breakdown-h3.mp4`, `treat-milk-tea-h3.mp4`).
