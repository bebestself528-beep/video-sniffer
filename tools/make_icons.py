#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标（纯标准库实现，无第三方依赖）。
输出：icons/icon16.png, icon48.png, icon128.png
设计：圆角方形渐变底 + 白色下载箭头 + 底部托架。
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')

# 主题色（indigo -> violet 渐变）
C1 = (99, 102, 241)    # #6366F1
C2 = (139, 92, 246)    # #8B5CF6
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_rect_inside(x, y, w, h, r):
    """(x,y) 是否在圆角矩形内（尺寸 w x h，圆角半径 r）"""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def in_triangle(px, py, p1, p2, p3):
    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])
    d1 = sign((px, py), p1, p2)
    d2 = sign((px, py), p2, p3)
    d3 = sign((px, py), p3, p1)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def render_icon(size):
    """以 8x 超采样渲染单个尺寸的图标，返回 RGB 行列表。"""
    S = 8
    W = size * S
    # 画布几何（按 128 基准比例缩放）
    k = W / 128.0
    radius = 28 * k

    # 箭头：竖杆矩形 + 三角箭头
    shaft = (58 * k, 26 * k, 70 * k, 64 * k)             # x1,y1,x2,y2
    tri = ((38 * k, 60 * k), (90 * k, 60 * k), (64 * k, 92 * k))
    # 底部托架
    tray = (40 * k, 98 * k, 88 * k, 107 * k)
    tray_r = 4.5 * k

    rows = []
    for oy in range(size):
        row = []
        for ox in range(size):
            # 超采样累加
            r_sum = g_sum = b_sum = 0
            for sy in range(S):
                for sx in range(S):
                    x = ox * S + sx + 0.5
                    y = oy * S + sy + 0.5
                    if not rounded_rect_inside(x, y, W, W, radius):
                        continue
                    # 渐变底色
                    t = min(1.0, max(0.0, (x + y) / (2.0 * W)))
                    col = lerp(C1, C2, t)
                    # 白色图形叠加
                    on_shape = False
                    if shaft[0] <= x <= shaft[2] and shaft[1] <= y <= shaft[3]:
                        on_shape = True
                    elif in_triangle(x, y, tri[0], tri[1], tri[2]):
                        on_shape = True
                    elif rounded_rect_inside(x - tray[0], y - tray[1], tray[2] - tray[0], tray[3] - tray[1], tray_r):
                        on_shape = True
                    if on_shape:
                        col = WHITE
                    r_sum += col[0]
                    g_sum += col[1]
                    b_sum += col[2]
            # 单位像素平均 + alpha
            n = S * S
            if r_sum == 0 and g_sum == 0 and b_sum == 0:
                row.append((0, 0, 0, 0))
            else:
                # 有效采样数
                valid = 0
                for sy in range(S):
                    for sx in range(S):
                        x = ox * S + sx + 0.5
                        y = oy * S + sy + 0.5
                        if rounded_rect_inside(x, y, W, W, radius):
                            valid += 1
                if valid == 0:
                    row.append((0, 0, 0, 0))
                else:
                    row.append((r_sum // valid, g_sum // valid, b_sum // valid, int(255 * valid / n)))
        rows.append(row)
    return rows


def write_png(path, rows):
    h = len(rows)
    w = len(rows[0])
    raw = b''.join(
        b'\x00' + bytes(v for px in row for v in px)
        for row in rows
    )

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (b'\x89PNG\r\n\x1a\n' +
           chunk(b'IHDR', ihdr) +
           chunk(b'IDAT', zlib.compress(raw, 9)) +
           chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        rows = render_icon(size)
        path = os.path.join(OUT_DIR, f'icon{size}.png')
        write_png(path, rows)
        print('generated', os.path.normpath(path))


if __name__ == '__main__':
    main()
