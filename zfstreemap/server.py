"""HTTP server: serves the single-page treemap UI and a JSON API for the dataset tree."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from typing import Tuple
from urllib.parse import urlsplit

from .zfs import Runner, ZFSError, collect_tree, run_zfs

# URL path -> (file in the static directory, content type)
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


class AnalyzerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: Tuple[str, int], runner: Runner):
        super().__init__(address, RequestHandler)
        self.runner = runner


class RequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/tree":
            self._send_tree()
        elif path in ASSETS:
            filename, content_type = ASSETS[path]
            body = resources.files(__package__).joinpath("static").joinpath(filename).read_bytes()
            self._send(200, content_type, body)
        else:
            self._send(404, "text/plain; charset=utf-8", b"Not found")

    def _send_tree(self) -> None:
        try:
            payload = collect_tree(self.server.runner)
        except ZFSError as exc:
            self._send_json(500, {"error": str(exc)})
            return
        self._send_json(200, payload)

    def _send_json(self, status: int, obj: dict) -> None:
        self._send(status, "application/json", json.dumps(obj).encode("utf-8"))

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def make_server(host: str = "127.0.0.1", port: int = 8080, runner: Runner = run_zfs) -> AnalyzerServer:
    return AnalyzerServer((host, port), runner)
