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

# 折叠卡片在收起 / 展开两种状态下的 DOM（与 client.js 的 Card 组件一致）
CARD_COLLAPSED = """
<section class="dsp-card">
  <div class="dsp-card-head dsp-card-head-btn">
    <h3 class="dsp-card-title">几点要知道的</h3>
    <span class="dsp-caret">▾</span>
  </div>
</section>
"""

CARD_EXPANDED = """
<section class="dsp-card">
  <div class="dsp-card-head dsp-card-head-btn">
    <h3 class="dsp-card-title">几点要知道的</h3>
    <span class="dsp-caret dsp-caret-open">▾</span>
  </div>
  <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.9">
    <li>触发条件严格限定为「你自己发的消息」——同事在群里说同样的话不会有任何反应，这是设计如此。</li>
    <li>@ 必须在正文里用 &lt;@openDingtalkId&gt; 占位符，这是钉钉的硬要求，插件已自动处理；若 @ 发送失败，会自动去掉 @ 重发一次，保证文案一定送达。</li>
    <li>插件用轮询而不是事件推送，是因为钉钉会把「你自己发的消息」从事件流里过滤掉，长连接收不到。</li>
    <li>设置文件：C:\\Users\\13680\\.dsh\\presale\\settings.json（面板上所有改动都立即写盘并生效，无需重启）</li>
  </ul>
</section>
"""

# 一张普通卡片，作为对照（确认折叠样式没有污染常驻卡片）
CARD_PLAIN = """
<section class="dsp-card">
  <h3 class="dsp-card-title">活动记录</h3>
  <p class="dsp-card-hint">每轮「发现 → 判定 → 发送/跳过」都记一条。试运行模式下这里是唯一的观察窗口。</p>
  <div class="dsp-row"><span class="dsp-note">暂无记录。若你刚在群里发过关键词，可点上面的「立即检查一次」。</span></div>
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
    <h2>① 收起（默认）</h2>
    <div class="surface"><div class="dsp-root">{CARD_COLLAPSED}</div></div>
  </div>
  <div class="pane">
    <h2>② 展开（点标题后）</h2>
    <div class="surface"><div class="dsp-root">{CARD_EXPANDED}</div></div>
  </div>
  <div class="pane">
    <h2>③ 对照：普通卡片不受影响</h2>
    <div class="surface"><div class="dsp-root">{CARD_PLAIN}</div></div>
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
