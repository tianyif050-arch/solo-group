import asyncio
import base64
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
  from dotenv import load_dotenv
except Exception:
  load_dotenv = None

if load_dotenv is not None:
  try:
    base = Path(__file__).resolve().parent
    load_dotenv(base / ".env", override=False)
    load_dotenv(base / ".env.local", override=False)
  except Exception:
    pass

try:
  import edge_tts
except Exception:
  edge_tts = None


SYSTEM_PROMPT = (
  "你是一个互联网大厂的资深面试官，面试候选人的 UX 与游戏设计实习岗位。"
  "根据回答提供专业、简短的追问或点评，像真实的口语交谈一样，每次回答不要超过 50 个字。"
)


class ChatRequest(BaseModel):
  session_id: str = Field(min_length=1)
  user_text: str = Field(min_length=1)
  resume_url: str | None = None


class SoloStartRequest(BaseModel):
  session_id: str = Field(min_length=1)
  resume_url: str | None = None


class ChatResponse(BaseModel):
  session_id: str
  text: str
  audio_url: str | None = None
  audio_data_uri: str | None = None


class GroupMember(BaseModel):
  id: str
  name: str
  avatar_url: str


class GroupMembersResponse(BaseModel):
  members: list[GroupMember]


class GroupChatRequest(BaseModel):
  session_id: str = Field(min_length=1)
  user_text: str = Field(min_length=1)
  member_id: str = Field(min_length=1)


class GroupChatResponse(BaseModel):
  session_id: str
  member_id: str
  text: str
  audio_url: str | None = None


class ResumeUploadResponse(BaseModel):
  session_id: str
  file_url: str


@dataclass
class SessionState:
  messages: list[dict[str, str]]
  updated_at: float


def _now() -> float:
  return time.time()


def _env(name: str, default: str = "") -> str:
  v = os.getenv(name)
  return default if v is None else str(v)


def _trim_history(messages: list[dict[str, str]], max_turns: int) -> list[dict[str, str]]:
  if max_turns <= 0:
    return []
  keep = max_turns * 2
  out = messages[-keep:]
  return out


async def call_openai_compatible_chat_completion(
  *,
  base_url: str,
  api_key: str,
  model: str,
  messages: list[dict[str, str]],
  timeout_s: float = 45.0,
) -> str:
  if not base_url:
    raise RuntimeError("OPENAI_BASE_URL is not set")
  if not api_key:
    raise RuntimeError("OPENAI_API_KEY is not set")
  if not model:
    raise RuntimeError("OPENAI_MODEL is not set")

  url = base_url.rstrip("/") + "/v1/chat/completions"
  payload = {
    "model": model,
    "messages": messages,
    "temperature": 0.7,
    "max_tokens": 120,
  }

  headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
  }

  async with httpx.AsyncClient(timeout=timeout_s) as client:
    r = await client.post(url, headers=headers, json=payload)
    if r.status_code >= 400:
      raise RuntimeError(f"LLM HTTP {r.status_code}: {r.text}")
    data = r.json()

  try:
    return str(data["choices"][0]["message"]["content"]).strip()
  except Exception:
    raise RuntimeError(f"Invalid LLM response: {data}")


async def call_zhipu_chat_completion(
  *,
  api_url: str,
  api_key: str,
  model: str,
  messages: list[dict[str, str]],
  timeout_s: float = 45.0,
) -> str:
  if not api_url:
    raise RuntimeError("ZHIPU_API_URL is not set")
  if not api_key:
    raise RuntimeError("ZHIPU_API_KEY is not set")
  if not model:
    raise RuntimeError("ZHIPU_MODEL is not set")

  payload = {
    "model": model,
    "messages": messages,
    "temperature": 0.7,
    "max_tokens": 120,
  }
  headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
  }

  async with httpx.AsyncClient(timeout=timeout_s) as client:
    r = await client.post(api_url, headers=headers, json=payload)
    if r.status_code >= 400:
      raise RuntimeError(f"LLM HTTP {r.status_code}: {r.text}")
    data = r.json()

  try:
    return str(data["choices"][0]["message"]["content"]).strip()
  except Exception:
    raise RuntimeError(f"Invalid LLM response: {data}")


async def tts_to_mp3_file(text: str, out_path: Path, voice: str) -> None:
  if edge_tts is None:
    raise RuntimeError("edge-tts is not available")
  out_path.parent.mkdir(parents=True, exist_ok=True)
  communicate = edge_tts.Communicate(text=text, voice=voice)
  await communicate.save(str(out_path))


def _enforce_max_chars(text: str, max_chars: int) -> str:
  t = str(text or "").strip()
  if max_chars <= 0:
    return ""
  if len(t) <= max_chars:
    return t
  return t[:max_chars]


def _extract_resume_facts(resume_text: str, max_items: int = 8) -> list[str]:
  src = _normalize_resume_text(resume_text)
  if not src:
    return []
  raw_lines = [x.strip() for x in src.splitlines() if x.strip()]
  seen: set[str] = set()
  scored: list[tuple[float, str]] = []
  for line in raw_lines:
    s = line
    if s in seen:
      continue
    seen.add(s)
    if len(s) < 8:
      continue
    if any(k in s for k in ("教育背景", "本科", "硕士", "博士", "预计毕业", "现居", "邮箱", "@", "电话", "|")) and not any(
      k in s for k in ("负责", "主导", "推动", "上线", "提升", "增长", "转化", "A/B", "埋点", "SQL", "%", "MAU", "DAU", "GMV")
    ):
      continue
    if len(s) > 90:
      s = s[:90]
    score = 0.0
    score += 2.0 if any(ch.isdigit() for ch in s) else 0.0
    score += 1.8 if any(k in s for k in ("%", "提升", "增长", "转化", "DAU", "MAU", "GMV", "A/B", "埋点", "SQL")) else 0.0
    score += 1.4 if any(k in s for k in ("项目", "负责", "主导", "搭建", "优化", "落地", "上线", "复盘")) else 0.0
    score += 1.0 if any(k in s for k in ("产品", "交互", "UX", "体验", "原型", "PRD", "用户研究")) else 0.0
    score += 0.6 if any("a" <= c.lower() <= "z" for c in s) else 0.0
    score += min(1.2, len(s) / 80.0)
    scored.append((score, s))
  scored.sort(key=lambda x: x[0], reverse=True)
  out: list[str] = []
  for _score, s in scored:
    if len(out) >= max_items:
      break
    out.append(s)
  return out


def _normalize_resume_text(text: str) -> str:
  t = str(text or "").replace("\u00a0", " ").replace("\t", " ")
  t = t.replace("\u2028", "\n").replace("\u2029", "\n")
  t = t.replace("•", "\n• ")
  t = "\n".join([x.strip() for x in t.splitlines()])
  t = "\n".join([x for x in t.splitlines() if x])
  t = t.strip()
  if len(t) > 6000:
    t = t[:6000]
  return t


def _extract_docx_text(abs_path: Path) -> str:
  import zipfile
  import xml.etree.ElementTree as ET

  try:
    with zipfile.ZipFile(str(abs_path), "r") as z:
      xml_bytes = z.read("word/document.xml")
  except Exception:
    return ""
  try:
    root = ET.fromstring(xml_bytes)
  except Exception:
    return ""
  out: list[str] = []
  for node in root.iter():
    tag = str(node.tag)
    if tag.endswith("}t") and node.text:
      out.append(str(node.text))
    if tag.endswith("}tab"):
      out.append(" ")
    if tag.endswith("}br") or tag.endswith("}cr"):
      out.append("\n")
  return _normalize_resume_text("".join(out))


def _extract_textutil_text(abs_path: Path) -> str:
  import subprocess

  try:
    r = subprocess.run(
      ["/usr/bin/textutil", "-convert", "txt", "-stdout", str(abs_path)],
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
      text=True,
      timeout=6.0,
      check=False,
    )
  except Exception:
    return ""
  if r.returncode != 0:
    return ""
  return _normalize_resume_text(r.stdout or "")


def _resume_path_from_url(resumes_dir: Path, resume_url: str) -> Path | None:
  from urllib.parse import unquote, urlparse

  u = str(resume_url or "").strip()
  if not u:
    return None
  try:
    p = urlparse(u).path
  except Exception:
    p = u
  name = str(p).split("/")[-1].strip()
  try:
    name = unquote(name)
  except Exception:
    pass
  if not name:
    return None
  abs_path = (resumes_dir / name).resolve()
  try:
    abs_path.relative_to(resumes_dir.resolve())
  except Exception:
    return None
  return abs_path


def _extract_resume_text(resumes_dir: Path, resume_url: str) -> str:
  p = _resume_path_from_url(resumes_dir, resume_url)
  if p is None or not p.exists():
    return ""
  suf = p.suffix.lower()
  if suf == ".docx":
    t = _extract_docx_text(p)
    if t:
      return t
    return _extract_textutil_text(p)
  if suf in {".pdf", ".doc"}:
    return _extract_textutil_text(p)
  return ""


def _mock_opening_question(resume_text: str) -> str:
  return "请你快速的做一下自我介绍。"


def _mock_personalized_followup(resume_text: str) -> str:
  facts = _extract_resume_facts(resume_text, max_items=10)
  if not facts:
    return "你刚刚的自我介绍里，最能代表你的项目是哪一个？"
  pick = _enforce_max_chars(facts[0], 30)
  if pick:
    return _enforce_max_chars(f"你简历里写到“{pick}”，你当时具体负责哪块？", 50)
  return "你简历里最有代表性的经历是哪一段？为什么？"


def _mock_interviewer_reply(user_text: str) -> str:
  t = str(user_text or "").strip()
  if not t:
    return "我刚刚没听清，你可以再说一遍吗？"
  if len(t) < 12:
    return "能再展开一点吗？最好说说你的具体做法和结果。"
  keys = [
    ("项目", "这个项目里你最难的一次取舍是什么？你当时怎么权衡的？"),
    ("用户", "你怎么验证这个方案真的解决了用户问题？"),
    ("数据", "你刚提到数据，能说下核心指标和变化幅度吗？"),
    ("协作", "跨团队推进时你遇到过阻力吗？你是怎么处理的？"),
    ("压力", "如果时间再砍半，你会保留哪两件事，为什么？"),
  ]
  for k, q in keys:
    if k in t:
      return q
  return "我听明白了。那你再举一个更具体的例子，重点说你的个人贡献。"


def _mock_group_member_reply(member_name: str, user_text: str) -> str:
  t = str(user_text or "").strip()
  n = str(member_name or "").strip() or "组员"
  if not t:
    return "我刚刚没听清，你能再说一遍吗？"
  if len(t) < 10:
    return f"{n}补一句：你能说得更具体点吗？最好带上结果。"
  if "为什么" in t or "原因" in t:
    return f"{n}觉得可以先拆假设，再用数据/访谈去验证，不要直接下结论。"
  if "怎么做" in t or "方案" in t:
    return f"{n}建议先定目标指标，再给两套方案对比，最后落一个MVP。"
  if "数据" in t:
    return f"{n}想追问下口径：核心指标是什么？变化幅度有多少？"
  return f"{n}同意大方向。我补充一个动作：先把优先级和验证方式写清楚。"


async def tts_to_mp3_data_uri(text: str, voice: str) -> str:
  if edge_tts is None:
    raise RuntimeError("edge-tts is not available")
  t = str(text or "").strip()
  if not t:
    raise RuntimeError("text is empty")
  communicate = edge_tts.Communicate(text=t, voice=voice)
  buf = bytearray()
  async for item in communicate.stream():
    if not isinstance(item, dict):
      continue
    if item.get("type") == "audio" and item.get("data"):
      buf.extend(item["data"])
  if not buf:
    raise RuntimeError("TTS returned empty audio")
  b64 = base64.b64encode(bytes(buf)).decode("ascii")
  return f"data:audio/mpeg;base64,{b64}"


def create_app() -> FastAPI:
  app = FastAPI()

  app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
  )

  base_dir = Path(__file__).resolve().parent
  static_dir = Path(_env("STATIC_DIR", str(base_dir / "static"))).resolve()
  audio_dir = Path(_env("AUDIO_DIR", str(static_dir / "audio"))).resolve()
  avatars_dir = Path(_env("AVATARS_DIR", str(static_dir / "avatars"))).resolve()
  resumes_dir = Path(_env("RESUMES_DIR", str(static_dir / "resumes"))).resolve()
  audio_dir.mkdir(parents=True, exist_ok=True)
  avatars_dir.mkdir(parents=True, exist_ok=True)
  resumes_dir.mkdir(parents=True, exist_ok=True)
  app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

  sessions: dict[str, SessionState] = {}
  group_sessions: dict[str, SessionState] = {}
  solo_turn_by_session: dict[str, int] = {}
  resume_url_by_session: dict[str, str] = {}
  resume_text_by_session: dict[str, str] = {}
  resume_brief_by_session: dict[str, str] = {}

  members_seed = [
    {"id": "m1", "name": "组员A", "avatar_path": "/static/avatars/m1.svg"},
    {"id": "m2", "name": "组员B", "avatar_path": "/static/avatars/m2.svg"},
    {"id": "m3", "name": "组员C", "avatar_path": "/static/avatars/m3.svg"},
    {"id": "m4", "name": "组员D", "avatar_path": "/static/avatars/m4.svg"},
  ]

  voice_by_member_id = {
    "m1": "zh-CN-XiaoxiaoNeural",
    "m2": "zh-CN-YunxiNeural",
    "m3": "zh-CN-XiaoyiNeural",
    "m4": "zh-CN-YunjianNeural",
  }

  async def cleanup_loop() -> None:
    ttl_s = float(_env("SESSION_TTL_SECONDS", "3600") or "3600")
    while True:
      await asyncio.sleep(30.0)
      now = _now()
      dead = [sid for sid, s in sessions.items() if now - s.updated_at > ttl_s]
      for sid in dead:
        sessions.pop(sid, None)
        group_sessions.pop(sid, None)
        solo_turn_by_session.pop(sid, None)
        resume_url_by_session.pop(sid, None)
        resume_text_by_session.pop(sid, None)
        resume_brief_by_session.pop(sid, None)

  @app.on_event("startup")
  async def _startup() -> None:
    asyncio.create_task(cleanup_loop())

  @app.get("/health")
  async def health() -> dict[str, Any]:
    return {"ok": True}

  def _abs_url(request: Request, rel: str) -> str:
    base = str(request.base_url).rstrip("/")
    r = str(rel or "").strip()
    if not r:
      return base
    if r.startswith("http://") or r.startswith("https://"):
      return r
    if not r.startswith("/"):
      r = "/" + r
    return base + r

  async def _call_llm(messages: list[dict[str, str]]) -> str:
    zhipu_key = _env("ZHIPU_API_KEY", "").strip()
    if zhipu_key:
      return await call_zhipu_chat_completion(
        api_url=_env("ZHIPU_API_URL", "https://open.bigmodel.cn/api/paas/v4/chat/completions"),
        api_key=zhipu_key,
        model=_env("ZHIPU_MODEL", "glm-4-flash"),
        messages=messages,
      )
    openai_key = _env("OPENAI_API_KEY", "").strip()
    openai_base = _env("OPENAI_BASE_URL", "").strip()
    if openai_key and openai_base:
      return await call_openai_compatible_chat_completion(
        base_url=openai_base,
        api_key=openai_key,
        model=_env("OPENAI_MODEL", "gpt-4o-mini"),
        messages=messages,
      )
    raise RuntimeError("LLM not configured: set ZHIPU_API_KEY (recommended) or OPENAI_API_KEY + OPENAI_BASE_URL")

  def _get_resume_text(session_id: str, resume_url: str | None) -> str:
    sid = str(session_id or "").strip()
    url = str(resume_url or "").strip()
    if url:
      prev = str(resume_url_by_session.get(sid) or "").strip()
      if prev and prev != url:
        resume_text_by_session.pop(sid, None)
        resume_brief_by_session.pop(sid, None)
      resume_url_by_session[sid] = url
      if sid not in resume_text_by_session:
        resume_text_by_session[sid] = _extract_resume_text(resumes_dir, url)
    t = resume_text_by_session.get(sid) or ""
    if not t:
      url2 = resume_url_by_session.get(sid) or ""
      if url2:
        t = _extract_resume_text(resumes_dir, url2)
        if t:
          resume_text_by_session[sid] = t
    return t

  async def _summarize_resume_text(resume_text: str) -> str:
    src = _normalize_resume_text(resume_text)
    if not src:
      return ""
    sys = (
      "你是简历摘要助手。请把简历内容压缩成可用于面试提问的摘要要点。"
      "要求：中文；不要编造；最多 12 行；每行一句；尽量保留数字指标与项目名。"
    )
    user = (
      "请输出这些部分（没有就跳过）：\n"
      "1) 目标岗位/方向\n"
      "2) 教育背景（学校/专业/时间）\n"
      "3) 2-4 个项目（你负责什么 + 量化结果）\n"
      "4) 技能栈/工具\n"
      "5) 候选人亮点\n"
      "6) 可追问点（2-3条）\n\n"
      f"简历原文：\n{src}"
    )
    try:
      out = await asyncio.wait_for(_call_llm([{"role": "system", "content": sys}, {"role": "user", "content": user}]), timeout=25.0)
    except Exception:
      return ""
    return _normalize_resume_text(out)

  async def _ensure_resume_brief(session_id: str, resume_url: str | None) -> str:
    sid = str(session_id or "").strip()
    if not sid:
      return ""
    cached = str(resume_brief_by_session.get(sid) or "").strip()
    if cached:
      return cached
    text = _get_resume_text(sid, resume_url)
    if not text:
      return ""
    brief = await _summarize_resume_text(text)
    if brief:
      resume_brief_by_session[sid] = brief
    return brief

  @app.get("/api/group/members", response_model=GroupMembersResponse)
  async def group_members(request: Request) -> Any:
    members = [
      GroupMember(id=m["id"], name=m["name"], avatar_url=_abs_url(request, m["avatar_path"])) for m in members_seed
    ]
    return JSONResponse(GroupMembersResponse(members=members).model_dump())

  @app.post("/api/chat", response_model=ChatResponse)
  async def chat(req: ChatRequest) -> Any:
    session_id = req.session_id.strip()
    user_text = req.user_text.strip()
    if not user_text:
      raise HTTPException(status_code=400, detail="user_text is empty")

    st = sessions.get(session_id)
    if st is None:
      st = SessionState(messages=[], updated_at=_now())
      sessions[session_id] = st

    st.updated_at = _now()
    st.messages.append({"role": "user", "content": user_text})
    st.messages = _trim_history(st.messages, max_turns=int(_env("SESSION_MAX_TURNS", "12") or "12"))

    resume_brief = await _ensure_resume_brief(session_id, req.resume_url)
    resume_text = _get_resume_text(session_id, req.resume_url)
    resume_hint = _normalize_resume_text(resume_text)
    resume_facts = _extract_resume_facts(resume_text, max_items=10)
    system = SYSTEM_PROMPT
    turn = int(solo_turn_by_session.get(session_id, -1))
    if resume_brief:
      system = f"{system}\n候选人简历摘要：\n{resume_brief}\n请基于摘要细节追问，避免泛泛而谈。"
    elif resume_hint:
      system = f"{system}\n候选人简历信息（节选）：\n{resume_hint}\n请基于简历细节追问，避免泛泛而谈。"
    elif resume_facts:
      system = f"{system}\n候选人简历要点：\n- " + "\n- ".join(resume_facts) + "\n请基于要点细节追问，避免泛泛而谈。"
    if turn == 0:
      if str(req.resume_url or "").strip() and not resume_hint and not resume_facts:
        text = "我这边简历内容没解析出来，可能是图片版PDF。你能换成 docx 或可复制文字的 pdf 再上传吗？"
        text = _enforce_max_chars(text, 50)
        if not text:
          text = "你能把简历换成 docx 再上传吗？"
        st.messages.append({"role": "assistant", "content": text})
        st.messages = _trim_history(st.messages, max_turns=int(_env("SESSION_MAX_TURNS", "12") or "12"))
        st.updated_at = _now()
        solo_turn_by_session[session_id] = turn + 1
        audio_url: str | None = None
        audio_data_uri: str | None = None
        tts_enabled = (_env("TTS_ENABLED", "true").lower() == "true")
        if tts_enabled:
          voice = _env("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
          try:
            audio_data_uri = await tts_to_mp3_data_uri(text, voice)
          except Exception:
            audio_data_uri = None
        return JSONResponse(ChatResponse(session_id=session_id, text=text, audio_url=audio_url, audio_data_uri=audio_data_uri).model_dump())
      follow_system = (
        f"{system}\n你已经在第一问让候选人做了自我介绍。"
        "现在请基于简历内容+候选人的自我介绍，给出 1 个个性化追问。\n"
        "硬性要求：\n"
        "1) 只输出 1 句话，且必须是一个问句。\n"
        "2) 必须引用简历里的具体细节（项目名/公司名/工具/数字指标 至少一个），不要编造。\n"
        "3) 不要再问“自我介绍”。\n"
      )
      if resume_facts:
        follow_system = f"{follow_system}\n可引用的简历原句片段（引用时尽量原样复述其中一段）：\n- " + "\n- ".join(resume_facts[:8])
      try:
        text = await _call_llm([{"role": "system", "content": follow_system}, {"role": "user", "content": f"候选人自我介绍：{user_text}"}])
      except Exception:
        text = _mock_personalized_followup(resume_brief or resume_hint or "\n".join(resume_facts))
    else:
      llm_messages = [{"role": "system", "content": system}, *st.messages]
      try:
        text = await _call_llm(llm_messages)
      except Exception:
        text = _mock_interviewer_reply(user_text)

    text = _enforce_max_chars(text, 50)
    if not text:
      text = "我没听清，能再说一遍吗？"

    st.messages.append({"role": "assistant", "content": text})
    st.messages = _trim_history(st.messages, max_turns=int(_env("SESSION_MAX_TURNS", "12") or "12"))
    st.updated_at = _now()
    if turn >= 0:
      solo_turn_by_session[session_id] = turn + 1

    audio_url: str | None = None
    audio_data_uri: str | None = None
    tts_enabled = (_env("TTS_ENABLED", "true").lower() == "true")
    if tts_enabled:
      voice = _env("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
      try:
        audio_data_uri = await tts_to_mp3_data_uri(text, voice)
      except Exception:
        audio_data_uri = None

    return JSONResponse(
      ChatResponse(session_id=session_id, text=text, audio_url=audio_url, audio_data_uri=audio_data_uri).model_dump()
    )

  @app.post("/api/solo/start", response_model=ChatResponse)
  async def solo_start(req: SoloStartRequest) -> Any:
    session_id = req.session_id.strip()
    if not session_id:
      raise HTTPException(status_code=400, detail="session_id is empty")
    st = sessions.get(session_id)
    if st is None:
      st = SessionState(messages=[], updated_at=_now())
      sessions[session_id] = st
    st.updated_at = _now()
    st.messages = []
    solo_turn_by_session[session_id] = 0
    if str(req.resume_url or "").strip():
      resume_url_by_session[session_id] = str(req.resume_url or "").strip()
      try:
        asyncio.create_task(_ensure_resume_brief(session_id, req.resume_url))
      except Exception:
        pass

    text = _mock_opening_question("")

    st.messages.append({"role": "assistant", "content": text})
    st.messages = _trim_history(st.messages, max_turns=int(_env("SESSION_MAX_TURNS", "12") or "12"))
    st.updated_at = _now()

    audio_url: str | None = None
    audio_data_uri: str | None = None
    tts_enabled = (_env("TTS_ENABLED", "true").lower() == "true")
    if tts_enabled:
      voice = _env("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
      try:
        audio_data_uri = await tts_to_mp3_data_uri(text, voice)
      except Exception:
        audio_data_uri = None
    return JSONResponse(ChatResponse(session_id=session_id, text=text, audio_url=audio_url, audio_data_uri=audio_data_uri).model_dump())

  @app.post("/api/group_chat", response_model=GroupChatResponse)
  async def group_chat(req: GroupChatRequest, request: Request) -> Any:
    session_id = req.session_id.strip()
    user_text = req.user_text.strip()
    member_id = req.member_id.strip()
    if not user_text:
      raise HTTPException(status_code=400, detail="user_text is empty")

    st = group_sessions.get(session_id)
    if st is None:
      st = SessionState(messages=[], updated_at=_now())
      group_sessions[session_id] = st

    st.updated_at = _now()
    st.messages.append({"role": "user", "content": user_text})
    st.messages = _trim_history(st.messages, max_turns=int(_env("SESSION_MAX_TURNS", "12") or "12"))

    member_name = next((m["name"] for m in members_seed if m["id"] == member_id), member_id)
    group_system = f"{SYSTEM_PROMPT}\n当前说话组员：{member_name}"
    llm_messages = [{"role": "system", "content": group_system}, *st.messages]

    try:
      text = await _call_llm(llm_messages)
    except Exception:
      text = _mock_group_member_reply(member_name, user_text)

    text = str(text).strip()
    if not text:
      text = "我没听清，能再说一遍吗？"

    st.messages.append({"role": "assistant", "content": text})
    st.messages = _trim_history(st.messages, max_turns=int(_env("SESSION_MAX_TURNS", "12") or "12"))
    st.updated_at = _now()

    audio_url: str | None = None
    tts_enabled = (_env("TTS_ENABLED", "true").lower() == "true")
    if tts_enabled:
      voice = voice_by_member_id.get(member_id) or _env("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
      fname = f"{session_id}_{member_id}_{uuid.uuid4().hex}.mp3"
      fpath = audio_dir / fname
      try:
        await tts_to_mp3_file(text, fpath, voice)
        audio_url = _abs_url(request, f"/static/audio/{fname}")
      except Exception:
        audio_url = None

    return JSONResponse(GroupChatResponse(session_id=session_id, member_id=member_id, text=text, audio_url=audio_url).model_dump())

  @app.post("/api/upload_resume", response_model=ResumeUploadResponse)
  async def upload_resume(request: Request, session_id: str = Form(min_length=1), file: UploadFile = File(...)) -> Any:
    sid = str(session_id or "").strip()
    if not sid:
      raise HTTPException(status_code=400, detail="session_id is empty")
    name = str(file.filename or "").strip()
    suffix = Path(name).suffix.lower()
    if suffix not in {".pdf", ".doc", ".docx"}:
      raise HTTPException(status_code=400, detail="only .pdf/.doc/.docx are supported")
    fname = f"{sid}_{uuid.uuid4().hex}{suffix}"
    out_path = resumes_dir / fname
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
      content = await file.read()
    except Exception as e:
      raise HTTPException(status_code=400, detail=f"read upload failed: {e}")
    try:
      out_path.write_bytes(content)
    except Exception as e:
      raise HTTPException(status_code=500, detail=f"save upload failed: {e}")
    file_url = _abs_url(request, f"/static/resumes/{fname}")
    resume_url_by_session[sid] = file_url
    resume_text_by_session[sid] = _extract_resume_text(resumes_dir, file_url)
    resume_brief_by_session.pop(sid, None)
    try:
      asyncio.create_task(_ensure_resume_brief(sid, file_url))
    except Exception:
      pass
    return JSONResponse(ResumeUploadResponse(session_id=sid, file_url=file_url).model_dump())

  return app


app = create_app()
