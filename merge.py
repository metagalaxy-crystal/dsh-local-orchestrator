from PIL import Image, ImageChops, ImageDraw, ImageFilter
import os

d = r"D:\dsh-plugin\merged-src"
files = ["01-audio.png", "02-music.png", "03-video.png", "04-image.png", "05-text.png"]
ims = [Image.open(os.path.join(d, f)).convert("RGB") for f in files]

def trim(im, bg=(255,255,255), tol=4):
    diff = ImageChops.difference(im, Image.new("RGB", im.size, bg)).convert("L")
    bbox = diff.point(lambda p: 255 if p > tol else 0).getbbox()
    return im.crop(bbox) if bbox else im

trimmed = [trim(im) for im in ims]
W, GAP, MARGIN = 1000, 26, 24
SEP = (232, 232, 232)

def scale_to_width(im, w):
    if im.width == w:
        return im
    f = w / im.width
    return im.resize((w, round(im.height * f)), Image.LANCZOS)

panels = []
for im in trimmed:
    p = scale_to_width(im, W)
    if p.width != im.width:                      # only sharpen the upscaled ones
        p = p.filter(ImageFilter.UnsharpMask(radius=1.2, percent=90, threshold=2))
    panels.append(p)

H = MARGIN * 2 + sum(p.height for p in panels) + GAP * (len(panels) - 1)
canvas = Image.new("RGB", (W + MARGIN * 2, H), "white")
draw = ImageDraw.Draw(canvas)
y = MARGIN
for i, p in enumerate(panels):
    canvas.paste(p, (MARGIN, y))
    y += p.height
    if i != len(panels) - 1:
        cy = y + GAP // 2
        draw.line([(MARGIN + 40, cy), (MARGIN + W - 40, cy)], fill=SEP, width=1)
        y += GAP

out = r"D:\dsh-plugin\merged\models-overview.png"
os.makedirs(os.path.dirname(out), exist_ok=True)
canvas.save(out, "PNG", optimize=True)
print("saved", out, canvas.size, round(os.path.getsize(out)/1024), "KB")

# crop of the weakest panel (video) for visual check
vp = panels[2]
vp.crop((0, 0, min(560, vp.width), vp.height)).save(r"D:\dsh-plugin\merged\_check-video.png")
