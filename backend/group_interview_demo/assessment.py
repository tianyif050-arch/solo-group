from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import statistics
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class _Point:
    ts: float
    v: float


def _safe_mean(xs: list[float]) -> float:
    xs2 = [x for x in xs if isinstance(x, (int, float)) and not math.isnan(float(x))]
    return float(statistics.mean(xs2)) if xs2 else 0.0


def _safe_stdev(xs: list[float]) -> float:
    xs2 = [x for x in xs if isinstance(x, (int, float)) and not math.isnan(float(x))]
    if len(xs2) < 2:
        return 0.0
    return float(statistics.stdev(xs2))


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _grade(score: float) -> str:
    s = float(score)
    if s >= 90:
        return "S"
    if s >= 80:
        return "A"
    if s >= 70:
        return "B"
    return "C"


def _load_events(db_path: str, run_id: str) -> list[dict[str, Any]]:
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        """
        SELECT id, ts, stage, speaker_id, speaker_name, event_type, content, meta_json
        FROM events
        WHERE run_id = ?
        ORDER BY ts ASC, id ASC
        """,
        (run_id,),
    ).fetchall()
    conn.close()

    events: list[dict[str, Any]] = []
    for _id, ts, stage, speaker_id, speaker_name, event_type, content, meta_json in rows:
        try:
            meta = json.loads(meta_json or "{}")
        except json.JSONDecodeError:
            meta = {}
        events.append(
            {
                "id": int(_id),
                "ts": float(ts),
                "stage": str(stage),
                "speaker_id": str(speaker_id),
                "speaker_name": str(speaker_name),
                "event_type": str(event_type),
                "content": str(content or ""),
                "meta": meta,
            }
        )
    return events


def _extract_timeseries(events: list[dict[str, Any]]) -> dict[str, list[_Point]]:
    motion: list[_Point] = []
    face: list[_Point] = []
    smile: list[_Point] = []
    blink: list[_Point] = []
    brow: list[_Point] = []
    rms: list[_Point] = []

    for e in events:
        ts = float(e["ts"])
        meta = e.get("meta") or {}
        if isinstance(meta, dict):
            vm = meta.get("video_metric")
            if isinstance(vm, dict):
                if "motion" in vm:
                    motion.append(_Point(ts=ts, v=float(vm.get("motion") or 0.0)))
                if "face" in vm:
                    face.append(_Point(ts=ts, v=1.0 if bool(vm.get("face")) else 0.0))
            vis = meta.get("vision_metric")
            if isinstance(vis, dict):
                if "smile" in vis:
                    smile.append(_Point(ts=ts, v=float(vis.get("smile") or 0.0)))
                if "blink" in vis:
                    blink.append(_Point(ts=ts, v=float(vis.get("blink") or 0.0)))
                if "brow" in vis:
                    brow.append(_Point(ts=ts, v=float(vis.get("brow") or 0.0)))
            am = meta.get("audio_metric")
            if isinstance(am, dict):
                if "rms" in am:
                    rms.append(_Point(ts=ts, v=float(am.get("rms") or 0.0)))

    return {"motion": motion, "face": face, "smile": smile, "blink": blink, "brow": brow, "rms": rms}


def _window(series: list[_Point], t0: float, t1: float) -> list[float]:
    return [p.v for p in series if t0 <= p.ts <= t1]


def _find_stage_ts(events: list[dict[str, Any]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for e in events:
        if e["event_type"] == "stage_change":
            out[str(e["stage"])] = float(e["ts"])
    return out


def _keyword_coverage(text: str) -> tuple[float, list[str]]:
    keywords = [
        "rag",
        "roi",
        "gmv",
        "留存",
        "转化",
        "闭环",
        "风控",
        "安全",
        "成本",
        "算力",
        "token",
        "微调",
        "提示词",
        "mvp",
        "指标",
        "实验",
        "a/b",
        "ab",
        "增长",
        "定价",
        "付费",
    ]
    low = (text or "").lower()
    hit: list[str] = []
    for k in keywords:
        if k in low:
            hit.append(k)
    cov = len(set(hit)) / max(1, len(keywords))
    return float(cov), sorted(set(hit))


def _user_utterances(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in events if e["event_type"] in ("utterance", "rebuttal") and e["speaker_id"] == "user" and e["content"]]


def _compute_response_latencies(events: list[dict[str, Any]]) -> list[float]:
    latencies: list[float] = []
    prev_non_user_ts: float | None = None
    for e in events:
        if e["event_type"] in ("utterance", "rebuttal") and e["speaker_id"] != "user" and e["content"]:
            prev_non_user_ts = float(e["ts"])
        if e["event_type"] == "stage_change":
            prev_non_user_ts = float(e["ts"])
        if e["event_type"] in ("utterance", "rebuttal") and e["speaker_id"] == "user" and e["content"]:
            if prev_non_user_ts is not None:
                latencies.append(max(0.0, float(e["ts"]) - prev_non_user_ts))
    return latencies


def _detect_pressure_moments(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    moments: list[dict[str, Any]] = []
    for e in events:
        if e["event_type"] == "interrupt":
            meta = e.get("meta") or {}
            target = ""
            if isinstance(meta, dict):
                target = str(meta.get("target_speaker_id") or "")
            if target == "user":
                moments.append({"kind": "interrupted", "ts": float(e["ts"]), "stage": e["stage"], "by": e["speaker_name"]})
    for e in events:
        if e["event_type"] == "rebuttal" and e["speaker_id"] != "user":
            moments.append({"kind": "rebuttal", "ts": float(e["ts"]), "stage": e["stage"], "by": e["speaker_name"]})
    return moments


def _user_interrupt_success(events: list[dict[str, Any]]) -> tuple[int, int]:
    attempts = 0
    success = 0
    for i, e in enumerate(events):
        if e["event_type"] != "interrupt" or e["speaker_id"] != "user":
            continue
        attempts += 1
        t0 = float(e["ts"])
        for j in range(i + 1, min(len(events), i + 30)):
            n = events[j]
            if float(n["ts"]) - t0 > 2.5:
                break
            if n["event_type"] in ("utterance", "rebuttal") and n["speaker_id"] == "user" and n["content"]:
                success += 1
                break
    return attempts, success


def _persistence_after_interrupt(events: list[dict[str, Any]]) -> float:
    received = []
    for i, e in enumerate(events):
        if e["event_type"] != "interrupt":
            continue
        meta = e.get("meta") or {}
        target = str(meta.get("target_speaker_id") or "") if isinstance(meta, dict) else ""
        if target != "user":
            continue
        received.append((i, float(e["ts"])))
    if not received:
        return 0.0
    kept = 0
    for idx, t0 in received:
        for j in range(idx + 1, min(len(events), idx + 40)):
            n = events[j]
            if float(n["ts"]) - t0 > 4.0:
                break
            if n["event_type"] in ("utterance", "rebuttal") and n["speaker_id"] == "user" and n["content"]:
                kept += 1
                break
    return kept / max(1, len(received))


def analyze_run(base_dir: str, run_id: str) -> dict[str, Any]:
    db_path = os.path.join(base_dir, "events.sqlite3")
    events = _load_events(db_path, run_id)
    if not events:
        raise RuntimeError("run_id 不存在或无事件")

    ts0 = float(events[0]["ts"])
    tsN = float(events[-1]["ts"])
    stages = _find_stage_ts(events)
    series = _extract_timeseries(events)

    user_utts = _user_utterances(events)
    user_chars = sum(len(e["content"]) for e in user_utts)
    all_utts = [e for e in events if e["event_type"] in ("utterance", "rebuttal") and e["content"]]
    all_chars = sum(len(e["content"]) for e in all_utts)
    talk_share = (user_chars / all_chars) if all_chars else 0.0

    cov, hits = _keyword_coverage(" ".join(e["content"] for e in user_utts))
    latencies = _compute_response_latencies(events)

    pressure = _detect_pressure_moments(events)
    pressure_windows: list[dict[str, Any]] = []
    for m in pressure:
        t = float(m["ts"])
        w0, w1 = t, t + 5.0
        pressure_windows.append(
            {
                **m,
                "motion_avg": _safe_mean(_window(series["motion"], w0, w1)),
                "blink_avg": _safe_mean(_window(series["blink"], w0, w1)),
                "brow_avg": _safe_mean(_window(series["brow"], w0, w1)),
                "rms_avg": _safe_mean(_window(series["rms"], w0, w1)),
            }
        )

    listen_face_ratio = 0.0
    if series["face"]:
        listen_face_ratio = _safe_mean([p.v for p in series["face"]])

    initiative = 0.0
    discuss_ts = stages.get("discuss")
    if discuss_ts is not None:
        first_user = next((e for e in user_utts if float(e["ts"]) >= discuss_ts), None)
        if first_user:
            dt = float(first_user["ts"]) - float(discuss_ts)
            initiative = 1.0 - _clamp01(dt / 20.0)

    summary_take = 0.0
    summary_ts = stages.get("summary")
    if summary_ts is not None:
        summary_user_turns = sum(1 for e in user_utts if float(e["ts"]) >= summary_ts)
        summary_take = _clamp01(summary_user_turns / 2.0)

    interruptions_made = sum(1 for e in events if e["event_type"] == "interrupt" and e["speaker_id"] == "user")
    interruptions_received = sum(
        1
        for e in events
        if e["event_type"] == "interrupt"
        and isinstance((e.get("meta") or {}), dict)
        and str((e.get("meta") or {}).get("target_speaker_id") or "") == "user"
    )

    rms_values = [p.v for p in series["rms"]]
    motion_values = [p.v for p in series["motion"]]
    blink_values = [p.v for p in series["blink"]]
    brow_values = [p.v for p in series["brow"]]

    stress_stability = 1.0
    if pressure_windows:
        motion_hi = _safe_mean([w["motion_avg"] for w in pressure_windows])
        brow_hi = _safe_mean([w["brow_avg"] for w in pressure_windows])
        rms_hi = _safe_mean([w["rms_avg"] for w in pressure_windows])
        motion_base = _safe_mean(motion_values)
        brow_base = _safe_mean(brow_values)
        rms_base = _safe_mean(rms_values)
        motion_delta = max(0.0, motion_hi - motion_base)
        brow_delta = max(0.0, brow_hi - brow_base)
        rms_delta = abs(rms_hi - rms_base)
        stress_stability = 1.0 - _clamp01((motion_delta / 30.0) * 0.45 + (brow_delta / 0.35) * 0.35 + (rms_delta / 0.25) * 0.2)

    response_quality = 1.0 - _clamp01(_safe_mean(latencies) / 6.0)
    info_density = _clamp01(cov * 1.8)
    teamwork = _clamp01(listen_face_ratio * 0.75 + (1.0 - _clamp01(_safe_mean(motion_values) / 60.0)) * 0.25)
    business = _clamp01(cov * 1.2 + (1.0 - _clamp01(_safe_mean(latencies) / 8.0)) * 0.2)

    interrupt_attempts, interrupt_success = _user_interrupt_success(events)
    interrupt_success_ratio = (interrupt_success / interrupt_attempts) if interrupt_attempts else 0.0
    persistence_ratio = _persistence_after_interrupt(events)

    score_initiative = 100.0 * _clamp01(initiative * 0.55 + talk_share * 0.25 + summary_take * 0.2)
    score_resilience = 100.0 * _clamp01(stress_stability * 0.75 + (1.0 - _clamp01(_safe_stdev(rms_values) / 0.25)) * 0.25)
    score_logic = 100.0 * _clamp01(info_density * 0.6 + response_quality * 0.4)
    score_teamwork = 100.0 * _clamp01(teamwork * 0.7 + persistence_ratio * 0.3)
    score_business = 100.0 * business

    overall = _safe_mean([score_initiative, score_resilience, score_logic, score_teamwork, score_business])
    grade = _grade(overall)

    role = "面试者"
    if talk_share >= 0.25 and score_logic >= 75:
        role = "核心输出者"
    elif talk_share >= 0.18 and initiative >= 0.6:
        role = "破冰者"
    elif summary_take >= 0.7:
        role = "收敛推进者"

    highlights: list[str] = []
    redflags: list[str] = []
    if score_resilience >= 80 and pressure_windows:
        highlights.append("高压场景下情绪与动作整体稳定，具备抗压输出能力。")
    if score_logic >= 80 and hits:
        highlights.append(f"发言覆盖关键业务词汇较多（{', '.join(hits[:8])}），信息密度较高。")
    if interrupt_attempts >= 1:
        highlights.append(f"主动打断成功率约 {interrupt_success_ratio*100:.0f}%（{interrupt_success}/{interrupt_attempts}），体现控场意愿。")
    if listen_face_ratio < 0.7:
        redflags.append("倾听阶段人脸稳定出现率偏低，可能被认为注意力不集中。")
    if _safe_mean(motion_values) > 45:
        redflags.append("整体动作幅度偏大，可能暴露紧张或坐立不安。")
    if _safe_mean(latencies) > 5.0:
        redflags.append("平均接话延迟偏高，容易错过抢位或控场时机。")

    report = {
        "run_id": run_id,
        "time_range": {"start_ts": ts0, "end_ts": tsN, "duration_s": max(0.0, tsN - ts0)},
        "stage_ts": stages,
        "raw": {
            "user_utterance_turns": len(user_utts),
            "user_chars": user_chars,
            "talk_share": talk_share,
            "interruptions_made": interruptions_made,
            "interruptions_received": interruptions_received,
            "interrupt_attempts": interrupt_attempts,
            "interrupt_success": interrupt_success,
            "interrupt_success_ratio": interrupt_success_ratio,
            "persistence_after_interrupt": persistence_ratio,
            "keyword_coverage": cov,
            "keyword_hits": hits,
            "response_latencies_s": latencies,
            "pressure_windows": pressure_windows,
            "rms_mean": _safe_mean(rms_values),
            "motion_mean": _safe_mean(motion_values),
            "blink_mean": _safe_mean(blink_values),
            "brow_mean": _safe_mean(brow_values),
            "face_ratio": listen_face_ratio,
        },
        "scores": {
            "overall": overall,
            "grade": grade,
            "initiative_ice_breaking": score_initiative,
            "resilience_eq": score_resilience,
            "logical_thinking": score_logic,
            "empathy_teamwork": score_teamwork,
            "business_acumen": score_business,
        },
        "summary": {
            "role": role,
            "one_liner": "你的输出结构性较强，但需要在高压与抢位时保持更稳定的节奏与身体状态。"
            if overall >= 75
            else "你需要提升抢位与输出密度，同时在高压情境下保持稳定与专注。",
            "highlights": highlights,
            "red_flags": redflags,
        },
    }

    report["intervals"] = build_interval_report(report, events, series, interval_s=300)
    return report


def build_interval_report(report: dict[str, Any], events: list[dict[str, Any]], series: dict[str, list[_Point]], interval_s: int) -> list[dict[str, Any]]:
    ts0 = float(report["time_range"]["start_ts"])
    tsN = float(report["time_range"]["end_ts"])
    n = int(math.ceil(max(0.0, tsN - ts0) / float(interval_s))) or 1

    out: list[dict[str, Any]] = []
    user_utts = [e for e in events if e["event_type"] in ("utterance", "rebuttal") and e["speaker_id"] == "user" and e["content"]]

    for i in range(n):
        a = ts0 + i * interval_s
        b = min(tsN, a + interval_s)
        seg_utts = [e for e in user_utts if a <= float(e["ts"]) < b]
        seg_text = " ".join(e["content"] for e in seg_utts)
        cov, _hits = _keyword_coverage(seg_text)
        motion_avg = _safe_mean(_window(series["motion"], a, b))
        face_ratio = _safe_mean(_window(series["face"], a, b))
        blink_avg = _safe_mean(_window(series["blink"], a, b))
        brow_avg = _safe_mean(_window(series["brow"], a, b))
        rms_avg = _safe_mean(_window(series["rms"], a, b))

        positioning = "面试者"
        if len(seg_utts) >= 3:
            positioning = "核心输出者"
        elif len(seg_utts) >= 1:
            positioning = "补充辅助者"
        if cov >= 0.2 and len(seg_utts) >= 2:
            positioning = "高密度输出者"

        advice: list[str] = []
        if len(seg_utts) == 0:
            advice.append("避免静默过久：用控时/对齐指标/总结共识的方式重新进入讨论。")
        if motion_avg > 45:
            advice.append("动作幅度偏大：尝试放慢语速、稳定坐姿、保持镜头内正视。")
        if face_ratio < 0.7:
            advice.append("镜头存在感不足：保持人脸稳定出镜，避免频繁离开镜头。")
        if cov < 0.12 and len(seg_utts) >= 1:
            advice.append("信息密度偏低：用“目标-指标-约束-方案-验证”的结构提升穿透力。")

        out.append(
            {
                "window": {"start_s": i * interval_s, "end_s": min((i + 1) * interval_s, int(tsN - ts0))},
                "positioning": positioning,
                "metrics": {
                    "user_turns": len(seg_utts),
                    "keyword_coverage": cov,
                    "motion_avg": motion_avg,
                    "face_ratio": face_ratio,
                    "blink_avg": blink_avg,
                    "brow_avg": brow_avg,
                    "rms_avg": rms_avg,
                },
                "advice": advice,
            }
        )
    return out


def save_report(base_dir: str, run_id: str, report: dict[str, Any]) -> tuple[str, str]:
    run_dir = os.path.join(base_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    json_path = os.path.join(run_dir, "assessment.json")
    md_path = os.path.join(run_dir, "assessment.md")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(render_report_md(report))
    return json_path, md_path


def render_report_md(report: dict[str, Any]) -> str:
    s = report.get("scores") or {}
    sm = report.get("summary") or {}
    raw = report.get("raw") or {}
    lines: list[str] = []
    lines.append(f"# 群面表现报告（run_id: {report.get('run_id')}）")
    lines.append("")
    lines.append("## 1) 面试综合鉴定")
    lines.append(f"- 整体评级：{s.get('grade')}（{s.get('overall'):.1f}）")
    lines.append(f"- 显性角色：{sm.get('role')}")
    lines.append(f"- 一句话点评：{sm.get('one_liner')}")
    lines.append("")
    lines.append("## 2) 核心能力评分（1-100）")
    lines.append(f"- 全局观与破冰力：{s.get('initiative_ice_breaking'):.1f}")
    lines.append(f"- 抗压与情绪颗粒度：{s.get('resilience_eq'):.1f}")
    lines.append(f"- 逻辑与结构化思维：{s.get('logical_thinking'):.1f}")
    lines.append(f"- 倾听与协同配合：{s.get('empathy_teamwork'):.1f}")
    lines.append(f"- 业务敏锐度：{s.get('business_acumen'):.1f}")
    lines.append("")
    lines.append("## 3) 行为高光与雷区复盘")
    lines.append("- 高光时刻：")
    for x in sm.get("highlights") or []:
        lines.append(f"  - {x}")
    if not (sm.get("highlights") or []):
        lines.append("  - （暂无显著高光，建议提升结构化表达与控场）")
    lines.append("- 致命雷区：")
    for x in sm.get("red_flags") or []:
        lines.append(f"  - {x}")
    if not (sm.get("red_flags") or []):
        lines.append("  - （暂无明显雷区）")
    lines.append("")
    lines.append("## 4) 关键数据概览")
    lines.append(f"- 你的发言次数：{raw.get('user_utterance_turns')}（话语占比约 {raw.get('talk_share', 0.0)*100:.1f}%）")
    lines.append(f"- 关键词覆盖率：{raw.get('keyword_coverage', 0.0)*100:.1f}%")
    lines.append(f"- 平均接话延迟：{_safe_mean(list(raw.get('response_latencies_s') or [])):.2f}s")
    lines.append(f"- 被打断次数：{raw.get('interruptions_received')}｜主动打断次数：{raw.get('interruptions_made')}")
    lines.append("")
    lines.append("## 5) 黄金时间轴复盘（5分钟切片）")
    def fmt_mmss(sec: int) -> str:
        m = int(sec) // 60
        s2 = int(sec) % 60
        return f"{m:02d}:{s2:02d}"
    for seg in report.get("intervals") or []:
        w = seg["window"]
        m = seg["metrics"]
        lines.append(f"### ▶️ {fmt_mmss(int(w['start_s']))} - {fmt_mmss(int(w['end_s']))}")
        lines.append(f"- 定位：{seg['positioning']}")
        lines.append(
            "- 数据表现："
            f"发言 {m['user_turns']} 次｜keyword {m['keyword_coverage']*100:.1f}%｜"
            f"motion {m['motion_avg']:.1f}｜face {m['face_ratio']*100:.1f}%｜"
            f"blink {m['blink_avg']:.2f}｜brow {m['brow_avg']:.2f}"
        )
        adv = seg.get("advice") or []
        if adv:
            lines.append("- AI 建议：")
            for a in adv:
                lines.append(f"  - {a}")
        lines.append("")
    return "\n".join(lines) + "\n"
