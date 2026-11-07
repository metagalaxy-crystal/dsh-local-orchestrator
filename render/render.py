# -*- coding: utf-8 -*-
"""Typography-style re-render of the five model tables into one crisp PNG (Pillow only)."""
import os

from PIL import Image, ImageDraw, ImageFont

from build import SECTIONS

OUT = r"D:\dsh-plugin\render\models-clean.png"

S = 2                      # render scale (2x -> crisp text)
W = 1400                   # logical page width
MARGIN = 48                # logical page margin

FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_BLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_MONO = r"C:\Windows\Fonts\consola.ttf"
FONT_MONOB = r"C:\Windows\Fonts\consolab.ttf"

COL_TEXT = (43, 47, 54)
COL_HEAD = (22, 24, 29)
COL_MUTED = (138, 144, 155)
COL_ACCENT = (63, 94, 251)
COL_BORDER = (226, 230, 236)
COL_TH_BG = (245, 246, 248)
COL_ROW_ALT = (252, 252, 253)
COL_TH_TEXT = (84, 91, 102)
CHIP_BG = (242, 244, 247)
CHIP_BD = (228, 231, 236)

OPEN_PUNCT = set("（(“『【")
CLOSE_PUNCT = set("）)，。；：、”』】%！？")


def f(path, size):
    return ImageFont.truetype(path, int(round(size * S)))


def px(v):
    return int(round(v * S))


def split_bold(text):
    out, i = [], 0
    while True:
        j = text.find("**", i)
        if j < 0:
            out.append((text[i:], False))
            break
        out.append((text[i:j], False))
        k = text.find("**", j + 2)
        if k < 0:
            out.append((text[j + 2:], True))
            break
        out.append((text[j + 2:k], True))
        i = k + 2
    return [r for r in out if r[0]]


def tokenize(segments):
    toks = []
    for text, bold in segments:
        buf = ""
        for ch in text:
            if ord(ch) < 128 and ch != " ":
                buf += ch
            else:
                if buf:
                    toks.append((buf, bold))
                    buf = ""
                toks.append((ch, bold))
        if buf:
            toks.append((buf, bold))
    return toks


def fixup(lines):
    """Avoid dangling closing punctuation / leading spaces and orphan brackets."""
    for i, line in enumerate(lines):
        while i > 0 and line and line[0][0].strip() and line[0][0][:1] in CLOSE_PUNCT:
            lines[i - 1].append(line.pop(0))
        while i + 1 < len(lines) and line and line[-1][0] in OPEN_PUNCT:
            lines[i + 1].insert(0, line.pop())
    for line in lines:
        j = 0
        while j < len(line) - 1:
            if line[j][0] == " " and line[j + 1][0][:1] in CLOSE_PUNCT:
                line.pop(j)
            else:
                j += 1
        while line and line[-1][0] == " ":
            line.pop()
        while line and line[0][0] == " ":
            line.pop(0)
    return [ln for ln in lines if ln]


def wrap(tokens, maxw, measure):
    lines, cur, curw = [], [], 0.0
    for tok, bold in tokens:
        w = measure(tok, bold)
        if curw + w > maxw and cur:
            while cur and cur[-1][0] == " ":
                curw -= measure(" ", cur[-1][1])
                cur.pop()
            lines.append(cur)
            cur, curw = [], 0.0
            if tok == " ":
                continue
        cur.append((tok, bold))
        curw += w
    if cur:
        while cur and cur[-1][0] == " ":
            cur.pop()
        lines.append(cur)
    lines = [ln for ln in lines if ln] or [[("", False)]]
    return fixup(lines)


def merge(line):
    segs = []
    for tok, bold in line:
        if segs and segs[-1][1] == bold:
            segs[-1][0] += tok
        else:
            segs.append([tok, bold])
    return [(t, b) for t, b in segs]


class Renderer:
    def __init__(self):
        self.fr = f(FONT_REG, 14)
        self.fb = f(FONT_BLD, 14)
        self.fth = f(FONT_BLD, 13.5)
        self.fmono = f(FONT_MONO, 13)
        self.fh1 = f(FONT_BLD, 27)
        self.fh2 = f(FONT_BLD, 18.5)
        self.fh2p = f(FONT_MONOB, 16.5)
        self.fsub = f(FONT_REG, 13.5)
        self.ffoot = f(FONT_REG, 12.5)
        self.line_h = px(14 * 1.62)
        self.pad_x = px(12)
        self.pad_y = px(10)

    def measure_bold(self, tok, bold):
        return (self.fb if bold else self.fr).getlength(tok)

    def measure_mono(self, tok, bold=False):
        return self.fmono.getlength(tok)

    # ---------- blocks ----------
    def block_title(self):
        ops = []
        y0 = px(42)
        ops.append(("rect", (px(MARGIN), y0 + px(15), px(MARGIN) + px(42), y0 + px(20)), COL_ACCENT, px(3)))
        ops.append(("text", (px(MARGIN + 56), y0), "本地模型清单", self.fh1, COL_HEAD))
        y1 = y0 + px(27 * 1.42)
        ops.append(("text", (px(MARGIN + 56), y1),
                    "audio / music / video / image / text  —— 按能力分类的模型与权重速查", self.fsub, COL_MUTED))
        return y1 + px(13.5 * 1.6) + px(24), ops

    def block_section(self, sec):
        ops = []
        head_h = px(18.5 * 1.75)
        x = px(MARGIN)
        ops.append(("text", (x, 0), sec["title_prefix"], self.fh2p, COL_ACCENT))
        x += self.fh2p.getlength(sec["title_prefix"]) + px(10)
        ops.append(("text", (x, 0), "——", self.fh2, (194, 199, 208)))
        x += self.fh2.getlength("——") + px(10)
        ops.append(("text", (x, 0), sec["title"], self.fh2, COL_HEAD))

        cols = sec["cols"]
        content_w = px(W - 2 * MARGIN)
        widths = [int(content_w * int(w.rstrip("%")) / 100) for _, w in cols]
        widths[-1] = content_w - sum(widths[:-1])
        xs = [px(MARGIN)]
        for w in widths[:-1]:
            xs.append(xs[-1] + w)

        table_top = head_h + px(6)
        y = table_top
        th_h = px(13.5 * 1.45) + 2 * px(9)
        ops.append(("rect", (px(MARGIN), y, px(MARGIN) + content_w, y + th_h), COL_TH_BG, 0))
        for i, (name, _) in enumerate(cols):
            ops.append(("text", (xs[i] + self.pad_x, y + px(9)), name, self.fth, COL_TH_TEXT))
        y += th_h

        for r_i, row in enumerate(sec["rows"]):
            cells = list(row)[: len(cols)]
            while len(cells) < len(cols):
                cells.append(None)
            prepared = []
            for i, cell in enumerate(cells):
                maxw = widths[i] - 2 * self.pad_x
                if i == 0 and isinstance(cell, str) and cell.rstrip().endswith("\\"):
                    lines = wrap([(ch, False) for ch in cell], maxw - px(13), self.measure_mono)
                    prepared.append(("chip", lines))
                else:
                    lines = wrap(tokenize(split_bold(cell or "")), maxw, self.measure_bold)
                    prepared.append(("text", lines))
            n_lines = max(len(l) for _, l in prepared)
            rh = n_lines * self.line_h + 2 * self.pad_y
            if r_i % 2 == 1:
                ops.append(("rect", (px(MARGIN), y, px(MARGIN) + content_w, y + rh), COL_ROW_ALT, 0))
            for i, (kind, lines) in enumerate(prepared):
                cy = y + self.pad_y - px(2)
                cx = xs[i] + self.pad_x
                if kind == "chip":
                    for line in lines:
                        segs = merge(line)
                        tw = sum(self.measure_mono(t) for t, _ in segs)
                        ops.append(("chip", (cx - px(6), cy + px(2), cx + tw + px(8), cy + self.line_h - px(1))))
                        tx = cx
                        for t, _ in segs:
                            ops.append(("text", (tx, cy), t, self.fmono, COL_TEXT))
                            tx += self.measure_mono(t)
                        cy += self.line_h
                else:
                    for line in lines:
                        tx = cx
                        for t, bold in merge(line):
                            fo = self.fb if bold else self.fr
                            ops.append(("text", (tx, cy), t, fo, COL_HEAD if bold else COL_TEXT))
                            tx += fo.getlength(t)
                        cy += self.line_h
            ops.append(("line", (px(MARGIN), y + rh), (px(MARGIN) + content_w, y + rh)))
            y += rh

        for i in range(1, len(cols)):
            ops.append(("vline", (xs[i], table_top), (xs[i], y)))
        ops.append(("frame", (px(MARGIN), table_top), (px(MARGIN) + content_w, y)))
        return y + px(36), ops

    # ---------- draw ----------
    def render(self):
        all_ops, y = [], 0
        for block in ["title"] + SECTIONS:
            h, ops = self.block_title() if block == "title" else self.block_section(block)
            all_ops += [(op, y) for op in ops]
            y += h

        all_ops.append((("text", (px(MARGIN), y + px(4)),
                         "依据 5 张原始截图重新排版重绘 · 文字为人工识别转录，请与原表核对",
                         self.ffoot, COL_MUTED), 0))
        total_h = int(y + px(12.5 * 1.7) + px(40))

        img = Image.new("RGB", (px(W), total_h), "white")
        d = ImageDraw.Draw(img)
        for op, dy in all_ops:
            kind = op[0]
            if kind == "text":
                d.text((op[1][0], op[1][1] + dy), op[2], font=op[3], fill=op[4])
            elif kind == "rect":
                box = (op[1][0], op[1][1] + dy, op[1][2], op[1][3] + dy)
                if op[3]:
                    d.rounded_rectangle(box, radius=op[3], fill=op[2])
                else:
                    d.rectangle(box, fill=op[2])
            elif kind == "chip":
                d.rounded_rectangle((op[1][0], op[1][1] + dy, op[1][2], op[1][3] + dy),
                                    radius=px(5), fill=CHIP_BG, outline=CHIP_BD, width=px(1))
            elif kind == "line":
                d.line([(op[1][0], op[1][1] + dy), (op[2][0], op[2][1] + dy)], fill=COL_BORDER, width=px(1))
            elif kind == "vline":
                d.line([(op[1][0], op[1][1] + dy), (op[2][0], op[2][1] + dy)], fill=COL_BORDER, width=px(1))
            elif kind == "frame":
                d.rectangle((op[1][0], op[1][1] + dy, op[2][0] - px(1), op[2][1] + dy - px(1)),
                            outline=COL_BORDER, width=px(1))

        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        img.save(OUT, "PNG", optimize=True)
        print("saved", OUT, img.size, round(os.path.getsize(OUT) / 1024), "KB")


if __name__ == "__main__":
    Renderer().render()
