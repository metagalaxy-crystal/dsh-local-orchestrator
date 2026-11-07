# -*- coding: utf-8 -*-
"""生成《有限资源调度器 改造方案 v2》的框架设计图（PNG）。

不依赖 graphviz / matplotlib，只用 Pillow 手绘：分层色块 + 圆角框 + 箭头。
运行：python render/diagram_v2.py
输出：docs/architecture-v2.png
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 2400, 1640
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


def rrect(x1, y1, x2, y2, fill, outline, radius=20, width=3):
    draw.rounded_rectangle([x1, y1, x2, y2], radius=radius, fill=fill, outline=outline, width=width)


def text(x, y, s, size, color=INK, is_bold=False):
    draw.text((x, y), s, font=(bold(size) if is_bold else reg(size)), fill=color)


def arrow(x1, y1, x2, y2, color, width=3, dash=0, head=16):
    if dash:
        total = math.hypot(x2 - x1, y2 - y1) or 1
        step = dash * 2
        t = 0.0
        while t < 1.0:
            t0 = t
            t1 = min(1.0, t + dash / total)
            draw.line(
                [(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0),
                 (x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1)],
                fill=color, width=width,
            )
            t += step / total
    else:
        draw.line([(x1, y1), (x2, y2)], fill=color, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    pts = [
        (x2, y2),
        (x2 - head * math.cos(ang - 0.42), y2 - head * math.sin(ang - 0.42)),
        (x2 - head * math.cos(ang + 0.42), y2 - head * math.sin(ang + 0.42)),
    ]
    draw.polygon(pts, fill=color)


# ---------------------------------------------------------------- 标题
text(60, 30, "dsh-local-orchestrator · 框架设计 v2", 44, INK, True)
text(62, 92, "决策环归 DSH agent loop（会话模型），执行环归插件 worker，资源仲裁归租约表 · 跨会话任务池 + 双决策接口", 21, MUTED)

# ---------------------------------------------------------------- ① 决策环
rrect(60, 150, 1720, 420, BLUE_BG, BLUE, 26, 4)
text(90, 164, "① 决策环 · DSH agent loop（谁决定下一步做什么）", 26, BLUE, True)

for x1, x2, title, lines in [
    (90, 870, "会话 A · agent loop",
     ["模型判断 → 调 local_step / local_task", "一次调用推进 1 步；回合结束交还控制权", "决策默认 dsh（DeepSeek），可切 local / openai"]),
    (900, 1690, "会话 B · agent loop",
     ["同一套工具，独立的任务与预算", "停 A 只暂停 A 的任务，B 不受影响", "唤醒只发给任务所属会话，不广播"]),
]:
    rrect(x1, 220, x2, 400, WHITE, BLUE, 18, 2)
    text(x1 + 24, 238, title, 23, INK, True)
    for i, line in enumerate(lines):
        text(x1 + 24, 280 + i * 30, line, 19, MUTED)

# ---------------------------------------------------------------- ② 工具层
rrect(60, 460, 1720, 580, ORANGE_BG, ORANGE, 24, 4)
text(90, 470, "② 工具层 · 单步原语（一次调用只推进一步，返回状态摘要 ≤ 800 字）", 24, ORANGE, True)

chips = [
    ("local_task", "create / list / cancel"),
    ("local_step", "run / retry / verdict"),
    ("local_delegate", "兼容门面（内部=建任务+循环）"),
    ("local_service", "load / stop / sync"),
    ("local_chat", "单次本地推理"),
    ("local_generate", "ComfyUI 出图/视频/音乐"),
    ("local_audio", "TTS / ASR / 质检"),
]
cw, gap, cy1, cy2 = 215, 16, 505, 560
for i, (name, sub) in enumerate(chips):
    x = 90 + i * (cw + gap)
    rrect(x, cy1, x + cw, cy2, WHITE, ORANGE, 14, 2)
    text(x + 12, cy1 + 9, name, 17, INK, True)
    text(x + 12, cy1 + 32, sub, 12, MUTED)

# ---------------------------------------------------------------- ③ 插件
rrect(60, 620, 1720, 1180, GREEN_BG, GREEN, 26, 4)
text(90, 634, "③ 插件 dsh-local-orchestrator · 执行环 + 资源仲裁", 26, GREEN, True)

modules = [
    # x1, y1, x2, y2, title, lines
    (90, 680, 610, 870, "tasks.js · 任务状态机",
     ["Task / Step / Substep 三层", "预算熔断：8 步 · 2 次 require · 30 分钟", "持久化 tasks/<id>.json · 断点恢复"]),
    (640, 680, 1160, 870, "worker.js · 执行环",
     ["取步 → 租约 → 执行 → 心跳 → 判定 → 写回", "只做确定性步骤；需要判断 → waiting_decision", "卡死：心跳超时 → 回退 + 重试（≤ 2 次）"]),
    (1190, 680, 1690, 870, "leases.js · 租约表",
     ["GPU 槽互斥 · CPU 槽并发", "显存预算唯一裁决者，模型只能提议", "按会话归属 → 取消/回滚精确到任务"]),
    (90, 890, 610, 1080, "manager.js · 资源管理",
     ["ensure / stop / releaseIdle · LRU 淘汰", "autoTune（ctx / ngl / KV）· adopt 复用", "端口回退 · 健康探测"]),
    (640, 890, 1160, 1080, "decision.js · 规划器",
     ["默认 dsh（DeepSeek）· session 兜底", "local：planOnce，规划后立即释放租约", "openai：任意兼容端点"]),
    (1190, 890, 1690, 1080, "tracker.js + 页签 · 观测",
     ["任务框图 · IO 三通道（decision/local/mcp）", "任务池页：按会话分组、步骤树、租约表", "/api/local-orchestrator/state"]),
]
for x1, y1, x2, y2, title, lines in modules:
    rrect(x1, y1, x2, y2, WHITE, GREEN, 16, 2)
    text(x1 + 22, y1 + 14, title, 22, INK, True)
    for i, line in enumerate(lines):
        text(x1 + 22, y1 + 58 + i * 30, line, 18, MUTED)

text(90, 1102, "执行环不调用 LLM：模型只通过工具推进任务，插件不自己「想」；需要决策时停住并唤醒所属会话。", 17, GREEN)

# ---------------------------------------------------------------- ④ 资源
rrect(60, 1220, 1720, 1560, SLATE_BG, SLATE, 26, 4)
text(90, 1234, "④ 本地资源池（单卡 8GB：GPU 槽互斥，CPU 槽并发）", 26, SLATE, True)

resources = [
    (90, "llama.cpp", ["LLM / VLM / embed / rerank", "端口 8080+ · 自动调参"]),
    (495, "ComfyUI", ["图 / 视频 / 音乐工作流", "首启 ~1 分钟 · /interrupt"]),
    (900, "Python 脚本", ["TTS / ASR / 音乐质检", "一次性进程 · 跑完释放"]),
    (1305, "MCP", ["Playwright / Blender / ArtCraft", "DSH 托管 · 零显存"]),
]
for x, title, lines in resources:
    rrect(x, 1290, x + 385, 1430, WHITE, SLATE, 16, 2)
    text(x + 18, 1306, title, 21, INK, True)
    for i, line in enumerate(lines):
        text(x + 18, 1348 + i * 28, line, 17, MUTED)

rrect(90, 1448, 1690, 1522, WHITE, SLATE, 14, 2)
text(110, 1458, "硬件：CPU 32 核 · 内存 31.7G · 显存 8G（预算 = min(空闲, 总量×(1-预留比例)) − 固定预留）", 18, INK)
text(110, 1490, "实测优先于估算：加载前后总占用差（WDDM 下按进程读不到显存）", 15, FAINT)

# ---------------------------------------------------------------- 右侧
panels = [
    (150, 420, "⑤ 唤醒与通知", PURPLE, PURPLE_BG, [
        "schedule.create → 会话 inbox",
        "跨回合唤醒，只叫任务所属会话",
        "systemPrompt 简报：每轮 N 个待决策",
        "deferContext：同回合带入模型",
        "唤醒内容 = 任务摘要 + 证据包",
        "任务解决后 schedule.delete",
        "schedule 失败 → 下次开会话提示",
    ]),
    (460, 760, "⑥ 跨会话隔离", PURPLE, PURPLE_BG, [
        "Task.sessionId 是第一等字段",
        "turn-stopping 只暂停本会话任务",
        "资源按会话轮转，避免饥饿",
        "会话归档 → paused + 释放租约",
        "local_task list 默认只看本会话",
        "跨会话只读（all=true）",
        "任务状态机禁止跨会话写",
    ]),
    (800, 1180, "⑦ 状态与产物", PURPLE, PURPLE_BG, [
        "tasks/<taskId>.json（tmp+rename）",
        "events.jsonl 审计可回放",
        "产物保留，回滚只回状态",
        "任务池页按会话分组",
        "恢复：running → paused",
        "adopt：端口 + alias 校验后接管",
        "rollback(taskId, toIndex)",
        "已验收产物的 seed / 参数可重放",
    ]),
    (1220, 1560, "⑧ 超时与显存回收", PURPLE, PURPLE_BG, [
        "1  单步硬超时 → abort 请求",
        "2  步骤回退，按失败重试",
        "3  卸载时 kill 进程组",
        "4  等显存回落，再起下一个模型",
        "每次处置写 events.jsonl",
        "回退状态，不删产物",
    ]),
]
for y1, y2, title, accent, bg, lines in panels:
    rrect(1780, y1, 2340, y2, bg, accent, 20, 3)
    text(1802, y1 + 14, title, 22, accent, True)
    for i, line in enumerate(lines):
        text(1802, y1 + 54 + i * 30, line, 17, MUTED)

# ---------------------------------------------------------------- 箭头
arrow(480, 400, 480, 458, BLUE)
text(492, 424, "工具调用", 15, FAINT)
arrow(1295, 400, 1295, 458, BLUE)

arrow(480, 580, 480, 618, ORANGE)
text(492, 588, "执行 / 查询", 15, FAINT)
arrow(1295, 580, 1295, 618, ORANGE)

arrow(480, 1180, 480, 1218, GREEN)
text(492, 1188, "租约", 15, FAINT)
arrow(760, 1218, 760, 1182, SLATE, 3, 8)
text(772, 1188, "实测显存 / 健康", 15, FAINT)

arrow(1780, 285, 1726, 285, PURPLE, 3, 9)
text(1726, 252, "唤醒", 14, PURPLE)
arrow(1780, 610, 1726, 610, PURPLE, 3, 9)
text(1726, 577, "隔离", 14, PURPLE)

# 图例
draw.line([(60, 1590), (110, 1590)], fill=INK, width=3)
text(120, 1578, "实线 = 调用 / 执行", 15, MUTED)
draw.line([(330, 1590), (380, 1590)], fill=PURPLE, width=3)
text(390, 1578, "虚线 = 通知 / 状态回流", 15, MUTED)
_footer = "v2 · 2026-11-04 · D:\\dsh-plugin"
_fw = draw.textlength(_footer, font=reg(15))
text(2400 - 40 - _fw, 1578, _footer, 15, FAINT)

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "architecture-v2.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print("saved", out, img.size)
