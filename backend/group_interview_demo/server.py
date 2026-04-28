from __future__ import annotations

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
import queue
import re
import threading
import time
from typing import Any

from aiohttp import web

from group_interview_demo.collector import RunCollector
from group_interview_demo.llm_client import BigModelChatClient
from group_interview_demo.models import Event
from group_interview_demo.personas import load_personas
from group_interview_demo.simulator import GroupInterviewSimulator, new_run_id
from group_interview_demo.topics import load_topics
from group_interview_demo.tts_generator import generate_tts_audio_url


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--host", type=str, default="127.0.0.1")
    p.add_argument("--port", type=int, default=8799)
    p.add_argument("--base-dir", type=str, default="group_interview_runs")
    p.add_argument("--topics", type=str, default=os.path.join(os.path.dirname(__file__), "data", "topics.json"))
    p.add_argument("--personas", type=str, default=os.path.join(os.path.dirname(__file__), "data", "personas.json"))
    p.add_argument("--agent-count", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--mode", type=str, default="mock", choices=["mock", "llm"])
    p.add_argument("--api-key", type=str, default="")
    p.add_argument("--model", type=str, default="glm-4-flash")
    p.add_argument("--read-seconds", type=int, default=20)
    p.add_argument("--discuss-seconds", type=int, default=180)
    p.add_argument("--speak-min", type=int, default=16)
    p.add_argument("--speak-max", type=int, default=28)
    p.add_argument("--p-interrupt", type=float, default=0.10)
    p.add_argument("--p-rebuttal", type=float, default=0.18)
    p.add_argument("--reply-delay-min", type=float, default=1.6)
    p.add_argument("--reply-delay-max", type=float, default=2.8)
    p.add_argument(
        "--vosk-model",
        type=str,
        default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models", "vosk-model-small-cn-0.22")),
    )
    p.add_argument("--no-asr", action="store_true")
    return p.parse_args()


def _abs_path(rel: str) -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), rel))


def _no_store_file(path: str) -> web.FileResponse:
    return web.FileResponse(
        path,
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
        },
    )

def _cors_headers(request: web.Request) -> dict[str, str]:
    origin = str(request.headers.get("Origin") or "")
    allowed = {"http://localhost:5173", "http://127.0.0.1:5173"}
    if origin in allowed:
        return {
            "Access-Control-Allow-Origin": origin,
            "Vary": "Origin",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Max-Age": "86400",
        }
    return {}


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        return web.Response(status=200, headers=_cors_headers(request))
    resp = await handler(request)
    try:
        for k, v in _cors_headers(request).items():
            resp.headers[k] = v
    except Exception:
        pass
    return resp


def _compute_and_save_report(base_dir: str, run_id: str) -> tuple[str, str]:
    from group_interview_demo.assessment import analyze_run, save_report

    report = analyze_run(base_dir, run_id)
    return save_report(base_dir, run_id, report)


FIGMA_IMAGE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".figma", "image"))


SOLO_BASE_FLOW = [
    "请你用 1 分钟做一个自我介绍，重点突出和产品/用户体验相关的经历。",
    "为什么想做产品经理？",
    "为什么选择我们公司 / 这个岗位？",
    "你理解的产品经理是做什么的？",
    "你未来 3–5 年的职业规划是什么？",
]


def _extract_role_hint(speaker_name: str) -> str:
    s = (speaker_name or "").strip()
    low = s.lower()
    if "hr" in low:
        return "HR"
    if "leader" in low or "主管" in s or "总监" in s:
        return "Leader"
    if "面试官" in s or "interviewer" in low or "业务" in s:
        return "Interviewer"
    return s or "Interviewer"


def _pick_voice_for_speaker(speaker_id: str, role_hint: str) -> str:
    # 固定映射：同一 speaker_id 在同一场里保持稳定音色，避免“全员同音”
    pool = [
        "zh-CN-XiaoxiaoNeural",
        "zh-CN-YunxiNeural",
        "zh-CN-XiaoyiNeural",
        "zh-CN-YunjianNeural",
    ]
    low = str(role_hint or "").lower()
    if "hr" in low:
        return "zh-CN-XiaoxiaoNeural"
    if "leader" in low:
        return "zh-CN-YunjianNeural"
    sid = str(speaker_id or "")
    idx = sum(ord(ch) for ch in sid) % len(pool) if sid else 0
    return pool[idx]


class SoloInterviewSession:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.question_idx = 0
        self.followup_count = 0
        self.pressure_level = 1
        self.history: list[dict[str, Any]] = []
        self.client: BigModelChatClient | None = None
        if str(args.mode or "").strip().lower() == "llm":
            self.client = BigModelChatClient(api_key=args.api_key, model_name=args.model)

    def _system_prompt(self) -> str:
        flow = "\n".join([f"- {q}" for q in SOLO_BASE_FLOW])
        return (
            "你是一位互联网大厂的资深面试官，正在面试候选人的用户体验(UX)与产品实习岗位。\n"
            "规则：\n"
            "1) 每次只说 1-2 句话。\n"
            "2) 每次只问 1 个问题（必要时先 1 句点评，再 1 句提问）。\n"
            "3) 绝不输出多余的解释、总结、格式化标题或编号。\n"
            "4) 绝对口语化：严禁书面语/公文腔（例如“就此问题”“综上所述”“因此可见”）。长句拆短句。\n"
            "5) 自然语气词：开头可以用“嗯”“好”“那”“其实”“我明白”等缓冲词，但不要堆叠。\n"
            "6) 专业但随意：别像客服一样过度礼貌，也别像冷冰冰的指令机。\n"
            "7) 表达示范：不要说“你的回答抽象，请举例”。更像真人：\"嗯，听下来有点抽象哈，能不能结合你之前的项目，给我举个具体的例子？\"\n"
            "面试流程（按顺序推进）：\n"
            f"{flow}\n"
        )

    def _decide_intent(self, user_text: str) -> str:
        t = (user_text or "").strip()
        if not t:
            return "repeat"
        if self.question_idx >= len(SOLO_BASE_FLOW):
            return "wrap"
        if self.followup_count >= 2:
            return "next"
        if len(t) < 24:
            return "followup"
        if self.followup_count == 0 and self.pressure_level >= 2:
            return "followup"
        return "next"

    def _next_base_question(self) -> str:
        if self.question_idx >= len(SOLO_BASE_FLOW):
            return "好的，今天先到这里。你还有什么想补充的吗？"
        return SOLO_BASE_FLOW[self.question_idx]

    def _mock_reply(self, intent: str, user_text: str) -> str:
        if intent == "repeat":
            return "我没听清，你能再说一遍吗？"
        if intent == "wrap":
            return "好的，今天先到这里。你还有什么想补充的吗？"
        if intent == "followup":
            self.pressure_level = min(3, self.pressure_level + 1)
            return "能给一个更具体的例子吗？你当时怎么做、结果是什么？"
        return self._next_base_question()

    def _build_messages(self, intent: str, user_text: str) -> list[dict[str, Any]]:
        curr_q = self._next_base_question()
        state = f"当前题目：{curr_q}\n当前追问次数：{self.followup_count}\n压力等级：{self.pressure_level}\n意图：{intent}\n"
        msgs: list[dict[str, Any]] = [{"role": "system", "content": self._system_prompt()}]
        msgs.append({"role": "system", "content": state})
        for m in self.history[-8:]:
            msgs.append(m)
        msgs.append({"role": "user", "content": user_text})
        return msgs

    def _advance_state_after_ask(self, intent: str) -> None:
        if intent == "followup":
            self.followup_count += 1
            return
        if intent == "next":
            self.question_idx += 1
            self.followup_count = 0
            self.pressure_level = max(1, self.pressure_level - 1)

    async def _send_stream(self, ws: web.WebSocketResponse, speaker_id: str, speaker_name: str, text: str) -> None:
        if ws.closed:
            return
        full = (text or "").strip()
        if not full:
            return
        ts_ms = int(time.time() * 1000)
        role = _extract_role_hint(speaker_name)
        audio_url = ""
        try:
            audio_url = await asyncio.wait_for(generate_tts_audio_url(full, "zh-CN-XiaoxiaoNeural"), timeout=10.0)
        except Exception:
            audio_url = ""
        payload = {
            "type": "agent_speak",
            "ts_ms": ts_ms,
            "speaker_id": speaker_id,
            "speaker_name": speaker_name,
            "role": role,
            "content": full,
            "text": full,
            "audio_url": audio_url,
        }
        await ws.send_str(json.dumps(payload, ensure_ascii=False))

    async def start(self, ws: web.WebSocketResponse) -> None:
        self.question_idx = 0
        self.followup_count = 0
        self.pressure_level = 1
        self.history = []
        await self._send_stream(ws, "interviewer", "Interviewer", self._next_base_question())

    async def on_user_text(self, ws: web.WebSocketResponse, user_text: str) -> None:
        t = (user_text or "").strip()
        if not t:
            return
        intent = self._decide_intent(t)
        self.history.append({"role": "user", "content": t})
        if self.client is None:
            out = self._mock_reply(intent, t)
            if intent in ("followup", "next"):
                self._advance_state_after_ask(intent)
            self.history.append({"role": "assistant", "content": out})
            await self._send_stream(ws, "interviewer", "Interviewer", out)
            return

        msgs = self._build_messages(intent, t)
        try:
            out, _lat = await asyncio.to_thread(self.client.chat, msgs, temperature=0.5, top_p=0.9, max_tokens=160)
        except Exception as e:
            out = f"我这边出现了点问题：{e}"
        out = str(out or "").strip()
        if not out:
            out = self._mock_reply(intent, t)
        if intent in ("followup", "next"):
            self._advance_state_after_ask(intent)
        self.history.append({"role": "assistant", "content": out})
        await self._send_stream(ws, "interviewer", "Interviewer", out)


class Session:

    def __init__(self, args: argparse.Namespace, vosk_model: Any | None, asr_warning: str, report_executor: ThreadPoolExecutor | None) -> None:
        self.args = args
        self.run_id = new_run_id()
        self.collector = RunCollector(args.base_dir, self.run_id)
        self._ws: web.WebSocketResponse | None = None
        self._sim: GroupInterviewSimulator | None = None
        self._sim_task: asyncio.Task[dict[str, Any]] | None = None
        self._stopped = False
        self._pause_until = 0.0
        self.client_mode = "GROUP"
        self._solo: SoloInterviewSession | None = None
        self._asr_enabled = False
        self._asr_warning = ""
        self._topic_sent = False
        self._report_ready = False
        self._report_json_path = ""
        self._report_md_path = ""
        self._report_task: asyncio.Task[None] | None = None
        self._report_executor = report_executor

        self._topics = load_topics(os.path.abspath(args.topics))
        self._pool = load_personas(os.path.abspath(args.personas))
        if not self._topics:
            raise RuntimeError("题库为空")
        if not self._pool:
            raise RuntimeError("人设为空")
        import random

        self._rng = random.Random(int(args.seed)) if int(args.seed) else random.Random()
        if args.agent_count <= 0 or args.agent_count > len(self._pool):
            raise RuntimeError("agent-count 超范围")
        self.agents = self._rng.sample(self._pool, k=int(args.agent_count))
        self.topic = None

        self._vosk = vosk_model
        self._loop: asyncio.AbstractEventLoop | None = None
        self._asr_stop: threading.Event | None = None
        self._asr_q: queue.Queue[bytes] | None = None
        self._asr_thread: threading.Thread | None = None
        if bool(args.no_asr):
            self._asr_enabled = False
            self._asr_warning = "ASR 已关闭：将忽略麦克风音频流；可使用页面底部“打字发送”参与讨论。"
            self._rec = None
        else:
            if self._vosk is None:
                self._asr_enabled = False
                self._asr_warning = asr_warning or "未启用服务端 ASR：当前将忽略麦克风音频流，可使用“打字发送”。"
                self._rec = None
            else:
                try:
                    from vosk import KaldiRecognizer

                    self._rec = KaldiRecognizer(self._vosk, 16000)
                    self._asr_enabled = True
                except Exception as e:
                    self._asr_enabled = False
                    self._asr_warning = f"Vosk 初始化失败：{e}；当前将忽略麦克风音频流，可使用“打字发送”。"
                    self._vosk = None
                    self._rec = None
        if self._asr_enabled and self._rec is not None:
            self._asr_stop = threading.Event()
            self._asr_q = queue.Queue(maxsize=48)

    def _start_asr_worker(self) -> None:
        if not self._asr_enabled or self._rec is None or self._asr_stop is None or self._asr_q is None:
            return
        if self._loop is None:
            return
        if self._asr_thread is not None:
            return

        def worker() -> None:
            last_partial_sent = ""
            last_partial_ts = 0.0
            while not self._asr_stop.is_set():
                try:
                    chunk = self._asr_q.get(timeout=0.2)
                except queue.Empty:
                    continue
                try:
                    ok = self._rec.AcceptWaveform(chunk)
                except Exception:
                    continue
                if ok:
                    try:
                        res = json.loads(self._rec.Result() or "{}")
                    except json.JSONDecodeError:
                        res = {}
                    text = str(res.get("text") or "").strip()
                    if not text:
                        continue
                    ts_ms = int(time.time() * 1000)

                    async def emit_final() -> None:
                        if self._ws is not None and not self._ws.closed:
                            await self._ws.send_str(json.dumps({"type": "user_final", "ts_ms": ts_ms, "text": text}, ensure_ascii=False))
                        await self.on_user_text(text)

                    try:
                        asyncio.run_coroutine_threadsafe(emit_final(), self._loop)
                    except Exception:
                        pass
                else:
                    try:
                        res = json.loads(self._rec.PartialResult() or "{}")
                    except json.JSONDecodeError:
                        res = {}
                    ptext = str(res.get("partial") or "").strip()
                    now = time.monotonic()
                    if now - last_partial_ts < 0.2 and ptext == last_partial_sent:
                        continue
                    last_partial_ts = now
                    last_partial_sent = ptext

                    async def emit_partial() -> None:
                        if self._ws is not None and not self._ws.closed:
                            await self._ws.send_str(json.dumps({"type": "user_partial", "text": ptext}, ensure_ascii=False))

                    try:
                        asyncio.run_coroutine_threadsafe(emit_partial(), self._loop)
                    except Exception:
                        pass

            try:
                self._rec.FinalResult()
            except Exception:
                pass

        self._asr_thread = threading.Thread(target=worker, daemon=True)
        self._asr_thread.start()

    def ensure_solo(self) -> SoloInterviewSession:
        if self._solo is None:
            self._solo = SoloInterviewSession(self.args)
        return self._solo

    def _ensure_sim(self) -> None:
        if self.client_mode == "SOLO":
            return
        if self._sim is not None:
            return
        self.topic = self._rng.choice(self._topics)
        self.collector.record_stage_change("read", f"本场参与的AI组员：{'、'.join([a.display_name for a in self.agents])}")
        self.collector.record_stage_change("read", f"本场题目：{self.topic.topic_id} {self.topic.title}")
        sim = GroupInterviewSimulator(
            topic=self.topic,
            agents=self.agents,
            collector=self.collector,
            mode=self.args.mode,
            api_key=self.args.api_key,
            model_name=self.args.model,
            speak_interval_min=self.args.speak_min,
            speak_interval_max=self.args.speak_max,
            p_interrupt=self.args.p_interrupt,
            p_rebuttal=self.args.p_rebuttal,
            discuss_seconds=self.args.discuss_seconds,
            read_seconds=self.args.read_seconds,
            reply_after_user=True,
            reply_delay_min=float(self.args.reply_delay_min),
            reply_delay_max=float(self.args.reply_delay_max),
            barge_in=True,
            quiet=True,
        )

        orig_record_and_print = sim._record_and_print

        def hooked(event: Event) -> None:
            orig_record_and_print(event)
            if self._ws is None or self._ws.closed:
                return
            if time.time() < self._pause_until:
                return
            if event.event_type in ("utterance", "rebuttal") and event.speaker_id != "user":
                asyncio.create_task(self._emit_agent_speak(event))
            if event.event_type == "stage_change":
                payload = {"type": "stage", "ts_ms": int(event.ts * 1000), "stage": event.stage, "content": event.content}
                asyncio.create_task(self._ws.send_str(json.dumps(payload, ensure_ascii=False)))

        sim._record_and_print = hooked
        self._sim = sim

    async def _emit_agent_speak(self, event: Event) -> None:
        if self._ws is None or self._ws.closed:
            return
        full = str(event.content or "").strip()
        if not full:
            return
        ts_ms = int(event.ts * 1000) if event.ts else int(time.time() * 1000)
        role = _extract_role_hint(str(event.speaker_name or ""))
        voice = _pick_voice_for_speaker(str(event.speaker_id or ""), role)
        audio_url = ""
        try:
            audio_url = await asyncio.wait_for(generate_tts_audio_url(full, voice), timeout=10.0)
        except Exception:
            audio_url = ""
        payload = {
            "type": "agent_speak",
            "ts_ms": ts_ms,
            "speaker_id": str(event.speaker_id or ""),
            "speaker_name": str(event.speaker_name or ""),
            "role": role,
            "content": full,
            "text": full,
            "audio_url": audio_url,
        }
        await self._ws.send_str(json.dumps(payload, ensure_ascii=False))

    async def on_user_text(self, text: str) -> None:
        if self._ws is None or self._ws.closed:
            return
        t = (text or "").strip()
        if not t:
            return
        if self.client_mode == "SOLO":
            solo = self.ensure_solo()
            await solo.on_user_text(self._ws, t)
            return
        if self._sim:
            await self._sim._handle_user_line(t)

    async def aclose(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self._asr_stop is not None:
            try:
                self._asr_stop.set()
            except Exception:
                pass
        if self._asr_thread is not None:
            try:
                self._asr_thread.join(timeout=0.8)
            except Exception:
                pass
            self._asr_thread = None
        if self._sim_task and not self._sim_task.done():
            self._sim_task.cancel()
            try:
                await asyncio.wait_for(self._sim_task, timeout=1.0)
            except Exception:
                pass
        try:
            self.collector.close()
        except Exception:
            pass

    async def attach_ws(self, ws: web.WebSocketResponse) -> None:
        self._ws = ws
        self._loop = asyncio.get_running_loop()
        self._start_asr_worker()
        await ws.send_str(
            json.dumps(
                {
                    "type": "hello",
                    "run_id": self.run_id,
                    "stage": "idle",
                    "agents": [{"speaker_id": a.agent_id, "speaker_name": a.display_name} for a in self.agents],
                    "asr_enabled": bool(self._asr_enabled),
                    "asr_warning": self._asr_warning,
                },
                ensure_ascii=False,
            )
        )

    async def barge_in(self) -> None:
        if not self._sim:
            return
        self._pause_until = time.time() + 2.4
        if self._sim._continuation_task and not self._sim._continuation_task.done():
            self._sim._continuation_task.cancel()
        event = Event(
            run_id=self.run_id,
            ts=time.time(),
            stage=self._sim.stage,
            speaker_id="client",
            speaker_name="浏览器",
            event_type="interrupt",
            content="",
            meta={"barge_in": True},
        )
        self.collector.record(event)
        if self._ws is not None and not self._ws.closed:
            await self._ws.send_str(json.dumps({"type": "user_partial", "text": ""}, ensure_ascii=False))
        self._sim._handle_voice_interrupt()

    async def feed_audio(self, pcm16_bytes: bytes) -> None:
        if not self._asr_enabled or not self._rec or self._asr_q is None:
            return
        try:
            self._asr_q.put_nowait(pcm16_bytes)
        except queue.Full:
            try:
                self._asr_q.get_nowait()
            except queue.Empty:
                return
            try:
                self._asr_q.put_nowait(pcm16_bytes)
            except queue.Full:
                return

    async def start(self) -> None:
        if self._sim_task:
            return
        self._ensure_sim()
        assert self._sim is not None
        self._sim_task = asyncio.create_task(self._sim.run())

    async def start_with_params(self, discuss_minutes: int | None) -> None:
        if self._sim_task:
            return
        if self.client_mode == "SOLO":
            solo = self.ensure_solo()
            if self._ws is not None and not self._ws.closed:
                await solo.start(self._ws)
            return
        self._ensure_sim()
        assert self._sim is not None
        if discuss_minutes is not None:
            m = max(5, int(discuss_minutes))
            m = int(m / 5) * 5
            self._sim.discuss_seconds = m * 60
        if self._ws is not None and not self._ws.closed and self.topic and not self._topic_sent:
            self._topic_sent = True
            await self._ws.send_str(
                json.dumps(
                    {
                        "type": "topic",
                        "topic_id": self.topic.topic_id,
                        "title": self.topic.title,
                        "content": self.topic.content,
                        "read_seconds": int(self.args.read_seconds),
                    },
                    ensure_ascii=False,
                )
            )
        self._sim_task = asyncio.create_task(self._sim.run())

    async def end_discuss(self) -> None:
        if self._sim:
            self._sim.stage = "summary"

    async def finish(self) -> tuple[str, str]:
        if not self._sim:
            if self._ws is not None and not self._ws.closed:
                await self._ws.send_str(json.dumps({"type": "done", "run_id": self.run_id}, ensure_ascii=False))
            return "", ""
        self._sim.stage = "summary"
        if not self._sim_task:
            self._sim_task = asyncio.create_task(self._sim.run())
        try:
            await asyncio.wait_for(self._sim_task, timeout=15.0)
        except Exception:
            pass
        from group_interview_demo.assessment import analyze_run, save_report

        report = analyze_run(self.args.base_dir, self.run_id)
        json_path, md_path = save_report(self.args.base_dir, self.run_id, report)
        if self._ws is not None and not self._ws.closed:
            await self._ws.send_str(
                json.dumps(
                    {
                        "type": "done",
                        "run_id": self.run_id,
                        "assessment_json": json_path,
                        "assessment_md": md_path,
                    },
                    ensure_ascii=False,
                )
            )
        return json_path, md_path

    async def _generate_report(self) -> None:
        try:
            if self._report_executor is None:
                return
            loop = asyncio.get_running_loop()
            json_path, md_path = await loop.run_in_executor(self._report_executor, _compute_and_save_report, self.args.base_dir, self.run_id)
            self._report_ready = True
            self._report_json_path = json_path
            self._report_md_path = md_path
            print(f"[report] ready run_id={self.run_id}", flush=True)
            if self._ws is not None and not self._ws.closed:
                await self._ws.send_str(
                    json.dumps(
                        {
                            "type": "report_ready",
                            "run_id": self.run_id,
                            "assessment_json": json_path,
                            "assessment_md": md_path,
                        },
                        ensure_ascii=False,
                    )
                )
        except Exception as e:
            print(f"[report] failed run_id={self.run_id}: {e}", flush=True)

    async def stop_and_prepare_report(self) -> None:
        if self._sim:
            self._sim.stage = "summary"
        if self._sim_task and not self._sim_task.done():
            self._sim_task.cancel()
            try:
                await asyncio.wait_for(self._sim_task, timeout=1.0)
            except Exception:
                pass

        if self._ws is not None and not self._ws.closed:
            await self._ws.send_str(json.dumps({"type": "stopped", "run_id": self.run_id}, ensure_ascii=False))

        if self._report_ready:
            return
        if self._report_task and not self._report_task.done():
            return
        self._report_task = asyncio.create_task(self._generate_report())


async def handle_index(request: web.Request) -> web.Response:
    path = os.path.join(os.path.dirname(__file__), "home.html")
    return _no_store_file(path)


async def handle_debug(request: web.Request) -> web.Response:
    path = os.path.join(os.path.dirname(__file__), "debug.html")
    return _no_store_file(path)


async def handle_group(request: web.Request) -> web.Response:
    path = os.path.join(os.path.dirname(__file__), "index.html")
    return _no_store_file(path)


async def handle_report(request: web.Request) -> web.Response:
    path = os.path.join(os.path.dirname(__file__), "report.html")
    return _no_store_file(path)


async def handle_growth(request: web.Request) -> web.Response:
    path = os.path.join(os.path.dirname(__file__), "growth.html")
    return _no_store_file(path)


async def handle_api_report(request: web.Request) -> web.Response:
    run_id = str(request.match_info.get("run_id") or "").strip()
    if not re.fullmatch(r"[0-9a-f]{12}", run_id):
        raise web.HTTPNotFound()
    base_dir = request.app["args"].base_dir
    json_path = os.path.join(base_dir, run_id, "assessment.json")
    if not os.path.exists(json_path):
        ex = request.app.get("report_executor")
        if ex is not None:
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(ex, _compute_and_save_report, base_dir, run_id)
            except Exception:
                pass
        if not os.path.exists(json_path):
            raise web.HTTPNotFound()
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return web.json_response(data)


def _infer_mode(text: str) -> str:
    t = text.lower()
    if "solo" in t:
        return "SOLO"
    if "group" in t or "群面" in t:
        return "GROUP"
    return "GROUP"


async def handle_api_history(request: web.Request) -> web.Response:
    base_dir = request.app["args"].base_dir
    if not os.path.isdir(base_dir):
        return web.json_response({"items": [], "summary": ""})
    items: list[dict[str, Any]] = []
    for name in os.listdir(base_dir):
        run_dir = os.path.join(base_dir, name)
        if not re.fullmatch(r"[0-9a-f]{12}", name):
            continue
        if not os.path.isdir(run_dir):
            continue
        score = None
        mode = "GROUP"
        role = ""
        one_liner = ""
        json_path = os.path.join(run_dir, "assessment.json")
        if os.path.exists(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    rep = json.load(f)
                score = rep.get("scores", {}).get("overall")
                role = str(rep.get("summary", {}).get("role") or "")
                one_liner = str(rep.get("summary", {}).get("one_liner") or "")
                mode = _infer_mode(f"{role} {one_liner}")
            except Exception:
                pass
        metrics_path = os.path.join(run_dir, "metrics.json")
        if score is None and os.path.exists(metrics_path):
            try:
                with open(metrics_path, "r", encoding="utf-8") as f:
                    m = json.load(f)
                # 粗粒度兜底：把占比类指标折算到 100 分区间
                score = round(
                    100
                    * (
                        0.45 * float(m.get("talk_share", 0))
                        + 0.35 * float(m.get("keyword_coverage", 0))
                        + 0.20 * (1.0 / (1.0 + float(m.get("avg_gap_seconds", 0))))
                    )
                )
            except Exception:
                pass
        if score is None:
            continue
        ts = os.path.getmtime(run_dir)
        date = time.strftime("%Y.%m.%d", time.localtime(ts))
        items.append(
            {
                "run_id": name,
                "date": date,
                "target": "UI交互设计师",
                "mode": mode,
                "score": int(round(float(score))),
                "one_liner": one_liner,
                "ts": ts,
            }
        )
    items.sort(key=lambda x: x["ts"], reverse=True)
    items = items[:12]
    if not items:
        return web.json_response({"items": [], "summary": "还没有历史面试记录，先去完成一次模拟面试吧。"})
    avg = round(sum(int(x["score"]) for x in items) / len(items))
    summary = f"你最近 {len(items)} 次模拟平均分 {avg}，继续保持稳定输出。"
    return web.json_response({"items": items, "summary": summary})


async def handle_static(request: web.Request) -> web.Response:
    name = request.match_info["name"]
    local_allowed = {"app.js", "debug.js", "report.js", "growth.js", "style.css"}
    local_assets_allowed = {"logo.svg", "examiner.svg", "face_landmarker.task", "vision_bundle.mjs"}
    figma_ok = bool(
        re.fullmatch(r"(screenshot_\d+_\d+\.png|mo5[a-z0-9]+-[a-z0-9]+\.(svg|png))", name)
    )

    if name not in local_allowed and name not in local_assets_allowed and not figma_ok:
        raise web.HTTPNotFound()

    if figma_ok:
        path = os.path.join(FIGMA_IMAGE_DIR, name)
    elif name in local_assets_allowed:
        path = os.path.join(os.path.dirname(__file__), "assets", "static", name)
    else:
        path = os.path.join(os.path.dirname(__file__), name)
    if not os.path.exists(path):
        raise web.HTTPNotFound()
    return _no_store_file(path)


async def handle_wasm(request: web.Request) -> web.Response:
    rel = request.match_info["path"]
    base = os.path.join(os.path.dirname(__file__), "assets", "static", "wasm")
    path = os.path.abspath(os.path.join(base, rel))
    if not path.startswith(os.path.abspath(base) + os.sep):
        raise web.HTTPNotFound()
    if not os.path.exists(path):
        raise web.HTTPNotFound()
    return _no_store_file(path)


async def handle_upload_video(request: web.Request) -> web.Response:
    reader = await request.multipart()
    run_id = ""
    video_bytes = b""
    filename = ""
    while True:
        part = await reader.next()
        if not part:
            break
        if part.name == "run_id":
            run_id = (await part.text()).strip()
        elif part.name == "video":
            filename = part.filename or "video.webm"
            video_bytes = await part.read(decode=False)
    if not run_id or not video_bytes:
        return web.json_response({"ok": False, "error": "missing"}, status=400)
    base_dir = request.app["args"].base_dir
    run_dir = os.path.join(base_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    out_path = os.path.join(run_dir, filename)
    with open(out_path, "wb") as f:
        f.write(video_bytes)
    return web.json_response({"ok": True, "path": out_path})


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(max_msg_size=10 * 1024 * 1024, heartbeat=15.0, autoping=True)
    await ws.prepare(request)
    session = Session(
        request.app["args"],
        request.app.get("vosk_model"),
        str(request.app.get("asr_warning") or ""),
        request.app.get("report_executor"),
    )
    await session.attach_ws(ws)
    last_msg_at = time.monotonic()
    while True:
        try:
            msg = await ws.receive(timeout=35.0)
        except asyncio.TimeoutError:
            if time.monotonic() - last_msg_at >= 35.0:
                break
            continue
        last_msg_at = time.monotonic()

        if msg.type == web.WSMsgType.TEXT:
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            t = str(data.get("type") or "")
            if t == "client_hello":
                mode = str(data.get("mode") or "").strip().upper()
                if mode in ("SOLO", "GROUP"):
                    session.client_mode = mode
                if session.client_mode == "SOLO":
                    session.ensure_solo()
                continue
            if t == "start":
                mode = str(data.get("mode") or "").strip().upper()
                if mode in ("SOLO", "GROUP"):
                    session.client_mode = mode
                if session.client_mode == "SOLO":
                    session.ensure_solo()
                discuss_minutes = data.get("discuss_minutes")
                await session.start_with_params(int(discuss_minutes) if discuss_minutes is not None else None)
            elif t == "end_discuss":
                await session.end_discuss()
            elif t == "stop":
                print(f"[ws] stop run_id={session.run_id}", flush=True)
                await session.stop_and_prepare_report()
            elif t == "barge_in":
                await session.barge_in()
            elif t == "user_text":
                mode = str(data.get("mode") or "").strip().upper()
                if mode in ("SOLO", "GROUP"):
                    session.client_mode = mode
                if session.client_mode == "SOLO":
                    session.ensure_solo()
                text = str(data.get("text") or "").strip()
                if text and session._ws is not None and not session._ws.closed:
                    ts_ms = int(data.get("ts_ms") or int(time.time() * 1000))
                    await session._ws.send_str(json.dumps({"type": "user_final", "ts_ms": ts_ms, "text": text}, ensure_ascii=False))
                    await session.on_user_text(text)
            elif t == "video_metric":
                ts = float(data.get("ts_ms") or int(time.time() * 1000)) / 1000.0
                stage_for_event = session._sim.stage if session._sim else "read"
                event = Event(
                    run_id=session.run_id,
                    ts=ts,
                    stage=stage_for_event,
                    speaker_id="client",
                    speaker_name="浏览器",
                    event_type="utterance",
                    content="",
                    meta={"video_metric": data},
                )
                session.collector.record(event)
            elif t == "vision_metric":
                ts = float(data.get("ts_ms") or int(time.time() * 1000)) / 1000.0
                stage_for_event = session._sim.stage if session._sim else "read"
                event = Event(
                    run_id=session.run_id,
                    ts=ts,
                    stage=stage_for_event,
                    speaker_id="client",
                    speaker_name="浏览器",
                    event_type="utterance",
                    content="",
                    meta={"vision_metric": data},
                )
                session.collector.record(event)
            elif t == "audio_metric":
                ts = float(data.get("ts_ms") or int(time.time() * 1000)) / 1000.0
                stage_for_event = session._sim.stage if session._sim else "read"
                event = Event(
                    run_id=session.run_id,
                    ts=ts,
                    stage=stage_for_event,
                    speaker_id="client",
                    speaker_name="浏览器",
                    event_type="utterance",
                    content="",
                    meta={"audio_metric": data},
                )
                session.collector.record(event)
        elif msg.type == web.WSMsgType.BINARY:
            await session.feed_audio(bytes(msg.data))
        elif msg.type == web.WSMsgType.CLOSE:
            break
        elif msg.type == web.WSMsgType.ERROR:
            break

    try:
        await ws.close()
    finally:
        await session.aclose()
    return ws


def main() -> None:
    args = parse_args()
    vosk_model: Any | None = None
    asr_warning = ""
    vosk_path = (args.vosk_model or os.getenv("VOSK_MODEL_PATH", "")).strip()
    if bool(args.no_asr):
        asr_warning = "ASR 已关闭：将忽略麦克风音频流；可使用页面底部“打字发送”参与讨论。"
    elif not vosk_path:
        asr_warning = "未配置 Vosk 模型：请设置环境变量 VOSK_MODEL_PATH 或传入 --vosk-model；当前将忽略麦克风音频流，可使用“打字发送”。"
    elif not os.path.exists(vosk_path):
        asr_warning = f"Vosk 模型目录不存在：{vosk_path}；当前将忽略麦克风音频流，可使用“打字发送”。"
    else:
        try:
            from vosk import Model, SetLogLevel

            SetLogLevel(-1)
            print("loading vosk model…", flush=True)
            vosk_model = Model(vosk_path)
            print("vosk ready", flush=True)
        except Exception as e:
            import platform
            import sys

            hint_parts: list[str] = []
            hint_parts.append(f"Python={sys.version.split()[0]} arch={platform.machine()}")
            hint_parts.append("可尝试：xattr -dr com.apple.quarantine <venv>/site-packages/vosk")
            hint_parts.append("或：pip uninstall cffi vosk -y && pip install cffi vosk")
            hint_parts.append("若为 Apple 芯片：确保 Python/venv 为 arm64（不要混用 x86_64）")
            hint = "；".join(hint_parts)
            asr_warning = f"Vosk 初始化失败：{e}；{hint}；当前将忽略麦克风音频流，可使用“打字发送”。"
    app = web.Application(middlewares=[cors_middleware])
    app["args"] = args
    app["vosk_model"] = vosk_model
    app["asr_warning"] = asr_warning
    app["report_executor"] = ThreadPoolExecutor(max_workers=1)
    app.router.add_get("/", handle_index)
    app.router.add_get("/debug", handle_debug)
    app.router.add_get("/group", handle_group)
    app.router.add_get("/report", handle_report)
    app.router.add_get("/growth", handle_growth)
    app.router.add_get("/static/{name}", handle_static)
    app.router.add_get("/static/wasm/{path:.*}", handle_wasm)
    static_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "static"))
    os.makedirs(os.path.join(static_dir, "tts"), exist_ok=True)
    app.router.add_static("/static/", path=static_dir, name="static")
    app.router.add_post("/upload_video", handle_upload_video)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/report/{run_id}", handle_api_report)
    app.router.add_get("/api/history", handle_api_history)
    print(f"web demo: http://{args.host}:{args.port}")
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
