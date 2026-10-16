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

# 「运行状态」卡片的两态（与 client.js 的渲染结构一致）。
# 收起：只有标题 + 徽标行 + 右侧箭头；展开：多出规则说明 + 8 项指标 + 身份说明。
STATUS_COLLAPSED = """
<section class="dsp-card">
  <h3 class="dsp-card-title">运行状态</h3>
  <div class="dsp-row">
    <span class="dsp-badge dsp-badge-ok">监听中</span>
    <span class="dsp-badge dsp-badge-ok">身份已锚定：吴瑞铎</span>
    <button type="button" class="dsp-caret" title="展开详情">▾</button>
  </div>
</section>
"""

STATUS_EXPANDED = """
<section class="dsp-card">
  <h3 class="dsp-card-title">运行状态</h3>
  <div class="dsp-row">
    <span class="dsp-badge dsp-badge-ok">监听中</span>
    <span class="dsp-badge dsp-badge-ok">身份已锚定：吴瑞铎</span>
    <button type="button" class="dsp-caret dsp-caret-open" title="收起详情">▾</button>
  </div>
  <p class="dsp-card-hint" style="margin-top:12px">「只认我本人触发」是硬规则：只有你（上面的登录账号）发出的关键词才会被执行，其他人的同类消息会被跳过。</p>
  <div class="dsp-grid">
    <div><div class="dsp-kv-k">上次检查</div><div class="dsp-kv-v">2026/10/15 23:50:13（1 分钟前）</div></div>
    <div><div class="dsp-kv-k">上次命中</div><div class="dsp-kv-v">从未</div></div>
    <div><div class="dsp-kv-k">已完成周期</div><div class="dsp-kv-v">19 次 / 命中 0 次</div></div>
    <div><div class="dsp-kv-k">当前轮询间隔</div><div class="dsp-kv-v">123 秒</div></div>
    <div><div class="dsp-kv-k">连续无命中</div><div class="dsp-kv-v">19 轮（会自动拉长间隔省配额）</div></div>
    <div><div class="dsp-kv-k">消息水位</div><div class="dsp-kv-v">2026/10/15 23:50:12</div></div>
    <div><div class="dsp-kv-k">我的 openDingtalkId</div><div class="dsp-kv-v dsp-mono">D8HS2Vhb…XXdD</div></div>
    <div><div class="dsp-kv-k">LLM 路由</div><div class="dsp-kv-v">deepseek-account / deepseek-flash（default）</div></div>
  </div>
</section>
"""

# 与 client.js 的 Card 组件等价的普通卡片
CARD_SAMPLE = """
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
    <h2>① 运行状态 · 收起（默认）</h2>
    <div class="surface"><div class="dsp-root">{STATUS_COLLAPSED}</div></div>
  </div>
  <div class="pane">
    <h2>② 运行状态 · 展开（点右侧箭头）</h2>
    <div class="surface"><div class="dsp-root">{STATUS_EXPANDED}</div></div>
  </div>
  <div class="pane">
    <h2>③ 对照：普通卡片不受影响</h2>
    <div class="surface"><div class="dsp-root">{CARD_SAMPLE}</div></div>
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
