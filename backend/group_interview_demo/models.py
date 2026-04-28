from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


Stage = Literal["read", "discuss", "summary"]
EventType = Literal["stage_change", "utterance", "interrupt", "rebuttal"]


@dataclass(frozen=True)
class Topic:
    topic_id: str
    title: str
    content: str


@dataclass(frozen=True)
class AgentProfile:
    agent_id: str
    display_name: str
    persona_prompt: str


@dataclass
class Event:
    run_id: str
    ts: float
    stage: Stage
    speaker_id: str
    speaker_name: str
    event_type: EventType
    content: str
    meta: dict[str, Any] = field(default_factory=dict)

