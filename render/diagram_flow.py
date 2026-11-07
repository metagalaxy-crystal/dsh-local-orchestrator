# -*- coding: utf-8 -*-
"""一张图汇总两个循环（决策环 + 执行环），风格对齐原框架设计图。

输出：docs/flow-v2.png
运行：python render/diagram_flow.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 2400, 1440
FONT_DIR = r"C:\Windows\Fonts"

INK = (31, 41, 55)
MUTED = (107, 114, 128)
FAINT = (156, 163, 175)

BLUE = (47, 111, 228)
BLUE_BG = (242, 247, 255)
ORANGE = (232, 113, 10)
ORANGE_BG = (255, 248, 239)
GREEN = (46, 158, 91)
GREEN_BG = (242, 250, 245)
SLATE = (75, 106, 138)
SLATE_BG = (238, 243, 248)
PURPLE = (123, 79, 209)
PURPLE_BG = (245, 241, 253)
GRAY_BG = (247, 248, 250)
WHITE = (255, 255, 255)

_fonts = {}


def _load(names, size):
    for name in names:
        path = os.path.join(FONT_DIR, name)
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def reg(size):
    key = ("r", size)
    if key not in _fonts:
        _fonts[key] = _load(["msyh.ttc", "msyh.ttf", "simhei.ttf"], size)
    return _fonts[key]


def bold(size):
    key = ("b", size)
    if key not in _fonts:
        _fonts[key] = _load(["msyhbd.ttc", "msyhbd.ttf", "msyh.ttc", "simhei.ttf"], size)
    return _fonts[key]


img = Image.new("RGB", (W, H), WHITE)
draw = ImageDraw.Draw(img, "RGBA")


def rrect(x1, y1, x2, y2, fill, outline, radius=18, width=3):
    draw.rounded_rectangle([x1, y1, x2, y2], radius=radius, fill=fill, outline=outline, width=width)


def text(x, y, s, size, color=INK, is_bold=False):
    draw.text((x, y), s, font=(bold(size) if is_bold else reg(size)), fill=color)


def arrow(x1, y1, x2, y2, color, width=3, dash=0, head=15):
    if dash:
        total = math.hypot(x2 - x1, y2 - y1) or 1
        t = 0.0
        while t < 1.0:
            t1 = min(1.0, t + dash / total)
            draw.line([(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t),
                       (x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1)], fill=color, width=width)
            t += (dash * 2) / total
    else:
        draw.line([(x1, y1), (x2, y2)], fill=color, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    draw.polygon([(x2, y2),
                  (x2 - head * math.cos(ang - 0.42), y2 - head * math.sin(ang - 0.42)),
                  (x2 - head * math.cos(ang + 0.42), y2 - head * math.sin(ang + 0.42))], fill=color)


def poly(points, color, width=3, dash=0, head=True):
    for i in range(len(points) - 1):
        arrow(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], color, width, dash,
              head=head and i == len(points) - 2)


def node(x1, y1, x2, y2, title, lines=(), accent=BLUE, fill=WHITE, title_size=23, line_size=17):
    rrect(x1, y1, x2, y2, fill, accent, 18, 3)
    text(x1 + 20, y1 + 14, title, title_size, INK, True)
    for i, line in enumerate(lines):
        text(x1 + 20, y1 + 52 + i * 28, line, line_size, MUTED)


# ================================================================ 标题
text(60, 26, "本地算力双环调度", 46, INK, True)
text(62, 90, "决策环决定「下一步做什么」，执行环负责「把这一步做完」；两环只通过任务池交接状态",
     21, MUTED)

# ================================================================ 决策环（左）
rrect(90, 260, 680, 520, BLUE_BG, BLUE, 20, 3)
text(112, 276, "会话模型 · 决策环", 23, BLUE, True)
for i, line in enumerate([
    "模型 → 工具调用 → 结果 → 模型",
    "决定：继续 / 改计划 / 停",
    "边界：不再要工具 = 回合结束",
    "看到的是任务摘要，不是全量产出",
]):
    text(112, 316 + i * 30, line, 18, MUTED)

rrect(90, 560, 680, 780, ORANGE_BG, ORANGE, 20, 3)
text(112, 574, "工具层 · 单步原语", 21, ORANGE, True)
for i, (name, sub) in enumerate([
    ("local_task", "create / list / rollback"),
    ("local_step", "run / retry / skip"),
]):
    y = 612 + i * 62
    rrect(112, y, 658, y + 50, WHITE, ORANGE, 12, 2)
    text(126, y + 6, name, 16, INK, True)
    text(126, y + 27, sub, 12, MUTED)
text(112, 740, "另：local_delegate / local_service（兼容门面）", 13, FAINT)

rrect(90, 806, 680, 880, GRAY_BG, SLATE, 14, 2)
text(108, 818, "一次调用只推进一步；worker 看到步骤在跑就让路", 15, MUTED)
text(108, 844, "插件不替模型「想」——决策永远在宿主", 15, FAINT)

# ================================================================ 任务池（中）
rrect(770, 260, 1490, 860, GREEN_BG, GREEN, 22, 3)
text(792, 274, "任务池 · Task 状态机", 23, GREEN, True)
text(792, 306, "跨会话 · 落盘 tasks/<id>.json · 重启恢复 paused", 15, MUTED)

cards = [
    ("会话 A · 生成海报", "running", GREEN, "2/4", [1, 1, 2, 0]),
    ("会话 A · 周报摘要", "waiting_decision", PURPLE, "1/1", [1, 3]),
    ("会话 B · 出 3 张图", "running", GREEN, "0/3", [2, 0, 0]),
]
dot_color = {0: (200, 204, 210), 1: GREEN, 2: ORANGE, 3: PURPLE}
chip_color = {"running": ORANGE, "waiting_decision": PURPLE, "paused": SLATE}
for i, (title, status, accent, progress, dots) in enumerate(cards):
    y = 346 + i * 132
    rrect(792, y, 1468, y + 112, WHITE, accent, 14, 2)
    text(812, y + 10, title, 18, INK, True)
    # 状态标签
    label = {"running": "执行中", "waiting_decision": "待决策", "paused": "已暂停"}[status]
    tw = draw.textlength(label, font=reg(13))
    cc = chip_color[status]
    rrect(1468 - 20 - tw - 16, y + 8, 1468 - 18, y + 30, cc, cc, 10, 1)
    text(1468 - 20 - tw - 8, y + 11, label, 13, WHITE)
    # 步骤点
    for j, state in enumerate(dots):
        cx = 812 + j * 30
        cy = y + 58
        draw.rounded_rectangle([cx, cy, cx + 18, cy + 18], radius=4, fill=dot_color[state],
                               outline=None if state else (200, 204, 210), width=1)
    text(812 + len(dots) * 30 + 8, y + 58, f"{progress} 步", 13, MUTED)

text(792, 742, "状态：queued → running → waiting_decision → done", 15, MUTED)
text(792, 770, "旁支：paused（可 resume）· error（连续失败/超预算）· cancelled", 15, MUTED)
text(792, 798, "状态是两环唯一的共享契约；取消只作用于本会话", 15, GREEN)

# ================================================================ 执行环（右）
rrect(1580, 260, 2300, 560, GREEN_BG, GREEN, 20, 3)
text(1602, 276, "worker · 执行环", 23, GREEN, True)
for i, line in enumerate([
    "tick(2s) → 取 running 任务 → claimStep",
    "→ 租约 → 执行一步 → 判定 → 写回",
    "边界：没有 running 任务 / 到了决策点",
]):
    text(1602, 316 + i * 30, line, 18, MUTED)

rrect(1580, 600, 2080, 780, WHITE, GREEN, 18, 3)
text(1602, 614, "租约表", 21, GREEN, True)
for i, line in enumerate([
    "GPU 槽互斥 · CPU 槽并发",
    "按会话轮转 · TTL 回收",
    "一次只放一个步骤进 GPU",
]):
    text(1602, 652 + i * 30, line, 17, MUTED)

rrect(1580, 806, 1840, 880, GRAY_BG, SLATE, 14, 2)
text(1596, 818, "卡住：硬超时 → 回退重试", 15, MUTED)
text(1596, 844, "卸载后等显存回落再起", 15, FAINT)

# ================================================================ 资源池（底）
rrect(90, 950, 2300, 1270, SLATE_BG, SLATE, 22, 3)
text(112, 964, "本地资源池（单卡 8GB：GPU 槽互斥，CPU 槽并发）", 23, SLATE, True)
res = [
    ("llama.cpp", ["LLM / VLM / embed / rerank", "端口 8080+ · 自动调参"]),
    ("ComfyUI", ["图 / 视频 / 音乐工作流", "首启 ~1 分钟"]),
    ("Python 脚本", ["TTS / ASR / 音乐质检", "一次性进程"]),
    ("MCP", ["Playwright / Blender / ArtCraft", "DSH 托管 · 零显存"]),
]
for i, (title, lines) in enumerate(res):
    x = 112 + i * 545
    rrect(x, 1012, x + 515, 1168, WHITE, SLATE, 14, 2)
    text(x + 18, 1026, title, 19, INK, True)
    for j, line in enumerate(lines):
        text(x + 18, 1062 + j * 26, line, 15, MUTED)

rrect(112, 1188, 2278, 1246, WHITE, SLATE, 12, 2)
text(130, 1200, "硬件：CPU 32 核 · 内存 31.7G · 显存 8G（预算 = min(空闲, 总量×(1-预留比例)) − 固定预留）", 17, INK)
text(130, 1224, "实测优先：加载前后总占用差（WDDM 下按进程读不到显存）", 13, FAINT)

# ================================================================ 环内箭头
# 任务池 → 会话模型（读状态）
arrow(770, 390, 684, 390, SLATE, 3)
text(688, 360, "摘要/待决策", 12, MUTED)
# 会话模型 → 工具层
arrow(385, 522, 385, 556, BLUE, 3)
text(398, 528, "调用", 13, FAINT)
# 工具层 → 任务池（写状态）
arrow(682, 700, 766, 700, ORANGE, 3)
text(690, 668, "写状态", 13, MUTED)

# 任务池 → worker（取步）
arrow(1492, 390, 1576, 390, SLATE, 3)
text(1496, 360, "取 running 步", 12, MUTED)
# worker → 任务池（写回判定）
arrow(1576, 500, 1492, 500, GREEN, 3)
text(1500, 468, "判定写回", 13, MUTED)

# worker → 租约 → 资源（执行）
arrow(1880, 562, 1880, 596, GREEN, 3)
text(1892, 568, "占用", 13, FAINT)
arrow(1880, 782, 1880, 946, GREEN, 3)
text(1892, 900, "执行一步（拿租约后进 GPU）", 13, FAINT)

# 资源 → worker（产物回流）
poly([(2240, 946), (2240, 566)], SLATE, 3, 8)
text(2095, 632, "产物 / 结果", 13, MUTED)

# 唤醒：worker → 会话模型（虚线，只叫所属会话）
poly([(1930, 258), (1930, 176), (385, 176), (385, 256)], PURPLE, 3, 10)
text(760, 148, "schedule 唤醒：只叫任务所属会话（其余会话不受影响）", 16, PURPLE)

# ================================================================ 图例
def swatch(x, y, color, label):
    draw.rounded_rectangle([x, y, x + 16, y + 16], radius=4, fill=color)
    text(x + 24, y, label, 15, MUTED)


swatch(90, 1320, BLUE, "决策环（宿主）")
swatch(300, 1320, GREEN, "执行环（插件）")
swatch(510, 1320, ORANGE, "工具 / 资源请求")
swatch(740, 1320, PURPLE, "唤醒 / 回流")
draw.line([(990, 1336), (1040, 1336)], fill=INK, width=3)
text(1050, 1324, "实线 = 调用 / 执行", 15, MUTED)
text(2130, 1324, "v0.6.0 · 2026-11-05", 15, FAINT)

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "flow-v2.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print("saved", out, img.size)
