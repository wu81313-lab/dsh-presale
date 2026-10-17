#!/usr/bin/env python
"""把侧边栏入口从 footer.action 挪到 panellist（顶部全局导航组）。

## 为什么

DSH 侧边栏有两处可以挂「全局面板入口」：

  · `sidebar.footer.action` —— 底部，紧邻「设置」按钮
  · `sidebar.panellist`     —— 顶部，`插件 / Skill/MCP / 自动化任务` 那一组

用户要的是顶部那组。两者注册参数完全一样（id / order / label），
所以只是换个插槽名，其余逻辑不动。

## 用法

python tools/move-entry-to-panellist.py            # 预演
python tools/move-entry-to-panellist.py --apply    # 落盘
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 顺序有意义：先把带上下文的整句替换掉，再做裸名字替换
REPLACEMENTS = [
    # client.js 注释
    ('// 2) 侧边栏入口：那一行紧邻「设置」按钮上方。\n      // 之所以要它：设置是模态窗口，而运维需要看着主页面做。',
     '// 2) 侧边栏入口：挂在顶部全局导航组（插件 / Skill/MCP / 自动化任务 之后）。\n      // 之所以要它：设置是模态窗口，而运维需要看着主页面做。'),
    ('\'dsh-presale: sidebar entry\'', '\'dsh-presale: sidebar entry\''),
    # 裸插槽名
    ("sidebar.footer.action", "sidebar.panellist"),
]

# README 里的位置描述
README_FIXES = [
    ('| **售前助手**（运维） | 侧边栏底部，紧邻「设置」上方 | 普通中央页面，**不挡任何操作** |',
     '| **售前助手**（运维） | 侧边栏顶部，与「插件 / Skill/MCP / 自动化任务」同一组 | 普通中央页面，**不挡任何操作** |'),
]

TARGETS = ['client/client.js', 'tools/selftest-client.mjs', 'tools/selftest-client-runtime.mjs', 'README.md']


def main() -> int:
    apply = '--apply' in sys.argv
    total = 0
    for rel in TARGETS:
        path = ROOT / rel
        if not path.exists():
            print(f'  ✖ 缺少 {rel}')
            return 1
        text = path.read_text(encoding='utf-8')
        before = text
        pairs = REPLACEMENTS + (README_FIXES if rel == 'README.md' else [])
        for old, new in pairs:
            n = text.count(old)
            if n > 0 and old != new:
                text = text.replace(old, new)
                total += n
                print(f'  {rel}: {n} 处  {old[:44]!r} → {new[:44]!r}')
        if apply and text != before:
            path.write_text(text, encoding='utf-8')

    print()
    if total == 0:
        print('没有需要替换的内容（可能已经改过了）')
    elif apply:
        print(f'已落盘，共 {total} 处')
    else:
        print(f'预演：将改 {total} 处。加 --apply 落盘。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
