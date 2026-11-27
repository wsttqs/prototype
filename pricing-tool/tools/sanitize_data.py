# -*- coding: utf-8 -*-
"""
脱敏发布管线：把真实业务数据转换为可公开发布的样例数据。

为什么需要：
    公开仓库（GitHub Pages）上的内容对所有人可读，而 git 历史无法真正撤回。
    Demo 依赖的两份真实数据里包含：
        - 1369 条 SPU 的**采购成本**（供应商结算价）
        - 完整的**物流渠道价目表**（逐国家 × 重量段 × 件价 / 计重单价）
    两者都属于不可外泄的商业敏感信息。

脱敏原则（保持 Demo 可用性与真实感，只替换"绝对金额"）：
    保留：SPU 编码 / 名称 / 重量 / 是否带电 / 录入时间
          物流渠道名 / 目的国 / 重量段区间 / 生效日期 / 各渠道国家覆盖
    替换：采购成本、件价、计重单价  -> 确定性合成值（同输入必得同输出）
    保留：3 条成本缺失的异常记录（继续走"数据缺失"提示分支）

    合成值不是随意取的，而是对齐真实数据的**分布与形状**，否则 Demo 会失真：
      · 采购成本：按「¥/克」定价，r^1.8 偏态分布，中位数与真实台账同量级
      · 物流单价：同一「渠道 × 目的国」内随重量段**递减**（真实价目表同样如此：
        大重量段件价与计重单价都更低），从而 Demo 里"多件装运费更省"的结论成立

用法:
    python tools/sanitize_data.py [--in-dir data] [--out-dir data]

相同输入始终产出相同结果，可重复执行；已脱敏的文件会被自动跳过。
"""
import argparse
import json
import os
import re
import sys

MARK = "【脱敏样例数据】"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 采购成本：以「¥/克」为口径的偏态系数（对齐真实台账的分位数）
SPU_RATE_BASE = 0.0239
SPU_RATE_SPAN = 0.1954
SPU_RATE_POW = 1.8
SPU_PRICE_MIN = 2.0
SPU_PRICE_MAX = 480.0

# 物流单价：件价 / 计重单价的基数与逐段递减系数
PIECE_BASE_MIN, PIECE_BASE_MAX = 10.0, 60.0
HEAVY_BASE_MIN, HEAVY_BASE_MAX = 30.0, 180.0
PIECE_DECAY_MIN, PIECE_DECAY_MAX = 0.880, 0.940
HEAVY_DECAY_MIN, HEAVY_DECAY_MAX = 0.970, 0.985
PIECE_FLOOR, HEAVY_FLOOR = 8.0, 10.0


def fnv1a(text):
    """确定性 32 位哈希 -> [0, 1)"""
    h = 0x811C9DC5
    for ch in text.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h / 0x100000000


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def sanitize_spu(items):
    out = []
    for it in items:
        o = dict(it)
        weight = o.get("weightG") or 0
        # 成本缺失的异常记录原样保留，保证"数据缺失"提示分支仍可复现
        if not o.get("purchasePrice"):
            out.append(o)
            continue
        r = fnv1a("spu:" + str(o.get("spu") or o.get("id")))
        # ¥/克 口径：越重越贵，且呈偏态分布（小件便宜、大件贵）
        rate = SPU_RATE_BASE + SPU_RATE_SPAN * (r ** SPU_RATE_POW)
        o["purchasePrice"] = round(clamp(weight * rate, SPU_PRICE_MIN, SPU_PRICE_MAX), 2)
        out.append(o)
    return out


def sanitize_logistics(items):
    """按「渠道 × 目的国」分组，组内按重量段序号单调递减地合成单价。"""
    groups = {}
    order = []
    for idx, it in enumerate(items):
        key = "%s||%s" % (it.get("channel"), it.get("country"))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(idx)

    prices = {}
    for key in order:
        rows = sorted(groups[key], key=lambda i: float(items[i].get("minWeight") or 0))
        ch = items[rows[0]].get("channel")
        country = items[rows[0]].get("country")

        base_piece = PIECE_BASE_MIN + fnv1a("lp:" + key) * (PIECE_BASE_MAX - PIECE_BASE_MIN)
        base_heavy = HEAVY_BASE_MIN + fnv1a("lh:" + key) * (HEAVY_BASE_MAX - HEAVY_BASE_MIN)
        decay_piece = PIECE_DECAY_MIN + fnv1a("ldp:" + key) * (PIECE_DECAY_MAX - PIECE_DECAY_MIN)
        decay_heavy = HEAVY_DECAY_MIN + fnv1a("ldh:" + key) * (HEAVY_DECAY_MAX - HEAVY_DECAY_MIN)

        for i, idx in enumerate(rows):
            src = items[idx]
            piece = round(max(PIECE_FLOOR, base_piece * (decay_piece ** i)), 2)
            heavy = round(max(HEAVY_FLOOR, base_heavy * (decay_heavy ** i)), 2)
            entry = {"piecePrice": piece, "heavyPrice": heavy}
            if src.get("gofoUsdPrice"):
                entry["gofoUsdPrice"] = round(
                    clamp(2.5 + fnv1a("gofo:%s|%s|%s" % (ch, country, src.get("minWeight"))) * 14, 2, 20), 2)
            prices[idx] = entry

    out = []
    for idx, it in enumerate(items):
        o = dict(it)
        o.update(prices[idx])
        out.append(o)
    return out


def load_js(path, var_name):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if MARK in src:
        return None, src
    m = re.search(re.escape(var_name) + r"\s*=\s*(\[[\s\S]*?\])\s*;", src)
    if not m:
        sys.exit("无法在 %s 中定位 %s" % (path, var_name))
    return json.loads(m.group(1)), src


def write_js(path, var_name, items, title):
    body = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
    out = (
        "/* %s —— %s\n"
        "   %s\n"
        "   本文件由 tools/sanitize_data.py 生成，采购成本与物流单价均为合成样例值，\n"
        "   不代表任何真实供应商或承运商报价，不得用于业务决策。\n"
        "   内部真实数据请勿提交到公开仓库。 */\n"
        "(function (root) {\n"
        "  'use strict';\n"
        "  root.%s = %s;\n"
        "})(typeof globalThis !== 'undefined' ? globalThis : this);\n"
    ) % (title, MARK, MARK, var_name, body)
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dir", default=os.path.join(ROOT, "data"))
    ap.add_argument("--out-dir", default=None)
    args = ap.parse_args()
    out_dir = args.out_dir or args.in_dir
    os.makedirs(out_dir, exist_ok=True)

    spu_path = os.path.join(args.in_dir, "spu.data.js")
    logi_path = os.path.join(args.in_dir, "logistics.data.js")

    spu, _ = load_js(spu_path, "root.SPU_DATA")
    if spu is None:
        print("spu.data.js 已是脱敏版本，跳过")
    else:
        write_js(os.path.join(out_dir, "spu.data.js"), "SPU_DATA",
                 sanitize_spu(spu), "SPU 数据")
        print("SPU 条数: %d （成本已替换为合成值）" % len(spu))

    logi, _ = load_js(logi_path, "root.LOGISTICS_DATA")
    if logi is None:
        print("logistics.data.js 已是脱敏版本，跳过")
    else:
        write_js(os.path.join(out_dir, "logistics.data.js"), "LOGISTICS_DATA",
                 sanitize_logistics(logi), "物流计价规则")
        print("物流计价行数: %d （件价/计重单价已替换为合成值）" % len(logi))


if __name__ == "__main__":
    main()
