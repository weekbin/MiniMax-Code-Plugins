# Octopus Meme Maker

Generate Smooth Squishmallow-style pink-octopus office-worker GIF memes from a scene description. Ships the 4-stage pipeline (base pose → 6s video → transparent text overlay → 720×720 GIF) plus the cross-platform scripts that assemble the final 480×480 mini-GIF for chat apps.

## Try it

```text
Make me a new octopus worker meme: 摆烂躺平 (lying flat on the desk, one eye half-closed, the other fully closed, the tip of one tentacle holding a coffee cup). The character must match the existing reference samples in reference/sample_01..06.png. Save the result to 04-lying-flat/ and follow the 4-stage pipeline in skills/octopus-meme-maker/SKILL.md.
```

Expected result: `04-lying-flat/base.png` (2048×2048 base) → `04-lying-flat/video.mp4` (1080p 6s 24fps) → `04-lying-flat/final.gif` (720×720 ≤ 6.4 MB) → `04-lying-flat/final-mini.gif` (480×480 ≤ 1.7 MB).

## What's in this Plugin

- `skills/octopus-meme-maker/SKILL.md` — the 4-stage pipeline + ban-list + exit conditions
- `skills/octopus-meme-maker/reference.md` — character anatomy, style rules, prompt template, reference image list
- `skills/octopus-meme-maker/issues.md` — known failure modes and feedback signals
- `scripts/make_text_overlay.py` — render transparent Chinese text overlay (Pillow, cross-platform font picker)
- `scripts/make_preview_strip.py` — extract 5 key frames from a 6s video and stitch a preview strip
- `scripts/make_gif.py` — compose 720×720 final.gif + 480×480 final-mini.gif from video + overlay (ffmpeg subprocess)
- `reference/sample_01..06.png` — character ground truth (6 reference frames)
- `reference/overview.png` — reference contact sheet
- `reference/videos/` — 2 h3 source videos (768×768, 24 fps, 6.58 s, h264+aac) picked as illustrative animation samples: `breakdown-h3.mp4` (我裂开了) and `treat-milk-tea-h3.mp4` (请大家喝奶茶)
- `examples/` — 3 base.png samples that the maintainer has successfully extracted. Pass them as `input_file_paths` to `image_synthesize` to lock the character anatomy and the scene layout while varying the pose: `02-stay-late-base.png`, `10-toilet-slacking-base.png`, `11-touch-fish-base.png`

## Requirements

- Python 3.10+
- `pip install Pillow`
- `ffmpeg` 4.4+ on `PATH` (verify with `ffmpeg -version`)
- A CJK font installed on the system for the text overlay. The script auto-picks the first match from this list:
  - macOS: `/System/Library/Fonts/STHeiti Medium.ttc`, `/System/Library/Fonts/PingFang.ttc`
  - Linux: `/usr/share/fonts/truetype/wqy/wqy-microhei.ttc`, `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`
  - Windows: `C:\Windows\Fonts\msyh.ttc`, `C:\Windows\Fonts\simhei.ttf`
  - Pass `--font <path>` to override.
- MiniMax Code's `image_synthesize` and `gen_videos` tools (used by stage 1 and stage 2 of the pipeline; not bundled in this Plugin — they are part of the host).

## Supported platforms

- macOS 13+ (verified by the original author on macOS)
- Linux (Ubuntu 22.04+, Debian 12+; ffmpeg + Python + Pillow only)
- Windows 10/11 with PowerShell or Git Bash; the pipeline is pure Python + ffmpeg subprocess calls

## Data and network

- No network access at runtime. The Plugin runs entirely on the local machine.
- The character generation steps (stage 1, stage 2) call host-provided image and video synthesis tools; those are out of scope for this Plugin but their network and data behaviour follows the host's policy.
- No credentials, accounts, paid services, telemetry, installers, symlinks, or native binaries are bundled.

## Verification

Run from the Plugin root:

```bash
python3 scripts/make_text_overlay.py "再熬一会" /tmp/octopus_test_overlay.png
python3 scripts/make_preview_strip.py /path/to/some/video.mp4 /tmp/octopus_test_strip.png
python3 scripts/make_gif.py /path/to/some/scene-dir "再熬一会"
```

All three scripts must exit 0 and produce the expected output file.

## License

Apache-2.0. See [LICENSE](./LICENSE).
