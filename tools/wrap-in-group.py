#!/usr/bin/env python
# 把 client.js 里一段连续的卡片包进 <Group>（折叠组）。
#
# 为什么用脚本：这段有 269 行，包一层意味着整体缩进 +2 且要在首尾插壳，
# 手工做极易漏括号（今天就因为漏括号白屏过一次）。
# 脚本会先校验被包区间的括号净值，非 0 就拒绝执行。
#
# 用法：python tools/wrap-in-group.py <文件> <起行> <止行> <缩进格数>
import pathlib
import sys

GROUP_OPEN = """        h(Group, {
          label: '高级设置',
          summary: groupSummary(),
        },
"""
GROUP_CLOSE = """        ),
"""


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("用法：python tools/wrap-in-group.py <文件> <起行> <止行> <缩进格数>")
        return 2
    path = pathlib.Path(argv[0])
    start, end, pad = int(argv[1]), int(argv[2]), int(argv[3])

    lines = path.read_text(encoding="utf-8").split("\n")
    body = lines[start - 1:end]

    # 括号净值校验：忽略整行注释
    net = sum(l.count("(") - l.count(")") for l in body
              if not l.strip().startswith("//"))
    print(f"待包装第 {start}–{end} 行（{len(body)} 行），括号净值 {net}")
    if net != 0:
        print("拒绝执行：区间括号不平衡，需人工确认边界。")
        return 1

    # 整体缩进（空行不动，避免留下尾随空格）
    indented = [(" " * pad + l) if l.strip() else l for l in body]

    wrapped = GROUP_OPEN.split("\n")[:-1] + indented + GROUP_CLOSE.split("\n")[:-1]
    out = lines[:start - 1] + wrapped + lines[end:]

    # 新文件整体括号仍须平衡
    total = sum(l.count("(") - l.count(")") for l in out
                if not l.strip().startswith("//")
                and not l.strip().startswith("*")
                and "`" not in l)
    print(f"写回后文件 {len(out)} 行（原 {len(lines)}），整体括号参考值 {total}")
    path.write_text("\n".join(out), encoding="utf-8")
    print("已写入。请随后跑 node --check 与 find-unbalanced.py 复核。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
