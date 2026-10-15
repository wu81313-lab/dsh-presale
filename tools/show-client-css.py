#!/usr/bin/env python
# 打印某个 DSH 客户端包里 CSS module 的规则，支持按关键字过滤。
#
# 为什么需要：第三方设置页要和客户端原生外观一致，而原生的字体/间距/圆角/
# 边框都写在这些 CSS module 里。靠肉眼猜会像上一版那样，做出一个"网页"
# 而不是"客户端设置页"。这个脚本把真实规则抓出来当参照。
#
# 只读。
# 用法：
#   python tools/show-client-css.py <包名> [关键字...]
#   python tools/show-client-css.py dsh-client-ui-settings-general content section title
#   python tools/show-client-css.py dsh-client-ui-settings-plugins          # 不过滤，全部打印
import pathlib
import re
import sys

ROOT = pathlib.Path(
    r"C:\Users\13680\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
)

# bundle 里的写法： const css$1 = "......";
CSS_RE = re.compile(r'const\s+(css\$?\d*)\s*=\s*"((?:[^"\\]|\\.){120,})";')


def unescape(js: str) -> str:
    return (
        js.replace("\\n", "\n")
        .replace('\\"', '"')
        .replace("\\'", "'")
        .replace("\\\\", "\\")
    )


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    pkg, *keywords = argv
    path = ROOT / pkg / "lib" / "client.js"
    if not path.exists():
        print(f"找不到：{path}")
        return 1

    text = path.read_text(encoding="utf-8", errors="replace")
    blocks = CSS_RE.findall(text)
    print(f"[{pkg}]  {path.stat().st_size / 1024:.1f} KB，CSS 块 {len(blocks)} 个")
    print("=" * 74)

    for name, raw in blocks:
        css = unescape(raw)
        # 按 } 切规则，便于过滤
        rules = [r.strip() for r in re.split(r"(?<=})", css) if r.strip()]
        picked = [r for r in rules if not keywords or any(k in r for k in keywords)]
        print(f"\n--- {name}：{len(picked)} / {len(rules)} 条规则 ---")
        for rule in picked:
            print(rule[:260])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
