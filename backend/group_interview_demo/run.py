from __future__ import annotations

import argparse
import asyncio
import os
import random

from group_interview_demo.collector import RunCollector
from group_interview_demo.personas import ensure_default_personas, load_personas
from group_interview_demo.simulator import GroupInterviewSimulator, new_run_id
from group_interview_demo.topics import ensure_default_topics, load_topics
from group_interview_demo.voice_io import VoiceConfig, VoiceInput, VoiceTTS, default_vosk_model_hint


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--mode", type=str, default="mock", choices=["mock", "llm"])
    p.add_argument("--api-key", type=str, default="")
    p.add_argument("--model", type=str, default="glm-4-flash")
    p.add_argument("--base-dir", type=str, default="group_interview_runs")
    p.add_argument("--topics", type=str, default="")
    p.add_argument("--topic-index", type=int, default=None)
    p.add_argument("--personas", type=str, default="")
    p.add_argument("--read-seconds", type=int, default=20)
    p.add_argument("--discuss-seconds", type=int, default=180)
    p.add_argument("--speak-min", type=int, default=10)
    p.add_argument("--speak-max", type=int, default=20)
    p.add_argument("--p-interrupt", type=float, default=0.18)
    p.add_argument("--p-rebuttal", type=float, default=0.22)
    p.add_argument("--agent-count", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--no-reply-after-user", action="store_true")
    p.add_argument("--reply-delay-min", type=float, default=0.8)
    p.add_argument("--reply-delay-max", type=float, default=1.6)
    p.add_argument("--voice", action="store_true")
    p.add_argument("--list-audio-devices", action="store_true")
    p.add_argument("--vosk-model", type=str, default="")
    p.add_argument("--input-device", type=int, default=-1)
    p.add_argument("--vad-rms-threshold", type=int, default=450)
    p.add_argument("--vad-hold-ms", type=int, default=250)
    p.add_argument("--no-tts", action="store_true")
    p.add_argument("--tts-rate", type=int, default=185)
    p.add_argument("--tts-backend", type=str, default="pyttsx3", choices=["pyttsx3", "powershell"])
    p.add_argument("--no-barge-in", action="store_true")
    return p.parse_args()


async def main_async() -> None:
    args = parse_args()
    if bool(args.list_audio_devices):
        import sounddevice as sd

        print(sd.query_devices(), flush=True)
        return
    data_dir = os.path.join(os.path.dirname(__file__), "data")
    topics_path = args.topics.strip() or ensure_default_topics(data_dir)
    personas_path = args.personas.strip() or ensure_default_personas(data_dir)
    topics = load_topics(topics_path)
    pool = load_personas(personas_path)
    if not topics:
        raise RuntimeError("题库为空")
    if not pool:
        raise RuntimeError("人设为空")
    agent_count = int(args.agent_count)
    if agent_count <= 0:
        raise RuntimeError("agent-count 必须为正整数")
    if agent_count > len(pool):
        raise RuntimeError(f"agent-count 超范围：1..{len(pool)}")
    rng = random.Random(int(args.seed)) if int(args.seed) else random.Random()
    agents = rng.sample(pool, k=agent_count)
    if args.topic_index is None:
        topic = rng.choice(topics)
    else:
        topic_index = int(args.topic_index)
        if topic_index < 0 or topic_index >= len(topics):
            raise RuntimeError(f"topic-index 超范围：0..{len(topics)-1}")
        topic = topics[topic_index]

    run_id = new_run_id()
    collector = RunCollector(args.base_dir, run_id)
    try:
        names = "、".join([a.display_name for a in agents])
        collector.record_stage_change("read", f"本场参与的AI组员：{names}")
        collector.record_stage_change("read", f"本场题目：{topic.topic_id} {topic.title}")
        voice_input = None
        voice_tts = None
        if bool(args.voice):
            try:
                input_device = None if int(args.input_device) < 0 else int(args.input_device)
                cfg = VoiceConfig(
                    vosk_model_path=str(args.vosk_model or "").strip(),
                    input_device=input_device,
                    vad_rms_threshold=int(args.vad_rms_threshold),
                    vad_hold_ms=int(args.vad_hold_ms),
                    tts_enabled=not bool(args.no_tts),
                    tts_rate=int(args.tts_rate),
                    tts_backend=str(args.tts_backend),
                )
                voice_input = VoiceInput(cfg)
                voice_tts = VoiceTTS(cfg) if cfg.tts_enabled else None
                if voice_tts:
                    print("语音模式提示：建议佩戴耳机，否则播报声音可能被麦克风识别为“打断”。", flush=True)
            except Exception as e:
                raise RuntimeError(f"语音模式初始化失败：{e}\n{default_vosk_model_hint()}")
        sim = GroupInterviewSimulator(
            topic=topic,
            agents=agents,
            collector=collector,
            mode=args.mode,
            api_key=args.api_key,
            model_name=args.model,
            speak_interval_min=args.speak_min,
            speak_interval_max=args.speak_max,
            p_interrupt=args.p_interrupt,
            p_rebuttal=args.p_rebuttal,
            discuss_seconds=args.discuss_seconds,
            read_seconds=args.read_seconds,
            reply_after_user=not bool(args.no_reply_after_user),
            reply_delay_min=float(args.reply_delay_min),
            reply_delay_max=float(args.reply_delay_max),
            voice_input=voice_input,
            voice_tts=voice_tts,
            barge_in=not bool(args.no_barge_in),
        )
        metrics = await sim.run()
    finally:
        collector.close()

    print("\n=== 数据输出 ===")
    print(f"run_id: {run_id}")
    print(f"transcript: {os.path.join(args.base_dir, run_id, 'transcript.jsonl')}")
    print(f"metrics: {os.path.join(args.base_dir, run_id, 'metrics.json')}")
    print(f"db: {os.path.join(args.base_dir, 'events.sqlite3')}")
    print(f"user_utterance_turns: {metrics.get('user_utterance_turns')}")


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
