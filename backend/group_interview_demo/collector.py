from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import asdict
from typing import Any

from group_interview_demo.models import Event, Stage


def _now_ts() -> float:
    return time.time()


class RunCollector:
    def __init__(self, base_dir: str, run_id: str) -> None:
        self.base_dir = base_dir
        self.run_id = run_id
        self.run_dir = os.path.join(base_dir, run_id)
        os.makedirs(self.run_dir, exist_ok=True)
        self.transcript_path = os.path.join(self.run_dir, "transcript.jsonl")
        self.db_path = os.path.join(base_dir, "events.sqlite3")
        os.makedirs(base_dir, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, timeout=30)
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
        except Exception:
            pass
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL,
              ts REAL NOT NULL,
              stage TEXT NOT NULL,
              speaker_id TEXT NOT NULL,
              speaker_name TEXT NOT NULL,
              event_type TEXT NOT NULL,
              content TEXT NOT NULL,
              meta_json TEXT NOT NULL
            )
            """
        )
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id)")
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def record(self, event: Event) -> None:
        payload = asdict(event)
        with open(self.transcript_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._conn.execute(
            """
            INSERT INTO events (run_id, ts, stage, speaker_id, speaker_name, event_type, content, meta_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.run_id,
                float(event.ts),
                str(event.stage),
                str(event.speaker_id),
                str(event.speaker_name),
                str(event.event_type),
                str(event.content),
                json.dumps(event.meta, ensure_ascii=False),
            ),
        )
        self._conn.commit()

    def record_stage_change(self, stage: Stage, content: str) -> None:
        self.record(
            Event(
                run_id=self.run_id,
                ts=_now_ts(),
                stage=stage,
                speaker_id="system",
                speaker_name="系统",
                event_type="stage_change",
                content=content,
                meta={},
            )
        )

    def write_metrics(self, metrics: dict[str, Any]) -> str:
        path = os.path.join(self.run_dir, "metrics.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(metrics, f, ensure_ascii=False, indent=2)
        return path


def compute_metrics(db_path: str, run_id: str) -> dict[str, Any]:
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        """
        SELECT ts, stage, speaker_id, speaker_name, event_type, content, meta_json
        FROM events
        WHERE run_id = ?
        ORDER BY ts ASC, id ASC
        """,
        (run_id,),
    ).fetchall()
    conn.close()

    per_speaker: dict[str, dict[str, Any]] = {}
    total_turns = 0
    interrupt_events = 0
    rebuttal_events = 0

    def ensure(speaker_id: str, speaker_name: str) -> dict[str, Any]:
        if speaker_id not in per_speaker:
            per_speaker[speaker_id] = {
                "speaker_id": speaker_id,
                "speaker_name": speaker_name,
                "utterance_turns": 0,
                "chars": 0,
                "interrupts_made": 0,
                "interrupts_received": 0,
                "rebuttals_made": 0,
            }
        return per_speaker[speaker_id]

    for ts, stage, speaker_id, speaker_name, event_type, content, meta_json in rows:
        if event_type == "utterance":
            total_turns += 1
            s = ensure(speaker_id, speaker_name)
            s["utterance_turns"] += 1
            s["chars"] += len(content or "")
        elif event_type == "interrupt":
            interrupt_events += 1
            s = ensure(speaker_id, speaker_name)
            s["interrupts_made"] += 1
            try:
                meta = json.loads(meta_json or "{}")
            except json.JSONDecodeError:
                meta = {}
            target_id = str(meta.get("target_speaker_id") or "")
            target_name = str(meta.get("target_speaker_name") or "")
            if target_id:
                t = ensure(target_id, target_name or target_id)
                t["interrupts_received"] += 1
        elif event_type == "rebuttal":
            rebuttal_events += 1
            s = ensure(speaker_id, speaker_name)
            s["rebuttals_made"] += 1

    user_turns = per_speaker.get("user", {}).get("utterance_turns", 0)
    return {
        "run_id": run_id,
        "total_utterance_turns": total_turns,
        "total_interrupt_events": interrupt_events,
        "total_rebuttal_events": rebuttal_events,
        "user_utterance_turns": user_turns,
        "per_speaker": list(per_speaker.values()),
    }
