"""アプリのアイコン(build/icon.png, build/icon.ico)を作るスクリプト。
カメラ風のアイコン(角丸の四角に、ボディ・ペンタプリズム・レンズ)を描きます。
使い方: python3 tools/make_icon.py
"""
import os
from PIL import Image, ImageDraw

S = 1024
BG1, BG2 = (30, 41, 59), (15, 23, 42)
BODY = (226, 232, 240, 255)
BODY_D = (148, 163, 184, 255)
DARK = (15, 23, 42, 255)
LENS = (37, 99, 235, 255)
LIME = (163, 230, 53, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# 背景: 縦グラデーションの角丸
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    gd.line((0, y, S, y), fill=tuple(int(BG1[i] + (BG2[i] - BG1[i]) * t) for i in range(3)) + (255,))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=230, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# ペンタプリズム(上のでっぱり)とシャッターボタン
d.rounded_rectangle((330, 215, 694, 400), radius=50, fill=BODY_D)
d.rounded_rectangle((722, 232, 842, 300), radius=22, fill=LIME)
# ボディ
d.rounded_rectangle((130, 330, 894, 800), radius=90, fill=BODY)
d.rectangle((130, 440, 894, 520), fill=DARK)          # 革張り風の帯
d.rounded_rectangle((130, 330, 894, 800), radius=90, outline=BODY_D, width=6)
# グリップ側のストライプ
d.rounded_rectangle((175, 560, 255, 760), radius=30, fill=BODY_D)
# レンズ
cx, cy = 512, 585
for r, c in [(215, DARK), (185, BODY_D), (160, DARK), (128, LENS), (78, (20, 50, 130, 255))]:
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=c)
d.ellipse((cx - 70, cy - 95, cx - 10, cy - 45), fill=(255, 255, 255, 190))   # 反射
# ファインダー窓
d.rounded_rectangle((200, 372, 300, 418), radius=14, fill=DARK)

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
os.makedirs(out_dir, exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save(os.path.join(out_dir, "icon.png"))
img.save(os.path.join(out_dir, "icon.ico"), format="ICO",
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("OK")
