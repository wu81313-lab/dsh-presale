#!/usr/bin/env python
# 用面板**真实的 CSS 与 DOM 结构**渲染一张预览图，确认折叠卡片的视觉效果。
#
# 为什么要这么做：这几天反复出现"我改了但没看过实际效果"的问题
# （盲改 → 用户看到才发现不对）。这个脚本把 client.js 里的 CSS 原样抽出来，
# 配上与 React 渲染结果等价的 HTML，用 Chrome 无头模式截图。
# 看到的就是面板真实的样子，不是另画一张设计稿。
#
# 依赖：Chrome 或 Edge（自动探测）、插件里的 client.js。
# 用法：python tools/preview-panel.py
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLIENT = ROOT / "client" / "client.js"
OUT_HTML = ROOT / "tools" / ".preview-panel.html"
OUT_PNG = ROOT / "tools" / "preview-panel.png"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

# 与 client.js 的 Card 组件等价的普通卡片（卡片现在是常驻展开的，没有折叠态）。
# 用「活动记录」当样本：它同时包含标题、说明、正文块，最能反映卡片排版。
CARD_SAMPLE = """
<section class="dsp-card">
  <h3 class="dsp-card-title">活动记录</h3>
  <p class="dsp-card-hint">每轮「发现 → 判定 → 发送/跳过」都记一条。试运行模式下这里是唯一的观察窗口。</p>
  <div class="dsp-row"><span class="dsp-note">暂无记录。若你刚在群里发过关键词，可点上面的「立即检查一次」。</span></div>
</section>
"""

# 带表单字段的卡片：确认输入框高度、字段间距、提示文字排版
CARD_FORM = """
<section class="dsp-card">
  <h3 class="dsp-card-title">动作二设置</h3>
  <p class="dsp-card-hint">提示词可自定义：改这里就能调整总结的口径、结构与详略。</p>
  <div class="dsp-row">
    <div class="dsp-label">触发关键词</div>
    <input class="dsp-input" value="梳理项目需求">
  </div>
  <div class="dsp-row">
    <div class="dsp-label">读取消息条数</div>
    <input class="dsp-input" value="200">
  </div>
  <div class="dsp-row">
    <div class="dsp-label">总结提示词</div>
    <textarea class="dsp-textarea">你是{company}的售前技术支持…</textarea>
    <div class="dsp-card-hint" style="flex:1 1 100%;margin:2px 0 0 0">改这里就能调整总结的口径。</div>
  </div>
</section>
"""


def extract_css() -> str:
    text = CLIENT.read_text(encoding="utf-8")
    start = text.index("const CSS = `") + len("const CSS = `")
    end = text.index("`;", start)
    return text[start:end]


def find_browser() -> str | None:
    for path in CHROME_CANDIDATES:
        if pathlib.Path(path).exists():
            return path
    return None


def main() -> int:
    css = extract_css()
    browser = find_browser()
    if browser is None:
        print("找不到 Chrome / Edge，无法截图")
        return 1

    # 令牌兜底值：真实运行时由 DSH 主题提供，这里给浅色主题的实际取值
    token_fallback = """
:root {
  --dsw-alias-border: #00000029;
  --dsw-alias-border-l1: #0000000a;
  --dsw-alias-border-l2: #0000001a;
  --dsw-alias-bg-layer: #ffffff;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f9fafb;
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-brand-primary: #0f1115;
  --dsw-alias-label-primary: #0f1115;
  --dsw-alias-label-secondary: #61666b;
  --dsw-alias-label-tertiary: #81858c;
  --dsw-alias-text-1: #0f1115;
  --dsw-alias-text-2: #61666b;
  --dsw-alias-text-3: #81858c;
}
body { margin: 0; padding: 24px; background: #f1f3f5; }
.pane { max-width: 720px; margin: 0 auto 26px; }
.pane > h2 { font: 600 13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  color: #61666b; margin: 0 0 10px; letter-spacing: .04em; }
.surface { background: #fff; border-radius: 12px; padding: 0; }
"""

    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>面板预览 · 折叠卡片</title>
<style>{token_fallback}{css}
/* 预览专用：把卡片放进白色容器里，模拟设置对话框的内容区 */
.pane .surface {{ padding: 16px; }}
.dsp-root {{ gap: 16px; }}
</style></head>
<body>
  <div class="pane">
    <h2>① 普通卡片（标题 + 说明 + 正文块）</h2>
    <div class="surface"><div class="dsp-root">{CARD_SAMPLE}</div></div>
  </div>
  <div class="pane">
    <h2>② 带表单字段的卡片（确认输入框高度与字段间距）</h2>
    <div class="surface"><div class="dsp-root">{CARD_FORM}</div></div>
  </div>
</body></html>
"""

    OUT_HTML.write_text(html, encoding="utf-8")
    if OUT_PNG.exists():
        OUT_PNG.unlink()

    uri = "file:///" + str(OUT_HTML).replace("\\", "/").replace(" ", "%20")
    proc = subprocess.run(
        [browser, "--headless", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=2", "--window-size=780,760",
         f"--screenshot={OUT_PNG}", uri],
        capture_output=True, text=True,
    )
    if not OUT_PNG.exists():
        print("截图失败：", proc.stderr[:400])
        return 1
    print(f"已生成 {OUT_PNG}  （{OUT_PNG.stat().st_size / 1024:.1f} KB）")
    print(f"HTML 源：{OUT_HTML}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
