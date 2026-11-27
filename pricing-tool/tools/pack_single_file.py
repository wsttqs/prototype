# -*- coding: utf-8 -*-
"""
打包「单文件离线版」：把 pricing-tool/ 整个目录内联进 1 个 .html。

产出：
    dist/商品套餐定价与订单成本测算工具.html

特性：
    · 双击即可用浏览器打开，无需本地服务器、无需联网
    · 计算内核 / 页面逻辑 / 数据文件与源码逐字一致（只是由外部文件改为内联）
    · 兼容 file:// 协议（源码中不含 fetch / XMLHttpRequest / ES module）

用法：
    python tools/pack_single_file.py
    python tools/pack_single_file.py --out dist/别的名字.html
"""
import argparse
import datetime
import hashlib
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# <script src="..."></script>   /   <link rel="stylesheet" href="...">
SCRIPT_RE = re.compile(r'<script\s+src="([^"]+)"\s*>\s*</script>', re.I)
STYLE_RE = re.compile(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*/?>', re.I)


def read(rel):
    path = os.path.join(ROOT, rel.replace('/', os.sep))
    if not os.path.exists(path):
        sys.exit('缺少文件：%s' % rel)
    with io.open(path, encoding='utf-8') as f:
        return f.read()


def inline_script(m):
    rel = m.group(1)
    src = read(rel).replace('</script', '<\\/script')
    return '<script>\n/* ==== 内联自 %s ==== */\n%s\n</script>' % (rel, src)


def inline_style(m):
    rel = m.group(1)
    css = read(rel).replace('</style', '<\\/style')
    return '<style>\n/* ==== 内联自 %s ==== */\n%s\n</style>' % (rel, css)


def detect_data_mode(html):
    m = re.search(r"dataMode:\s*'([a-z]+)'", html)
    return m.group(1) if m else 'unknown'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join('dist', '商品套餐定价与订单成本测算工具.html'))
    ap.add_argument('--no-banner', action='store_true', help='不注入构建信息页脚')
    args = ap.parse_args()

    html = read('index.html')
    html = STYLE_RE.sub(inline_style, html)
    html = SCRIPT_RE.sub(inline_script, html)

    mode = detect_data_mode(html)
    now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

    # 防止被搜索引擎收录（内网资料外泄的第一道保险）
    if 'name="robots"' not in html:
        html = html.replace(
            '<meta name="viewport"',
            '<meta name="robots" content="noindex, nofollow, noarchive" />\n<meta name="viewport"', 1)

    # 页脚注入构建信息，方便同事确认拿到的是哪一版

    if not args.no_banner and '</footer>' in html:
        note = ('<div>单文件离线版 · 构建时间 %s · 数据模式 %s · 本文件含内部业务数据，请勿外传</div>'
                % (now, '内部真实数据' if mode == 'real' else '脱敏样例数据'))
        html = html.replace('</footer>', '    %s\n  </footer>' % note, 1)

    out = os.path.join(ROOT, args.out.replace('/', os.sep))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with io.open(out, 'w', encoding='utf-8', newline='') as f:
        f.write(html)

    size = os.path.getsize(out)
    digest = hashlib.sha256(html.encode('utf-8')).hexdigest()
    with io.open(out + '.sha256.txt', 'w', encoding='utf-8') as f:
        f.write('%s  %s\n' % (digest, os.path.basename(out)))

    print('已生成：%s' % out)
    print('大小  ：%.1f KB' % (size / 1024.0))
    print('SHA256：%s' % digest)
    print('数据模式：%s' % ('内部真实数据' if mode == 'real' else '脱敏样例数据'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
