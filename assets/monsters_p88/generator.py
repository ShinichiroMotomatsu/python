# -*- coding: utf-8 -*-
# 過去編バトル用モンスター (PC-88風 8色+ディザ, 48x48ドット)
from PIL import Image, ImageDraw, ImageFont
import os

PAL = {
 'navy': (20, 22, 40, 255), 'blue': (48, 80, 180, 255), 'lblue': (130, 180, 232, 255),
 'cream': (232, 226, 192, 255), 'dgreen': (30, 100, 52, 255), 'green': (106, 180, 70, 255),
 'brown': (160, 106, 44, 255), 'red': (204, 70, 50, 255),
}
S = 48

def new():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))

def E(d, box, c):  # 楕円
    d.ellipse(box, fill=PAL[c])
def P(d, pts, c):  # 多角形
    d.polygon(pts, fill=PAL[c])
def R(d, box, c):  # 矩形
    d.rectangle(box, fill=PAL[c])
def L(d, pts, c, w=1):
    d.line(pts, fill=PAL[c], width=w)

def dith(img, box, cfrom, cto, lvl):
    """box内で色cfromのピクセルをパターンに従いctoへ (lvl:1=1/8 2=1/4 3=1/2)"""
    px = img.load()
    fx, fy, tx, ty = box
    for y in range(max(0, fy), min(S, ty + 1)):
        for x in range(max(0, fx), min(S, tx + 1)):
            if px[x, y] != PAL[cfrom]:
                continue
            if lvl == 1: hit = (x % 4 == 1 and y % 4 == 1) or (x % 4 == 3 and y % 4 == 3)
            elif lvl == 2: hit = (x % 2 == 0 and y % 2 == 0)
            else: hit = (x + y) % 2 == 0
            if hit: px[x, y] = PAL[cto]

def outline(img):
    """透明部のうち不透明に隣接するピクセルを紺で縁取り"""
    px = img.load()
    edge = []
    for y in range(S):
        for x in range(S):
            if px[x, y][3] != 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < S and 0 <= ny < S and px[nx, ny][3] != 0 and px[nx, ny] != PAL['navy']:
                    edge.append((x, y)); break
    for x, y in edge:
        px[x, y] = PAL['navy']

# ============================================================ 各モンスター
def m_slime():
    im = new(); d = ImageDraw.Draw(im)
    E(d, (8, 18, 39, 44), 'blue')                       # 本体ドーム
    E(d, (12, 14, 35, 34), 'blue')
    P(d, [(10, 40), (6, 45), (13, 43)], 'blue')         # 左のしずく
    P(d, [(38, 40), (42, 45), (35, 43)], 'blue')
    dith(im, (8, 26, 39, 45), 'blue', 'navy', 3)        # 下半分の陰
    E(d, (15, 17, 24, 24), 'lblue')                     # ハイライト
    E(d, (17, 19, 21, 22), 'cream')
    E(d, (16, 26, 21, 33), 'cream'); E(d, (27, 26, 32, 33), 'cream')  # 目
    R(d, (18, 29, 19, 32), 'navy'); R(d, (29, 29, 30, 32), 'navy')
    L(d, [(20, 37), (24, 39), (28, 37)], 'navy')        # 口
    return im

def m_goblin():
    im = new(); d = ImageDraw.Draw(im)
    E(d, (14, 8, 33, 26), 'green')                      # 頭
    P(d, [(14, 12), (4, 6), (15, 19)], 'green')         # 左耳
    P(d, [(33, 12), (43, 6), (32, 19)], 'green')
    R(d, (16, 24, 31, 38), 'green')                     # 胴
    dith(im, (14, 18, 33, 38), 'green', 'dgreen', 2)
    R(d, (14, 30, 33, 36), 'brown')                     # 腰布
    P(d, [(14, 30), (10, 40), (17, 36)], 'brown')
    R(d, (16, 38, 20, 45), 'green'); R(d, (27, 38, 31, 45), 'green')  # 脚
    R(d, (15, 45, 21, 46), 'brown'); R(d, (26, 45, 32, 46), 'brown')
    R(d, (11, 22, 15, 33), 'green')                     # 左腕
    R(d, (32, 22, 36, 30), 'green')
    R(d, (34, 10, 37, 30), 'brown')                     # こん棒
    E(d, (32, 4, 40, 14), 'brown')
    dith(im, (32, 4, 40, 14), 'brown', 'navy', 2)
    R(d, (17, 14, 20, 17), 'red'); R(d, (26, 14, 29, 17), 'red')      # 目
    R(d, (18, 15, 18, 16), 'cream'); R(d, (27, 15, 27, 16), 'cream')
    L(d, [(18, 21), (23, 22), (28, 21)], 'navy')
    R(d, (19, 21, 20, 23), 'cream'); R(d, (26, 21, 27, 23), 'cream')  # 牙
    return im

def m_bat():
    im = new(); d = ImageDraw.Draw(im)
    P(d, [(22, 20), (2, 8), (4, 22), (10, 18), (12, 28), (18, 24)], 'red')    # 左翼
    P(d, [(26, 20), (46, 8), (44, 22), (38, 18), (36, 28), (30, 24)], 'red')
    dith(im, (2, 8, 46, 28), 'red', 'navy', 2)
    L(d, [(6, 10), (10, 18)], 'navy'); L(d, [(42, 10), (38, 18)], 'navy')     # 翼の骨
    E(d, (18, 14, 30, 30), 'brown')                      # 体
    dith(im, (18, 22, 30, 30), 'brown', 'navy', 3)
    P(d, [(19, 15), (17, 9), (23, 13)], 'brown')         # 耳
    P(d, [(29, 15), (31, 9), (25, 13)], 'brown')
    E(d, (20, 18, 23, 21), 'lblue'); E(d, (25, 18, 28, 21), 'lblue')          # 目
    R(d, (21, 19, 21, 20), 'navy'); R(d, (26, 19, 26, 20), 'navy')
    R(d, (21, 24, 22, 26), 'cream'); R(d, (26, 24, 27, 26), 'cream')          # 牙
    P(d, [(22, 30), (24, 35), (26, 30)], 'brown')        # 尾
    return im

def m_skeleton():
    im = new(); d = ImageDraw.Draw(im)
    E(d, (17, 4, 30, 17), 'cream')                       # 頭蓋
    R(d, (19, 15, 28, 19), 'cream')
    R(d, (19, 12, 21, 15), 'navy'); R(d, (26, 12, 28, 15), 'navy')  # 眼窩
    R(d, (20, 13, 20, 13), 'red'); R(d, (27, 13, 27, 13), 'red')    # 眼光
    for i in range(3):                                    # 歯
        R(d, (20 + i * 3, 17, 20 + i * 3, 18), 'navy')
    R(d, (22, 19, 25, 22), 'cream')                      # 首
    R(d, (17, 22, 30, 24), 'cream')                      # 鎖骨
    for i in range(3):                                    # 肋骨
        R(d, (18, 26 + i * 3, 29, 27 + i * 3), 'cream')
    R(d, (23, 24, 24, 34), 'cream')                      # 背骨
    R(d, (20, 35, 27, 37), 'cream')                      # 骨盤
    R(d, (20, 38, 22, 45), 'cream'); R(d, (25, 38, 27, 45), 'cream')  # 脚
    dith(im, (17, 15, 30, 45), 'cream', 'brown', 1)
    R(d, (13, 22, 15, 33), 'cream')                      # 左腕(剣持ち)
    R(d, (31, 22, 33, 30), 'cream')                      # 右腕
    R(d, (12, 8, 14, 22), 'lblue')                       # 錆びた剣
    P(d, [(12, 8), (13, 3), (14, 8)], 'lblue')
    R(d, (10, 21, 16, 22), 'brown')                      # 鍔
    dith(im, (12, 3, 14, 20), 'lblue', 'navy', 2)
    E(d, (30, 26, 40, 38), 'brown')                      # 盾
    E(d, (32, 28, 38, 36), 'brown')
    dith(im, (30, 26, 40, 38), 'brown', 'navy', 2)
    R(d, (34, 31, 36, 33), 'cream')
    return im

def m_wolf():
    im = new(); d = ImageDraw.Draw(im)
    E(d, (6, 18, 36, 36), 'brown')                       # 胴
    E(d, (28, 10, 44, 24), 'brown')                      # 頭
    P(d, [(30, 12), (28, 4), (35, 10)], 'brown')         # 耳
    P(d, [(38, 11), (42, 4), (44, 12)], 'brown')
    P(d, [(40, 16), (47, 19), (40, 22)], 'brown')        # 鼻先
    R(d, (46, 18, 47, 19), 'navy')                       # 鼻
    dith(im, (6, 24, 44, 40), 'brown', 'navy', 2)        # 下半身の陰
    dith(im, (6, 10, 44, 18), 'brown', 'cream', 1)       # 背のハイライト
    P(d, [(4, 20), (0, 12), (10, 18)], 'brown')          # 尾
    R(d, (10, 34, 13, 44), 'brown'); R(d, (18, 35, 21, 44), 'brown')  # 脚
    R(d, (28, 34, 31, 44), 'brown'); R(d, (34, 32, 37, 43), 'brown')
    R(d, (9, 44, 14, 45), 'navy'); R(d, (27, 44, 32, 45), 'navy')     # 爪先
    E(d, (33, 14, 37, 17), 'red')                        # 目
    R(d, (34, 15, 35, 16), 'cream')
    L(d, [(40, 21), (44, 21)], 'navy')                   # 口
    R(d, (41, 21, 41, 23), 'cream'); R(d, (43, 21, 43, 22), 'cream')  # 牙
    return im

def m_myconid():
    im = new(); d = ImageDraw.Draw(im)
    E(d, (8, 6, 39, 26), 'red')                          # カサ
    R(d, (8, 16, 39, 20), 'red')
    dith(im, (8, 14, 39, 21), 'red', 'navy', 2)
    E(d, (13, 9, 19, 14), 'cream'); E(d, (26, 7, 34, 12), 'cream')    # 斑点
    E(d, (33, 14, 37, 17), 'cream'); E(d, (10, 15, 13, 18), 'cream')
    R(d, (16, 20, 31, 41), 'cream')                      # 柄(体)
    P(d, [(16, 41), (12, 45), (20, 43)], 'cream')        # すそ
    P(d, [(31, 41), (35, 45), (27, 43)], 'cream')
    dith(im, (16, 32, 35, 45), 'cream', 'brown', 2)
    R(d, (19, 25, 21, 30), 'navy'); R(d, (26, 25, 28, 30), 'navy')    # 眠たげな目
    R(d, (19, 25, 21, 26), 'cream'); R(d, (26, 25, 28, 26), 'cream')
    L(d, [(21, 35), (24, 36), (26, 35)], 'brown')        # 口
    E(d, (5, 30, 12, 36), 'red')                         # 子きのこ
    R(d, (7, 35, 9, 40), 'cream')
    return im

def m_ghoul():
    im = new(); d = ImageDraw.Draw(im)
    E(d, (15, 5, 32, 22), 'dgreen')                      # 頭
    R(d, (16, 20, 31, 36), 'dgreen')                     # 胴
    dith(im, (15, 14, 32, 36), 'dgreen', 'navy', 2)
    dith(im, (15, 5, 32, 12), 'dgreen', 'green', 1)
    R(d, (14, 24, 34, 33), 'brown')                      # ぼろ服
    P(d, [(14, 33), (12, 40), (19, 35)], 'brown')
    P(d, [(34, 33), (36, 40), (29, 35)], 'brown')
    dith(im, (12, 24, 36, 40), 'brown', 'navy', 2)
    R(d, (8, 18, 15, 22), 'dgreen')                      # 突き出た左腕
    R(d, (5, 18, 9, 27), 'dgreen')
    R(d, (3, 26, 5, 28), 'cream'); R(d, (6, 27, 8, 29), 'cream')      # 爪
    R(d, (32, 20, 38, 24), 'dgreen')                     # 右腕
    R(d, (36, 24, 39, 30), 'dgreen')
    R(d, (17, 36, 21, 45), 'dgreen'); R(d, (26, 36, 30, 45), 'dgreen')  # 脚
    R(d, (18, 11, 21, 14), 'red'); R(d, (26, 11, 29, 14), 'red')      # 落ち窪んだ目
    R(d, (19, 12, 19, 13), 'cream'); R(d, (27, 12, 27, 13), 'cream')
    L(d, [(19, 18), (28, 18)], 'navy')                   # 縫い口
    L(d, [(21, 17), (21, 19)], 'navy'); L(d, [(25, 17), (25, 19)], 'navy')
    return im

def m_mage():
    im = new(); d = ImageDraw.Draw(im)
    P(d, [(23, 2), (13, 16), (34, 16)], 'blue')          # とんがり帽
    R(d, (11, 15, 36, 17), 'blue')
    E(d, (16, 15, 31, 26), 'navy')                       # フードの闇
    R(d, (18, 19, 20, 21), 'lblue'); R(d, (27, 19, 29, 21), 'lblue')  # 光る目
    P(d, [(14, 24), (33, 24), (37, 45), (10, 45)], 'blue')  # ローブ
    dith(im, (10, 30, 37, 45), 'blue', 'navy', 3)
    dith(im, (13, 2, 34, 16), 'blue', 'navy', 1)
    R(d, (12, 44, 35, 45), 'navy')
    P(d, [(14, 26), (8, 34), (13, 35)], 'blue')          # 左袖
    R(d, (8, 33, 12, 36), 'cream')                       # 手
    R(d, (36, 12, 38, 44), 'brown')                      # 杖
    E(d, (33, 6, 41, 14), 'red')                         # 宝珠
    E(d, (35, 8, 38, 11), 'cream')
    R(d, (20, 32, 27, 33), 'cream')                      # 帯
    return im

def m_golem():
    im = new(); d = ImageDraw.Draw(im)
    R(d, (14, 6, 33, 18), 'brown')                       # 頭
    R(d, (10, 17, 37, 36), 'brown')                      # 胴
    R(d, (4, 17, 11, 32), 'brown')                       # 左腕
    R(d, (36, 17, 43, 32), 'brown')
    R(d, (13, 36, 21, 45), 'brown'); R(d, (26, 36, 34, 45), 'brown')  # 脚
    dith(im, (4, 6, 43, 45), 'brown', 'cream', 1)        # 岩肌 (まばら)
    dith(im, (4, 30, 43, 45), 'brown', 'navy', 3)        # 下部の強い陰
    dith(im, (36, 6, 43, 30), 'brown', 'navy', 2)        # 右側面の陰
    R(d, (14, 17, 33, 18), 'navy')                       # 首の切れ目
    L(d, [(10, 22), (17, 25), (15, 33)], 'navy', 2)      # ひび
    L(d, [(29, 20), (32, 28)], 'navy', 2)
    L(d, [(19, 8), (23, 13)], 'navy', 2)
    R(d, (16, 9, 20, 13), 'lblue'); R(d, (27, 9, 31, 13), 'lblue')    # 目
    R(d, (17, 10, 18, 12), 'cream'); R(d, (28, 10, 29, 12), 'cream')
    R(d, (19, 15, 28, 16), 'navy')                       # 口の亀裂
    E(d, (11, 18, 17, 23), 'dgreen'); E(d, (31, 31, 36, 35), 'dgreen')  # 苔
    E(d, (6, 27, 10, 31), 'dgreen'); E(d, (24, 6, 29, 9), 'dgreen')
    R(d, (2, 30, 12, 35), 'brown')                       # 拳
    R(d, (35, 30, 45, 35), 'brown')
    L(d, [(5, 31), (5, 34)], 'navy'); L(d, [(8, 31), (8, 34)], 'navy')  # 指
    L(d, [(39, 31), (39, 34)], 'navy'); L(d, [(42, 31), (42, 34)], 'navy')
    return im

def m_drake():
    im = new(); d = ImageDraw.Draw(im)
    P(d, [(16, 24), (0, 2), (3, 14), (7, 12), (8, 24), (12, 18)], 'dgreen')   # 左翼 (大きく)
    P(d, [(30, 24), (47, 2), (44, 14), (40, 12), (39, 24), (34, 18)], 'dgreen')
    dith(im, (0, 2, 47, 24), 'dgreen', 'navy', 2)
    L(d, [(3, 6), (8, 22)], 'navy'); L(d, [(44, 6), (39, 22)], 'navy')        # 翼の骨
    E(d, (14, 18, 33, 40), 'green')                      # 胴
    E(d, (18, 6, 32, 19), 'green')                       # 頭
    P(d, [(30, 9), (43, 13), (30, 17)], 'green')         # 長い鼻先
    R(d, (40, 13, 41, 14), 'navy')                       # 鼻孔
    P(d, [(20, 8), (17, 0), (24, 5)], 'cream')           # 角
    P(d, [(27, 6), (31, 0), (31, 8)], 'cream')
    dith(im, (14, 28, 33, 42), 'green', 'dgreen', 2)
    R(d, (19, 26, 28, 38), 'cream')                      # 腹
    for i in range(4):
        L(d, [(19, 28 + i * 3), (28, 28 + i * 3)], 'brown')
    for i in range(4):                                    # 背びれ
        P(d, [(14 + 0 * i, 20 + i * 5), (10, 23 + i * 5), (14, 25 + i * 5)], 'red')
    P(d, [(15, 34), (3, 44), (13, 42)], 'green')         # 尾
    P(d, [(4, 41), (0, 47), (8, 45)], 'red')             # 尾の先の矢尻
    R(d, (17, 40, 21, 45), 'green'); R(d, (27, 40, 31, 45), 'green')  # 脚
    R(d, (16, 44, 22, 46), 'dgreen'); R(d, (26, 44, 32, 46), 'dgreen')
    E(d, (24, 9, 29, 14), 'red')                         # 目
    R(d, (26, 10, 27, 12), 'cream')
    R(d, (33, 15, 34, 16), 'cream'); R(d, (36, 15, 37, 16), 'cream')  # 牙
    P(d, [(43, 11), (47, 9), (46, 14), (44, 15)], 'red')              # 火の息
    R(d, (44, 11, 45, 12), 'cream')
    return im

MONSTERS = [
    ('スライム', 'slime', m_slime), ('ゴブリン', 'goblin', m_goblin),
    ('おおこうもり', 'bat', m_bat), ('がいこつ剣士', 'skeleton', m_skeleton),
    ('荒野のオオカミ', 'wolf', m_wolf), ('マタンゴ', 'myconid', m_myconid),
    ('グール', 'ghoul', m_ghoul), ('闇の魔導士', 'mage', m_mage),
    ('ストーンゴーレム', 'golem', m_golem), ('仔ドレイク', 'drake', m_drake),
]

os.makedirs('monsters', exist_ok=True)
imgs = []
for name, key, fn in MONSTERS:
    im = fn()
    outline(im)
    im.save(f'monsters/{key}.png')
    imgs.append((name, im))

# ---- 確認用シート (5x2, 6倍拡大, 紺背景) ----
Z = 6
CW, CH = S * Z + 24, S * Z + 46
sheet = Image.new('RGB', (CW * 5, CH * 2), (10, 12, 26))
dr = ImageDraw.Draw(sheet)
font = ImageFont.truetype('/usr/share/fonts/truetype/fonts-japanese-gothic.ttf', 22)
for i, (name, im) in enumerate(imgs):
    cx, cy = (i % 5) * CW, (i // 5) * CH
    big = im.resize((S * Z, S * Z), Image.NEAREST)
    # 各セルにPC-88风グラデ床
    dr.rectangle([cx + 6, cy + 6, cx + CW - 6, cy + S * Z + 12], outline=(60, 70, 110))
    sheet.paste(big, (cx + 12, cy + 8), big)
    w = dr.textlength(name, font=font)
    dr.text((cx + (CW - w) / 2, cy + S * Z + 16), name, fill=(232, 226, 192), font=font)
sheet.save('monsters_sheet.png')
print('ok', sheet.size)
