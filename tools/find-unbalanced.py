#!/usr/bin/env python
# 定位 client.js 里括号不平衡的位置。
#
# 为什么需要：这份代码用手写 React.createElement 而不是 JSX，少一个 ')' 时
# node --check 只会在**文件末尾**报错，看不出是哪个区块的问题。
# 这个脚本逐行累计括号深度、逐行输出，能直接看出哪一段开始偏。
#
# 只读。
# 用法：
#   python tools/find-unbalanced.py                  # 打印所有 h(Card 处的深度
#   python tools/find-unbalanced.py 400 520          # 打印指定行区间内逐行深度
import pathlib
import sys


def scan(path: pathlib.Path):
    """返回 [(行号, 该行处理后的深度, 该行代码)]，括号只统计代码区。"""
    text = path.read_text(encoding="utf-8")
    out = []
    depth = 0
    in_template = False
    in_block_comment = False

    for line_no, raw in enumerate(text.split("\n"), 1):
        stripped = raw.strip()

        # CSS 模板串：整段跳过（它里面有括号，不该计入）
        if in_template:
            if "`;" in raw:
                in_template = False
            out.append((line_no, depth, "（模板串）"))
            continue
        if stripped.startswith("const CSS = `"):
            in_template = True
            out.append((line_no, depth, "（模板串开始）"))
            continue

        # 块注释
        if in_block_comment:
            if "*/" in raw:
                in_block_comment = False
            out.append((line_no, depth, "（注释）"))
            continue
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                in_block_comment = True
            out.append((line_no, depth, "（注释）"))
            continue
        if stripped.startswith("//"):
            out.append((line_no, depth, "（行注释）"))
            continue

        # 去掉行尾注释：只认「// 」后面不再有引号的情况，避免破坏 URL
        code = raw
        if "//" in raw:
            head, _, tail = raw.partition("//")
            if "'" not in tail and '"' not in tail and "`" not in tail:
                code = head

        depth += code.count("(") - code.count(")")
        out.append((line_no, depth, stripped))
    return out


def main(argv: list[str]) -> int:
    path = pathlib.Path(__file__).resolve().parent.parent / "client" / "client.js"
    rows = scan(path)

    if len(argv) == 2:
        lo, hi = int(argv[0]), int(argv[1])
        print(f"{path.name}  行 {lo}–{hi}")
        for line_no, depth, code in rows:
            if lo <= line_no <= hi:
                print(f"  {line_no:>4}  d={depth:<3} {code[:96]}")
        return 0

    print(f"文件：{path.name}  共 {len(rows)} 行")
    print(f"结束深度：{rows[-1][1]}（应为 0）")
    print()
    print("各 h(Card 出现处的深度（同级卡片应当相同）：")
    prev = None
    for line_no, depth, code in rows:
        if "h(Card" in code or "h(Card," in code:
            mark = ""
            if prev is not None and depth != prev:
                mark = f"   ← 与上一张卡不同（上 {prev}）"
            print(f"  行 {line_no:>4}  深度 {depth}{mark}")
            prev = depth
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
