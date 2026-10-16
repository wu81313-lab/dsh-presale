#!/usr/bin/env python
# 删除 client.js 里指定行区间（用于搬走已并入别处的大段代码）。
#
# 为什么用脚本而不是手改：这段有 67 行，手工复制粘贴容易漏掉一层括号
# （今天就因为 details→Card 转换漏括号，来回改了四次）。
# 脚本按行号切片，并**先检查切口两端的括号平衡**，平衡才写回。
#
# 用法：python tools/cut-lines.py <文件> <起行> <止行>
import pathlib
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("用法：python tools/cut-lines.py <文件> <起行> <止行>")
        return 2
    path = pathlib.Path(argv[0])
    start, end = int(argv[1]), int(argv[2])

    lines = path.read_text(encoding="utf-8").split("\n")
    before, cut, after = lines[:start - 1], lines[start - 1:end], lines[end:]

    print(f"文件：{path.name}  共 {len(lines)} 行")
    print(f"将删除第 {start}–{end} 行（{len(cut)} 行）：")
    for i, l in enumerate(cut[:3], start):
        print(f"  {i:>5}  {l.strip()[:90]}")
    print("   …")
    for i, l in enumerate(cut[-2:], end - 1):
        print(f"  {i:>5}  {l.strip()[:90]}")

    def balance(block: list[str]) -> int:
        return sum(l.count("(") - l.count(")") for l in block
                   if not l.strip().startswith("//"))

    b = balance(cut)
    print(f"\n被删区间的括号净值：{b}（应为 0，否则会切坏结构）")
    if b != 0:
        print("拒绝执行：切口不平衡，需要人工确认边界。")
        return 1

    path.write_text("\n".join(before + after), encoding="utf-8")
    print(f"\n已删除，文件现为 {len(before + after)} 行")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
