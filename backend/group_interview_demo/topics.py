from __future__ import annotations

import json
import os
from dataclasses import asdict

from group_interview_demo.models import Topic


def load_topics(topics_path: str) -> list[Topic]:
    with open(topics_path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, list):
        raise ValueError("topics JSON 必须是数组")
    topics: list[Topic] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"topics[{i}] 必须是对象")
        topic_id = str(item.get("topic_id") or item.get("id") or f"topic_{i+1}")
        title = str(item.get("title") or "").strip()
        content = str(item.get("content") or item.get("question") or "").strip()
        if not title or not content:
            raise ValueError(f"topics[{i}] 缺少 title/content")
        topics.append(Topic(topic_id=topic_id, title=title, content=content))
    return topics


def ensure_default_topics(default_dir: str) -> str:
    os.makedirs(default_dir, exist_ok=True)
    path = os.path.join(default_dir, "topics.json")
    if os.path.exists(path):
        return path
    sample = [
        asdict(
            Topic(
                topic_id="sample_1",
                title="校园共享空间改造（示例题）",
                content=(
                    "你们是某高校创新团队，需要在预算有限的情况下改造一处公共空间，"
                    "目标是提升学生学习效率与社交体验。请讨论并给出方案与落地优先级。"
                ),
            )
        )
    ]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sample, f, ensure_ascii=False, indent=2)
    return path

