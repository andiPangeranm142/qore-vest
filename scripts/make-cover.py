#!/usr/bin/env python3
"""Generate the QoreVest featured image (1280x720, 16:9) for the fest submission.

Title art only: no statistics, no transaction data, nothing fabricated.
Regenerate with: python3 scripts/make-cover.py
"""
from PIL import Image, ImageDraw, ImageFont
import os
import random

W, H = 1280, 720
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "featured.png")

# Deep-slate gradient: app background -> near-black.
top = (15, 23, 42)
bottom = (6, 10, 22)
img = Image.new("RGB", (W, H), top)
px = img.load()
for y in range(H):
    t = y / (H - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    for x in range(W):
        px[x, y] = (r, g, b)

d = ImageDraw.Draw(img, "RGBA")

# Subtle dot grid (deterministic).
random.seed(7)
for _ in range(160):
    x = random.randint(0, W - 1)
    y = random.randint(0, H - 1)
    r = random.choice([1, 1, 2])
    a = random.randint(18, 60)
    d.ellipse([x - r, y - r, x + r, y + r], fill=(110, 231, 183, a))

EMERALD = (16, 185, 129, 255)
EMERALD_DIM = (16, 185, 129, 110)
GOLD = (212, 175, 55, 255)
SLATE_CARD = (30, 41, 59, 255)
SLATE_LINE = (51, 65, 85, 255)
WHITE = (226, 232, 240, 255)
MUTED = (148, 163, 184, 255)

font_dir = "/usr/share/fonts/truetype/dejavu"
f_title = ImageFont.truetype(f"{font_dir}/DejaVuSans-Bold.ttf", 116)
f_sub = ImageFont.truetype(f"{font_dir}/DejaVuSans.ttf", 36)
f_small = ImageFont.truetype(f"{font_dir}/DejaVuSans.ttf", 26)
f_badge = ImageFont.truetype(f"{font_dir}/DejaVuSans-Bold.ttf", 24)
f_mono = ImageFont.truetype(f"{font_dir}/DejaVuSansMono.ttf", 24)
f_coin = ImageFont.truetype(f"{font_dir}/DejaVuSans-Bold.ttf", 150)

# --- Left: title block ---
d.text((64, 150), "QoreVest", font=f_title, fill=WHITE)
d.text((66, 290), "EVM token · Native vesting", font=f_sub, fill=(110, 231, 183, 255))
d.text((66, 350), "Claims settle atomically across", font=f_small, fill=MUTED)
d.text((66, 384), "the EVM and Native VMs.", font=f_small, fill=MUTED)

# Badge.
bx, by = 64, 470
d.rounded_rectangle([bx, by, bx + 430, by + 52], radius=26, fill=(5, 150, 105, 255))
d.text((bx + 24, by + 13), "QORECHAIN FEST · CROSS-VM", font=f_badge, fill=WHITE)

# --- Right: the vault + vesting timeline ---
# Vault card.
vx0, vy0, vx1, vy1 = 780, 110, 1216, 470
d.rounded_rectangle([vx0, vy0, vx1, vy1], radius=24, fill=SLATE_CARD, outline=SLATE_LINE, width=2)
# Vault door: gold ring + dark face + keyhole.
cx, cy, R = 998, 250, 92
for i in range(40, 0, -1):
    a = int(2 + (40 - i) * 0.4)
    d.ellipse([cx - R - i * 2, cy - R - i * 2, cx + R + i * 2, cy + R + i * 2],
              fill=(16, 185, 129, a))
d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=GOLD)
d.ellipse([cx - R + 12, cy - R + 12, cx + R - 12, cy + R - 12], fill=(15, 23, 42, 255))
d.ellipse([cx - R + 22, cy - R + 22, cx + R - 22, cy + R - 22],
          outline=GOLD, width=3)
# Keyhole: circle + stem.
d.ellipse([cx - 13, cy - 26, cx + 13, cy + 0], fill=GOLD)
d.polygon([(cx - 9, cy - 2), (cx + 9, cy - 2), (cx + 14, cy + 34), (cx - 14, cy + 34)], fill=GOLD)
# "QVEST" label under the vault, centered on the vault.
def center_text(x_center, y, s, font, fill):
    bbox = d.textbbox((0, 0), s, font=font)
    d.text((x_center - (bbox[2] - bbox[0]) / 2, y), s, font=font, fill=fill)

center_text(cx, vy0 + 298, "QVEST", f_badge, WHITE)
center_text(cx, vy0 + 328, "locked · vesting · claimed", f_small, MUTED)

# Vesting timeline: cliff (flat) then linear ramp, under the vault card.
tx0, ty0, tx1, ty1 = 780, 540, 1216, 640
d.rounded_rectangle([tx0, ty0, tx1, ty1], radius=16, fill=(15, 23, 42, 255), outline=SLATE_LINE, width=2)
# Axes.
ax0, ay0 = tx0 + 30, ty1 - 24
ax1, ay1 = tx1 - 24, ty0 + 22
d.line([ax0, ay0, ax1, ay0], fill=SLATE_LINE, width=2)
d.line([ax0, ay0, ax0, ay1], fill=SLATE_LINE, width=2)
# Cliff: flat segment, then linear ramp.
cliff_x = ax0 + int((ax1 - ax0) * 0.35)
d.line([ax0, ay0, cliff_x, ay0], fill=EMERALD, width=5)
d.line([cliff_x, ay0, ax1 - 6, ay1 + 4], fill=EMERALD, width=5)
d.ellipse([cliff_x - 6, ay0 - 6, cliff_x + 6, ay0 + 6], fill=GOLD)
d.text((ax0, ty0 + 8), "cliff", font=f_small, fill=MUTED)
label = "linear release"
bbox = d.textbbox((0, 0), label, font=f_small)
d.text((ax1 - (bbox[2] - bbox[0]), ty0 + 8), label, font=f_small, fill=MUTED)

# EVM -> Native bridge arrow, bottom left.
d.text((64, 570), "EVM", font=f_badge, fill=WHITE)
d.line([130, 584, 300, 584], fill=EMERALD, width=4)
d.polygon([(300, 584), (282, 574), (282, 594)], fill=EMERALD)
d.text((318, 570), "NATIVE", font=f_badge, fill=WHITE)
d.text((64, 612), "one atomic transaction", font=f_small, fill=MUTED)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT)
print(f"wrote {OUT} ({W}x{H})")
