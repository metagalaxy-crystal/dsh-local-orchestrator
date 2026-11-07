# -*- coding: utf-8 -*-
"""双循环与三种协作形态的运行示意图。

输出：docs/loops-v2.png
运行：python render/diagram_loops.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 2400, 2000
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


def arrow(x1, y1, x2, y2, color, width=3, dash=0, head=14):
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


def node(x, y, w, h, title, lines=(), accent=BLUE, fill=WHITE, title_size=20, line_size=16):
    rrect(x, y, x + w, y + h, fill, accent, 16, 3)
    text(x + 16, y + 12, title, title_size, INK, True)
    for i, line in enumerate(lines):
        text(x + 16, y + 44 + i * 26, line, line_size, MUTED)


def section(y, title, accent, note=""):
    draw.rectangle([60, y - 14, 72, y + 34], fill=accent)
    text(92, y - 16, title, 30, INK, True)
    if note:
        text(96, y + 22, note, 17, MUTED)


# ================================================================ 标题
text(60, 28, "双循环 · 三种协作形态", 46, INK, True)
text(62, 92, "决策环在宿主（谁决定下一步），执行环在插件（把一步做完）；两者只通过任务状态机交接",
     21, MUTED)

# ================================================================ ① 两个循环
section(180, "① 两个循环各自转，不互相调用", SLATE,
        "决策环有「回合」边界，执行环有「2s tick」边界；共享的唯一状态是任务池里的 Task/Step")

b1 = (90, 240, 760, 470)
rrect(*b1, BLUE_BG, BLUE, 20, 3)
text(112, 258, "决策环 · DSH agent loop", 23, BLUE, True)
for i, line in enumerate([
    "模型 → 工具调用 → 结果 → 模型 → …",
    "边界：模型不再要工具（turn 结束）",
    "谁在跑：会话模型；插件只是被调用方",
    "不变量：插件不能替模型「想」",
]):
    text(112, 300 + i * 32, line, 18, MUTED)

b2 = (820, 240, 1490, 470)
rrect(*b2, GREEN_BG, GREEN, 20, 3)
text(842, 258, "执行环 · worker（插件内）", 23, GREEN, True)
for i, line in enumerate([
    "tick(2s) → 取 running 任务 → claimStep",
    "→ 租约 → 执行一步 → 判定 → 写回",
    "边界：没有 running 任务 / 到了决策点",
    "不变量：一次只推进一步，同一时刻只占一个 GPU 槽",
]):
    text(842, 300 + i * 32, line, 18, MUTED)

b3 = (1560, 240, 2310, 470)
rrect(*b3, GRAY_BG, SLATE, 20, 3)
text(1582, 258, "交接点：任务状态机", 23, SLATE, True)
for i, line in enumerate([
    "queued：建好还没人跑第一步",
    "running：允许 worker 继续推进",
    "waiting_decision：停下，等模型判断",
    "done / error / paused / cancelled：终态或可恢复",
]):
    text(1582, 300 + i * 32, line, 18, MUTED)

arrow(770, 320, 808, 320, BLUE)
text(770, 288, "工具调用", 15, FAINT)
arrow(1500, 390, 1548, 390, SLATE, 3, 8)
text(1480, 358, "状态", 15, FAINT)

# ================================================================ ② 形态 A
section(530, "② 形态 A · 会话内驱动（默认）", ORANGE, "决策粒度 = 每一步：模型看到结果再决定下一句")
AW, AGAP, AY, AH = 372, 46, 580, 150
ax = 90
anodes = [
    ("会话模型", ["调 local_step run"], BLUE),
    ("工具层", ["claimStep 认领这一步"], ORANGE),
    ("执行器", ["ensure → 推理 / 生成"], GREEN),
    ("工具层", ["判定产物 + 写回任务"], ORANGE),
    ("会话模型", ["看摘要，决定下一步"], BLUE),
]
for i, (title, lines, accent) in enumerate(anodes):
    node(ax + i * (AW + AGAP), AY, AW, AH, title, lines, accent)
    if i > 0:
        arrow(ax + i * (AW + AGAP) - AGAP + 6, AY + AH / 2,
              ax + i * (AW + AGAP) - 6, AY + AH / 2, MUTED)
# 回环
last_x = ax + 4 * (AW + AGAP) + AW / 2
first_x = ax + AW / 2
poly([(last_x, AY + AH), (last_x, AY + AH + 60), (first_x, AY + AH + 60), (first_x, AY + AH + 4)],
     BLUE, 3, 10)
text(first_x + 20, AY + AH + 66, "↺ 一次调用只推进一步；要更多步，模型再调一次", 17, BLUE)
text(90, AY + AH + 104, "worker 看到该任务有步骤在跑 → 让路（claimStep 失败），不抢同一步", 16, FAINT)

# ================================================================ ③ 形态 B
section(880, "③ 形态 B · 决策模型驱动（一次规划，批量执行）", ORANGE,
        "决策粒度 = 计划：适合 dsh / 本地小模型；8GB 上必须步间复用同一个模型")
BW, BGAP, BY, BH = 480, 50, 930, 130
bx = 90
bnodes = [
    ("决策模型", ["plan(steps) 一次拆完"], BLUE),
    ("执行器", ["批量执行 step1..N", "同一模型不重载"], GREEN),
    ("执行器", ["汇总产物与耗时"], GREEN),
    ("会话模型", ["拿到最终产出"], BLUE),
]
for i, (title, lines, accent) in enumerate(bnodes):
    node(bx + i * (BW + BGAP), BY, BW, BH, title, lines, accent)
    if i > 0:
        arrow(bx + i * (BW + BGAP) - BGAP + 6, BY + BH / 2,
              bx + i * (BW + BGAP) - 6, BY + BH / 2, MUTED)
text(90, BY + BH + 18, "local 模式：planOnce=true，规划完立即释放租约（否则每步重载 45s）；决策失败回落 session 模式",
     16, FAINT)

# ================================================================ ④ 形态 C
section(1120, "④ 形态 C · 后台推进 + 检查点（跨会话）", ORANGE,
        "决策粒度 = 检查点：会话可以关掉，worker 继续跑；到点用 schedule 唤醒所属会话")

CW, CGAP, CY, CH = 380, 48, 1215, 110
CY2 = 1415
CY3 = 1585

# Row1：启动
c1 = [
    ("会话模型", ["create(goal) → queued"], BLUE),
    ("会话模型", ["local_step run 第 1 步"], BLUE),
    ("任务状态", ["running：允许后台接管"], SLATE),
]
for i, (title, lines, accent) in enumerate(c1):
    node(90 + i * (CW + CGAP), CY, CW, CH, title, lines, accent)
    if i > 0:
        arrow(90 + i * (CW + CGAP) - CGAP + 6, CY + CH / 2, 90 + i * (CW + CGAP) - 6, CY + CH / 2, MUTED)

# Row2：worker 推进
c2 = [
    ("worker", ["tick 取步 · 按会话轮转"], GREEN),
    ("租约 + 执行", ["GPU 槽 / 显存预算"], GREEN),
    ("判定", ["done / require / error"], GREEN),
]
for i, (title, lines, accent) in enumerate(c2):
    node(90 + i * (CW + CGAP), CY2, CW, CH, title, lines, accent)
    if i > 0:
        arrow(90 + i * (CW + CGAP) - CGAP + 6, CY2 + CH / 2, 90 + i * (CW + CGAP) - 6, CY2 + CH / 2, MUTED)

# 任务状态 → worker（走廊 y=1360）
x_state = 90 + 2 * (CW + CGAP) + CW / 2
x_worker = 90 + CW / 2
poly([(x_state, CY + CH), (x_state, 1360), (x_worker, 1360), (x_worker, CY2 - 4)], SLATE, 3, 8)
text(1150, 1330, "后台接管", 14, FAINT)

# 否：回到 worker 继续下一步（走廊 y=1560）
poly([(1000, CY2 + CH), (1000, 1560), (x_worker, 1560), (x_worker, CY2 + CH + 4)], GREEN, 3, 8)
text(300, 1566, "否：继续下一步（直到没有 running 任务）", 15, GREEN)

# 是：进入检查点
arrow(1136, CY2 + CH, 1136, CY3 - 4, PURPLE, 3, 8)
text(1148, 1530, "是：require / 失败 / 超预算", 14, PURPLE)

# Row3：检查点
node(946, CY3, CW, CH, "waiting_decision", ["schedule 唤醒所属会话"], PURPLE)
node(1374, CY3, CW, CH, "会话模型", ["get → retry / rollback", "resume 后重新排队"], PURPLE)
arrow(946 + CW + 6, CY3 + CH / 2, 1374 - 6, CY3 + CH / 2, PURPLE, 3, 8)

# resume → 任务回到 running（右侧走廊）
poly([(1754, CY3 + CH / 2), (1800, CY3 + CH / 2), (1800, 1270), (1332, 1270)], PURPLE, 3, 8)
text(1808, 1386, "resume / retry 后", 15, PURPLE)
text(1808, 1410, "任务回到 running", 15, PURPLE)

# ================================================================ ⑤ 状态机
section(1742, "⑤ 任务状态机（三种形态共用）", SLATE, "")
SX, SY, SW, SH = 90, 1800, 300, 86
states = [
    ("queued", SLATE, "建好 / 等第一步"),
    ("running", GREEN, "执行环可推进"),
    ("waiting_decision", PURPLE, "停下等人"),
    ("done", BLUE, "全部步骤完成"),
]
for i, (name, color, desc) in enumerate(states):
    x = SX + i * (SW + 120)
    rrect(x, SY, x + SW, SY + SH, WHITE, color, 16, 3)
    text(x + 18, SY + 10, name, 20, INK, True)
    text(x + 18, SY + 46, desc, 16, MUTED)
    if i > 0:
        arrow(SX + i * (SW + 120) - 116, SY + SH / 2, SX + i * (SW + 120) - 6, SY + SH / 2, MUTED)
        text(SX + i * (SW + 120) - 118, SY + 14, ["开始", "需要判断", "判断通过"][i - 1], 14, FAINT)
# 旁支
text(SX, SY + SH + 16, "旁支：paused（暂停，可 resume）· error（连续失败 / 超预算）· cancelled（取消）· 重启后 running → paused",
     16, FAINT)

# ================================================================ 图例 / 页脚
draw.line([(60, 1950), (110, 1950)], fill=INK, width=3)
text(120, 1938, "实线 = 调用 / 执行", 15, MUTED)
draw.line([(330, 1950), (380, 1950)], fill=PURPLE, width=3)
text(390, 1938, "虚线 = 唤醒 / 状态回流", 15, MUTED)
text(2340 - 300, 1938, "v0.6.0 · 2026-11-05", 15, FAINT)

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "loops-v2.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print("saved", out, img.size)
