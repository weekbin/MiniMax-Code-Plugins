---
name: octopus-meme-maker
description: Use this skill when the user asks for a new pink-octopus office-worker GIF meme, a Smooth Squishmallow-style worker octopus sticker, a 4-character Chinese caption on a 720x720 looping GIF, or wants to add a scene to an existing meme library. Drives a 4-stage pipeline (base pose via image_synthesize -> 6s 24fps video via gen_videos -> transparent Chinese text overlay via Pillow -> 720x720 + 480x480 GIF via ffmpeg) and enforces a strict character-anatomy ban-list. Read this skill before starting any new scene.
license: Apache-2.0
metadata:
  author: weekbin
  version: 0.1.0
  scope: plugin-portable
  minMcodeVersion: 0.2.0
---

# Octopus Meme Maker

Generate one 720×720 looping GIF + one 480×480 mini-GIF per scene. Read this entire file before producing any output.

## 1. Pre-flight

Read `reference.md` (anatomy + prompt template) and `issues.md` (ban-list + failure modes) before stage 1.

### 1.1 Copy the reference frames

```bash
mkdir -p <scene-dir>/{iterations,frames-check}
cp reference/sample_0{1..6}.png <host-image-synthesize-input-dir>/
```

Exit condition: `ls reference/sample_0{1..6}.png` returns 6 paths; `<scene-dir>/iterations/` and `<scene-dir>/frames-check/` exist.

## 2. Stage 1 — base pose (image_synthesize, 2K 1:1)

Generate a 2048×2048 PNG. Iterate by saving rejected attempts to `iterations/vN-base.png` until the user confirms. Reject any output that matches an `issues.md` ban-list entry; iterate ≥ 1 time before asking the user.

### 2.1 Prompt skeleton

```text
A cute pink octopus mascot plush toy character in <SCENE_POSE>.
[Full anatomy block — see reference.md § Anatomy]
[Scene-specific action / expression / prop]
Style: Squishmallow / Pop Mart 3D render, NOT furry, NOT stitched plush.
```

Exit condition: `<scene-dir>/base.png` exists, ≥ 2 MB, and the user has typed "确认" / "OK" / "可以".

## 3. Stage 2 — 6s video (gen_videos, 1080p 24fps)

Call `gen_videos` with `<scene-dir>/base.png` as `first_frame_image` and a 6-second prompt that restates the stage 1 prompt's style block. Copy the output to `<scene-dir>/video.mp4` inside the host's workspace (host tool requires a workspace-relative path; absolute paths fail).

### 3.1 gen_videos parameters

```text
video_prompt = "<stage 1 style block> + <6-second motion description>"
duration     = 6s
fps          = 24
size         = 1080x1080
```

Exit condition: `<scene-dir>/video.mp4` exists, `ffprobe -show_streams video.mp4` reports `width=1080 height=1080 (or 1920) nb_frames=141` and `duration≈5.87`.

## 4. Stage 3 — preview strip (sanity check, not the deliverable)

### 4.1 Generate the strip

```bash
python3 scripts/make_preview_strip.py <scene-dir>/video.mp4 \
  <scene-dir>/frames-check/preview.png \
  --labels "t=0s,<pose>,t=1.8s,<pose>,t=3.0s,<pose>,t=4.2s,<pose>,t=5.5s,<pose>"
```

Exit condition: `frames-check/preview.png` exists, 5 frames wide, and the user confirms the animation reads as expected.

## 5. Stage 4 — GIF assembly (the deliverable)

### 5.1 Compose both GIFs

```bash
python3 scripts/make_gif.py <scene-dir> "<caption>"
```

The script produces both `<scene-dir>/final.gif` (720×720, ≤ 6.4 MB target) and `<scene-dir>/final-mini.gif` (480×480, ≤ 1.7 MB target). Run from the Plugin root.

Exit condition: both files exist, the captions read correctly, and `du -h` reports sizes within the targets above. If `final.gif` > 7 MB, the scene is too visually complex; see § Failure Recovery.

## 6. Examples

### 6.1 摆烂躺平 (lying flat)

- Caption: "摆烂躺平"
- Pose: sprawled on the desk, one eye half-closed, one tentacle holding a coffee cup
- Expected: base.png ≥ 3 MB, final.gif 4-7 MB, final-mini.gif 1.0-1.7 MB.

### 6.2 假装很忙 (pretending to be busy, no caption)

- Caption: (none)
- Pose: phone in one tentacle, eyes down, neutral mouth
- Stage 4 command: `python3 scripts/make_gif.py <scene-dir> ""` — the overlay is empty, only the video frames survive.

### 6.3 期待 m3pro (waiting for m3pro)

- Caption: "期待 m3pro"
- Pose: tentacles cupping the cheeks, eyes wide
- Expected: base.png ≥ 3 MB, final.gif ≤ 4.5 MB (simpler scene, no motion blur).

## 7. Failure Recovery

### 7.1 Stage 1 base pose hits a ban-list entry

Re-read `issues.md` § Ban-list. Sweep the prompt for the matching word, replace with the recommended phrasing, re-run stage 1 with the previous attempt saved to `iterations/vN-base.png`. Iterate ≥ 1 time before re-asking the user.

### 7.2 Stage 2 gen_videos returns "input file path outside workspace"

The host tool only accepts paths inside the host's workspace. Copy `<scene-dir>/base.png` to `<host-workspace>/<scene-dir>/base.png` first, then pass the workspace-relative path. Do not pass an absolute path.

### 7.3 Stage 4 final.gif > 7 MB

The scene is visually complex (motion blur, gradient, many distinct colors). Lower `PALETTE_DITHER` from `bayer:bayer_scale=5` to `bayer:bayer_scale=4` in `scripts/make_gif.py`, or reduce `FPS` from 24 to 20. Re-run stage 4; do not regenerate base or video.

## 8. Quick Reference

| Stage | Tool | Output | Exit criterion |
|---|---|---|---|
| 1. base pose | `image_synthesize` | `<scene-dir>/base.png` | ≥ 2 MB, user-confirmed |
| 2. video | `gen_videos` | `<scene-dir>/video.mp4` | 141 frames @ 24fps |
| 3. preview | `make_preview_strip.py` | `frames-check/preview.png` | 5 frames wide |
| 4. GIF | `make_gif.py` | `final.gif` + `final-mini.gif` | sizes within targets |

For character anatomy, prompt template, and reference frames, see `reference.md`. For known failure modes and feedback-signal translations, see `issues.md`.

## 9. Hard Rules

- Stage 1 must iterate ≥ 1 time before asking the user. First-shot base poses fail the ban-list roughly 60% of the time.
- Never crop the video to fit text. The text is composited as a transparent overlay, not baked into the video.
- Never hardcode scene paths. Use `<scene-dir>` as a parameter; the Plugin must work for any user-provided scene name.
- After stage 4, append a row to the maintainer's `README.md` scene table with `path`, `caption`, and `size` for both GIFs.
