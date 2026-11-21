# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow==11.3.0"]
# ///
"""Generate asymmetric synthetic images for Studio #103."""

import argparse
from io import BytesIO
from pathlib import Path
import random
import struct
import zlib

from PIL import Image, ImageDraw, PngImagePlugin


def exif(orientation):
    result = Image.Exif()
    result[274] = orientation
    result[315] = "Studio image acceptance"
    result[34853] = {1: "N", 2: (1.0, 2.0, 3.0)}
    return result


def corners(width, height):
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    for x, y, rgb in [(0, 0, (235, 20, 20)), (1, 0, (20, 235, 20)),
                      (0, 1, (20, 20, 235)), (1, 1, (235, 235, 20))]:
        draw.rectangle((x * width // 2, y * height // 2,
                        (x + 1) * width // 2 - 1, (y + 1) * height // 2 - 1), fill=rgb)
    return image


def exactly_png(image, target):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    png = buffer.getvalue()
    data = b"fixture\x00" + b"x" * (target - len(png) - 20)
    chunk = b"tEXt" + data
    padded = png[:-12] + struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk)) + png[-12:]
    assert len(padded) == target
    return padded


def generate(output, p3):
    output.mkdir(parents=True, exist_ok=True)
    image = corners(96, 64)
    for orientation in range(1, 9):
        image.save(output / f"exif-{orientation}.jpg", quality=95, exif=exif(orientation))
    image = corners(8064, 6048)
    image.save(output / "baseline-48mp.jpg", quality=92, exif=exif(6))
    image.save(output / "progressive-48mp.jpg", quality=92, progressive=True, exif=exif(6))

    Image.new("RGBA", (8000, 8000), (12, 40, 80, 128)).save(output / "passthrough-8000.png")
    Image.new("RGBA", (8001, 8000), (12, 40, 80, 128)).save(output / "oversized-8001.png")
    Image.new("RGBA", (100, 16385), (12, 40, 80, 128)).save(output / "long.png")
    image = Image.new("RGBA", (2304, 1536), (128, 100, 90, 128))
    ImageDraw.Draw(image).rectangle((0, 0, 1151, 1535), fill=(128, 100, 90, 0))
    if p3:
        pnginfo = PngImagePlugin.PngInfo()
        pnginfo.add_text("fixture", "Display P3")
        image.info["icc_profile"] = p3.read_bytes()
    else:
        pnginfo = None
    image.save(output / "alpha.png", pnginfo=pnginfo)
    # Exercise PNG retries: preserving all noisy 2048px pixels exceeds the byte cap.
    noise = Image.frombytes("RGB", (2304, 1536), random.Random(103).randbytes(2304 * 1536 * 3))
    (output / "source-max.png").write_bytes(exactly_png(noise, 16_777_216))
    (output / "file-max.png").write_bytes(exactly_png(corners(201, 173), 3_750_000))
    (output / "truncated.png").write_bytes((output / "alpha.png").read_bytes()[:27])
    (output / "truncated.jpg").write_bytes((output / "exif-1.jpg").read_bytes()[:-2])
    image = corners(32, 24)
    image.save(output / "animated.png", save_all=True, append_images=[Image.new("RGB", image.size, "white")], duration=50)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--p3", type=Path)
    args = parser.parse_args()
    generate(args.output, args.p3)
