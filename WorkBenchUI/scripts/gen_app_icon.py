"""生成应用图标 assets/app-icon.png（256×256，渐变圆角 + 六边形品牌标识）。

与 renderer/js/icons.js 中 WB.brandLogo 的视觉语言一致。
"""

from PIL import Image, ImageDraw, ImageFilter
import math
import os

SIZE = 256
SS = 4  # 超采样倍数
S = SIZE * SS

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "renderer", "assets", "app-icon.png")

# ---------- 渐变背景（对角：深蓝 → 蓝 → 青） ----------
grad = Image.new("RGB", (S, S))
gd = ImageDraw.Draw(grad)
stops = [(0.0, (13, 30, 58)), (0.45, (37, 99, 235)), (1.0, (34, 211, 238))]
for y in range(S):
    for_x = y / S
    t = for_x
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t0 <= t <= t1:
            k = (t - t0) / (t1 - t0)
            col = tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
            gd.line([(0, y), (S, y)], fill=col)
            break

# 顶部高光
glow = Image.new("L", (S, S), 0)
gl = ImageDraw.Draw(glow)
gl.ellipse([-S * 0.25, -S * 0.55, S * 1.25, S * 0.45], fill=90)
glow = glow.filter(ImageFilter.GaussianBlur(S * 0.12))
grad = Image.composite(Image.new("RGB", (S, S), (220, 245, 255)), grad, glow.point(lambda v: int(v * 0.45)))

# ---------- 圆角蒙版 ----------
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.24), fill=255)

base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
base.paste(grad, (0, 0), mask)

# ---------- 六边形 + 内六边形 ----------
layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ld = ImageDraw.Draw(layer)
cx = cy = S / 2
R = S * 0.31
r = S * 0.185


def hexagon(cx, cy, radius, rotation=-90):
    pts = []
    for i in range(6):
        ang = math.radians(rotation + i * 60)
        pts.append((cx + radius * math.cos(ang), cy + radius * math.sin(ang)))
    return pts


outer = hexagon(cx, cy, R)
inner = hexagon(cx, cy, r)

# 外层描边（半透明白）
ld.polygon(outer, outline=(255, 255, 255, 150), width=int(S * 0.016))
# 内层实心（白，略透明）
ld.polygon(inner, fill=(255, 255, 255, 235))

# 内部竖线 + 三个节点（呼应 brandLogo）
ld.line([(cx, cy - r * 0.78), (cx, cy + r * 0.78)], fill=(13, 30, 58, 200), width=int(S * 0.014))
for t in (-0.72, 0.0, 0.72):
    ny = cy + r * t
    rad = S * 0.021
    ld.ellipse([cx - rad, ny - rad, cx + rad, ny + rad], fill=(13, 30, 58, 220))

# 外圈连接点（六个小圆，白色）
for pts in outer:
    rad = S * 0.012
    ld.ellipse([pts[0] - rad, pts[1] - rad, pts[0] + rad, pts[1] + rad], fill=(230, 250, 255, 220))

base = Image.alpha_composite(base, layer)

# ---------- 外发光 ----------
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
shd = ImageDraw.Draw(shadow)
shd.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.24), fill=(34, 211, 238, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.05))

canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
canvas = Image.alpha_composite(canvas, shadow)
canvas = Image.alpha_composite(canvas, base)

canvas.resize((SIZE, SIZE), Image.LANCZOS).save(OUT)
print(f"[gen-app-icon] {OUT}")
