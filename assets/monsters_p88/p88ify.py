# -*- coding: utf-8 -*-
# p88ify: 任意の画像を過去編PC-88スタイル (8色+オーダードディザ) に変換する
# 使い方: python3 p88ify.py 入力.png [出力.png] [--size 128] [--bright 1.0]
from PIL import Image, ImageEnhance
import sys, os

PAL = [
 (20, 22, 40), (48, 80, 180), (130, 180, 232), (232, 226, 192),
 (30, 100, 52), (106, 180, 70), (160, 106, 44), (204, 70, 50),
]
# Bayer 4x4 オーダードディザ行列
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

GRAYSAFE = (0, 1, 2, 3)  # 低彩度は 紺/青/水色/クリーム のみに割当 (灰の緑化防止)

def nearest(r, g, b):
    lo, hi = min(r, g, b), max(r, g, b)
    cand = GRAYSAFE if hi - lo < 34 else range(len(PAL))
    best, bd = 0, 1e9
    for i in cand:
        pr, pg, pb = PAL[i]
        # 知覚重み付き距離
        d = 0.30 * (r - pr) ** 2 + 0.59 * (g - pg) ** 2 + 0.11 * (b - pb) ** 2
        if d < bd: bd, best = d, i
    return best

def p88ify(src, size=128, bright=1.0, sat=1.15, spread=56):
    im = src.convert('RGB')
    # 正方形にセンタークロップ
    w, h = im.size
    if w != h:
        m = min(w, h)
        im = im.crop(((w - m) // 2, (h - m) // 2, (w - m) // 2 + m, (h - m) // 2 + m))
    im = im.resize((size, size), Image.LANCZOS)
    if bright != 1.0: im = ImageEnhance.Brightness(im).enhance(bright)
    if sat != 1.0: im = ImageEnhance.Color(im).enhance(sat)
    out = Image.new('RGB', (size, size))
    sp, op = im.load(), out.load()
    for y in range(size):
        for x in range(size):
            r, g, b = sp[x, y]
            t = (BAYER[y % 4][x % 4] / 15.0 - 0.5) * spread  # ディザ閾値ゆらぎ
            op[x, y] = PAL[nearest(r + t, g + t, b + t)]
    return out

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = {a.split('=')[0][2:]: a.split('=')[1] for a in sys.argv[1:] if a.startswith('--') and '=' in a}
    if not args:
        print('usage: p88ify.py in.png [out.png] [--size=128] [--bright=1.0]'); sys.exit(1)
    src = Image.open(args[0])
    dst = p88ify(src, size=int(opts.get('size', 128)), bright=float(opts.get('bright', 1.0)))
    outp = args[1] if len(args) > 1 else os.path.splitext(args[0])[0] + '_p88.png'
    dst.save(outp)
    print('saved', outp)
