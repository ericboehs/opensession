#!/usr/bin/env python3
"""Structured command and lifecycle endpoint for OpenSession Lambda MicroVMs."""

import base64
import json
import os
import signal
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 32 * 1024 * 1024
MAX_OUTPUT = 8 * 1024 * 1024


def drain_output(stream, state):
    while chunk := stream.read(64 * 1024):
        remaining = MAX_OUTPUT - len(state["data"])
        if remaining > 0:
            state["data"].extend(chunk[:remaining])
        if len(chunk) > remaining:
            state["truncated"] = True


def output_text(state):
    suffix = b"\n[output truncated by OpenSession]\n" if state["truncated"] else b""
    return (bytes(state["data"]) + suffix).decode("utf-8", errors="replace")


class Handler(BaseHTTPRequestHandler):
    server_version = "opensession-lambda-microvm/1"

    def log_message(self, fmt, *args):
        print("[control] " + fmt % args, flush=True)

    def json_body(self):
        length = int(self.headers.get("content-length", "0"))
        if length > MAX_BODY:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def reply(self, status=200, body=None):
        data = json.dumps(body or {}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path.startswith("/aws/lambda-microvms/runtime/v1/"):
                self.reply(200, {"ok": True})
                return
            body = self.json_body()
            if self.path == "/exec":
                env = os.environ.copy()
                env.update({str(k): str(v) for k, v in body.get("env", {}).items()})
                timeout = max(1, int(body.get("timeoutMs", 120000))) / 1000
                process = subprocess.Popen(
                    ["sh", "-lc", str(body["command"])],
                    cwd=body.get("cwd") or None,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
                stdout = {"data": bytearray(), "truncated": False}
                stderr = {"data": bytearray(), "truncated": False}
                readers = [
                    threading.Thread(
                        target=drain_output, args=(process.stdout, stdout)
                    ),
                    threading.Thread(
                        target=drain_output, args=(process.stderr, stderr)
                    ),
                ]
                for reader in readers:
                    reader.start()
                timed_out = False
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                for reader in readers:
                    reader.join()
                self.reply(
                    200,
                    {
                        "exitCode": 124 if timed_out else process.returncode,
                        "stdout": output_text(stdout),
                        "stderr": output_text(stderr)
                        + ("\ncommand timed out" if timed_out else ""),
                    },
                )
                return
            if self.path == "/background":
                env = os.environ.copy()
                env.update({str(k): str(v) for k, v in body.get("env", {}).items()})
                process = subprocess.Popen(
                    ["sh", "-lc", str(body["command"])],
                    cwd=body.get("cwd") or None,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                threading.Thread(target=process.wait, daemon=True).start()
                self.reply(200, {"started": True})
                return
            if self.path == "/files":
                path = Path(str(body["path"]))
                if not path.is_absolute():
                    raise ValueError("file path must be absolute")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(body["content"], validate=True))
                self.reply(200, {"written": True})
                return
            self.reply(404, {"error": "not found"})
        except Exception as error:
            self.reply(500, {"error": str(error)[:1000]})


ThreadingHTTPServer(
    ("0.0.0.0", int(os.environ.get("BKS_CONTROL_PORT", "8080"))), Handler
).serve_forever()
