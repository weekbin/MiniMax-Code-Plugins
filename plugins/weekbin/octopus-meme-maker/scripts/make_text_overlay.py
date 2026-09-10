#!/usr/bin/env python3
"""Render a transparent Chinese text overlay PNG.

Usage:
    python3 make_text_overlay.py <text> <output.png> [--size 130] [--stroke 10] [--font <path>]

The text is composited as black-fill + white-stroke on a transparent RGBA canvas.
By default the script picks the first available CJK font from a cross-platform
candidate list; pass --font to override.

Exit 0: file written to <output>, stdout prints "OK: <path> (<w>x<h>, text='<text>')".
Exit 1: missing font and no --font override.
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

TEXT_COLOR = (24, 24, 24)
STROKE_COLOR = (255, 255, 255)
CANVAS_W = 1080
CANVAS_H = 220
DEFAULT_SIZE = 130
DEFAULT_STROKE = 10

FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    # Linux
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    # Windows
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def pick_chinese_font():
    """Return the first existing path from FONT_CANDIDATES, or None."""
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("text", help="Chinese text to render")
    p.add_argument("output", help="Output PNG path")
    p.add_argument("--size", type=int, default=DEFAULT_SIZE)
    p.add_argument("--stroke", type=int, default=DEFAULT_STROKE)
    p.add_argument("--font", default=None, help="Path to a CJK .ttc / .ttf file")
    p.add_argument("--width", type=int, default=CANVAS_W)
    p.add_argument("--height", type=int, default=CANVAS_H)
    args = p.parse_args()

    font_path = args.font or pick_chinese_font()
    if not font_path:
        print(
            "ERROR: no CJK font found. Install one of: wqy-microhei / noto-cjk (Linux), "
            "STHeiti (macOS), msyh (Windows); or pass --font <path>.",
            file=sys.stderr,
        )
        sys.exit(1)

    overlay = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = ImageFont.truetype(font_path, args.size)
    bbox = draw.textbbox((0, 0), args.text, font=font, stroke_width=args.stroke)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (args.width - text_w) / 2 - bbox[0]
    y = (args.height - text_h) / 2 - bbox[1]
    draw.text(
        (x, y),
        args.text,
        font=font,
        fill=TEXT_COLOR,
        stroke_width=args.stroke,
        stroke_fill=STROKE_COLOR,
    )
    overlay.save(args.output, "PNG")
    print(f"OK: {args.output} ({args.width}x{args.height}, text='{args.text}', font={font_path})")


if __name__ == "__main__":
    main()
