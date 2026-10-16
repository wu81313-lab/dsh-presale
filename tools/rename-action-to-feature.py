#!/usr/bin/env python
# 把界面标签「动作一 / 动作二」改名为「功能一 / 功能二」。
#
# 为什么要脚本而不是手改：这两个词散落在 6 个源文件、README 与 4 个自检脚本里
# 共 20 余处，手改必然漏；漏掉的那处会变成"界面写功能一、警告里写动作一"。
#
# 关键区分（不做无脑全局替换）：
#   · 动作一 / 动作二        → 编号标签，要改
#   · 触发动作               → 同一事物的泛称，一并改（否则新旧术语混用）
#   · 维护动作 / 动作层       → 普通名词"操作/行为"，**不能动**
# 所以按「动作一 → 功能一」这种**带编号**的模式替换，再单独处理「触发动作」。
#
# 用法：python tools/rename-action-to-feature.py [--apply]
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 顺序有意义：先换掉带编号的，避免后续规则误匹配
RULES = [
    ("动作一", "功能一"),
    ("动作二", "功能二"),
    ("触发动作", "触发功能"),
]

SKIP_DIRS = {"node_modules", ".git"}
SKIP_SUFFIX = (".bak", ".png", ".log")
EXTS = {".js", ".mjs", ".md", ".json", ".py"}


def main() -> int:
    apply = "--apply" in sys.argv
    targets: list[pathlib.Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in EXTS:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name.endswith(SKIP_SUFFIX) or ".bak" in path.name:
            continue
        # 排除本脚本自身：规则表里就有"动作一/动作二"这些字面量，
        # 不改的话它会被自己替换掉（把规则表改坏）。
        if path.resolve() == pathlib.Path(__file__).resolve():
            continue
        targets.append(path)

    total_files, total_hits = 0, 0
    for path in sorted(targets):
        text = path.read_text(encoding="utf-8")
        original = text
        hits = 0
        for old, new in RULES:
            n = text.count(old)
            if n:
                text = text.replace(old, new)
                hits += n
        if text == original:
            continue
        total_files += 1
        total_hits += hits
        rel = path.relative_to(ROOT)
        print(f"  {str(rel):<44} {hits} 处")
        if apply:
            path.write_text(text, encoding="utf-8")

    print()
    print(f"{'已改写' if apply else '待改写'}：{total_files} 个文件，共 {total_hits} 处")
    if not apply:
        print("（这是预演。加 --apply 才真正写入。）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
