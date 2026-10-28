#!/usr/bin/env python3
"""
Generate every native app-icon variant for Zode from the single source artwork
`icons/zode.png`.

Source artwork: 1600x1600 RGBA. Transparent corners, Zune-orange square
(#F55629) overlapping a near-black square (#1F1F1F / #212121).

Outputs (all under `icons/`):
    zode.png                     untouched source of truth
    zode-1024.png               iOS / macOS master (square, no alpha)
    zode-256.png ... zode-16.png  generic raster ladder
    zode.ico                    Windows multi-resolution icon
    zode.icns                   macOS icon bundle
    zode-maskable-1024.png      Android adaptive foreground (art in safe zone)
    zode-android-background.png Android adaptive background (solid)
    android-mipmap-*/ic_*.png   Android launcher densities
    social-preview.png          GitHub social preview (1280x640)
    favicon.png / favicon.ico   web favicon

Run:  python3 icons/make_icons.py
Deps: Pillow (PIL). No network access required.
"""

import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "zode.png")

# Apple "squircle" — the macOS Big Sur+ icon outline is a superellipse.
SUPERELLIPSE_N = 5.0


def _superellipse_mask(size, n=SUPERELLIPSE_N, samples=512):
    """Return an L-mode mask (255 inside) of a superellipse filling `size`."""
    w, h = size
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    # Sample the boundary then fill the polygon: PIL has no superellipse primitive.
    pts = []
    cx, cy = w / 2.0, h / 2.0
    a, b = w / 2.0, h / 2.0
    for i in range(samples):
        t = 2.0 * 3.141592653589793 * i / samples
        ct, st = __import__("math").cos(t), __import__("math").sin(t)
        x = cx + a * __import__("math").copysign(abs(ct) ** (2.0 / n), ct)
        y = cy + b * __import__("math").copysign(abs(st) ** (2.0 / n), st)
        pts.append((x, y))
    draw.polygon(pts, fill=255)
    return mask


def _squircle(size):
    """macOS icon shape: superellipse, with a small inset so it reads as a rounded square."""
    inset = max(1, int(round(size * 0.005)))
    mask = _superellipse_mask((size - 2 * inset, size - 2 * inset))
    out = Image.new("L", (size, size), 0)
    out.paste(mask, (inset, inset))
    return out


def _art_on_solid(size, bg=(255, 255, 255, 255)):
    """Place the source artwork scaled to fill `size` over a solid background."""
    art = Image.open(SRC).convert("RGBA")
    art = art.resize((size, size), Image.LANCZOS)
    base = Image.new("RGBA", (size, size), bg)
    base.alpha_composite(art)
    return base


def make_raster_set():
    """Square, fully opaque raster ladder — iOS + generic."""
    master = _art_on_solid(1024)
    master.save(os.path.join(HERE, "zode-1024.png"))
    for s in (512, 256, 128, 64, 32, 16):
        master.resize((s, s), Image.LANCZOS).save(os.path.join(HERE, f"zode-{s}.png"))
    # Flatten the 16px one over white — tiny transparent pixels turn muddy otherwise.
    tiny = Image.open(os.path.join(HERE, "zode-16.png")).convert("RGBA")
    flat = Image.new("RGBA", (16, 16), (255, 255, 255, 255))
    flat.alpha_composite(tiny)
    flat.convert("RGB").save(os.path.join(HERE, "zode-16.png"))
    print("raster ladder written")


def make_macos_icns():
    """Build a .icns containing the PNG variants macOS expects.

    icns entry types are fixed 4-character OSType codes, NOT filenames.
    """
    # (pixel size, icns OSType code)
    entries = [
        (16, "icp4"),    # 16x16
        (32, "icp5"),    # 32x32
        (64, "icp6"),    # 64x64
        (128, "ic07"),   # 128x128
        (256, "ic08"),   # 256x256
        (512, "ic09"),   # 512x512
        (1024, "ic10"),  # 1024x1024
    ]
    stage = os.path.join(HERE, ".icns_tmp")
    os.makedirs(stage, exist_ok=True)
    # macOS icons are the squircle shape on a transparent field, artwork inset ~10%.
    for px, code in entries:
        canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        art_size = int(round(px * 0.90))  # ~10% margin, per Apple's icon grid
        # Container: white squircle so the artwork's transparent corners read as
        # a solid rounded tile rather than holes.
        container = Image.new("RGBA", (art_size, art_size), (255, 255, 255, 255))
        art = Image.open(SRC).convert("RGBA").resize((art_size, art_size), Image.LANCZOS)
        container.alpha_composite(art)
        mask = _squircle(art_size)
        container.putalpha(mask)
        off = (px - art_size) // 2
        canvas.alpha_composite(container, (off, off))
        canvas.save(os.path.join(stage, f"{code}.png"))

    icns_path = os.path.join(HERE, "zode.icns")
    blobs = [(code, open(os.path.join(stage, f"{code}.png"), "rb").read())
             for _, code in entries]
    # The header length field is the TOTAL file size; each entry's length field
    # includes its own 8-byte type+length header.
    total = 8 + sum(len(d) + 8 for _, d in blobs)
    with open(icns_path, "wb") as fh:
        fh.write(b"icns")
        fh.write(struct.pack(">I", total))
        for code, data in blobs:
            fh.write(code.encode("ascii") + struct.pack(">I", len(data) + 8) + data)
    for _, code in entries:
        os.remove(os.path.join(stage, f"{code}.png"))
    os.rmdir(stage)
    print(f"icns written ({os.path.getsize(icns_path)} bytes)")


def make_ico():
    """Windows .ico with 16/32/48/64/128/256 px PNG-compressed entries."""
    sizes = (16, 32, 48, 64, 128, 256)
    # PIL's ICO writer only DOWNSAMPLES from the image it is given, so the
    # source must be the largest size or every smaller entry is dropped.
    source = Image.open(SRC).convert("RGBA").resize((256, 256), Image.LANCZOS)
    ico_path = os.path.join(HERE, "zode.ico")
    source.save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"ico written ({os.path.getsize(ico_path)} bytes)")


def make_android():
    """Adaptive icon foreground (art inside the 66% safe zone) + solid background."""
    # Adaptive canvas is 108x108dp; only the centre 72x72dp is guaranteed visible.
    fg_size = 1024
    fg = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
    art = Image.open(SRC).convert("RGBA")
    art_size = int(round(fg_size * 0.62))
    art = art.resize((art_size, art_size), Image.LANCZOS)
    off = (fg_size - art_size) // 2
    fg.alpha_composite(art, (off, off))
    fg.save(os.path.join(HERE, "zode-maskable-1024.png"))

    bg = Image.new("RGBA", (fg_size, fg_size), (245, 86, 41, 255))
    bg.save(os.path.join(HERE, "zode-android-background.png"))

    # Legacy launcher densities: mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, xxxhdpi 192
    legacy = {
        "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192,
    }
    for bucket, px in legacy.items():
        d = os.path.join(HERE, "android-mipmap-" + bucket)
        os.makedirs(d, exist_ok=True)
        # Round (legacy) + square (round variant) + foreground for adaptive.
        base = Image.open(SRC).convert("RGBA").resize((px, px), Image.LANCZOS)
        base.save(os.path.join(d, f"ic_launcher.png"))
        round_img = base.copy()
        mask = Image.new("L", (px, px), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
        round_img.putalpha(mask)
        round_img.save(os.path.join(d, "ic_launcher_round.png"))
        fgs = int(round(px * 1.5))
        f = Image.new("RGBA", (fgs, fgs), (0, 0, 0, 0))
        a = Image.open(SRC).convert("RGBA").resize((int(fgs * 0.62), int(fgs * 0.62)), Image.LANCZOS)
        o = (fgs - a.size[0]) // 2
        f.alpha_composite(a, (o, o))
        f.save(os.path.join(d, "ic_launcher_foreground.png"))
    print("android icons written")


def _font(size, bold=False):
    """The UI font, preferring the copy that is vendored with the repository.

    The font has to be pinned, not merely "some sans serif": the social
    preview is a PNG, and two different rasterisers draw the same text into
    different bytes.  A build machine without Liberation falls back to
    DejaVu, and the preview then differs by a few bytes from the committed
    one — which is exactly what the reproducibility check in CI is there to
    catch.  The vendored copy makes the output identical everywhere.
    """
    vendored = os.path.join(HERE, "fonts")
    cands = []
    if bold:
        cands += [os.path.join(vendored, "LiberationSans-Bold.ttf")]
    cands += [os.path.join(vendored, "LiberationSans-Regular.ttf")]
    # The system copies, in case the vendored ones are ever removed.
    if bold:
        cands += ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
    cands += ["/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_social_preview():
    """GitHub social preview: 1280x640, the icon on the left, wordmark on the right.

    The banner is painted on the app's own warm-paper canvas. The icon's dark
    tile is #212121, which is invisible against a near-black ground, so the
    ground has to sit *above* it in value for the tile to read at all. Paper
    does that, and it lets the orange keep its punch instead of fighting a
    mid-tone brown.
    """
    W, H = 1280, 640

    # --- the ground: a soft warm gradient, paper -> paper-2 ----------------
    ground = Image.new("RGB", (W, H), (247, 245, 242))
    grad = Image.new("L", (1, H))
    for y in range(H):
        t = y / (H - 1)
        grad.putpixel((0, y), int(255 * (0.45 + 0.55 * t)))
    ground = Image.composite(
        Image.new("RGB", (W, H), (233, 229, 223)), ground, grad.resize((W, H))
    )
    img = ground
    d = ImageDraw.Draw(img)

    # --- the artwork, lifted off the ground with a soft shadow --------------
    art = Image.open(SRC).convert("RGBA").resize((360, 360), Image.LANCZOS)
    ax, ay = 96, 140

    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    silhouette = Image.new("RGBA", art.size, (96, 82, 70, 120))
    # The shadow takes the artwork's own alpha, so the transparent corners of
    # the mark stay transparent and the shadow reads as the mark, not a box.
    shadow.paste(silhouette, (ax + 8, ay + 16), art)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    img = Image.alpha_composite(img.convert("RGBA"), shadow).convert("RGB")
    d = ImageDraw.Draw(img)

    img.paste(art, (ax, ay), art)

    # --- the wordmark ------------------------------------------------------
    d.text((520, 236), "zode", font=_font(108, bold=True), fill=(20, 20, 20))
    d.text((524, 360), "code content before chrome", font=_font(34), fill=(106, 102, 96))
    d.text((524, 412), "macOS  ·  Windows  ·  iOS  ·  Android", font=_font(26), fill=(216, 60, 14))

    img.save(os.path.join(HERE, "social-preview.png"))
    print("social preview written")


def make_favicon():
    Image.open(SRC).convert("RGBA").resize((64, 64), Image.LANCZOS).save(
        os.path.join(HERE, "favicon.png"))
    Image.open(SRC).convert("RGBA").resize((32, 32), Image.LANCZOS).save(
        os.path.join(HERE, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32)])
    print("favicon written")


def main():
    if not os.path.exists(SRC):
        sys.exit(f"missing source artwork: {SRC}")
    make_raster_set()
    make_macos_icns()
    make_ico()
    make_android()
    make_social_preview()
    make_favicon()
    print("all icon variants written to", HERE)


if __name__ == "__main__":
    main()
