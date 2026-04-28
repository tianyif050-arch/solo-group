from __future__ import annotations

import asyncio
import random
import threading
import time
import uuid
from dataclasses import asdict
from typing import Any, Literal

from group_interview_demo.collector import RunCollector, compute_metrics
from group_interview_demo.llm_client import BigModelChatClient
from group_interview_demo.models import AgentProfile, Event, EventType, Stage, Topic
from group_interview_demo.voice_io import VOICE_SPEECH_START, VoiceInput, VoiceTTS


Mode = Literal["mock", "llm"]


def _fmt_time(ts: float) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts))


def _print_line(ts: float, name: str, content: str) -> None:
    print(f"[{_fmt_time(ts)}] {name}: {content}", flush=True)


class _InputThread:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._queue: asyncio.Queue[str] = asyncio.Queue()

    def stop(self) -> None:
        self._stop.set()

    async def get(self) -> str:
        return await self._queue.get()

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        def run() -> None:
            while not self._stop.is_set():
                try:
                    line = input()
                except EOFError:
                    break
                asyncio.run_coroutine_threadsafe(self._queue.put(line), loop)

        t = threading.Thread(target=run, daemon=True)
        t.start()


def _split_two_parts(text: str) -> tuple[str, str]:
    s = (text or "").strip()
    if len(s) <= 40:
        return s, ""
    cut = max(20, int(len(s) * 0.55))
    for sep in ["。", "！", "？", "\n", "，", ",", ";", "；"]:
        i = s.find(sep, cut - 10)
        if i != -1 and i + 1 < len(s) - 5:
            return s[: i + 1].strip(), s[i + 1 :].strip()
    return s[:cut].strip(), s[cut:].strip()


def _mock_reply(profile: AgentProfile, topic: Topic, last: str, intent: str) -> str:
    base = profile.persona_prompt
    topic_title = str(topic.title or "").strip()
    topic_text = f"{topic.title}\n{topic.content}"
    last_snip = (last or "").strip()
    anchor = f"针对你刚才提到的“{last_snip[:12]}”，" if last_snip else ""

    if "优先级" in topic_text or "排序" in topic_text:
        focus = random.choice(
            [
                "我会先按“用户价值、实现成本、风险”做三维排序，再定第一版上线清单。",
                "先别堆点子，先把评估维度写下来，再排出 Top3 先做的。",
                "先定一个北极星指标，再把功能拆成必须/可选，优先做必须的闭环。",
            ]
        )
    elif "留存" in topic_text or "活跃" in topic_text:
        focus = random.choice(
            [
                "我会先抓一条主指标（7日留存/人均互动），再用A/B验证最小改动。",
                "先把流失点定位清楚，再只改一个环节，跑一轮对照数据。",
                "先做新手期的最小闭环，让用户第一天就能得到反馈，再谈活动。",
            ]
        )
    elif "流程" in topic_text or "核心功能" in topic_text:
        focus = random.choice(
            [
                "我会先画核心流程，再只保留最小闭环功能，剩余放二期。",
                "先把关键路径跑通，旁枝需求先砍掉，别一上来就做大全。",
                "先把失败路径补齐（报错/回退/兜底），否则体验会崩。",
            ]
        )
    elif "原因" in topic_text or "分析" in topic_text or "定位" in topic_text:
        focus = random.choice(
            [
                "我会先拆假设，再定义验证口径，避免拍脑袋。",
                "先把数据口径对齐，再做分层对比（新老/渠道/版本），很快能定位。",
                "先做两次快速访谈补证据，不然讨论会一直飘。",
            ]
        )
    else:
        focus = random.choice(
            [
                "我会先给出一个明确立场，再补一个可执行动作和验证方式。",
                "先把目标说清楚，不然大家永远在聊各自的想法。",
                "我倾向先做一个小实验，先用结果把讨论拉回地面。",
            ]
        )

    ask = random.choice(["你们觉得呢？", "我这个顺序大家认可吗？", "要不要我把优先级先写出来？", "你同意吗？"])

    if intent == "summary":
        return f"我总结一下：围绕“{topic_title}”，先拍板结论，再定两步落地。{focus}"
    if intent == "rebuttal":
        return f"{anchor}我不完全同意，这个结论依据不够。建议先统一评估指标，再比较方案。{focus}{ask}"
    if "抢位型" in base or "Aggressor" in base:
        return random.choice(
            [
                f"我先来说两句，别绕圈子了。{focus}",
                f"我先抢个结论：先定目标和约束，再拍板执行顺序。{focus}",
                f"先收敛，不要发散。围绕“{topic_title}”直接定优先级。{focus}",
            ]
        )
    if "反驳型" in base or "Devil" in base:
        return random.choice(
            [
                f"{anchor}我不完全同意，你这个前提缺证据。{focus}",
                f"我先追问：如果核心假设不成立，方案怎么兜底？{focus}",
                f"这个结论跳步了，先给验证口径再下判断。{focus}",
            ]
        )
    if "善良型" in base or "Peacemaker" in base:
        return random.choice(
            [
                f"我认可前面观点，我补充一步：{focus}",
                f"我同意大家的方向，我们先对齐指标，再分工推进。{focus}",
                f"我来缓和一下分歧：先统一目标，再选一版最小方案。{focus}",
            ]
        )
    if "理论型" in base or "Theorist" in base:
        return random.choice(
            [
                f"从底层逻辑看，关键是约束下的价值闭环。{focus}",
                f"我从框架上补一句：目标-约束-策略-验证，四步走。{focus}",
                f"这个题本质是资源配置问题，先定主目标再做取舍。{focus}",
            ]
        )
    if "经验型" in base or "Pragmatist" in base:
        return random.choice(
            [
                f"我给结构化建议：先定指标，再列约束，最后落一个MVP。{focus}{ask}",
                f"我建议三步：目标量化、方案对比、一周内可验证动作。{focus}{ask}",
                f"先做可执行版本，边跑边校准，不要一开始求完美。{focus}{ask}",
            ]
        )
    if "小白型" in base or "Novice" in base:
        return random.choice(
            [
                f"我有点紧张，我先复述下题目：{topic_title}。我觉得先做最核心那一步会更稳。",
                f"我可能不太全面，但我觉得先从最影响用户的一点改起比较好。{focus}",
                f"我补一句简单的：先把必做项选出来，再讨论锦上添花。{focus}",
            ]
        )
    if "总结型" in base or "Opportunist" in base:
        return random.choice(
            [
                f"我先把大家观点收一下，后面我来做总结。先记住：{focus}",
                f"我在记录共识：目标、约束、备选方案都齐了，接下来就差拍板。{focus}",
                f"我建议先形成一版结论草案，最后我来收口。{focus}",
            ]
        )
    if "控场型" in base or "Timekeeper" in base:
        return random.choice(
            [
                f"时间不多了，我们现在切到结论环节。每人30秒给出立场。{focus}",
                f"先控时：2分钟内完成排序/取舍，然后直接定分工。{focus}",
                f"请大家收敛发言，围绕一个主目标快速拍板。{focus}",
            ]
        )
    if "强势" in base or "推进" in base:
        return "我先定个框架：目标-约束-方案-验证。大家分别补充一条关键点，最后我们统一优先级。"
    if "谨慎" in base or "风险" in base:
        return "我补充下风险与边界：预算、人力、时间是硬约束。我们需要一个最小可行方案，并预留备选。"
    if "创意" in base or "发散" in base:
        return "我有两个新思路：一是用场景化分区提升效率，二是用轻量活动机制提升社交。可以组合落地。"
    if "总结" in base or "调和" in base:
        return "我先对齐一下共识：目标是什么、衡量指标是什么。然后把方案拆成短中长期，逐条拍板。"
    if "质疑" in base or "追问" in base:
        return "我先追问一句：这个方案的证据是什么？如果指标不提升，我们的回退机制是什么？需要更严谨。"
    return f"我基于题目补充一点：{focus}"


def _build_llm_messages(
    profile: AgentProfile,
    topic: Topic,
    stage: Stage,
    history: list[dict[str, Any]],
    intent: str,
) -> list[dict[str, Any]]:
    sys = (
        "你正在参加一个群面：你是其中一位候选人。"
        "请严格按照你的人设与说话风格发言，保持简短（1-3句），不要输出markdown。"
        "必须推进讨论产出，避免空泛套话。"
        "如果有上下文，必须点名回应至少一位同学（例如“我同意X同学…/我不同意X同学…”），并在你的话里给出一个具体依据（数据/约束/假设/对比维度）。"
        "不要复读上一句，也不要重复你自己上一轮的措辞。"
        f"\n\n你的身份与人设：{profile.display_name}\n{profile.persona_prompt}"
    )
    user = f"题目：{topic.title}\n{topic.content}\n\n环节：{stage}\n发言意图：{intent}\n"
    if history:
        user += "\n最近对话（只供参考，不要逐字复述）：\n"
        for h in history[-8:]:
            user += f"- {h['speaker_name']}: {h['content']}\n"
    has_options = any(x in topic.content for x in ["选项：", "选项:", "A.", "B.", "C.", "A．", "B．", "C．"])
    if intent == "summary":
        user += "\n请做最后总结：1）一句话结论 2）两条优先级/落地动作。1-3句。"
    elif intent == "rebuttal":
        user += "\n请明确反驳上一位的关键点，并给出更好的替代建议（包含一个依据），1-3句。"
    else:
        if has_options:
            user += "\n请选一个明确立场（例如 A/B/C），并给出理由与下一步（MVP/验证/分工），1-3句。"
        else:
            user += "\n请推进讨论：给出一个清晰观点+一个具体下一步（指标/验证/分工/时间），1-3句。"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


class GroupInterviewSimulator:
    def __init__(
        self,
        topic: Topic,
        agents: list[AgentProfile],
        collector: RunCollector,
        mode: Mode = "mock",
        api_key: str = "",
        model_name: str = "glm-4-flash",
        speak_interval_min: int = 10,
        speak_interval_max: int = 20,
        p_interrupt: float = 0.18,
        p_rebuttal: float = 0.22,
        discuss_seconds: int = 180,
        read_seconds: int = 20,
        reply_after_user: bool = True,
        reply_delay_min: float = 0.8,
        reply_delay_max: float = 1.6,
        voice_input: VoiceInput | None = None,
        voice_tts: VoiceTTS | None = None,
        barge_in: bool = True,
        quiet: bool = False,
    ) -> None:
        self.topic = topic
        self.agents = agents
        self.collector = collector
        self.mode = mode
        self.client = BigModelChatClient(api_key=api_key, model_name=model_name)
        self.speak_interval_min = speak_interval_min
        self.speak_interval_max = speak_interval_max
        self.p_interrupt = p_interrupt
        self.p_rebuttal = p_rebuttal
        self.discuss_seconds = discuss_seconds
        self.read_seconds = read_seconds
        self.reply_after_user = reply_after_user
        self.reply_delay_min = reply_delay_min
        self.reply_delay_max = reply_delay_max
        self.voice_input = voice_input
        self.voice_tts = voice_tts
        self.barge_in = barge_in
        self.quiet = quiet
        self.stage: Stage = "read"
        self.history: list[dict[str, Any]] = []
        self._continuation_task: asyncio.Task[None] | None = None
        self._continuation_owner: str = ""
        self._user_reply_task: asyncio.Task[None] | None = None
        self._last_speaker_id: str = ""
        self._last_user_ts: float = 0.0

    def _record_and_print(self, event: Event) -> None:
        self.collector.record(event)
        if (not self.quiet) and event.event_type in ("utterance", "rebuttal"):
            _print_line(event.ts, event.speaker_name, event.content)
            if self.voice_tts and event.speaker_id != "user":
                self.voice_tts.speak(event.content)

    def _handle_voice_interrupt(self) -> None:
        if not self.voice_tts or not self.voice_tts.is_speaking():
            return
        if self.barge_in:
            self.voice_tts.stop()
            if self._continuation_task and not self._continuation_task.done():
                self._continuation_task.cancel()
        ie = Event(
            run_id=self.collector.run_id,
            ts=time.time(),
            stage=self.stage,
            speaker_id="user",
            speaker_name="你",
            event_type="interrupt",
            content="",
            meta={"target_speaker_id": self._continuation_owner or "", "target_speaker_name": ""},
        )
        self.collector.record(ie)
        self.history.append(asdict(ie))
        if not self.quiet:
            _print_line(ie.ts, "你", "（打断）")

    async def _agent_say(self, profile: AgentProfile, stage: Stage, intent: str) -> None:
        last = self.history[-1]["content"] if self.history else ""
        if self.mode == "mock":
            full = _mock_reply(profile, self.topic, last, intent)
            latency_ms = 0
        else:
            msgs = _build_llm_messages(profile, self.topic, stage, self.history, intent)
            full, latency_ms = await asyncio.to_thread(self.client.chat, msgs, temperature=0.7, top_p=0.9, max_tokens=256)
        full = str(full).strip()
        if not full:
            return

        part1, part2 = _split_two_parts(full)
        ts = time.time()
        event_type: EventType = "rebuttal" if intent == "rebuttal" else "utterance"
        e1 = Event(
            run_id=self.collector.run_id,
            ts=ts,
            stage=stage,
            speaker_id=profile.agent_id,
            speaker_name=profile.display_name,
            event_type=event_type,
            content=part1,
            meta={"latency_ms": latency_ms, "intent": intent, "part": 1},
        )
        self._record_and_print(e1)
        self.history.append(asdict(e1))

        if part2:
            if self._continuation_task and not self._continuation_task.done():
                self._continuation_task.cancel()
            self._continuation_owner = profile.agent_id
            self._continuation_task = asyncio.create_task(
                self._agent_continuation(profile, stage, event_type, part2, latency_ms, intent)
            )

    async def _agent_continuation(
        self,
        profile: AgentProfile,
        stage: Stage,
        event_type: EventType,
        part2: str,
        latency_ms: int,
        intent: str,
    ) -> None:
        try:
            await asyncio.sleep(random.uniform(1.2, 2.4))
            ts = time.time()
            e2 = Event(
                run_id=self.collector.run_id,
                ts=ts,
                stage=stage,
                speaker_id=profile.agent_id,
                speaker_name=profile.display_name,
                event_type=event_type,
                content=part2,
                meta={"latency_ms": latency_ms, "intent": intent, "part": 2},
            )
            self._record_and_print(e2)
            self.history.append(asdict(e2))
        except asyncio.CancelledError:
            return

    async def _maybe_interrupt(self) -> AgentProfile | None:
        if not self._continuation_task or self._continuation_task.done():
            return None
        if random.random() >= self.p_interrupt:
            return None
        candidates = [a for a in self.agents if a.agent_id != self._continuation_owner]
        if not candidates:
            return None
        interrupter = random.choice(candidates)
        target = next((a for a in self.agents if a.agent_id == self._continuation_owner), None)
        if target:
            ie = Event(
                run_id=self.collector.run_id,
                ts=time.time(),
                stage=self.stage,
                speaker_id=interrupter.agent_id,
                speaker_name=interrupter.display_name,
                event_type="interrupt",
                content="",
                meta={"target_speaker_id": target.agent_id, "target_speaker_name": target.display_name},
            )
            self.collector.record(ie)
            self.history.append(asdict(ie))
            if not self.quiet:
                _print_line(ie.ts, interrupter.display_name, f"我打断一下 {target.display_name}。")
        self._continuation_task.cancel()
        return interrupter

    async def _bot_loop(self, stop_at: float) -> None:
        while time.time() < stop_at:
            await asyncio.sleep(random.uniform(self.speak_interval_min, self.speak_interval_max))
            if time.time() >= stop_at:
                break
            if self._last_user_ts and (time.time() - self._last_user_ts) < 2.6:
                continue

            interrupter = await self._maybe_interrupt()
            if interrupter:
                await self._agent_say(interrupter, self.stage, intent="normal")
                self._last_speaker_id = interrupter.agent_id
                continue

            candidates = [a for a in self.agents if a.agent_id != self._last_speaker_id] or self.agents
            speaker = random.choice(candidates)
            intent = "rebuttal" if (self.history and random.random() < self.p_rebuttal) else "normal"
            await self._agent_say(speaker, self.stage, intent=intent)
            self._last_speaker_id = speaker.agent_id

    async def _reply_to_user(self) -> None:
        await asyncio.sleep(random.uniform(self.reply_delay_min, self.reply_delay_max))
        if self.stage != "discuss":
            return
        if not self.agents:
            return
        if self._last_user_ts and (time.time() - self._last_user_ts) < 1.8:
            return
        candidates = [a for a in self.agents if a.agent_id != self._last_speaker_id] or self.agents
        speaker = random.choice(candidates)
        intent = "rebuttal" if (self.history and random.random() < self.p_rebuttal) else "normal"
        await self._agent_say(speaker, self.stage, intent=intent)
        self._last_speaker_id = speaker.agent_id

    def _schedule_user_reply(self) -> None:
        if not self.reply_after_user:
            return
        if self._user_reply_task and not self._user_reply_task.done():
            self._user_reply_task.cancel()
        self._user_reply_task = asyncio.create_task(self._reply_to_user())

    async def _handle_user_line(self, line: str) -> bool:
        s = (line or "").strip()
        if not s:
            return True
        if s == VOICE_SPEECH_START:
            self._handle_voice_interrupt()
            return True
        self._last_user_ts = time.time()
        s_norm = s.replace("　", " ").strip().lower()
        if s_norm in {"next", "下一步", "进入讨论", "进入自由讨论", "进入总结", "总结", "/next"}:
            s = "/next"
        if s_norm in {"quit", "退出", "停止", "结束", "/quit"}:
            s = "/quit"
        if s_norm in {"help", "帮助", "/help"}:
            s = "/help"
        if s.startswith("/quit"):
            return False
        if s.startswith("/next"):
            if self.stage == "read":
                self.stage = "discuss"
            elif self.stage == "discuss":
                self.stage = "summary"
            return True
        if s.startswith("/help"):
            if not self.quiet:
                print("命令：/next 进入下一环节；/quit 退出；直接输入文字=发言。", flush=True)
            return True

        e = Event(
            run_id=self.collector.run_id,
            ts=time.time(),
            stage=self.stage,
            speaker_id="user",
            speaker_name="你",
            event_type="utterance",
            content=s,
            meta={},
        )
        self._record_and_print(e)
        self.history.append(asdict(e))
        if self.stage == "discuss":
            self._schedule_user_reply()
        return True

    async def run(self) -> dict[str, Any]:
        self.collector.record_stage_change("read", f"阅读题目：{self.topic.topic_id} {self.topic.title}")
        if not self.quiet:
            print("\n=== 阅读题目 ===\n", flush=True)
            print(self.topic.title, flush=True)
            print(self.topic.content, flush=True)
            print(f"\n输入 /next 进入自由讨论（默认 {self.read_seconds} 秒后自动进入）。", flush=True)

        loop = asyncio.get_running_loop()
        input_source: VoiceInput | _InputThread | None
        if self.voice_input:
            input_source = self.voice_input
        else:
            input_source = None if self.quiet else _InputThread()
        if input_source is not None:
            input_source.start(loop)  # type: ignore[union-attr]
        bot_task: asyncio.Task[None] | None = None

        try:
            read_deadline = time.time() + self.read_seconds
            if input_source is None:
                while self.stage == "read" and time.time() < read_deadline:
                    await asyncio.sleep(0.2)
            else:
                while self.stage == "read" and time.time() < read_deadline:
                    try:
                        line = await asyncio.wait_for(input_source.get(), timeout=0.5)  # type: ignore[union-attr]
                    except asyncio.TimeoutError:
                        continue
                    ok = await self._handle_user_line(line)
                    if not ok:
                        return {"run_id": self.collector.run_id, "aborted": True}
            if self.stage == "read":
                self.stage = "discuss"

            self.collector.record_stage_change("discuss", "进入自由讨论")
            if not self.quiet:
                print("\n=== 自由讨论 ===\n", flush=True)
                print("提示：直接输入发言；/next 提前进入总结；/quit 退出。", flush=True)

            discuss_stop = time.time() + self.discuss_seconds
            bot_task = asyncio.create_task(self._bot_loop(discuss_stop))
            if input_source is None:
                while self.stage == "discuss" and time.time() < discuss_stop:
                    await asyncio.sleep(0.2)
            else:
                while self.stage == "discuss" and time.time() < discuss_stop:
                    try:
                        line = await asyncio.wait_for(input_source.get(), timeout=0.5)  # type: ignore[union-attr]
                    except asyncio.TimeoutError:
                        continue
                    ok = await self._handle_user_line(line)
                    if not ok:
                        return {"run_id": self.collector.run_id, "aborted": True}
                    if self.stage != "discuss":
                        break

            if self.stage == "discuss":
                self.stage = "summary"

            self.collector.record_stage_change("summary", "进入总结环节")
            if not self.quiet:
                print("\n=== 总结 ===\n", flush=True)
            for a in self.agents:
                await self._agent_say(a, "summary", intent="summary")
                await asyncio.sleep(random.uniform(0.6, 1.2))

            metrics = compute_metrics(self.collector.db_path, self.collector.run_id)
            self.collector.write_metrics(metrics)
            return metrics
        finally:
            if bot_task and not bot_task.done():
                bot_task.cancel()
            if self._continuation_task and not self._continuation_task.done():
                self._continuation_task.cancel()
            if self._user_reply_task and not self._user_reply_task.done():
                self._user_reply_task.cancel()
            if input_source is not None:
                try:
                    input_source.stop()  # type: ignore[union-attr]
                except Exception:
                    pass


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]
