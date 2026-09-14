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
| Head bumps absent (model rendered zero bumps) | Prompt did not mention them | Add "TWO small soft ear-like bumps on top" to the anatomy block |
| Head bumps HIDDEN by pose / angle / smoke / framing (model rendered them, but the camera angle, a tucked pose, dense smoke, or a tight crop hides one or both bumps) | Pose or composition overrules the bumps; this is the more common failure mode of the two | (1) Move the bumps mention to the very top of the prompt, (2) add "BOTH bumps must be visible and unobscured in the final image — do not let pose / angle / smoke / framing hide them", (3) when the scene requires a tight pose (e.g. octopus on its back, head tucked under tentacles), change the pose or the camera angle so both bumps read |
| Body surface looks flocked / fuzzy / felt / furry / woven / cloth instead of smooth Squishmallow vinyl | Model drifts toward "well-done plush" or "charred plush" and adds a fabric texture; common when the scene is BBQ / fire / hot / cozy | (1) Add the SURFACE block from `reference.md` § Prompt template verbatim, (2) call out the failure mode explicitly: "DO NOT render the body as flocked velvet, fuzzy fabric, felt, fur, woven cloth, or stitched plush", (3) add "Texture must be consistent across the entire body — no smooth/fuzzy zones", (4) re-check ALL 6 candidates in the contact sheet, not just one |
| One candidate in the batch looks sharper than the others (texture / lighting / crispness drift across the 6) | Inconsistent prompt application across parallel requests | Reject the off-style candidates and re-roll ONLY those indices with the SURFACE block added at the top of the prompt, not the bottom |

## Pipeline failures

| Symptom | Root cause | Fix |
|---|---|---|
| `gen_videos` returns "input file path outside workspace" | `image_synthesize` saved the base to an absolute path outside the host's workspace | Copy the base to the host's workspace-relative path before calling `gen_videos` |
| `make_gif.py` hangs on ffmpeg filter_complex | Single ffmpeg invocation with too many filters | The shipped script already splits into 3 ffmpeg runs (overlay, palettegen, paletteuse); do not collapse them into one |
| `final.gif` exceeds 16 MB | Background contains gradient / motion blur / many distinct colors | Lower `paletteuse=dither=bayer:bayer_scale` from 5 to 4; reduce fps from 24 to 20 in the script args |
| `final-mini.gif` is unexpectedly large (5 MB+) | High-frequency detail survives the 480×480 downscale, so the mini palette still needs many colors | Reduce fps from 24 to 20, or accept it — the reference scenes range 0.8–5.3 MB, so a large mini is not by itself a defect |
| Text overflows the canvas | Font size 220 with 4-character caption | Use `--size 130` for 4-character captions; 220 fits only 2-character captions at 1080 wide |

## Feedback signals (translate user reports into action)

| User says | Action |
|---|---|
| "眼睛是白色的嘛" or "眼睛画错了" | Re-read `reference.md` § Anatomy; re-paste the full eye block; re-run stage 1 |
| "邪恶" or "太丑了" | Sweep the prompt for any ban-list word; replace with horizontal / cute / not-sinister |
| "质感不对" / "fuzzy" / "flocked" / "像毛绒玩具" / "像布料" | Add the SURFACE block from `reference.md` § Prompt template verbatim; reject any candidate whose body looks like fabric; re-roll with the SURFACE block at the TOP of the prompt |
| "耳朵没了" / "缺耳朵" / "头上没凸起" | First check whether the bumps are HIDDEN (camera angle / pose / framing) rather than absent — if so, change the pose or the camera angle per the "Head bumps HIDDEN" ban-list row; if truly absent, add the bumps line at the very top of the prompt |
| "切掉了一部分" or "图片被裁了" | Stop cropping the video for text. Use the transparent overlay path (stage 4) |
| "文字后面有白底" | The script's overlay is transparent by default; check that the canvas is RGBA and `(0,0,0,0)` |
| "视频太短 / 太快" | Check `ffprobe` `nb_frames` and `duration`; the target is 141 frames at 24fps = 5.87s |
| "和之前不一样了" | The character drifted from the reference. Re-run stage 1 with all 6 reference frames attached |

## Maintenance

When a new failure mode is found, add a row. When a fix is no longer relevant (e.g. a ban-list word is no longer triggering the model), remove the row — do not keep a "previously this was broken" history.
