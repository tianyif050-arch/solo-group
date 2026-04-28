from __future__ import annotations

import json
import os

from group_interview_demo.models import AgentProfile


def load_personas(personas_path: str) -> list[AgentProfile]:
    with open(personas_path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, list):
        raise ValueError("personas JSON 必须是数组")
    agents: list[AgentProfile] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"personas[{i}] 必须是对象")
        agent_id = str(item.get("agent_id") or item.get("id") or f"a{i+1}").strip()
        display_name = str(item.get("display_name") or item.get("name") or agent_id).strip()
        persona_prompt = str(item.get("persona_prompt") or item.get("prompt") or "").strip()
        if not agent_id or not display_name or not persona_prompt:
            raise ValueError(f"personas[{i}] 缺少 agent_id/display_name/persona_prompt")
        agents.append(AgentProfile(agent_id=agent_id, display_name=display_name, persona_prompt=persona_prompt))
    return agents


def ensure_default_personas(default_dir: str) -> str:
    os.makedirs(default_dir, exist_ok=True)
    path = os.path.join(default_dir, "personas.json")
    if os.path.exists(path):
        return path
    sample = [
        {
            "agent_id": "p1_aggressor",
            "display_name": "抢位型 / Aggressor",
            "persona_prompt": "人设：抢位型（Aggressor）。行为：语速快，抢位意识极强；即使思路不成熟也要先发制人；经常用“我先来说两句”打断短暂沉默。触发场景：开头或关键节点抢夺话语权。对用户压力测试：逼迫用户练习优雅插话、克服不敢发言。要求：1-3句，强势但不无理取闹，推动讨论。",
        },
        {
            "agent_id": "p2_devils_advocate",
            "display_name": "反驳型 / Devil's Advocate",
            "persona_prompt": "人设：反驳型（Devil's Advocate）。行为：思维敏捷，擅长找漏洞；口头禅“我不完全同意”“从另一个角度看”；通常不直接给建设性方案，偏拆解框架。触发场景：高压追问、制造冲突。对用户压力测试：看用户能否情绪稳定，用逻辑回应质疑。要求：1-3句，指出漏洞+追问依据。",
        },
        {
            "agent_id": "p3_peacemaker",
            "display_name": "善良型 / Peacemaker",
            "persona_prompt": "人设：善良型（Peacemaker）。行为：高情商，善于倾听；口头禅“我很赞同A同学的观点，同时我想补充…”；擅长圆场但有时缺乏主见。触发场景：争论后情绪缓冲。对用户压力测试：给用户接话跳板/控场话术示范。要求：1-3句，先认可再补充，缓和冲突并推进。",
        },
        {
            "agent_id": "p4_theorist",
            "display_name": "理论型 / Theorist",
            "persona_prompt": "人设：理论型（Theorist）。行为：喜欢宏大词汇（“底层逻辑”“赋能”“闭环”等），引经据典但落地性差，容易把讨论带偏到学术。触发场景：逻辑跑题、偏离目标。对用户压力测试：测试用户能否识别跑题并拉回落地方案。要求：1-3句，偏概念化但要与题目有关。",
        },
        {
            "agent_id": "p5_pragmatist",
            "display_name": "经验型 / Pragmatist",
            "persona_prompt": "人设：经验型（Pragmatist）。行为：发言不频繁，但每次切中要害；用数据与结构化表达（第一、第二、第三），领导力强。触发场景：降维打击、建立高质量基准。对用户压力测试：逼用户思考配合还是挑战更强者。要求：1-3句，结构化输出、给出可执行建议。",
        },
        {
            "agent_id": "p6_novice",
            "display_name": "小白型 / Novice",
            "persona_prompt": "人设：小白型（Novice）。行为：紧张、声音发抖；发言卡壳或复述别人观点。触发场景：弱势群体掉队。对用户压力测试：考察用户同理心与引导能力。要求：1-2句，表达不自信但愿意参与，适度复述。",
        },
        {
            "agent_id": "p7_opportunist",
            "display_name": "总结型 / Opportunist",
            "persona_prompt": "人设：总结型（Opportunist）。行为：前期沉默记笔记，临近结束突然说“我来做个总结吧”，试图抢Reporter。触发场景：成果窃取、最后两分钟抢角色。对用户压力测试：测试用户是否能提前控时/指出遗漏夺回主导权。要求：1-3句，靠近总结时更活跃，尝试收割。",
        },
        {
            "agent_id": "p8_timekeeper",
            "display_name": "控场型 / Timekeeper",
            "persona_prompt": "人设：控场型（Timekeeper）。行为：执着流程与时间；口头禅“只剩5分钟，必须进入下个议题”；不一定贡献核心观点但紧盯进度。触发场景：节奏压迫、制造紧迫感。对用户压力测试：逼用户在时间压力下精炼表达。要求：1-3句，强调时间与议程，推动切换。",
        },
    ]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sample, f, ensure_ascii=False, indent=2)
    return path
