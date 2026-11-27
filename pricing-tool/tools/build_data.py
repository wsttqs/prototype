# -*- coding: utf-8 -*-
"""
构建 Demo 底层数据：将两份真实 Excel 转换为前端可直接加载的 JS 数据文件。

用法:
    python tools/build_data.py [--spu <xlsx>] [--logistics <xlsx>] [--out <dir>]

输出:
    data/spu.data.js         -> window.SPU_DATA
    data/logistics.data.js   -> window.LOGISTICS_DATA

字段映射见 docs/交付说明.md。原始 Excel 只读，不做任何修改。
"""
import argparse
import datetime
import json
import os
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("需要 openpyxl： pip install openpyxl")

# 默认从环境变量读取，避免把本机绝对路径写进仓库。
#   ECOM_SPU_XLSX       -> SPU 信息 Excel 路径
#   ECOM_LOGISTICS_XLSX -> 物流渠道计价规则 Excel 路径
# 也可用命令行参数覆盖：--spu / --logistics
DEFAULT_SPU = os.environ.get("ECOM_SPU_XLSX", "")
DEFAULT_LOGISTICS = os.environ.get("ECOM_LOGISTICS_XLSX", "")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def js_num(v):
    """把 Excel 数值转成 JSON 安全数值，None -> None。"""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return round(float(v), 6)
    try:
        return round(float(str(v).strip()), 6)
    except ValueError:
        return None


def js_str(v):
    if v is None:
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    return str(v).strip()


# elec（是否带电）的写法在不同导出之间不统一：兼容 1/0、是/否、true/false、带电/不带电
ELEC_TRUE = {"1", "true", "yes", "y", "t", "是", "带电", "带电商品"}
ELEC_FALSE = {"0", "false", "no", "n", "f", "否", "不带电", "非带电", "无电", ""}


def js_bool(v):
    """把 elec 列转成布尔值；无法识别时按「不带电」处理。"""
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    s = str(v).strip().lower()
    if s in ELEC_TRUE:
        return True
    if s in ELEC_FALSE:
        return False
    try:
        return float(s) != 0
    except ValueError:
        return False


def load_rows(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    it = ws.iter_rows(values_only=True)
    header = [str(h).strip() for h in next(it)]
    rows = []
    for raw in it:
        if all(c is None or str(c).strip() == "" for c in raw):
            continue
        rows.append(dict(zip(header, raw)))
    wb.close()
    return header, rows


def build_spu(path):
    header, rows = load_rows(path)
    required = ["product_id", "product_name", "product_number", "purchase_price", "weight"]
    missing = [c for c in required if c not in header]
    if missing:
        sys.exit("SPU 文件缺少必需列: %s (实际列: %s)" % (missing, header))
    items = []
    for r in rows:
        items.append({
            "id": js_num(r["product_id"]),
            "spu": js_str(r["product_number"]),
            "name": js_str(r["product_name"]),
            # 采购成本：源文件未标注币种，按人民币处理（可在上层切换展示币种）
            "purchasePrice": js_num(r["purchase_price"]),
            # 重量：源文件为克
            "weightG": js_num(r["weight"]),
            # 是否带电：决定默认物流渠道（带电 → 特惠带电；不带电 → 特惠普货）
            "elec": js_bool(r.get("elec")),
            "createTime": js_str(r.get("create_time")),
        })
    if "elec" not in header:
        print("  [提示] SPU 文件无 elec 列，全部按「不带电」处理")
    items.sort(key=lambda x: (x["spu"] or ""))
    return items


def effective_date(v):
    """取生效日期 YYYY-MM-DD；源表中 0000-00-00 表示未维护生效日期，按空处理。"""
    if v is None:
        return None
    s = js_str(v)[:10]
    if not s or s.startswith("0000-00-00"):
        return None
    return s


def build_logistics(path):
    header, rows = load_rows(path)
    required = ["logistics_business", "logistics_channel", "country",
                "heavy_price", "piece_price", "min_weight", "max_weight"]
    missing = [c for c in required if c not in header]
    if missing:
        sys.exit("物流文件缺少必需列: %s (实际列: %s)" % (missing, header))
    bands = []
    for r in rows:
        mw, xw = js_num(r["min_weight"]), js_num(r["max_weight"])
        if mw is None or xw is None:
            continue
        bands.append({
            "business": js_str(r["logistics_business"]),
            "channel": js_str(r["logistics_channel"]),
            "country": js_str(r["country"]),
            "minWeight": mw,
            "maxWeight": xw,
            # 计重价：元 / 公斤（作用于订单总重）
            "heavyPrice": js_num(r["heavy_price"]),
            # 件价：元 / 件（作用于订单件数）
            "piecePrice": js_num(r["piece_price"]),
            "gofoUsdPrice": js_num(r.get("gofo_usd_price")),
            "effectiveDate": effective_date(r.get("date")),
        })
    bands.sort(key=lambda b: (b["business"], b["channel"], b["country"], b["minWeight"]))
    return bands


def write_js(path, var, payload, banner):
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8") as f:
        f.write("/* %s */\n" % banner)
        f.write("(function (root) {\n")
        f.write("  'use strict';\n")
        f.write("  root.%s = %s;\n" % (var, body))
        f.write("})(typeof window !== 'undefined' ? window : globalThis);\n")
    print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spu", default=DEFAULT_SPU)
    ap.add_argument("--logistics", default=DEFAULT_LOGISTICS)
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    args = ap.parse_args()

    missing = []
    if not args.spu or not os.path.isfile(args.spu):
        missing.append("--spu / ECOM_SPU_XLSX")
    if not args.logistics or not os.path.isfile(args.logistics):
        missing.append("--logistics / ECOM_LOGISTICS_XLSX")
    if missing:
        sys.exit(
            "缺少源 Excel（%s）。请通过命令行参数或环境变量指定：\n"
            "  python tools/build_data.py --spu <SPU信息.xlsx> --logistics <物流渠道计价规则.xlsx>\n"
            "  或设置环境变量 ECOM_SPU_XLSX / ECOM_LOGISTICS_XLSX" % ", ".join(missing)
        )

    os.makedirs(args.out, exist_ok=True)

    spu = build_spu(args.spu)
    write_js(os.path.join(args.out, "spu.data.js"), "SPU_DATA", spu,
             "SPU 数据 —— 由 SPU信息-260901~261126.xlsx 转换，请勿手工修改")
    print("  SPU 条数: %d" % len(spu))
    print("  其中带电: %d 条 / 不带电: %d 条"
          % (sum(1 for x in spu if x["elec"]), sum(1 for x in spu if not x["elec"])))

    lg = build_logistics(args.logistics)
    write_js(os.path.join(args.out, "logistics.data.js"), "LOGISTICS_DATA", lg,
             "物流计价规则 —— 由 物流渠道计价规则-1126最新生效.xlsx 转换，请勿手工修改")
    print("  物流计价行数: %d" % len(lg))


if __name__ == "__main__":
    main()
