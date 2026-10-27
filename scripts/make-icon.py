"""生成简牍应用图标：深色圆角底 + 青色「简」字，与 dyzj-dark 的配色一致。

为什么要自己生成：M4 的「桌面感」缺省时 electron-builder 用 Electron 默认图标，
在任务栏和 exe 上都是一眼假的。自用软件不必找设计师，但图标不能没有。

配色取自实测的 dyzj-dark 变量：
  --bg-color:            #262626
  --titlebefore-color:   #00c4b6
"""

from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
BG = (38, 38, 38, 255)        # #262626
ACCENT = (0, 196, 182, 255)   # #00c4b6
TEXT = (255, 255, 255, 255)

SIZE = 1024


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def find_cjk_font(size: int) -> ImageFont.FreeTypeFont:
    """优先用系统里确定存在的雅黑；找不到就退默认字体（宁可丑也别崩）。"""
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def build() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底：Windows 任务栏会把大写图标裁成方块，圆角让它在深色任务栏上不显突兀
    d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.18), fill=BG)

    # 「简」居中：汉字字形的视觉重心比几何中心略高，这里上移 3% 抵消
    font = find_cjk_font(int(SIZE * 0.62))
    bbox = d.textbbox((0, 0), "简", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (SIZE - w) / 2 - bbox[0]
    y = (SIZE - h) / 2 - bbox[1] - SIZE * 0.03
    d.text((x, y), "简", font=font, fill=TEXT)

    # 底部一道青色短线，呼应 dyzj 主题里标题的下划线
    bar_w, bar_h = int(SIZE * 0.30), int(SIZE * 0.035)
    d.rounded_rectangle(
        [(SIZE - bar_w) // 2, int(SIZE * 0.80), (SIZE + bar_w) // 2, int(SIZE * 0.80) + bar_h],
        radius=bar_h // 2,
        fill=ACCENT,
    )

    # 统一用圆角遮罩裁一次，保证四角完全透明（PIL 画圆角会在边缘留半透明灰）
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, (0, 0), rounded_rect_mask(SIZE, int(SIZE * 0.18)))
    return out


def main() -> None:
    icon = build()
    png_path = os.path.join(OUT_DIR, "icon.png")
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    icon.save(png_path, "PNG")
    # 多尺寸 ico：Windows 会从 16px 到 256px 各取所需，只给 256 会在小尺寸显糊
    icon.save(ico_path, "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", png_path, os.path.getsize(png_path))
    print("wrote", ico_path, os.path.getsize(ico_path))


if __name__ == "__main__":
    main()
