#!/usr/bin/env python
"""把已经生成好的需求梳理正文发送到指定钉钉群。

## 为什么要单独一个脚本

正文是 1100+ 字的中文多段落，走 shell 传参会被引号、换行、全角符号折腾。
这里用 subprocess 的**参数数组**直接调 dws 的 node 入口，不经过任何 shell。

## 调用链

  之前失败的路径：插件 -> dws chat +messages-send --as user --group <cid> --text <正文> --yes
  本脚本复刻同一命令，只是换成 Python 拼参数。

用法：python send_to_group.py <conversationId> <textJsonPath> [--dry-run]
"""
import json
import pathlib
import subprocess
import uuid
import sys

DWS_JS = pathlib.Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / \
    "dingtalk-workspace-cli" / "bin" / "dws.js"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if len(args) < 2:
        print("用法：python send_to_group.py <conversationId> <textJsonPath> [--dry-run]")
        return 2
    conversation_id, json_path = args[0], pathlib.Path(args[1])

    if not DWS_JS.exists():
        print(f"✖ 找不到 dws 入口：{DWS_JS}")
        return 1

    payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
    text = (payload.get("text") or "").strip()
    if not text:
        print("✖ 正文为空，不发")
        return 1

    print(f"  目标群      : {conversation_id}")
    print(f"  正文字数    : {len(text)}")
    print(f"  首行        : {text.splitlines()[0]}")
    print(f"  末行        : {text.splitlines()[-1]}")
    print()

    cmd = [
        "node", str(DWS_JS), "chat", "+messages-send",
        "--as", "user",
        "--group", conversation_id,
        "--text", text,
    ]
    if dry:
        cmd += ["--dry-run"]
    else:
        # 幂等键：真实发送时 server 端可能要求 uuid 非空。
        # 注意 --dry-run 不校验这一项（它只生成本地计划），所以预演永远通过。
        cmd += ["--yes", "--idempotency-key", str(uuid.uuid4())]
    cmd += ["-f", "json"]

    # --alt：换用另一个独立工具 chat +send-to-group。
    # 存在理由：+messages-send 在 2026-11 起整条 --as user 通道都在 tool_validation
    # 阶段报 PARAM_ERROR（短文本、发自己、换 --chat-id 也一样），疑似 CLI 与
    # 服务端 schema 不同步。+send-to-group 是另一个 leaf，参数是 --content。
    if "--alt" in sys.argv:
        cmd = [
            "node", str(DWS_JS), "chat", "+send-to-group",
            "--group", conversation_id,
            "--content", text,
        ]
        # 非交互环境必须显式 --yes，否则报 confirmation_required
        cmd += ["--dry-run"] if dry else ["--yes"]
        cmd += ["-f", "json"]

    print(("（预演，不会真发）" if dry else "（真实发送）"))
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(f"  退出码: {result.returncode}")
    out = (result.stdout or "").strip()
    if out:
        print("  ---- stdout ----")
        print(out[:2000])
    err = (result.stderr or "").strip()
    if err:
        print("  ---- stderr ----")
        print(err[:1200])
    return 0 if result.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
