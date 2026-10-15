#!/usr/bin/env python
# 核对「售前助手」设置面板的两个具体修复点。
#
# 背景（用户在客户端截图里报的问题）：
#   ① 短输入框（冷却秒数、读取消息条数）被撑成大块
#   ② 底部那条「所有改动都已保存 / 放弃改动 / 保存」应该删掉
#
# 只读。运行：python tools/verify-presale-panel.py
import pathlib
import re

CLIENT = pathlib.Path(__file__).resolve().parent.parent / "client" / "client.js"


def main() -> int:
    if not CLIENT.exists():
        print(f"找不到 {CLIENT}")
        return 1
    text = CLIENT.read_text(encoding="utf-8")

    # CSS 是模板字符串，用位置切出来（避免正则里出现反引号）
    start = text.index("const CSS = `") + len("const CSS = `")
    end = text.index("`;", start)
    css = text[start:end]

    problems: list[str] = []

    print("==== ① 短输入框限高 ====")
    m = re.search(r"\.dsp-input \{([^}]*)\}", css)
    body = m.group(1) if m else ""
    has_height = "height: 34px" in body
    has_no_flex = "flex: none" in body
    print(f"  .dsp-input 规则     : {' '.join(body.split())[:110]}")
    print(f"  固定 height:34px    : {'✔' if has_height else '✖'}")
    print(f"  声明 flex:none      : {'✔' if has_no_flex else '✖'}（防止被 flex/grid 拉伸）")
    if not (has_height and has_no_flex):
        problems.append("短输入框仍可能被撑大")

    # input 与 textarea 必须是**分开的**规则（早前共用一个类，textarea 的
    # min-height 把短文本框一起撑大了）
    shared = re.search(r"\.dsp-input,\s*\.dsp-textarea", css)
    print(f"  input 与 textarea 分规则 : {'✖ 仍共用（会被撑大）' if shared else '✔ 已分开'}")
    if shared:
        problems.append("input 与 textarea 仍共用规则")

    print()
    print("==== ② 底部全局保存条已删除 ====")
    for needle, label in [
        ("dsp-dock", "底部保存条样式"),
        ("所有改动都已保存", "那条文案"),
        ("saveAll", "全局保存函数"),
        ("dsc-dock", "（错拼残留）"),
    ]:
        hit = needle in text
        print(f"  {label:<16}: {'✖ 仍存在' if hit else '✔ 已删除'}")
        if hit:
            problems.append(f"仍存在：{label}")

    print()
    print("==== ③ 每张卡自己的保存行 ====")
    has_foot = ".dsp-card-foot" in css
    supports_dirty = "props.dirty" in text
    onsave_count = text.count("onSave:")
    print(f"  卡片脚样式           : {'✔' if has_foot else '✖'}")
    print(f"  Card 支持 dirty 态    : {'✔' if supports_dirty else '✖'}")
    print(f"  传了 onSave 的卡片数  : {onsave_count}（动作一/二、@销售、附件、轮询、模型 = 6 张，动作一二是同一草稿）")
    if not (has_foot and supports_dirty and onsave_count >= 4):
        problems.append("每卡保存行不完整")

    print()
    print("==== ④ 其余不该回退的项 ====")
    for needle, label in [
        (".5px solid", "0.5px 细边框（客户端原生做法）"),
        ("border-radius: 16px", "卡片 16px 圆角"),
        ("max-width: 720px", "内容列 720px"),
        ("border-radius: 18px", "按钮胶囊"),
        ("dsp-switch", "开关"),
    ]:
        hit = needle in text
        print(f"  {label:<32}: {'✔' if hit else '✖ 丢了'}")
        if not hit:
            problems.append(f"回退了：{label}")

    print()
    if problems:
        print("==== 未通过 ====")
        for p in problems:
            print(f"  ✖ {p}")
        return 1
    print("==== 全部通过 ====")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
