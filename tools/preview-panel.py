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

# 「总开关」卡片（与 client.js 渲染结构一致）。
# 关键点：
#   · 卡片说明挂在**标题**上（悬停标题出气泡），没有额外的 ? 圆点；
#   · 「保存开关」与监听状态开关在**标题行右侧**，不再另起一行占高度；
#   · 三个维护动作折在 details 里。
SWITCH_CARD = """
<section class="dsp-card">
  <h3 class="dsp-card-title dsp-card-title-row">
    <span class="dsp-card-title-text"><span class="dsp-tiptrigger" title="建议先用「试运行」把文案和 @ 判定调准，确认无误后再关掉试运行让它真发消息。">总开关</span></span>
    <span class="dsp-card-action">
      <button class="dsp-btn dsp-btn-primary dsp-btn-sm">保存开关</button>
      <label class="dsp-switch on" title="点击停止监听">
        <input type="checkbox" checked>
        <span class="dsp-switch-track">
          <span class="dsp-switch-text">On</span>
          <span class="dsp-switch-thumb"></span>
        </span>
        <span class="dsp-switch-caption">监听中</span>
      </label>
    </span>
  </h3>
  <div class="dsp-row">
    <div class="dsp-label">启用监听</div>
    <label class="dsp-check"><input type="checkbox" checked> 开启</label>
  </div>
  <div class="dsp-row">
    <div class="dsp-label"><span class="dsp-tiptrigger" title="开启时一切照常执行（读消息、判销售、组装文案），但只在活动日志里记录「本该发什么」，不会真的发到群里。">试运行 dryRun</span></div>
    <label class="dsp-check"><input type="checkbox"> 真实发送到群</label>
  </div>
  <details class="dsp-maintain">
    <summary>维护（排查用，平时不需要动）</summary>
    <div class="dsp-actions" style="margin-top:10px">
      <button class="dsp-btn">立即检查一次</button>
      <button class="dsp-btn">把水位重置为现在</button>
      <button class="dsp-btn">重新识别身份</button>
    </div>
  </details>
</section>
"""

# 「已停止」状态：开关变红（state-error-primary），一眼看出功能没在工作。
# 注意：替换串不要带缩进——之前依赖了 6 空格缩进，后来结构一改（变 8 空格）
# 就静默失配，预览里"已停止"那张仍显示绿色，白核对了一轮。
SWITCH_CARD_OFF = (SWITCH_CARD
                   .replace('<label class="dsp-switch on"', '<label class="dsp-switch"')
                   .replace('<input type="checkbox" checked>', '<input type="checkbox">', 1)
                   .replace('<span class="dsp-switch-text">On</span>', '<span class="dsp-switch-text">Off</span>')
                   .replace('<span class="dsp-switch-caption">监听中</span>', '<span class="dsp-switch-caption">已停止</span>'))
assert 'dsp-switch on' not in SWITCH_CARD_OFF, 'SWITCH_CARD_OFF 替换失败：开关仍是 on 态'

# 悬停标题时的样子。
# 气泡是 position:fixed，且**水平居中于触发区**——触发区是整行标题（卡片宽度），
# 所以气泡落在卡片中间，而不是紧贴「总开关」四个字。按同一算法给坐标，
# 保证预览与真实渲染一致。
SWITCH_CARD_HOVER = SWITCH_CARD.replace(
    '<span class="dsp-tiptrigger"',
    '<span class="dsp-tiptrigger" data-open="1"',
).replace(
    '</section>',
    '<div class="dsp-tip" role="tooltip" style="left:382px;top:148px">'
    '建议先用「试运行」把文案和 @ 判定调准，确认无误后再关掉试运行让它真发消息。</div></section>',
    1,
)

# 「@ 销售人员」分两层：常用开关常显，判定策略折在 details 里。
MENTION_SAMPLE = """
<div class="dsp-card">
  <div class="dsp-subhead" style="margin-top:0;padding-top:0;border-top:0">@ 销售人员</div>
  <div class="dsp-row">
    <div class="dsp-label">启用 @</div>
    <label class="dsp-check"><input type="checkbox" checked> 开启</label>
  </div>
  <details class="dsp-maintain">
    <summary>@ 判定策略（当前：置信度 high）</summary>
    <div style="margin-top:4px">
      <div class="dsp-row"><div class="dsp-label">最低置信度</div>
        <select class="dsp-select"><option>high（最保守，推荐）</option></select></div>
      <div class="dsp-row"><div class="dsp-label">中等置信度降级为文本提及</div>
        <label class="dsp-check"><input type="checkbox"> 关闭：干脆不 @</label></div>
      <div class="dsp-row"><div class="dsp-label">判不出时 @ 你自己</div>
        <label class="dsp-check"><input type="checkbox"> 关闭（推荐）</label></div>
    </div>
  </details>
</div>
"""

# 「高级设置」折叠组（与 client.js 的 Group 组件一致）。
GROUP_SAMPLE = """
<details class="dsp-group">
  <summary>
    <span class="dsp-group-label">高级设置</span>
    <span class="dsp-group-sum">deepseek-flash · 轮询 30s · 读附件 · 日志 12 条</span>
  </summary>
  <div class="dsp-group-body">
    <section class="dsp-card">
      <h3 class="dsp-card-title">轮询与性能</h3>
      <div class="dsp-row"><div class="dsp-label">轮询间隔（秒）</div><input class="dsp-input" value="30"></div>
    </section>
    <section class="dsp-card">
      <h3 class="dsp-card-title">模型</h3>
      <div class="dsp-row"><div class="dsp-label">provider</div><input class="dsp-input" value="deepseek-account"></div>
      <div class="dsp-row"><div class="dsp-label">model</div><input class="dsp-input" value="deepseek-flash"></div>
    </section>
  </div>
</details>
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
    <h2>① 总开关（监听中：开关为绿）</h2>
    <div class="surface"><div class="dsp-root">{SWITCH_CARD}</div></div>
  </div>
  <div class="pane">
    <h2>② 总开关（已停止：开关为红）</h2>
    <div class="surface"><div class="dsp-root">{SWITCH_CARD_OFF}</div></div>
  </div>
  <div class="pane">
    <h2>③ 运行状态 · 收起（默认）</h2>
    <div class="surface"><div class="dsp-root">{STATUS_COLLAPSED}</div></div>
  </div>
  <div class="pane">
    <h2>④ 高级设置 · 折叠组（默认收起）</h2>
    <div class="surface"><div class="dsp-root">{GROUP_SAMPLE}</div></div>
  </div>
  <div class="pane">
    <h2>⑤ @ 销售人员 · 只留「启用 @」，判定策略折起来</h2>
    <div class="surface"><div class="dsp-root">{MENTION_SAMPLE}</div></div>
  </div>
  <div class="pane">
    <h2>⑥ 运行状态 · 展开（点右侧箭头）</h2>
    <div class="surface"><div class="dsp-root">{STATUS_EXPANDED}</div></div>
  </div>
</body></html>
"""

    # --tip：只渲染「悬停气泡」那一块。
    # 为什么需要单独一个模式：气泡是 position:fixed，整页截图时它会落到
    # 别的区块上，看不出真实效果。单独一屏最清楚。
    if "--tip" in sys.argv:
        tip_html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>悬停提示预览</title>
<style>{token_fallback}{css}
.pane .surface {{ padding: 16px; }}
</style></head>
<body>
  <div class="pane">
    <h2>总开关 · 悬停标题时的气泡（无 ? 圆点，触发区就是标题整行）</h2>
    <div class="surface"><div class="dsp-root">{SWITCH_CARD_HOVER}</div></div>
  </div>
</body></html>
"""
        OUT_HTML.write_text(tip_html, encoding="utf-8")
        if OUT_PNG.exists():
            OUT_PNG.unlink()
        uri = "file:///" + str(OUT_HTML).replace("\\", "/").replace(" ", "%20")
        subprocess.run(
            [browser, "--headless", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=2", "--window-size=760,480",
             f"--screenshot={OUT_PNG}", uri],
            capture_output=True, text=True,
        )
        if OUT_PNG.exists():
            print(f"已生成 {OUT_PNG}  （{OUT_PNG.stat().st_size / 1024:.1f} KB）（仅气泡）")
            return 0
        print("截图失败")
        return 1

    # --group：只渲染「高级设置折叠组」那一块（收起 / 展开两态）。
    # 整页截图是固定视口的，第 4 块以后落在视口下方拍不到，所以单独出一屏。
    if "--group" in sys.argv:
        open_group = GROUP_SAMPLE.replace('<details class="dsp-group">',
                                          '<details class="dsp-group" open>', 1)
        grp_html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>高级设置折叠组</title>
<style>{token_fallback}{css}
.pane .surface {{ padding: 16px; }}
.dsp-root {{ gap: 16px; }}
</style></head>
<body>
  <div class="pane">
    <h2>① 收起（默认）—— 主屏只留日常要动的卡</h2>
    <div class="surface"><div class="dsp-root">{GROUP_SAMPLE}</div></div>
  </div>
  <div class="pane">
    <h2>② 展开后 —— 组内卡片去掉了各自的框，只靠分隔线区分</h2>
    <div class="surface"><div class="dsp-root">{open_group}</div></div>
  </div>
</body></html>
"""
        OUT_HTML.write_text(grp_html, encoding="utf-8")
        if OUT_PNG.exists():
            OUT_PNG.unlink()
        uri = "file:///" + str(OUT_HTML).replace("\\", "/").replace(" ", "%20")
        subprocess.run(
            [browser, "--headless", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=2", "--window-size=800,760",
             f"--screenshot={OUT_PNG}", uri],
            capture_output=True, text=True,
        )
        if OUT_PNG.exists():
            print(f"已生成 {OUT_PNG}  （{OUT_PNG.stat().st_size / 1024:.1f} KB）（仅折叠组）")
            return 0
        print("截图失败")
        return 1

    # --switch：只渲染「总开关」那一块（监听中 / 已停止两态）。
    if "--switch" in sys.argv:
        sw_html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>总开关</title>
<style>{token_fallback}{css}
.pane .surface {{ padding: 16px; }}
.dsp-root {{ gap: 16px; }}
</style></head>
<body>
  <div class="pane">
    <h2>① 监听中 —— 保存与开关在标题行右侧，不再另起一行</h2>
    <div class="surface"><div class="dsp-root">{SWITCH_CARD}</div></div>
  </div>
  <div class="pane">
    <h2>② 已停止 —— 开关转红</h2>
    <div class="surface"><div class="dsp-root">{SWITCH_CARD_OFF}</div></div>
  </div>
</body></html>
"""
        OUT_HTML.write_text(sw_html, encoding="utf-8")
        if OUT_PNG.exists():
            OUT_PNG.unlink()
        uri = "file:///" + str(OUT_HTML).replace("\\", "/").replace(" ", "%20")
        subprocess.run(
            [browser, "--headless", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=2", "--window-size=800,620",
             f"--screenshot={OUT_PNG}", uri],
            capture_output=True, text=True,
        )
        if OUT_PNG.exists():
            print(f"已生成 {OUT_PNG}  （{OUT_PNG.stat().st_size / 1024:.1f} KB）（仅总开关）")
            return 0
        print("截图失败")
        return 1

    # --mention：只渲染「@ 销售人员」那一块（收起 / 展开两态）。
    if "--mention" in sys.argv:
        open_mention = MENTION_SAMPLE.replace('<details class="dsp-maintain">',
                                              '<details class="dsp-maintain" open>', 1)
        men_html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>@ 销售人员</title>
<style>{token_fallback}{css}
.pane .surface {{ padding: 16px; }}
.dsp-root {{ gap: 16px; }}
</style></head>
<body>
  <div class="pane">
    <h2>① 收起（默认）—— 只留「启用 @」</h2>
    <div class="surface"><div class="dsp-root">{MENTION_SAMPLE}</div></div>
  </div>
  <div class="pane">
    <h2>② 展开后 —— 判定策略四项</h2>
    <div class="surface"><div class="dsp-root">{open_mention}</div></div>
  </div>
</body></html>
"""
        OUT_HTML.write_text(men_html, encoding="utf-8")
        if OUT_PNG.exists():
            OUT_PNG.unlink()
        uri = "file:///" + str(OUT_HTML).replace("\\", "/").replace(" ", "%20")
        subprocess.run(
            [browser, "--headless", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=2", "--window-size=800,620",
             f"--screenshot={OUT_PNG}", uri],
            capture_output=True, text=True,
        )
        if OUT_PNG.exists():
            print(f"已生成 {OUT_PNG}  （{OUT_PNG.stat().st_size / 1024:.1f} KB）（仅 @ 销售人员）")
            return 0
        print("截图失败")
        return 1

    OUT_HTML.write_text(html, encoding="utf-8")
    if OUT_PNG.exists():
        OUT_PNG.unlink()

    # --only N：只渲染第 N 块（1 起）——同样为了避开 fixed 气泡的干扰。
    only = None
    if "--only" in sys.argv:
        only = int(sys.argv[sys.argv.index("--only") + 1])
        # 把其余 pane 藏起来（保留为不可见，避免影响布局计算）
        parts = html.split('<div class="pane">')
        head, panes = parts[0], parts[1:]
        for i in range(len(panes)):
            if i + 1 != only:
                panes[i] = panes[i].replace(
                    '<div class="pane">', '<div class="pane" style="display:none">', 1)
        html = head + '<div class="pane">'.join(panes)
        OUT_HTML.write_text(html, encoding="utf-8")

    uri = "file:///" + str(OUT_HTML).replace("\\", "/").replace(" ", "%20")
    proc = subprocess.run(
        [browser, "--headless", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=2", "--window-size=780,600",
         f"--screenshot={OUT_PNG}", uri],
        capture_output=True, text=True,
    )
    if not OUT_PNG.exists():
        print("截图失败：", proc.stderr[:400])
        return 1
    label = f"（仅第 {only} 块）" if only else ""
    print(f"已生成 {OUT_PNG}  （{OUT_PNG.stat().st_size / 1024:.1f} KB）{label}")
    print(f"HTML 源：{OUT_HTML}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
