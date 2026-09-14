---
name: octopus-meme-maker
description: Use this skill when the user asks for a new pink-octopus office-worker GIF meme, a Smooth Squishmallow-style worker octopus sticker, a 4-character Chinese caption on a 720x720 looping GIF, or wants to add a scene to an existing meme library. Drives a 4-stage pipeline (base pose via image_synthesize -> 6s 24fps video via gen_videos -> transparent Chinese text overlay via Pillow -> 720x720 + 480x480 GIF via ffmpeg) and enforces a strict character-anatomy ban-list. Read this skill before starting any new scene.
license: Apache-2.0
metadata:
  author: weekbin
  version: 0.1.0
---

# Octopus Meme Maker

Generate one 720×720 looping GIF + one 480×480 mini-GIF per scene. Read this entire file before producing any output.

## 1. Pre-flight

`${PLUGIN_ROOT}` is the environment variable MiniMax Code sets to this Plugin's root directory. Every command in this file is anchored to it, so the commands work from any working directory.

Read `reference.md` (anatomy + prompt template) and `issues.md` (ban-list + failure modes) before stage 1.

### 1.1 Copy the reference frames

Shell blocks in this file are POSIX shell: macOS, Linux, or Git Bash on Windows.

```shell
mkdir -p <scene-dir>/iterations <scene-dir>/frames-check
cp "${PLUGIN_ROOT}"/reference/sample_*.png <host-image-synthesize-input-dir>/
```

Exit condition: `ls "${PLUGIN_ROOT}"/reference/sample_*.png` lists 6 files; `<scene-dir>/iterations/` and `<scene-dir>/frames-check/` exist.

## 2. Stage 1 — base pose (image_synthesize, 2K 1:1)

Generate a 2048×2048 PNG. Iterate by saving rejected attempts to `iterations/vN-base.png` until the user confirms. Reject any output that matches an `issues.md` ban-list entry; iterate ≥ 1 time before asking the user.

### 2.1 Prompt skeleton

```text
A cute pink octopus mascot plush toy character in <SCENE_POSE>.
[Full anatomy block — see reference.md § Anatomy]
[Scene-specific action / expression / prop]
Style: Squishmallow / Pop Mart 3D render, NOT furry, NOT stitched plush.
```

Exit condition: `<scene-dir>/base.png` is a 2048×2048 PNG and the user has typed "确认" / "OK" / "可以".

## 3. Stage 2 — 6s video (gen_videos, 1080p 24fps)

Call `gen_videos` with `<scene-dir>/base.png` as `first_frame_image` and a 6-second prompt that restates the stage 1 prompt's style block. Copy the output to `<scene-dir>/video.mp4` inside the host's workspace (host tool requires a workspace-relative path; absolute paths fail).

### 3.1 gen_videos parameters

```text
video_prompt = "<stage 1 style block> + <6-second motion description>"
duration     = 6s
fps          = 24
size         = 1080x1080
```

Exit condition: `<scene-dir>/video.mp4` exists and `ffprobe -show_streams video.mp4` reports `width=1080 height=1080` at `r_frame_rate=24/1` with `nb_frames=141`.

## 4. Stage 3 — preview strip (sanity check, not the deliverable)

### 4.1 Generate the strip

```shell
python3 "${PLUGIN_ROOT}/scripts/make_preview_strip.py" <scene-dir>/video.mp4 \
  <scene-dir>/frames-check/preview.png \
  --labels "t=0.0s,<pose>,t=1.8s,<pose>,t=3.0s,<pose>,t=4.2s,<pose>,t=5.8s,<pose>"
```

Exit condition: `frames-check/preview.png` exists, 5 frames wide, and the user confirms the animation reads as expected.

## 5. Stage 4 — GIF assembly (the deliverable)

### 5.1 Compose both GIFs

```shell
python3 "${PLUGIN_ROOT}/scripts/make_gif.py" <scene-dir> "<caption>"
```

The script writes both `<scene-dir>/final.gif` (720×720) and `<scene-dir>/final-mini.gif` (480×480). Both scripts resolve their own location, so the command works from any working directory.

File size tracks scene complexity, not a fixed budget. Across the 23 reference scenes the main GIF lands between 2.8 MB and 15.8 MB (median 7.2 MB), and the mini GIF between 0.8 MB and 5.3 MB (median 1.6 MB). Report both sizes to the user as information; treat the ranges as a sanity band rather than a cap.

Exit condition: both files exist, `ffprobe -select_streams v:0 -show_entries stream=width,height,nb_frames` reports `720,720,141` for `final.gif` and `480,480,141` for `final-mini.gif`, and the caption reads correctly. If `final.gif` exceeds 16 MB, apply the reduction levers in § Failure Recovery.

## 6. Examples

### 6.1 摆烂躺平 (lying flat)

- Caption: "摆烂躺平"
- Pose: sprawled on the desk, one eye half-closed, one tentacle holding a coffee cup
- Expected: `base.png` 2048×2048; `final.gif` ≈ 6 MB; `final-mini.gif` ≈ 1.6 MB.

### 6.2 假装很忙 (pretending to be busy, no caption)

- Caption: (none)
- Pose: phone in one tentacle, eyes down, neutral mouth
- Stage 4 command: `python3 "${PLUGIN_ROOT}/scripts/make_gif.py" <scene-dir> ""` — the overlay is empty, only the video frames survive.

### 6.3 期待 m3pro (waiting for m3pro)

- Caption: "期待 m3pro"
- Pose: tentacles cupping the cheeks, eyes wide
- Expected: `base.png` 2048×2048; `final.gif` ≈ 4 MB; `final-mini.gif` ≈ 1.0 MB.

## 7. Failure Recovery

### 7.1 Stage 1 base pose hits a ban-list entry

Re-read `issues.md` § Ban-list. Sweep the prompt for the matching word, replace with the recommended phrasing, re-run stage 1 with the previous attempt saved to `iterations/vN-base.png`. Iterate ≥ 1 time before re-asking the user.

### 7.2 Stage 2 gen_videos returns "input file path outside workspace"

The host tool only accepts paths inside the host's workspace. Copy `<scene-dir>/base.png` to `<host-workspace>/<scene-dir>/base.png` first, then pass the workspace-relative path. Do not pass an absolute path.

### 7.3 Stage 4 final.gif exceeds 16 MB

The scene carries heavy motion blur, a wide gradient, or many distinct colours. Lower `PALETTE_DITHER` from `bayer:bayer_scale=5` to `bayer:bayer_scale=4` in `"${PLUGIN_ROOT}/scripts/make_gif.py"`, or reduce `FPS` from 24 to 20. Re-run stage 4; do not regenerate base or video.

## 8. Quick Reference

| Stage | Tool | Output | Exit criterion |
|---|---|---|---|
| 1. base pose | `image_synthesize` | `<scene-dir>/base.png` | 2048×2048 PNG, user-confirmed |
| 2. video | `gen_videos` | `<scene-dir>/video.mp4` | 1080×1080, 141 frames @ 24fps |
| 3. preview | `make_preview_strip.py` | `frames-check/preview.png` | 5 frames wide |
| 4. GIF | `make_gif.py` | `final.gif` + `final-mini.gif` | 720,720,141 and 480,480,141 |

For character anatomy, prompt template, and reference frames, see `reference.md`. For known failure modes and feedback-signal translations, see `issues.md`.

## 9. Hard Rules

- Stage 1 must iterate ≥ 1 time before asking the user. First-shot base poses fail the ban-list roughly 60% of the time.
- Never crop the video to fit text. The text is composited as a transparent overlay, not baked into the video.
- Never hardcode scene paths. Use `<scene-dir>` as a parameter; the Plugin must work for any user-provided scene name.
- After stage 4, append a row to the maintainer's `README.md` scene table with `path`, `caption`, and `size` for both GIFs.
