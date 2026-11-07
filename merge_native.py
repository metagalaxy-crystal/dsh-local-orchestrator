from PIL import Image, ImageChops, ImageDraw
import os

d = r"D:\dsh-plugin\merged-src"
files = ["01-audio.png", "02-music.png", "03-video.png", "04-image.png", "05-text.png"]

def trim(im, tol=4):
    diff = ImageChops.difference(im, Image.new("RGB", im.size, (255,255,255))).convert("L")
    bbox = diff.point(lambda p: 255 if p > tol else 0).getbbox()
    return im.crop(bbox) if bbox else im

panels = [trim(Image.open(os.path.join(d, f)).convert("RGB")) for f in files]
W = max(p.width for p in panels)
GAP, MARGIN = 26, 24
H = MARGIN * 2 + sum(p.height for p in panels) + GAP * (len(panels) - 1)
canvas = Image.new("RGB", (W + MARGIN * 2, H), "white")
draw = ImageDraw.Draw(canvas)
y = MARGIN
for i, p in enumerate(panels):
    canvas.paste(p, (MARGIN, y))
    y += p.height
    if i != len(panels) - 1:
        cy = y + GAP // 2
        draw.line([(MARGIN, cy), (MARGIN + W, cy)], fill=(232, 232, 232), width=1)
        y += GAP
out = r"D:\dsh-plugin\merged\models-overview-native.png"
canvas.save(out, "PNG", optimize=True)
print("saved", out, canvas.size, round(os.path.getsize(out)/1024), "KB", [p.width for p in panels])
