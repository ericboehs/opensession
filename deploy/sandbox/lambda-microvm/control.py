#!/usr/bin/env python3
"""Structured command and lifecycle endpoint for Open Session Lambda MicroVMs."""

import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MAX_BODY = 32 * 1024 * 1024
MAX_OUTPUT = 8 * 1024 * 1024
MAX_PTYS = 16
PTYS = {}
PTYS_LOCK = threading.Lock()


def resize_pty(fd, cols, rows):
    cols = max(20, min(500, int(cols or 100)))
    rows = max(5, min(200, int(rows or 30)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def close_pty(pty_id):
    with PTYS_LOCK:
        entry = PTYS.pop(pty_id, None)
    if not entry:
        return
    try:
        os.killpg(entry["process"].pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        os.close(entry["master"])
    except OSError:
        pass


def drain_output(stream, state):
    while chunk := stream.read(64 * 1024):
        remaining = MAX_OUTPUT - len(state["data"])
        if remaining > 0:
            state["data"].extend(chunk[:remaining])
        if len(chunk) > remaining:
            state["truncated"] = True


def output_text(state):
    suffix = b"\n[output truncated by Open Session]\n" if state["truncated"] else b""
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
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.reply(200, {"ok": True})
        elif parsed.path == "/pty/read":
            pty_id = parse_qs(parsed.query).get("id", [""])[0]
            with PTYS_LOCK:
                entry = PTYS.get(pty_id)
            if not entry:
                self.reply(404, {"error": "pty not found"})
                return
            timeout = max(0, min(2000, int(parse_qs(parsed.query).get("timeoutMs", ["1000"])[0]))) / 1000
            data = b""
            try:
                ready, _, _ = select.select([entry["master"]], [], [], timeout)
                if ready:
                    data = os.read(entry["master"], 64 * 1024)
            except OSError as error:
                if error.errno not in (errno.EAGAIN, errno.EIO):
                    raise
            code = entry["process"].poll()
            self.reply(
                200,
                {
                    "data": base64.b64encode(data).decode(),
                    "exited": code is not None,
                    "exitCode": code,
                },
            )
            if code is not None and not data:
                close_pty(pty_id)
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path.startswith("/aws/lambda-microvms/runtime/v1/"):
                self.reply(200, {"ok": True})
                return
            body = self.json_body()
            if self.path == "/pty/start":
                with PTYS_LOCK:
                    if len(PTYS) >= MAX_PTYS:
                        raise ValueError("too many open ptys")
                master, slave = pty.openpty()
                resize_pty(master, body.get("cols"), body.get("rows"))
                env = os.environ.copy()
                env.update({"HOME": "/home/ubuntu", "TERM": "xterm-256color"})
                process = subprocess.Popen(
                    ["bash", "-il"],
                    cwd=body.get("cwd") or "/home/ubuntu",
                    env=env,
                    stdin=slave,
                    stdout=slave,
                    stderr=slave,
                    start_new_session=True,
                    close_fds=True,
                )
                os.close(slave)
                os.set_blocking(master, False)
                pty_id = str(uuid.uuid4())
                with PTYS_LOCK:
                    PTYS[pty_id] = {"master": master, "process": process}
                self.reply(200, {"id": pty_id})
                return
            if self.path in ("/pty/write", "/pty/resize", "/pty/close"):
                pty_id = str(body.get("id", ""))
                with PTYS_LOCK:
                    entry = PTYS.get(pty_id)
                if not entry:
                    self.reply(404, {"error": "pty not found"})
                    return
                if self.path == "/pty/write":
                    os.write(entry["master"], base64.b64decode(body.get("data", ""), validate=True))
                elif self.path == "/pty/resize":
                    resize_pty(entry["master"], body.get("cols"), body.get("rows"))
                    os.killpg(entry["process"].pid, signal.SIGWINCH)
                else:
                    close_pty(pty_id)
                self.reply(200, {"ok": True})
                return
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
