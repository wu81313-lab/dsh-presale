#!/usr/bin/env python
"""渲染「售前助手」图标：候选对比 + 放进侧边栏的实拍对照。

规格与 DSH 内置图标一致（照 dsh-local-kb 实测参数）：
  viewBox 0 0 24 24 / fill none / stroke currentColor / stroke-width 1.6 / 圆头圆角

每个候选按两个尺寸渲染：56px（看细节）和 16px（真实尺寸）。
16px 那一栏才是关键——侧边栏里就是这个大小。

用法：python tools/preview-icon.py
产物：tools/preview-icon.png
"""
import pathlib
import subprocess
import sys

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
OUT = pathlib.Path(__file__).resolve().parent / "preview-icon.png"

# 最终选用的是 E。其余保留在对比图里，方便以后想换时直接挑。
CHOSEN = "E"

CANDIDATES = [
    (
        "E",
        "对话气泡 + 勾",
        "气泡=钉钉群里的聊天，勾=已整理完的需求。单个勾在 16px 下转折明显、不糊。",
        [
            "M20.5 13.4a2 2 0 0 1-2 2H11l-4.5 3.2v-3.2H5.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v6Z",
            "M8.6 9.6l2 2 4-4",
        ],
    ),
    (
        "A",
        "对话气泡 + 两行文本",
        "同一思路，但两行细线在 16px 下间距只有一个多像素，会糊成一条灰杠。",
        [
            "M20.5 13.4a2 2 0 0 1-2 2H11l-4.5 3.2v-3.2H5.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v6Z",
            "M7.4 9.1h9.2",
            "M7.4 12.4h5.6",
        ],
    ),
    (
        "B",
        "清单卡 + 勾",
        "直接画「需求清单」这个产出物。含义最直白，但看不出「从群聊来」。",
        [
            "M6.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V6a1.5 1.5 0 0 1 1.5-1.5Z",
            "M8.5 9.2l1.6 1.6 2.6-2.6",
            "M8.5 15h7",
        ],
    ),
    (
        "C",
        "漏斗：从杂乱里提炼",
        "表达「把一屏聊天浓缩成要点」。语义准，但容易被读成「筛选/过滤」。",
        ["M4.2 5.6h15.6l-6 7.4v5.4l-3.6 2v-7.4l-6-7.4Z"],
    ),
    (
        "D",
        "对话气泡 + 星光（AI）",
        "在 A 的基础上加一颗小星强调「模型生成」。元素多一个，16px 下星糊成一团。",
        [
            "M19.5 13.4a2 2 0 0 1-2 2H11l-4 2.9v-2.9H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h12.5a2 2 0 0 1 2 2v6Z",
            "M6.8 9h7.4",
            "M6.8 12.2h4.4",
            "M17.6 4.2l.85 1.95 1.95.85-1.95.85-.85 1.95-.85-1.95-1.95-.85 1.95-.85Z",
        ],
    ),
]

# 侧边栏里实际相邻的三个图标（近似画法，只为看视觉是否协调）
NEIGHBOURS = [
    ("插件", [
        "M9.2 4.5h5.6v2.1a1.6 1.6 0 1 0 3.2 0V4.5h1.5a1.4 1.4 0 0 1 1.4 1.4v4.3h-1.9"
        "a1.6 1.6 0 1 0 0 3.2h1.9v4.3a1.4 1.4 0 0 1-1.4 1.4h-4.4v-1.9a1.6 1.6 0 1 0-3.2 0"
        "v1.9H6.6a1.4 1.4 0 0 1-1.4-1.4v-4.4h2a1.6 1.6 0 1 0 0-3.2h-2V5.9a1.4 1.4 0 0 1 1.4-1.4h2.6Z",
    ]),
    ("Skill/MCP", [
        "M6.7 4.5h6.1l4.5 4.5v10a1 1 0 0 1-1 1H6.7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z",
        "M12.8 4.5V9h4.5",
    ]),
    ("自动化任务", [
        "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z",
        "M12 7.5V12l3 1.8",
    ]),
]


def svg(paths, size):
    body = "".join(f'<path d="{d}"/>' for d in paths)
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
        f'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" '
        f'stroke-linejoin="round">{body}</svg>'
    )


def candidate_rows():
    out = []
    for name, title, why, paths in CANDIDATES:
        chosen = name == CHOSEN
        badge = '<span class="badge">已选用</span>' if chosen else ''
        out.append(
            '<div class="row' + (' chosen' if chosen else '') + '">'
            f'<div class="big">{svg(paths, 56)}</div>'
            '<div class="meta">'
            f'<div class="name">{name} · {title}{badge}</div>'
            f'<div class="why">{why}</div>'
            '</div>'
            '<div class="px16">'
            '<div class="label">16px 真实尺寸</div>'
            f'<div class="strip">{svg(paths, 16)}<span class="entry">售前助手</span></div>'
            f'<div class="strip dim">{svg(paths, 16)}<span class="entry">售前助手</span></div>'
            '</div></div>'
        )
    return "".join(out)


def context_html():
    chosen_paths = next(p for n, _, _, p in CANDIDATES if n == CHOSEN)

    def rows():
        parts = [f'<div class="ctxrow">{svg(p, 16)}<span>{label}</span></div>'
                 for label, p in NEIGHBOURS]
        parts.append(f'<div class="ctxrow highlight">{svg(chosen_paths, 16)}<span>售前助手</span></div>')
        return "".join(parts)

    return (
        '<h2>放进侧边栏之后（16px，与相邻图标同排）</h2>'
        '<div class="ctxs">'
        f'<div class="ctx light"><div class="ctxhline">浅色主题</div>{rows()}</div>'
        f'<div class="ctx dark"><div class="ctxhline">深色主题</div>{rows()}</div>'
        '</div>'
    )


HTML = """<!doctype html><meta charset="utf-8"><style>
  body {{ margin:0; padding:28px 32px; background:#fff; color:#111; width:860px;
         font-family:"Microsoft YaHei",system-ui,sans-serif; }}
  h1 {{ font-size:17px; margin:0 0 4px; }}
  h2 {{ font-size:14px; margin:26px 0 12px; padding-top:18px; border-top:1px solid #eee; }}
  .sub {{ font-size:12px; color:#888; margin-bottom:22px; }}
  .row {{ display:flex; align-items:center; gap:22px; padding:16px 0; border-top:1px solid #eee; }}
  .row.chosen {{ background:#f7fbf8; }}
  .big {{ flex:none; width:72px; display:flex; justify-content:center; color:#222; }}
  .meta {{ flex:1; }}
  .name {{ font-size:14px; font-weight:600; margin-bottom:4px; }}
  .badge {{ font-size:11px; font-weight:500; color:#1a7f37; background:#e7f5ec;
           border-radius:99px; padding:1px 7px; margin-left:6px; }}
  .why {{ font-size:12px; color:#666; line-height:1.6; }}
  .px16 {{ flex:none; width:190px; }}
  .label {{ font-size:11px; color:#999; margin-bottom:6px; }}
  .strip {{ display:flex; align-items:center; gap:8px; padding:6px 8px;
           border-radius:6px; width:fit-content; }}
  .strip.dim {{ background:#f4f4f5; }}
  .entry {{ font-size:13px; }}
  .ctxs {{ display:flex; gap:16px; }}
  .ctx {{ border-radius:10px; padding:12px 14px; width:250px; box-sizing:border-box; }}
  .ctx.light {{ background:#fff; border:1px solid #e8e8ea; color:#1a1a1a; }}
  .ctx.dark {{ background:#1c1c1e; border:1px solid #2c2c2e; color:#e8e8ea; }}
  .ctxhline {{ font-size:11px; opacity:.5; margin-bottom:8px; }}
  .ctxrow {{ display:flex; align-items:center; gap:9px; padding:5px 7px;
            border-radius:6px; font-size:13px; }}
  .ctxrow.highlight {{ background:rgba(128,128,128,.14); }}
</style>
<h1>售前助手 · 图标</h1>
<div class="sub">24×24 / 描边 1.6 / 圆头圆角，与 DSH 内置图标同一套参数</div>
{rows}
{ctx}
"""


def main():
    # HTML 里为了排版写成 {{ }} 的 CSS 花括号要先还原，否则整份样式表都是
    # 不合法的 `{{ ... }}`，浏览器直接忽略——渲染出来会是一坨没有样式的裸文本。
    html = HTML.replace("{rows}", candidate_rows()).replace("{ctx}", context_html())
    html = html.replace("{{", "{").replace("}}", "}")
    html_path = OUT.with_suffix(".html")
    html_path.write_text(html, encoding="utf-8")

    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=2", "--window-size=920,1180",
        f"--screenshot={OUT}", str(html_path),
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=120)
    if not OUT.exists():
        print("✖ 渲染失败")
        print(result.stderr.decode("utf-8", "replace")[:800])
        return 1
    print(f"已生成 {OUT}（{OUT.stat().st_size / 1024:.1f} KB）")
    html_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
