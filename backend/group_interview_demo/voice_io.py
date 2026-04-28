from __future__ import annotations

import asyncio
try:
    import audioop
except Exception:
    audioop = None
import json
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Literal


VOICE_SPEECH_START = "__VOICE_SPEECH_START__"


@dataclass(frozen=True)
class VoiceConfig:
    vosk_model_path: str
    sample_rate: int = 16000
    input_device: int | None = None
    vad_rms_threshold: int = 450
    vad_hold_ms: int = 250
    tts_enabled: bool = True
    tts_rate: int = 185
    tts_backend: Literal["pyttsx3", "powershell"] = "pyttsx3"


class VoiceInput:
    def __init__(self, cfg: VoiceConfig) -> None:
        self.cfg = cfg
        self._stop = threading.Event()
        self._audio_q: queue.Queue[bytes] = queue.Queue()
        self._out_q: asyncio.Queue[str] = asyncio.Queue()
        self._thread: threading.Thread | None = None
        self._last_rms = 0
        self._last_rms_ts = 0.0

        self._require_vosk()
        self._require_sounddevice()

        from vosk import KaldiRecognizer, Model

        model_path = self.cfg.vosk_model_path.strip()
        if not model_path:
            model_path = os.getenv("VOSK_MODEL_PATH", "").strip()
        if not model_path:
            raise RuntimeError("缺少 Vosk 模型路径：请通过 --vosk-model 或环境变量 VOSK_MODEL_PATH 提供")
        if not os.path.exists(model_path):
            raise RuntimeError(f"Vosk 模型目录不存在：{model_path}")

        self._model = Model(model_path)
        self._rec = KaldiRecognizer(self._model, self.cfg.sample_rate)

    def _require_sounddevice(self) -> None:
        try:
            __import__("sounddevice")
        except Exception:
            raise RuntimeError("缺少依赖 sounddevice：请 pip install sounddevice")

    def _require_vosk(self) -> None:
        try:
            __import__("vosk")
        except Exception:
            raise RuntimeError("缺少依赖 vosk：请 pip install vosk")

    async def get(self) -> str:
        return await self._out_q.get()

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._thread:
            return

        import sounddevice as sd

        def audio_cb(indata, frames, time_info, status) -> None:
            if self._stop.is_set():
                return
            try:
                if audioop is None:
                    rms = 0
                else:
                    rms = int(audioop.rms(bytes(indata), 2))
            except Exception:
                rms = 0
            self._last_rms = rms
            self._last_rms_ts = time.monotonic()
            self._audio_q.put(bytes(indata))

        stream = sd.RawInputStream(
            samplerate=self.cfg.sample_rate,
            blocksize=8000,
            dtype="int16",
            channels=1,
            callback=audio_cb,
            device=self.cfg.input_device,
        )

        def worker() -> None:
            in_speech = False
            with stream:
                while not self._stop.is_set():
                    try:
                        chunk = self._audio_q.get(timeout=0.2)
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
                        if text:
                            asyncio.run_coroutine_threadsafe(self._out_q.put(text), loop)
                        in_speech = False
                    else:
                        try:
                            partial = json.loads(self._rec.PartialResult() or "{}")
                        except json.JSONDecodeError:
                            partial = {}
                        ptext = str(partial.get("partial") or "").strip()
                        rms_ok = False
                        if self.cfg.vad_rms_threshold > 0:
                            if self._last_rms >= int(self.cfg.vad_rms_threshold):
                                if (time.monotonic() - self._last_rms_ts) * 1000 <= int(self.cfg.vad_hold_ms):
                                    rms_ok = True
                        else:
                            rms_ok = True
                        if rms_ok and len(ptext) >= 3 and not in_speech:
                            in_speech = True
                            asyncio.run_coroutine_threadsafe(self._out_q.put(VOICE_SPEECH_START), loop)
            try:
                self._rec.FinalResult()
            except Exception:
                pass

        self._thread = threading.Thread(target=worker, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()


class VoiceTTS:
    def __init__(self, cfg: VoiceConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        self._engine = None
        self._speaking = False
        self._q: queue.Queue[str] = queue.Queue()
        if self.cfg.tts_backend == "pyttsx3":
            self._require_pyttsx3()
        t = threading.Thread(target=self._worker, daemon=True)
        t.start()

    def _require_pyttsx3(self) -> None:
        try:
            __import__("pyttsx3")
        except Exception:
            raise RuntimeError("缺少依赖 pyttsx3：请 pip install pyttsx3")

    def is_speaking(self) -> bool:
        return bool(self._speaking)

    def stop(self) -> None:
        with self._lock:
            if self._engine:
                try:
                    self._engine.stop()
                except Exception:
                    pass
            self._speaking = False
            while True:
                try:
                    self._q.get_nowait()
                except queue.Empty:
                    break

    def speak(self, text: str) -> None:
        if not self.cfg.tts_enabled:
            return
        t = str(text or "").strip()
        if not t:
            return
        self._q.put(t)

    def _worker(self) -> None:
        if self.cfg.tts_backend == "powershell":
            self._worker_powershell()
            return
        try:
            import pythoncom

            pythoncom.CoInitialize()
        except Exception:
            pass
        import pyttsx3

        self._engine = pyttsx3.init()
        try:
            self._engine.setProperty("rate", int(self.cfg.tts_rate))
        except Exception:
            pass

        while True:
            try:
                text = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            if not text:
                continue
            with self._lock:
                self._speaking = True
                try:
                    self._engine.say(text)
                    self._engine.runAndWait()
                except Exception:
                    pass
                self._speaking = False

    def _worker_powershell(self) -> None:
        while True:
            try:
                text = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            t = str(text or "").strip()
            if not t:
                continue
            t = t.replace("\r", " ").replace("\n", " ")
            t = t.replace("'", "''")
            rate = int(self.cfg.tts_rate)
            cmd = (
                "Add-Type -AssemblyName System.Speech; "
                "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                f"$s.Rate={rate}; "
                f"$s.Speak('{t}');"
            )
            with self._lock:
                self._speaking = True
                try:
                    subprocess.run(
                        ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
                        check=False,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                except Exception:
                    pass
                self._speaking = False


def default_vosk_model_hint() -> str:
    return "建议下载 Vosk 中文模型，例如 vosk-model-small-cn-0.22，并把目录路径传给 --vosk-model"
