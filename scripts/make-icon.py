#!/usr/bin/env python3
"""Rebuild the Peek PNG/ICNS on macOS: python3 -m pip install Pillow; python3 scripts/make-icon.py.

The geometry and colours match assets/icon.svg. No remote assets are used.
"""
from pathlib import Path
import math
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SCALE = 3


def rounded_shape(draw, bounds, radii, fill):
    left, top, right, bottom = bounds
    tl, tr, br, bl = radii
    points = []
    for cx, cy, radius, start in [
        (right - tr, top + tr, tr, -90),
        (right - br, bottom - br, br, 0),
        (left + bl, bottom - bl, bl, 90),
        (left + tl, top + tl, tl, 180),
    ]:
        for step in range(91):
            angle = math.radians(start + step)
            points.append(((cx + radius * math.cos(angle)) * SCALE,
                           (cy + radius * math.sin(angle)) * SCALE))
    draw.polygon(points, fill=fill)


image = Image.new("RGBA", (1024 * SCALE, 1024 * SCALE))
draw = ImageDraw.Draw(image)
rounded_shape(draw, (80, 80, 944, 944), (196,) * 4, "#181d1c")
rounded_shape(draw, (298, 298, 726, 726), (214, 214, 214, 44), "#c8e8ae")
rounded_shape(draw, (362, 362, 662, 662), (150, 150, 150, 10), "#181d1c")
draw.ellipse(tuple(value * SCALE for value in (464, 438, 560, 534)), fill="#c8e8ae")
ASSETS.mkdir(exist_ok=True)
image.resize((256, 256), Image.Resampling.LANCZOS).save(ASSETS / "icon.png")

with tempfile.TemporaryDirectory(prefix="peek-icon-") as temporary:
    iconset = Path(temporary) / "Peek.iconset"
    iconset.mkdir()
    for points in (16, 32, 128, 256, 512):
        for density in (1, 2):
            pixels = points * density
            suffix = "@2x" if density == 2 else ""
            name = f"icon_{points}x{points}{suffix}.png"
            image.resize((pixels, pixels), Image.Resampling.LANCZOS).save(iconset / name)
    subprocess.run(["/usr/bin/iconutil", "--convert", "icns", "--output",
                    str(ASSETS / "icon.icns"), str(iconset)], check=True)

print(f"Created {ASSETS / 'icon.png'} and {ASSETS / 'icon.icns'}")
