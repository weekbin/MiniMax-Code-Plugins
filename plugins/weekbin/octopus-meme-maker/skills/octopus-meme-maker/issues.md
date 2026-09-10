# Known Issues and Failure Modes

When the user reports a problem, find the matching row, read the root cause, apply the fix. Do not skip this file.

## Ban-list (rejects any base pose that matches)

| Symptom | Root cause | Fix |
|---|---|---|
| Eyes drawn as beige sockets with a black line | Anatomy description omitted | Re-paste the full eye-anatomy block from `reference.md` into the prompt |
| Sinister / evil smirk | Prompt contains "smirk", "squinted upward", or "evil" | Remove these words; replace with "HORIZONTAL half-lidded" and "cute, not sinister" |
| Visible teeth or tongue | Prompt contains "show teeth" or "tongue" | Add explicit "NEVER show teeth or tongue" |
| Eyebrows drawn as a single black bar | Prompt contains "eyebrow" (misread as one thick bar) | Replace with the per-eye upper-eyelid arc description |
| Mouth tilts upward into a grin | Prompt or model defaulted to a smile | Add "Mouth opens HORIZONTALLY, never angles upward" |
| Head bumps missing | Prompt did not mention them | Add "TWO small soft ear-like bumps on top" to the anatomy block |

## Pipeline failures

| Symptom | Root cause | Fix |
|---|---|---|
| `gen_videos` returns "input file path outside workspace" | `image_synthesize` saved the base to an absolute path outside the host's workspace | Copy the base to the host's workspace-relative path before calling `gen_videos` |
| `make_gif.py` hangs on ffmpeg filter_complex | Single ffmpeg invocation with too many filters | The shipped script already splits into 3 ffmpeg runs (overlay, palettegen, paletteuse); do not collapse them into one |
| `final.gif` > 7 MB despite a simple scene | Background contains gradient / motion blur / many distinct colors | Lower `paletteuse=dither=bayer:bayer_scale` from 5 to 4; reduce fps from 24 to 20 in the script args |
| `final-mini.gif` > 1.7 MB | Scale 480×480 but the source palette is still 720×720's | Re-run `make_gif.py` which builds the mini from a separately extracted 480×480 palette; do not downscale an already-encoded GIF |
| Text overflows the canvas | Font size 220 with 4-character caption | Use `--size 130` for 4-character captions; 220 fits only 2-character captions at 1080 wide |

## Feedback signals (translate user reports into action)

| User says | Action |
|---|---|
| "眼睛是白色的嘛" or "眼睛画错了" | Re-read `reference.md` § Anatomy; re-paste the full eye block; re-run stage 1 |
| "邪恶" or "太丑了" | Sweep the prompt for any ban-list word; replace with horizontal / cute / not-sinister |
| "切掉了一部分" or "图片被裁了" | Stop cropping the video for text. Use the transparent overlay path (stage 4) |
| "文字后面有白底" | The script's overlay is transparent by default; check that the canvas is RGBA and `(0,0,0,0)` |
| "视频太短 / 太快" | Check `ffprobe` `nb_frames` and `duration`; the target is 141 frames at 24fps = 5.87s |
| "和之前不一样了" | The character drifted from the reference. Re-run stage 1 with all 6 reference frames attached |

## Maintenance

When a new failure mode is found, add a row. When a fix is no longer relevant (e.g. a ban-list word is no longer triggering the model), remove the row — do not keep a "previously this was broken" history.
