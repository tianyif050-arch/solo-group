from __future__ import annotations

import os
import time
import uuid


DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"


def _tts_dir_abs() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "static", "tts"))


async def generate_tts_audio_url(text: str, voice_name: str | None = None) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    voice = (voice_name or "").strip() or DEFAULT_VOICE
    out_dir = _tts_dir_abs()
    os.makedirs(out_dir, exist_ok=True)
    fname = f"{int(time.time() * 1000)}_{uuid.uuid4().hex}.mp3"
    abs_path = os.path.join(out_dir, fname)
    import edge_tts

    comm = edge_tts.Communicate(t, voice)
    await comm.save(abs_path)
    return f"/static/tts/{fname}"

