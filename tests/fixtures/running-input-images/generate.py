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


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png_scanlines(width, height, interlaced, idat):
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, interlaced)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def exactly_png(image, target):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    png = buffer.getvalue()
    data = b"fixture\x00" + b"x" * (target - len(png) - 20)
    chunk = b"tEXt" + data
    padded = png[:-12] + struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk)) + png[-12:]
    assert len(padded) == target
    return padded


def split_png(blob):
    offset = 8
    while offset < len(blob):
        length, kind = struct.unpack_from(">I4s", blob, offset)
        end = offset + 8 + length
        yield kind, blob[offset + 8:end]
        offset = end + 4


def with_final_idat_padding(blob, padding, ancillary=None):
    chunks = list(split_png(blob))
    final = max(i for i, (kind, _) in enumerate(chunks) if kind == b"IDAT")
    _, payload = chunks[final]
    chunks[final] = (b"IDAT", payload + padding)
    if ancillary:
        chunks.insert(final + 1, ancillary)
    return blob[:8] + b"".join(png_chunk(kind, data) for kind, data in chunks)


def screenshot_samples(output, p3):
    # Match a 520×253 RGBA Snipping Tool sample's pHYs, tIME and 8 KiB IDAT layout
    # using generated swatches rather than the artwork in Microsoft's example.
    screen = corners(520, 253).convert("RGBA")
    screen.paste(Image.frombytes("RGBA", (100, 80), random.Random(106).randbytes(100 * 80 * 4)), (110, 90))
    buffer = BytesIO()
    screen.save(buffer, format="PNG", dpi=(120, 120))
    chunks = list(split_png(buffer.getvalue()))
    compressed = b"".join(data for kind, data in chunks if kind == b"IDAT")
    windows_chunks = [(kind, data) for kind, data in chunks if kind in (b"IHDR", b"pHYs")]
    windows_chunks.append((b"tIME", struct.pack(">HBBBBB", 2026, 11, 21, 10, 0, 0)))
    windows_chunks.extend((b"IDAT", compressed[i:i + 8192]) for i in range(0, len(compressed), 8192))
    windows_chunks.append((b"IEND", b""))
    windows = buffer.getvalue()[:8] + b"".join(png_chunk(kind, data) for kind, data in windows_chunks)
    (output / "screenshot-windows.png").write_bytes(windows)
    (output / "screenshot-windows-padded.png").write_bytes(with_final_idat_padding(windows, bytes(16)))
    (output / "screenshot-ancillary.png").write_bytes(with_final_idat_padding(
        windows, b"\xa5\x00\x5a", (b"tEXt", b"Description\x00Synthetic screen capture")))
    mac = screen.resize((1040, 506), Image.Resampling.NEAREST)
    mac.save(output / "screenshot-macos.png", dpi=(144, 144), icc_profile=p3.read_bytes() if p3 else None)


def generate(output, p3):
    output.mkdir(parents=True, exist_ok=True)
    screenshot_samples(output, p3)
    image = corners(96, 64)
    for orientation in range(1, 9):
        image.save(output / f"exif-{orientation}.jpg", quality=95, exif=exif(orientation))
    cmyk = corners(48, 32).convert("CMYK")
    cmyk.save(output / "cmyk.jpg", quality=95)
    cmyk.save(output / "cmyk-rotated.jpg", quality=95, exif=exif(6))
    image = corners(8064, 6048)
    image.save(output / "baseline-48mp.jpg", quality=92, exif=exif(6))
    image.save(output / "progressive-48mp.jpg", quality=92, progressive=True, exif=exif(6))

    large_png = output / "passthrough-8000.png"
    Image.new("RGBA", (8000, 8000), (12, 40, 80, 128)).save(large_png)
    (output / "passthrough-8000-padded.png").write_bytes(with_final_idat_padding(large_png.read_bytes(), bytes(16)))
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
    (output / "corrupt-idat.png").write_bytes(png_scanlines(1, 1, 0, b"\xffinvalid zlib"))
    passes = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    rows = b"".join(bytes(1 + len(range(x, 9, step_x))) * len(range(y, 9, step_y)) for x, y, step_x, step_y in passes)
    (output / "adam7.png").write_bytes(png_scanlines(9, 9, 1, zlib.compress(rows)))
    image = corners(32, 24)
    image.save(output / "animated.png", save_all=True, append_images=[Image.new("RGB", image.size, "white")], duration=50)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--p3", type=Path)
    args = parser.parse_args()
    generate(args.output, args.p3)
