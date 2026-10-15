#!/usr/bin/env python
# 提取 DSH 内置设置页的原生 CSS 与结构，用来对齐第三方设置页的视觉。
#
# 为什么需要：dsh-presale 是「设置 → 售前助手」这一页，它必须长得像客户端
# 自带的设置页（常规 / 模型 / 插件…），而不是一张自创的网页。
# 这个脚本把内置页的 CSS module 原文抓出来，作为设计参照。
#
# 只读。用法：python tools/inspect-native-settings-ui.py [包名]
import pathlib
import re
import sys

ROOT = pathlib.Path(
    r"C:\Users\13680\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
)

DEFAULT_PKGS = [
    "dsh-client-ui-settings-general",
    "dsh-client-ui-settings-models",
    "dsh-client-ui-settings-plugins",
]

# CSS module 在 bundle 里形如： const css$1 = "....";
CSS_RE = re.compile(r'const\s+(css\$?\d*)\s*=\s*"((?:[^"\\]|\\.){200,})";')


def unescape(js: str) -> str:
    return (
        js.replace("\\n", "\n")
        .replace('\\"', '"')
        .replace("\\\\", "\\")
        .replace("\\t", "\t")
    )


def main() -> int:
    pkgs = sys.argv[1:] or DEFAULT_PKGS
    for pkg in pkgs:
        path = ROOT / pkg / "lib" / "client.js"
        if not path.exists():
            print(f"[{pkg}] 不存在")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        blocks = CSS_RE.findall(text)
        print("=" * 72)
        print(f"[{pkg}]  {path.stat().st_size / 1024:.1f} KB，CSS 块 {len(blocks)} 个")
        print("=" * 72)
        for name, raw in blocks:
            css = unescape(raw)
            # 只关心"版式骨架"相关的规则，跳过细枝末节
            print(f"\n--- {name}（{len(css)} 字符）---")
            print(css[:2000])
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
