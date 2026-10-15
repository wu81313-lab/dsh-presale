#!/usr/bin/env python
# 从 DSH 主题包导出**权威的别名令牌清单** → tools/theme-tokens.json
#
# 为什么不在自检里手写白名单：我最初按 cordis_inspect_query(Theme/listTokens)
# 返回的 14 个令牌建了白名单，但那个列表只是**子集**——客户端自带设置页里实际
# 还用了 border-l3 / border-l4 / bg-layer-3 / label-tertiary / label-dimmed /
# state-warn-label / bg-module-platform（共 79 个）。
# 手写白名单会把真令牌判成非法，自检就从"防护"变成了"阻碍正确改动"。
#
# 所以流程反过来：**从主题包导出清单 → 自检读这份清单**。
# 主题包升级后重跑本脚本即可，不用改自检代码。
#
# 只读（只写 tools/theme-tokens.json）。
# 用法：python tools/sync-theme-tokens.py
import json
import pathlib
import re

THEME = pathlib.Path(
    r"C:\Users\13680\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh"
    r"\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js"
)
OUT = pathlib.Path(__file__).resolve().parent / "theme-tokens.json"


def main() -> int:
    if not THEME.exists():
        print(f"找不到主题包：{THEME}")
        return 1
    text = THEME.read_text(encoding="utf-8", errors="replace")

    names = sorted({f"--dsw-alias-{n}" for n in re.findall(r"--dsw-alias-([a-z0-9-]+)\s*:", text)})
    # 一并导出两套主题的取值，方便人工核对配色
    values: dict[str, dict[str, str]] = {}
    light_start = text.find("body{--dsw-alias-bg-base")
    dark_start = text.find("body[data-ds-dark-theme]{--dsw-alias-bg-base")
    if light_start >= 0 and dark_start >= 0:
        blocks = {
            "light": text[light_start:dark_start],
            "dark": text[dark_start:text.find("}", dark_start)],
        }
        for token in names:
            short = token.removeprefix("--dsw-alias-")
            pair = {}
            for theme, block in blocks.items():
                m = re.search(rf"--dsw-alias-{re.escape(short)}:([^;]+);", block)
                if m:
                    pair[theme] = m.group(1).strip()
            if pair:
                values[token] = pair

    payload = {
        "_comment": "由 tools/sync-theme-tokens.py 从 DSH 主题包导出，请勿手改；主题包升级后重跑该脚本。",
        "_source": "dsh-client-ui-theme/lib/client.js",
        "count": len(names),
        "tokens": names,
        "values": values,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写出 {OUT.name}：{len(names)} 个令牌，{len(values)} 个带两套取值")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
