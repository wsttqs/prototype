"""本地预览服务器 —— 供业务人员在浏览器中打开 Demo（不改动任何业务代码）。

用法：
    python tools/serve.py            # 默认 http://127.0.0.1:8765/
    python tools/serve.py 8080       # 指定端口
"""
import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    # 多线程 + HTTP/1.1，避免浏览器并发加载多个脚本时相互阻塞
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        # Demo 数据与代码随时可能更新，禁用缓存以免看到旧版本
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(Handler, directory=ROOT)
    with ThreadedServer(('127.0.0.1', port), handler) as httpd:
        print('Demo 已启动：http://127.0.0.1:%d/index.html  (Ctrl+C 停止)' % port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止。')


if __name__ == '__main__':
    main()
