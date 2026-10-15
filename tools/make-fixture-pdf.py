# 生成一份真实 PDF，用来验证插件的 PDF 解析链路。
#
# 为什么要真文件：单测里只有"%PDF-1.4"这种假字节，只能证明"缺库时报错正确"，
# 证明不了"真 PDF 的文字能读出来"。
#
# 用 PyMuPDF 生成（本机系统 Python 已装）。内容无关痛痒，不涉及任何真实项目。
# 注意：PyMuPDF 默认字体不含中文，直接写中文会变成方框或丢字，
# 所以这里显式指定中文字体（Windows 自带 msyh/simsun）。
#
# 运行：python tools/make-fixture-pdf.py <输出路径>

import sys

import pymupdf

out = sys.argv[1] if len(sys.argv) > 1 else 'fixture.pdf'

# 找一个能显示中文的字体
CJK_CANDIDATES = [
    r'C:\Windows\Fonts\msyh.ttc',      # 微软雅黑
    r'C:\Windows\Fonts\simsun.ttc',    # 宋体
    r'C:\Windows\Fonts\simhei.ttf',    # 黑体
]
font_file = next((p for p in CJK_CANDIDATES if __import__('os').path.exists(p)), None)
if font_file is None:
    print('找不到中文字体，生成的 PDF 里中文会丢失', file=sys.stderr)
else:
    print(f'使用字体：{font_file}', file=sys.stderr)

doc = pymupdf.open()

# 第 1 页：标题与正文
page = doc.new_page()
if font_file:
    page.insert_font(fontname='cjk', fontfile=font_file)
    page.insert_text((60, 80), '半自动打码贴标线技术任务书', fontname='cjk', fontsize=18)
    page.insert_text((60, 130), '一、项目概述', fontname='cjk', fontsize=13)
    page.insert_text((60, 160), '需要在集运仓内建立一条半自动流水线，用于在商品上标注 Data Matrix 二维码。',
                     fontname='cjk', fontsize=11)
    page.insert_text((60, 185), '单次生产运行仅处理具有相同形状和尺寸的单一品项（SKU）。',
                     fontname='cjk', fontsize=11)
else:
    page.insert_text((60, 80), 'Data Matrix labelling line - technical specification', fontsize=18)

# 第 2 页：分条列项（验证多行文本都能提取）
page2 = doc.new_page()
if font_file:
    page2.insert_font(fontname='cjk', fontfile=font_file)
    page2.insert_text((60, 80), '二、设备构成', fontname='cjk', fontsize=13)
    items = [
        '1. 输送线体：带宽约 500mm，速度可调',
        '2. 打印贴标机头：热转印，不低于 300dpi',
        '3. 视觉检测：2 套工业相机 + 配套光源',
        '4. 剔除机构：气动，不良品自动剔除至不良品箱',
        '5. 控制单元：PLC + 工控机 + 触摸屏',
    ]
    y = 115
    for item in items:
        page2.insert_text((60, y), item, fontname='cjk', fontsize=11)
        y += 28
else:
    page2.insert_text((60, 80), 'Equipment list: conveyor, labeller, cameras, reject unit', fontsize=12)

# 第 3 页：只有图形、没有文字（验证"没有可提取文字"的判断）
page3 = doc.new_page()
shape = page3.new_shape()
shape.draw_rect(pymupdf.Rect(100, 100, 400, 300))
shape.finish(color=(0, 0, 0), fill=(0.9, 0.9, 0.9))
shape.commit()

# 字体子集化：不这么做会把整套中文字体塞进 PDF（实测 19MB！）
# 注意 subset 参数在 insert_font 上不一定有（版本差异），这里用文档级 API。
try:
    doc.subset_fonts()
except Exception as exc:
    print(f'字体子集化失败（文件会偏大，不影响验证）：{exc}', file=sys.stderr)

doc.save(out, garbage=3, deflate=True)
doc.close()
print(f'已生成：{out}')
