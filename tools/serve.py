"""Static server for web/ that disables caching, so edited JS modules always reload.

usage: python3 tools/serve.py [port]
"""
import functools, http.server, os, sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
handler = functools.partial(NoCache, directory=root)
print(f"Slune: http://localhost:{port}")
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
