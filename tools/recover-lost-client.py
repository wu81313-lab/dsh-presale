#!/usr/bin/env python
# 从 git 的悬挂对象里找回被 checkout 覆盖掉的 client.js 版本。
#
# 背景：用 `git checkout <rev> -- <file>` 回退时，工作区里**未提交**的改动会被
# 直接覆盖。那些内容会以 dangling blob 的形式残留在对象库里一段时间。
# 这个脚本把这些 blob 全列出来，找出像 client.js 且含特定标记的版本。
#
# 只读（只调用 git cat-file / fsck，不写任何东西）。
# 用法：python tools/recover-lost-client.py [关键词]
import subprocess
import sys

ROOT = r"C:\Users\13680\.dsh\plugins\dsh-presale"


def run(*args: str) -> str:
    out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                         encoding="utf-8", errors="replace")
    return out.stdout or ""


def main(argv: list[str]) -> int:
    keywords = argv or ["维护（排查用", "dsp-maintain", "dsp-toggles"]
    print(f"关键词：{keywords}\n")

    ids = [l.split()[2] for l in run("fsck", "--lost-found", "--no-progress").splitlines()
           if l.startswith("dangling blob")]
    print(f"悬挂 blob 共 {len(ids)} 个\n")

    hits = []
    for blob in ids:
        size = run("cat-file", "-s", blob).strip()
        try:
            if int(size) < 5000:          # client.js 有几十 KB，小的先跳过
                continue
        except ValueError:
            continue
        body = run("cat-file", "-p", blob)
        if "dsh-presale" not in body and "__ModuleLoader__" not in body:
            continue
        found = [k for k in keywords if k in body]
        has_switch = "dsp-switch" in body
        lines = body.count("\n") + 1
        mark = "  ← 命中" if found else ""
        print(f"  {blob[:12]}  {size:>7} 字节  {lines:>5} 行  开关={has_switch}  命中={found}{mark}")
        if found:
            hits.append((blob, found))

    print()
    if hits:
        print("可作为恢复来源的候选：")
        for blob, found in hits:
            print(f"  git cat-file -p {blob} > client/client.js    （命中 {found}）")
    else:
        print("没找到含这些标记的版本 —— 那些改动可能已被 git 回收（gc）。")
        print("可再试：git fsck --unreachable 或检查编辑器本地历史。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
