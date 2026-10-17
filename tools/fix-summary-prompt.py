#!/usr/bin/env python
"""修「功能二」提示词的两个问题，并生成 settings 补丁。

## 问题

1. 悬空引用：第 7 条已被删除，但第 8 条仍写「判断第 7 条时」。
   模型读到不存在的条目会困惑（实测它自作主张加了一段「补充：」）。
2. 附件解析情况被写进正文：模型把「压缩包未能解析」这类运维信息
   写进了给客户看的总结。

## 做法

- 第 8 条那句改为「判断信息取舍时」；
- 新增一条硬约束：附件解析失败一律不写进正文；
- **编号重排为连续的 1–11**：原来的 1,2,3,4,5,6,8,9,10,11 有缺口，
  缺口本身就是这次悬空引用的根源。
- 只改这两点，其余文字逐字保留（含用户自定义的公司名与人名）。

## 用法

python tools/fix-summary-prompt.py            # 预演，打印新旧对比
python tools/fix-summary-prompt.py --write    # 写出补丁 JSON 供接口提交
"""
import json
import pathlib
import sys

SETTINGS = pathlib.Path.home() / ".dsh" / "presale" / "settings.json"
PATCH_OUT = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "presale-patch-prompt.json"

# 新版提示词：以用户当前保存的两节版为基准，只做上述修正
NEW_PROMPT = """你是弥特智能科技的售前技术支持。下面是钉钉项目群的一段聊天记录，可能还附带了群里分享的文件内容与图片。

请梳理出这个项目的需求，输出要求：

1. 用中文直接发在钉钉群里阅读，不要用表格（手机端显示会乱）。不要用 Markdown 语法符号。

2. **不要写标题、不要写开头语，直接从「客户与场景」开始。** 标题由程序自动添加，你写了会重复。

3. 结构两节，节标题就用「客户与场景」「明确的需求」。

4. 「客户与场景」**尽量精简，2–3 句话讲完**：只保留客户是谁、要做什么、现状与痛点。不要罗列文件名称、不要复述文件里的大段内容、不要写"核心依据是…"。不要与「明确的需求」重复。

5. **不要写任何引用依据。** 句末不要加「（需求docx）」「据《xx.xlsx》」「来源：…」这类标注——读者不关心出自哪个文件，标出来只是噪音。把不同来源的信息直接融合成结论即可。

6. 「明确的需求」只写记录里真的有依据的内容，不要脑补、不要补充行业通用做法。合并重复项，按重要性排序。

7. 聊天记录、文件内容、图片都会给你，**都要看**。文件与图片里的信息往往比聊天更接近真实需求，要优先依据它们。**判断信息取舍时**也要把文件与图片里的问答算进去。

8. 如果有招标文件（没有就不要在内容里提及），要重点关注付款条件、评分标准、URS 内容、技术要求。

9. **不要写附件解析情况。** 附件读取失败、格式不支持、正文提取不出来、压缩包打不开这类技术信息，一律不要出现在正文里——它们是给运维排查用的，写进给客户看的总结只是噪音。程序会在活动日志里单独记录这些情况，不需要你在正文里汇报。

10. 总长控制在 500 字以内；信息特别多时可弹性增加，但不要超过 900 字。

11. 结尾单独一行注明：本消息由吴瑞铎AI售前助理发出"""


def main() -> int:
    settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
    old = settings["triggers"]["summarize"]["prompt"]

    print("==== 旧提示词 ====")
    for line in old.split("\n"):
        if line.strip():
            print("  " + line[:100])
    print()
    print("==== 新提示词 ====")
    for line in NEW_PROMPT.split("\n"):
        if line.strip():
            print("  " + line[:100])
    print()

    # 自检：确认两个问题都改掉了
    checks = [
        ("悬空引用已清除", "判断第 7 条时" not in NEW_PROMPT),
        ("改成「判断信息取舍时」", "判断信息取舍时" in NEW_PROMPT),
        ("已有附件解析约束", "不要写附件解析情况" in NEW_PROMPT),
        ("编号连续 1..11", all(f"\n{n}. " in "\n" + NEW_PROMPT or NEW_PROMPT.startswith(f"{n}. ")
                              for n in range(1, 12))),
        ("保留公司名", "弥特智能科技" in NEW_PROMPT),
        ("保留署名", "吴瑞铎" in NEW_PROMPT),
    ]
    ok = True
    for label, passed in checks:
        print(("  ✔ " if passed else "  ✖ ") + label)
        if not passed:
            ok = False
    if not ok:
        print("\n自检未通过，不写补丁。")
        return 1

    if "--write" in sys.argv:
        patch = {"patch": {"triggers": {"summarize": {"prompt": NEW_PROMPT}}}, "strict": True}
        PATCH_OUT.write_text(json.dumps(patch, ensure_ascii=False), encoding="utf-8")
        print(f"\n补丁已写到 {PATCH_OUT}")
    else:
        print("\n（预演。加 --write 生成补丁文件。）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
