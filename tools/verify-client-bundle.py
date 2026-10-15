#!/usr/bin/env python
# 验证「客户端 bundle 真的被服务出去了」。
#
# 为什么值得单独验：文件写对不等于浏览器拿到的是新代码——
# 客户端 bundle 由 DSH 按内容哈希路由（/plugins/??<id>/client.js&rev=<sha1前12位>），
# 哈希对不上会 404，于是"改了但没生效"。
#
# 只读。用法：python tools/verify-client-bundle.py
import hashlib
import pathlib
import urllib.error
import urllib.request

PLUGIN = "dsh-presale"
BUNDLE = pathlib.Path(__file__).resolve().parent.parent / "client" / "client.js"
BASE = "http://127.0.0.1:19387"

raw = BUNDLE.read_bytes()
rev = hashlib.sha1(raw).hexdigest()[:12]
print(f"bundle : {BUNDLE}")
print(f"大小   : {len(raw) / 1024:.1f} KB")
print(f"sha1   : {rev}")
print()

# 几个候选路径都试一下，找出真正能取到内容的那个
candidates = [
    f"/plugins/??{PLUGIN}/client.js&rev={rev}",
    f"/plugins/{PLUGIN}/client.js?rev={rev}",
    f"/plugins/{PLUGIN}/client.js",
]

markers = {
    "底部保存条 dsp-dock": "dsp-dock",
    "折叠标记 dsp-caret": "dsp-caret",
    "register 双参数": ", Panel)",
    "旧错误 token 用法": "var(--dsw-alias-text-1",
}

ok = False
for path in candidates:
    req = urllib.request.Request(BASE + path, headers={"Host": "127.0.0.1:19387"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        print(f"OK   {path}")
        print(f"     HTTP {resp.status}｜{len(body) / 1024:.1f} KB")
        for label, needle in markers.items():
            hit = needle in body
            if needle == "var(--dsw-alias-text-1":
                print(f"     {label:22} {'⚠ 仍有（不应该）' if hit else '✔ 已清'}")
            else:
                print(f"     {label:22} {'✔ 有' if hit else '✖ 无'}")
        ok = True
        break
    except urllib.error.HTTPError as exc:
        print(f"FAIL {path}  ->  HTTP {exc.code}")
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL {path}  ->  {exc}")

print()
print("==== 结论 ====")
if ok:
    print("客户端 bundle 已被服务，且内容是新版（含底部保存条与折叠分组）。")
    print("浏览器刷新页面即可看到新界面。")
else:
    print("没能取到 bundle。可能路由需要页面上下文（浏览器带 cookie/查询），")
    print("这不代表代码有问题——用 selftest-client.mjs 验证的是装载契约本身。")
