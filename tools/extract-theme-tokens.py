#!/usr/bin/env python
# 从 DSH 主题包导出**浅色 / 深色两套**别名令牌的真实色值，
# 以及**权威的令牌名清单**（供 selftest 做"名字是否真实存在"的校验）。
#
# 为什么需要：设置页要和客户端原生外观一致，而原生组件用的是
# `--dsw-alias-*` 这一层别名令牌。要画效果图（或核对配色）就必须拿到
# 这些令牌在两个主题下的实际取值 —— 靠猜会像早前那样配出蓝色主色。
#
# 为什么清单要导出而不是手写：我最初按 cordis_inspect_query(Theme/listTokens)
# 返回的 14 个令牌建了白名单，但那个列表只是**子集**——客户端自带设置页里实际
# 还用了 border-l3 / border-l4 / bg-layer-3 / label-tertiary / label-dimmed /
# state-warn-label / bg-module-platform。手写白名单会把真令牌误判成非法，
# 自检就从"防护"变成了"阻碍正确改动"。所以清单必须导出，不能维护。
#
# 只读。用法：
#   python tools/extract-theme-tokens.py                 # 两套主题的色值
#   python tools/extract-theme-tokens.py --list-tokens    # 全部合法令牌名
import pathlib
import re
import sys

THEME = pathlib.Path(
    r"C:\Users\13680\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh"
    r"\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js"
)

# 关注这些别名令牌（原生设置页组件里出现过的）
WANTED = [
    "bg-base", "bg-layer-1", "bg-layer-2", "bg-layer-3", "bg-layer-4",
    "bg-module-platform", "bg-overlay", "bg-mask-1",
    "border-l1", "border-l2", "border-l3", "border-l4",
    "brand-primary", "brand-text",
    "label-primary", "label-primary-foreground", "label-secondary",
    "label-tertiary", "label-dimmed", "label-error",
    "state-success-primary", "state-warn-primary", "state-error-primary",
    "state-warn-label", "state-idle-primary",
    "interactive-bg-hover", "interactive-bg-active",
    "button-primary-fill",
    "specific-sidebar-fill", "specific-sidebar-nav-item-active",
]


def main(argv: list[str]) -> int:
    """argv[0] 为 --list-tokens 时只导令牌名清单。"""
    text = THEME.read_text(encoding="utf-8", errors="replace")

    # --list-tokens：导出全部合法令牌名（供 selftest 校验用）
    if argv and argv[0] == "--list-tokens":
        names = sorted(set(re.findall(r"--dsw-alias-([a-z0-9-]+)\s*:", text)))
        print(f"# DSH 主题包中定义的别名令牌，共 {len(names)} 个")
        print("# 来源：dsh-client-ui-theme/lib/client.js")
        for n in names:
            print(f"--dsw-alias-{n}")
        return 0

    # 静态色板：--dsw-static-<name>-<step>:#hex
    static = {}
    for name, step, value in re.findall(
        r"--dsw-static-([a-z]+(?:-[a-z]+)*)-(\d+):(#[0-9a-fA-F]{3,8})", text
    ):
        static[f"{name}-{step}"] = value

    # 两套别名块：body{...} 是浅色，body[data-ds-dark-theme]{...} 是深色
    light_start = text.find("body{--dsw-alias-bg-base")
    dark_start = text.find("body[data-ds-dark-theme]{--dsw-alias-bg-base")
    if light_start < 0 or dark_start < 0:
        print("找不到主题块，检查 bundle 结构")
        return 1
    light_block = text[light_start:dark_start]
    dark_end = text.find("}", dark_start)
    dark_block = text[dark_start:dark_end]

    def resolve(block: str, token: str) -> str:
        m = re.search(rf"--dsw-alias-{re.escape(token)}:([^;]+);", block)
        if not m:
            return "（无）"
        value = m.group(1).strip()
        # 把 var(--dsw-static-x-y) 展开成十六进制
        ref = re.fullmatch(r"var\(--dsw-static-([a-z0-9-]+)\)", value)
        if ref and ref.group(1) in static:
            return f"{static[ref.group(1)]}   ← {value}"
        return value

    print(f"{'令牌':<28} {'浅色':<34} 深色")
    print("-" * 96)
    for token in WANTED:
        print(f"{'--dsw-alias-' + token:<28} {resolve(light_block, token):<34} {resolve(dark_block, token)}")

    print()
    print("静态色板（部分）：")
    for key in [
        "neutral-bluish-00", "neutral-bluish-50", "neutral-bluish-60", "neutral-bluish-75",
        "neutral-bluish-100", "neutral-bluish-150", "neutral-bluish-200", "neutral-bluish-300",
        "neutral-bluish-400", "neutral-bluish-500", "neutral-bluish-600", "neutral-bluish-700",
        "neutral-bluish-800", "neutral-bluish-850", "neutral-bluish-875", "neutral-bluish-900",
        "neutral-bluish-950", "neutral-bluish-1000",
        "green-500", "amber-500", "red-600",
    ]:
        print(f"  {key:<24} {static.get(key, '（无）')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
