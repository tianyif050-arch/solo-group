from __future__ import annotations

import argparse
import json
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

from group_interview_demo.collector import RunCollector, compute_metrics
from group_interview_demo.models import Event


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--host", type=str, default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--base-dir", type=str, default="group_interview_runs")
    return p.parse_args()


class _State:
    def __init__(self, base_dir: str) -> None:
        self.base_dir = base_dir
        self.collectors: dict[str, RunCollector] = {}

    def get(self, run_id: str) -> RunCollector:
        if run_id not in self.collectors:
            self.collectors[run_id] = RunCollector(self.base_dir, run_id)
        return self.collectors[run_id]


class Handler(BaseHTTPRequestHandler):
    state: _State

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/events":
            self._send_json(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else ""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid_json"})
            return
        try:
            event = Event(
                run_id=str(body["run_id"]),
                ts=float(body["ts"]),
                stage=body["stage"],
                speaker_id=str(body["speaker_id"]),
                speaker_name=str(body["speaker_name"]),
                event_type=body["event_type"],
                content=str(body.get("content") or ""),
                meta=dict(body.get("meta") or {}),
            )
        except Exception:
            self._send_json(400, {"error": "invalid_event"})
            return
        collector = self.state.get(event.run_id)
        collector.record(event)
        self._send_json(200, {"ok": True})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") != "/metrics":
            self._send_json(404, {"error": "not_found"})
            return
        qs = urllib.parse.parse_qs(parsed.query)
        run_id = (qs.get("run_id") or [""])[0]
        if not run_id:
            self._send_json(400, {"error": "missing_run_id"})
            return
        db_path = os.path.join(self.state.base_dir, "events.sqlite3")
        try:
            metrics = compute_metrics(db_path, run_id)
        except Exception:
            self._send_json(500, {"error": "metrics_failed"})
            return
        self._send_json(200, {"ok": True, "metrics": metrics})

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    args = parse_args()
    state = _State(args.base_dir)
    Handler.state = state
    server = HTTPServer((args.host, args.port), Handler)
    print(f"collector server: http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
