from __future__ import annotations

import os
import time
from typing import Any

import requests


class BigModelChatClient:
    def __init__(
        self,
        api_key: str | None = None,
        model_name: str = "glm-4-flash",
        api_url: str = "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        connect_timeout: int = 10,
        read_timeout: int = 45,
    ) -> None:
        self.api_key = (api_key or os.getenv("ZHIPU_API_KEY") or "").strip()
        self.model_name = model_name
        self.api_url = api_url
        self.timeout = (connect_timeout, read_timeout)

    def chat(self, messages: list[dict[str, Any]], temperature: float = 0.7, top_p: float = 0.9, max_tokens: int = 512) -> tuple[str, int]:
        if not self.api_key:
            raise RuntimeError("缺少 API Key：请通过 --api-key 或环境变量 ZHIPU_API_KEY 提供")
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        payload = {
            "model": self.model_name,
            "messages": messages,
            "temperature": float(temperature),
            "top_p": float(top_p),
            "max_tokens": int(max_tokens),
        }
        t0 = time.time()
        response = requests.post(self.api_url, headers=headers, json=payload, timeout=self.timeout)
        latency_ms = int((time.time() - t0) * 1000)
        if response.status_code >= 400:
            preview = response.text[:500]
            raise RuntimeError(f"http_{response.status_code}: {preview}")
        content = response.json()["choices"][0]["message"]["content"]
        return str(content), latency_ms

