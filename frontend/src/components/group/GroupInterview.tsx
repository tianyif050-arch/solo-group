import { useNavigate } from 'react-router-dom'
import { useBodyClass } from '@/useBodyClass'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTTS } from '@/hooks/useTTS'
import { enqueueAudioUrl, stopAudioQueue, unlockAudioWithMic } from '@/utils/audioQueue'
import Topbar from '@/components/Topbar'

type Agent = { speaker_id: string; speaker_name: string }

type WsHello = { type: 'hello'; run_id: string; stage: string; agents: Agent[]; asr_enabled: boolean; asr_warning?: string }
type WsAgentSpeak = { type: 'agent_speak'; ts_ms: number; speaker_id: string; speaker_name: string; text?: string; content?: string; audio_url?: string; role?: string }
type WsStage = { type: 'stage'; ts_ms: number; stage: string; content: string }
type WsTopic = { type: 'topic'; topic_id: string; title: string; content: string; read_seconds: number }
type WsUserPartial = { type: 'user_partial'; text: string }
type WsUserFinal = { type: 'user_final'; ts_ms: number; text: string }
type WsDone = { type: 'done'; run_id: string; assessment_json?: string; assessment_md?: string }
type WsStopped = { type: 'stopped'; run_id: string; assessment_json?: string; assessment_md?: string }

type WsMsg = WsHello | WsAgentSpeak | WsStage | WsTopic | WsUserPartial | WsUserFinal | WsDone | WsStopped | { type: string; [k: string]: any }

type ChatMsg = {
  tsMs: number
  speakerId: string
  speakerName: string
  content: string
  tag?: string
  interrupt?: boolean
}

function fmtMmSs(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function fmtTime(tsMs: number) {
  const d = new Date(tsMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function downsampleBuffer(buffer: Float32Array, inSampleRate: number, outSampleRate: number) {
  if (outSampleRate === inSampleRate) return buffer
  const ratio = inSampleRate / outSampleRate
  const newLen = Math.round(buffer.length / ratio)
  const result = new Float32Array(newLen)
  let offsetResult = 0
  let offsetBuffer = 0
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
    let acc = 0
    let count = 0
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      acc += buffer[i]
      count++
    }
    result[offsetResult] = acc / Math.max(1, count)
    offsetResult++
    offsetBuffer = nextOffsetBuffer
  }
  return result
}

function floatTo16BitPCM(float32Array: Float32Array) {
  const out = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function hashRole(input: string) {
  const s = String(input || '')
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function agentAvatarDataUri(label: string, seed: string) {
  const colors = [
    ['#9a79fc', '#5ad7c5'],
    ['#ffb86b', '#9a79fc'],
    ['#5ad7c5', '#ff6b6b'],
    ['#6b8bff', '#ffb86b'],
  ]
  const idx = hashRole(seed) % colors.length
  const [c1, c2] = colors[idx] || colors[0]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="url(#g)"/><circle cx="64" cy="52" r="22" fill="#fff" opacity="0.92"/><path d="M24 118c8-22 25-34 40-34s32 12 40 34" fill="#fff" opacity="0.92"/><text x="64" y="72" font-size="18" text-anchor="middle" fill="#3d3671" font-family="system-ui, -apple-system, Segoe UI, Roboto">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export default function GroupInterview() {
  useDemoStylesheet()
  useBodyClass('groupBody')
  const navigate = useNavigate()
  const tts = useTTS()
  const httpBaseRef = useRef<string>('http://127.0.0.1:8799')

  const examinerHref = useMemo(() => new URL('../../assets/static/examiner.svg', import.meta.url).href, [])
  const micGain = useMemo(() => {
    const v = Number(String(((import.meta as any).env || {}).VITE_MIC_GAIN || '3'))
    return Number.isFinite(v) && v > 0 ? v : 3
  }, [])

  const wsRef = useRef<WebSocket | null>(null)
  const agentNameByIdRef = useRef<Record<string, string>>({})
  const [statusText, setStatusText] = useState('未连接')
  const [wsUrl, setWsUrl] = useState('')
  const [runId, setRunId] = useState('')
  const [reportRunId, setReportRunId] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [asrEnabled, setAsrEnabled] = useState(false)
  const [asrWarning, setAsrWarning] = useState('')

  const [stageLabel, setStageLabel] = useState('准备中')
  const pageLoadedAtRef = useRef<number>(Date.now())
  const [stageTimerText, setStageTimerText] = useState('00:00')

  const [topic, setTopic] = useState<{ title: string; content: string; readSeconds: number } | null>(null)
  const [topicOverlayVisible, setTopicOverlayVisible] = useState(false)
  const [topicOverlayCountdown, setTopicOverlayCountdown] = useState('00:00')
  const [topicDialogOpen, setTopicDialogOpen] = useState(false)

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [partialText, setPartialText] = useState('（等待语音输入）')
  const [paused, setPaused] = useState(false)
  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [discussionActive, setDiscussionActive] = useState(false)

  const [discussMinutes, setDiscussMinutes] = useState(20)
  const discussEndAtRef = useRef<number>(0)
  const [countdownText, setCountdownText] = useState('-')

  const [speakingId, setSpeakingId] = useState<string>('')
  const speakingTimerRef = useRef<number | null>(null)

  const [cameraId, setCameraId] = useState<string>(() => {
    try {
      return localStorage.getItem('camera_device_id') || 'default'
    } catch {
      return 'default'
    }
  })
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioSrcRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcRef = useRef<ScriptProcessorNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioSampleRateRef = useRef<number>(0)
  const [audioStreaming, setAudioStreaming] = useState(false)
  const [audioRms, setAudioRms] = useState(0)
  const lastRmsUpdateAtRef = useRef<number>(0)
  const [isUserSpeaking, setIsUserSpeaking] = useState(false)
  const userSpeakingUntilRef = useRef<number>(0)
  const lastBargeAtRef = useRef<number>(0)

  const [sessionRunning, setSessionRunning] = useState(false)
  const [canShowReport, setCanShowReport] = useState(false)

  const speakTextFallback = (text: string, roleHint?: string) => {
    const t = String(text || '').trim()
    if (!t) return
    const synth = (window as any).speechSynthesis as SpeechSynthesis | undefined
    const Utter = (window as any).SpeechSynthesisUtterance as typeof SpeechSynthesisUtterance | undefined
    if (!synth || !Utter) return
    try {
      const u = new Utter(t)
      u.lang = 'zh-CN'
      u.rate = 0.95
      const voices = synth.getVoices?.() || []
      const zhVoices = voices.filter((v) => String(v.lang || '').toLowerCase().includes('zh'))
      if (zhVoices.length) {
        const idx = hashRole(String(roleHint || 'group_agent')) % zhVoices.length
        u.voice = zhVoices[idx] || null
      }
      synth.speak(u)
    } catch {}
  }

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setStageTimerText(fmtMmSs(Date.now() - pageLoadedAtRef.current))
    }, 250)
    return () => window.clearInterval(timerId)
  }, [])

  useEffect(() => {
    return () => {
      stopAudioQueue()
    }
  }, [])

  useEffect(() => {
    if (!paused) return
    stopAudioQueue()
  }, [paused])

  useEffect(() => {
    const timerId = window.setInterval(() => {
      if (!discussEndAtRef.current) return
      const left = discussEndAtRef.current - Date.now()
      if (left <= 0) {
        setCountdownText('00:00')
        discussEndAtRef.current = 0
        return
      }
      setCountdownText(fmtMmSs(left))
    }, 250)
    return () => window.clearInterval(timerId)
  }, [])

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setCameraDevices(devices.filter((d) => d.kind === 'videoinput'))
    })
  }, [])

  useEffect(() => {
    if (!cameraId || cameraId === 'default') return
    if (!cameraDevices.length) return
    if (cameraDevices.some((d) => d.deviceId === cameraId)) return
    setCameraId('default')
  }, [cameraDevices, cameraId])

  useEffect(() => {
    try {
      localStorage.setItem('camera_device_id', cameraId)
    } catch {}
  }, [cameraId])

  const appendMessage = (m: ChatMsg) => {
    setMessages((prev) => [...prev, m].slice(-200))
  }

  const markSpeaking = (speakerId: string) => {
    setSpeakingId(speakerId)
    if (speakingTimerRef.current) window.clearTimeout(speakingTimerRef.current)
    speakingTimerRef.current = window.setTimeout(() => setSpeakingId(''), 1500)
  }

  useEffect(() => {
    if (!audioStreaming) return
    if (!isUserSpeaking) return
    const now = Date.now()
    if (now - lastBargeAtRef.current < 900) return
    lastBargeAtRef.current = now
    stopAudioQueue()
    try {
      wsRef.current?.send(JSON.stringify({ type: 'barge_in', ts_ms: now }))
    } catch {}
  }, [audioStreaming, isUserSpeaking])

  const connect = () => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return
    setStatusText('连接中')
    const urls: string[] = []
    const envAny = (import.meta as any).env || {}
    const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
    const pageHost = typeof window !== 'undefined' ? String(window.location.hostname || '') : ''
    const isLocalPage = pageHost === 'localhost' || pageHost === '127.0.0.1'
    const wsProto = pageIsHttps ? 'wss' : 'ws'
    const groupWs = String(envAny.VITE_GROUP_WS_URL || '').trim()
    if (groupWs) urls.push(groupWs)
    const commonWs = String(envAny.VITE_WS_URL || '').trim()
    if (commonWs) urls.push(commonWs)
    const groupApi = String(envAny.VITE_GROUP_API_URL || '').trim()
    if (groupApi) {
      try {
        const u = new URL(groupApi)
        const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
        urls.push(`${proto}//${u.host}/ws`)
      } catch {}
    }
    if (isLocalPage) {
      try {
        urls.push(`${wsProto}://127.0.0.1:8800/ws`)
      } catch {}
    }
    if (!urls.length) {
      setWsUrl('')
      setStatusText('连接失败')
      return
    }

    const tryConnect = (idx: number) => {
      const ws = new WebSocket(urls[idx])
      wsRef.current = ws

      ws.onopen = () => {
        setStatusText('已连接')
        setWsUrl(ws.url || urls[idx] || '')
        try {
          const u = new URL(ws.url || urls[idx])
          const proto = u.protocol === 'wss:' ? 'https:' : 'http:'
          httpBaseRef.current = `${proto}//${u.host}`
        } catch {}
      }
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null
        setWsUrl('')
        if (idx + 1 < urls.length) {
          tryConnect(idx + 1)
          return
        }
        setStatusText('未连接')
      }
      ws.onerror = () => {
        if (idx + 1 < urls.length) {
          tryConnect(idx + 1)
          return
        }
        setWsUrl('')
        setStatusText('连接失败')
      }
      ws.onmessage = (evt) => {
        let msg: WsMsg
        try {
          msg = JSON.parse(String(evt.data || ''))
        } catch {
          return
        }

        if (msg.type === 'hello') {
          const m = msg as WsHello
          setRunId(String(m.run_id || ''))
          const raw = Array.isArray(m.agents) ? m.agents : []
          const mapped = raw.map((a, idx) => ({
            speaker_id: a.speaker_id,
            speaker_name: `组员${String.fromCharCode(65 + (idx % 26))}`,
          }))
          agentNameByIdRef.current = Object.fromEntries(mapped.map((a) => [a.speaker_id, a.speaker_name]))
          setAgents(mapped)
          setAsrEnabled(Boolean(m.asr_enabled))
          setAsrWarning(String(m.asr_warning || ''))
        } else if (msg.type === 'topic') {
          const m = msg as WsTopic
          setTopic({ title: m.title, content: m.content, readSeconds: m.read_seconds })
          setTopicOverlayVisible(true)
          const endAt = Date.now() + Math.max(1, Number(m.read_seconds)) * 1000
          const id = window.setInterval(() => {
            const left = endAt - Date.now()
            if (left <= 0) {
              window.clearInterval(id)
              setTopicOverlayCountdown('00:00')
              setTopicOverlayVisible(false)
            setDiscussionActive(true)
            discussEndAtRef.current = Date.now() + Math.max(1, Number(discussMinutes)) * 60 * 1000
            setCountdownText(fmtMmSs(discussEndAtRef.current - Date.now()))
            } else {
              setTopicOverlayCountdown(fmtMmSs(left))
            }
          }, 250)
          setTopicOverlayCountdown(fmtMmSs(Math.max(0, endAt - Date.now())))
        } else if (msg.type === 'agent_speak') {
          if (paused) return
          const m = msg as WsAgentSpeak
          const text = String(m.content || m.text || '').trim()
          if (text) {
            console.log('收到后端回答文本:', text)
            console.log('准备调用 speak()...')
          }
          const rel = String(m.audio_url || '').trim()
          if (ttsEnabled && rel) {
            const abs = `${httpBaseRef.current}${rel.startsWith('/') ? '' : '/'}${rel}`
            enqueueAudioUrl(abs, {
              onStart: () => setSpeakingId(m.speaker_id),
              onEnded: () => setSpeakingId(''),
              onError: () => setSpeakingId(''),
            })
          } else if (ttsEnabled && text) {
            speakTextFallback(text, String(m.speaker_id || m.role || 'group_agent'))
          }
          appendMessage({
            tsMs: m.ts_ms || Date.now(),
            speakerId: m.speaker_id,
            speakerName: String(agentNameByIdRef.current[m.speaker_id] || '组员'),
            content: text,
            tag: 'AI',
          })
          if (!ttsEnabled || !rel) markSpeaking(m.speaker_id)
        } else if (msg.type === 'user_partial') {
          const m = msg as WsUserPartial
          setPartialText(m.text ? m.text : '（等待语音输入）')
        } else if (msg.type === 'user_final') {
          const m = msg as WsUserFinal
          const text = String(m.text || '').trim()
          if (!text) return
          appendMessage({
            tsMs: m.ts_ms || Date.now(),
            speakerId: 'user',
            speakerName: '你',
            content: text,
            tag: 'USER',
          })
          setPartialText('（等待语音输入）')
          markSpeaking('user')
        } else if (msg.type === 'stage') {
          const m = msg as WsStage
          appendMessage({ tsMs: m.ts_ms || Date.now(), speakerId: 'system', speakerName: '系统', content: m.content, tag: m.stage })
          setStageLabel(m.stage === 'read' ? '准备中' : m.stage === 'discuss' ? '进行中' : m.stage === 'summary' ? '总结中' : '进行中')
        if (m.stage === 'discuss' && !discussionActive) {
          setDiscussionActive(true)
          discussEndAtRef.current = Date.now() + Math.max(1, Number(discussMinutes)) * 60 * 1000
          setCountdownText(fmtMmSs(discussEndAtRef.current - Date.now()))
        }
        } else if (msg.type === 'done' || msg.type === 'stopped') {
          const m = msg as WsDone | WsStopped
          setSessionRunning(false)
        setDiscussionActive(false)
          setCanShowReport(true)
          setReportRunId(String(m.run_id || '').trim())
          setStageLabel('已结束')
          discussEndAtRef.current = 0
          setCountdownText('-')
          appendMessage({ tsMs: Date.now(), speakerId: 'system', speakerName: '系统', content: '本轮面试已结束，报告生成中…', tag: m.type })
        }
      }
    }

    tryConnect(0)
  }

  const startCamera = async () => {
    const constraintsExact: MediaStreamConstraints =
      cameraId && cameraId !== 'default' ? { video: { deviceId: { exact: cameraId } }, audio: false } : { video: true, audio: false }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraintsExact)
    } catch (e: any) {
      const name = String(e?.name || '')
      if (name === 'OverconstrainedError' || name === 'NotFoundError') {
        setCameraId('default')
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      } else {
        throw e
      }
    }
    cameraStreamRef.current = stream
    if (videoRef.current) videoRef.current.srcObject = stream
  }

  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }

  const startAudioStreaming = async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (audioStreamRef.current || audioStreaming) {
      stopAudioStreaming()
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false })
    } catch (e: any) {
      const name = String(e?.name || '')
      if (name === 'OverconstrainedError' || name === 'NotFoundError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      }
      if (name === 'NotReadableError') {
        throw new Error('NotReadableError：麦克风被占用或无法启动（请关闭占用麦克风的 App/网页后重试）')
      }
      throw e
    }
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
    let ctx: AudioContext
    try {
      ctx = new (AudioCtx as any)({ sampleRate: 16000 })
    } catch {
      ctx = new AudioCtx()
    }
    try {
      if (ctx.state === 'suspended') await ctx.resume()
    } catch {}
    if (ctx.state !== 'running') {
      throw new Error(`AudioContext 未运行（state=${ctx.state}），请再次点击“开始面试”以激活麦克风权限`)
    }
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(8192, 1, 1)
    audioCtxRef.current = ctx
    audioSrcRef.current = source
    audioProcRef.current = processor
    audioStreamRef.current = stream
    audioSampleRateRef.current = ctx.sampleRate
    setAudioStreaming(true)
    setAudioRms(0)
    lastRmsUpdateAtRef.current = 0

    processor.onaudioprocess = (e) => {
      const currWs = wsRef.current
      if (!currWs || currWs.readyState !== WebSocket.OPEN) return
      const input = e.inputBuffer.getChannelData(0)
      const down = downsampleBuffer(input, audioSampleRateRef.current, 16000)
      if (micGain !== 1) {
        for (let i = 0; i < down.length; i++) {
          const s = down[i] * micGain
          down[i] = s < -1 ? -1 : s > 1 ? 1 : s
        }
      }
      const now = Date.now()
      if (now - lastRmsUpdateAtRef.current >= 180) {
        let acc = 0
        for (let i = 0; i < down.length; i++) acc += down[i] * down[i]
        const rms = Math.sqrt(acc / Math.max(1, down.length))
        lastRmsUpdateAtRef.current = now
        setAudioRms((prev) => prev * 0.7 + rms * 0.3)
        if (rms >= 0.015) userSpeakingUntilRef.current = now + 350
        setIsUserSpeaking(now < userSpeakingUntilRef.current)
      }
      const pcm16 = floatTo16BitPCM(down)
      try {
        currWs.send(pcm16.buffer)
      } catch {}
    }

    source.connect(processor)
    processor.connect(ctx.destination)
  }

  const stopAudioStreaming = () => {
    setAudioStreaming(false)
    setAudioRms(0)
    setIsUserSpeaking(false)
    try {
      audioProcRef.current?.disconnect()
      audioSrcRef.current?.disconnect()
    } catch {}
    try {
      audioStreamRef.current?.getTracks()?.forEach((t) => t.stop())
    } catch {}
    try {
      audioCtxRef.current?.close()
    } catch {}
    audioCtxRef.current = null
    audioSrcRef.current = null
    audioProcRef.current = null
    audioStreamRef.current = null
  }

  useEffect(() => {
    if (!sessionRunning) return
    if (!discussionActive) return
    if (!asrEnabled) return
    if (audioStreaming) return
    startAudioStreaming().catch((e) => {
      appendMessage({ tsMs: Date.now(), speakerId: 'system', speakerName: '系统', content: `麦克风初始化失败：${e}` })
    })
  }, [sessionRunning, discussionActive, asrEnabled, audioStreaming])

  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close()
      } catch {}
      wsRef.current = null
      stopCamera()
      stopAudioStreaming()
      if (speakingTimerRef.current) window.clearTimeout(speakingTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (ttsEnabled && !tts.isUnlocked) return
    connect()
  }, [tts.isUnlocked, ttsEnabled])

  const startSession = async () => {
    connect()
    for (let i = 0; i < 50; i++) {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) break
      await new Promise((r) => window.setTimeout(r, 100))
    }

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendMessage({
        tsMs: Date.now(),
        speakerId: 'system',
        speakerName: '系统',
        content: '连接后端失败：请先启动 group_interview_demo 后端（8800 端口），再点击“开始面试”。',
        tag: 'error',
      })
      return
    }
    setSessionRunning(true)
    setDiscussionActive(false)
    setCanShowReport(false)
    setReportRunId('')
    setMessages([])
    setPartialText('（等待语音输入）')
    discussEndAtRef.current = 0
    setCountdownText('-')
    setAudioRms(0)

    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false })
      s.getTracks().forEach((t) => t.stop())
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
      const ctx = new AudioCtx()
      try {
        if (ctx.state === 'suspended') await ctx.resume()
      } catch {}
      try {
        await ctx.close()
      } catch {}
    } catch (e) {
      appendMessage({ tsMs: Date.now(), speakerId: 'system', speakerName: '系统', content: `麦克风预热失败：${e}` })
    }
    ws.send(
      JSON.stringify({
        type: 'start',
        ts_ms: Date.now(),
        tts: true,
        typewriter: true,
        discuss_minutes: discussMinutes,
      }),
    )
    try {
      await startCamera()
    } catch (e) {
      appendMessage({ tsMs: Date.now(), speakerId: 'system', speakerName: '系统', content: `摄像头初始化失败：${e}` })
    }
  }

  const stopSession = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const rid = runId.trim()
    if (rid) setReportRunId(rid)
    ws.send(JSON.stringify({ type: 'stop', ts_ms: Date.now() }))
    setSessionRunning(false)
    setDiscussionActive(false)
    setCanShowReport(true)
    setStageLabel('已结束')
    discussEndAtRef.current = 0
    setCountdownText('-')
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel()
      } catch {}
    }
    stopCamera()
    stopAudioStreaming()
  }

  const openReport = () => {
    const rid = reportRunId.trim() || runId.trim()
    if (!rid) return
    const apiBase = String(httpBaseRef.current || '').trim()
    navigate(`/report?run_id=${encodeURIComponent(rid)}${apiBase ? `&api_base=${encodeURIComponent(apiBase)}` : ''}`)
  }

  const sendUserText = (text: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const t = text.trim()
    if (!t) return
    ws.send(JSON.stringify({ type: 'user_text', ts_ms: Date.now(), text: t }))
    appendMessage({ tsMs: Date.now(), speakerId: 'user', speakerName: '你', content: t, tag: 'USER' })
    markSpeaking('user')
  }

  const textInputRef = useRef<HTMLTextAreaElement>(null)

  return (
    <div>
      {ttsEnabled && !tts.isUnlocked ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0, 0, 0, 0.10)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <button
            onClick={async () => {
              // 关键：必须由用户点击触发一次“静音 TTS”，才能解除浏览器自动播放限制
              await unlockAudioWithMic()
            }}
            style={{
              height: 56,
              padding: '0 32px',
              borderRadius: 16,
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              fontWeight: 700,
              background: '#9a79fc',
              color: '#fff',
              boxShadow: '0 20px 40px rgba(0,0,0,0.25)',
            }}
          >
            点击进入面试室并开启语音
          </button>
        </div>
      ) : null}
      <Topbar
        right={
          <>
            <div className="statusPill">{statusText}</div>
            {tts.isSpeaking ? <div className="statusPill">面试官正在说话...</div> : null}
            <button className="primary" onClick={startSession} disabled={sessionRunning}>
              开始面试
            </button>
            <button className="danger" onClick={stopSession} disabled={!sessionRunning}>
              结束面试
            </button>
            <button className="ghost" onClick={openReport} disabled={!canShowReport || !(reportRunId.trim() || runId.trim())}>
              进入总结
            </button>
          </>
        }
      />

      <main className="page">
        <section className="stageCard">
          {topic ? (
            <div className="topicBar">
              <div className="topicLeft">
                <div className="topicLabel">当前题目：</div>
                <div className="topicTitle">{topic.title}</div>
              </div>
              <button className="linkBtn" onClick={() => setTopicDialogOpen(true)}>
                查看完整题目
              </button>
            </div>
          ) : null}

          {topic && topicOverlayVisible ? (
            <div className="topicOverlay">
              <div className="topicOverlayCard">
                <div className="topicOverlayHead">
                  <div className="topicOverlayTitle">当前题目</div>
                  <div className="topicOverlayCountdown">{topicOverlayCountdown}</div>
                </div>
                <div className="topicOverlayText">{topic.content}</div>
              </div>
            </div>
          ) : null}

          <div className="room">
            <div className="tiles">
              <div className={`tile examiner ${speakingId === 'examiner' ? 'speaking' : ''}`} data-speaker-id="examiner">
                <div className="tileHeader">
                  <div className="tileName">AI考官</div>
                  <div className="tileBadge">发言中</div>
                </div>
                <div className="examinerBody">
                  <img className="examinerImg" src={examinerHref} alt="" />
                </div>
              </div>

              <div className={`tile videoTile ${speakingId === 'user' ? 'speaking' : ''}`} data-speaker-id="user">
                <div className="tileHeader">
                  <div className="tileName">你</div>
                  <div className="tileBadge">发言中</div>
                </div>
                <video ref={videoRef} autoPlay playsInline muted />
              </div>

              <div className={`tile placeholder ${speakingId === (agents[0]?.speaker_id || 'agent_1') ? 'speaking' : ''}`} data-speaker-id={agents[0]?.speaker_id || 'agent_1'}>
                <div className="tileHeader">
                  <div className="tileName">{agents[0]?.speaker_name || '组员A'}</div>
                  <div className="tileBadge">发言中</div>
                </div>
                <div className="phBody">
                  <img className="phAvatar" src={agentAvatarDataUri('A', agents[0]?.speaker_id || 'agent_1')} alt="" />
                </div>
              </div>

              <div className="sideCol">
                <div className="card subtitles">
                  <div className="cardHeader">
                    <div className="cardTitle">
                      实时字幕
                      <span className="subnote">
                        {' '}
                        {audioStreaming ? ` · ${audioRms.toFixed(3)}` : ''}
                        {sessionRunning && !discussionActive ? ' · 读题中' : ''}
                      </span>
                    </div>
                    <button className="ghost" onClick={() => setPaused((p) => !p)}>
                      {paused ? '继续' : '暂停'}
                    </button>
                  </div>
                  {audioStreaming && isUserSpeaking ? <div className="hint">正在听取语音...</div> : null}
                  <div className="subtitleLog">
                    {messages.map((m, idx) => (
                      <div key={`${m.tsMs}-${idx}`} className={`msg ${m.interrupt ? 'interrupt' : ''}`}>
                        <div className="meta">
                          <div className="name">{m.speakerName}</div>
                          <div className="time">{fmtTime(m.tsMs)}</div>
                          {m.tag ? <div className="tag">{m.tag}</div> : null}
                        </div>
                        <div className="content">{m.content}</div>
                      </div>
                    ))}
                  </div>
                  {asrEnabled ? null : asrWarning ? <div className="hint">{asrWarning}</div> : null}
                </div>
              </div>

              <div className={`tile placeholder ${speakingId === (agents[1]?.speaker_id || 'agent_2') ? 'speaking' : ''}`} data-speaker-id={agents[1]?.speaker_id || 'agent_2'}>
                <div className="tileHeader">
                  <div className="tileName">{agents[1]?.speaker_name || '组员B'}</div>
                  <div className="tileBadge">发言中</div>
                </div>
                <div className="phBody">
                  <img className="phAvatar" src={agentAvatarDataUri('B', agents[1]?.speaker_id || 'agent_2')} alt="" />
                </div>
              </div>

              <div className={`tile placeholder ${speakingId === (agents[2]?.speaker_id || 'agent_3') ? 'speaking' : ''}`} data-speaker-id={agents[2]?.speaker_id || 'agent_3'}>
                <div className="tileHeader">
                  <div className="tileName">{agents[2]?.speaker_name || '组员C'}</div>
                  <div className="tileBadge">发言中</div>
                </div>
                <div className="phBody">
                  <img className="phAvatar" src={agentAvatarDataUri('C', agents[2]?.speaker_id || 'agent_3')} alt="" />
                </div>
              </div>

              <div className={`tile placeholder ${speakingId === (agents[3]?.speaker_id || 'agent_4') ? 'speaking' : ''}`} data-speaker-id={agents[3]?.speaker_id || 'agent_4'}>
                <div className="tileHeader">
                  <div className="tileName">{agents[3]?.speaker_name || '组员D'}</div>
                  <div className="tileBadge">发言中</div>
                </div>
                <div className="phBody">
                  <img className="phAvatar" src={agentAvatarDataUri('D', agents[3]?.speaker_id || 'agent_4')} alt="" />
                </div>
              </div>

              <div className="sideCol">
                <div className="card timerCard">
                  <div className="timerLeft">
                    <div className="timerIcon" aria-hidden="true" />
                    <div className="timerLabel">当前剩余时间</div>
                  </div>
                  <div className="timerValue">{countdownText}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="stageBar">
            <div className="stageText">{stageLabel}</div>
            <div className="stageProgress" aria-hidden="true" />
            <div className="stageTime">{stageTimerText}</div>
          </div>
        </section>

        <section className="speakCard">
          <div className="speakTitle">你的发言</div>
          <div className="speakBody">
            <div className="partial">{partialText}</div>
            <div className="speakRow">
              <textarea
                ref={textInputRef}
                className="textInput"
                rows={2}
                placeholder="（可选）打字发送：无 ASR / 调试时使用"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    sendUserText(textInputRef.current?.value || '')
                    if (textInputRef.current) textInputRef.current.value = ''
                  }
                }}
              />
              <button
                className="primary"
                onClick={() => {
                  sendUserText(textInputRef.current?.value || '')
                  if (textInputRef.current) textInputRef.current.value = ''
                }}
              >
                发送
              </button>
            </div>
            <div className="hint">说话即可发言；当你开口时，正在播报/打字的 AI 会立刻停止（模拟抢话打断）。</div>
          </div>
        </section>

        <section className="hidden">
          <select value={discussMinutes} onChange={(e) => setDiscussMinutes(Number(e.target.value))}>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="15">15</option>
            <option value="20">20</option>
            <option value="25">25</option>
            <option value="30">30</option>
          </select>
        </section>

        {topicDialogOpen && topic ? (
          <div className="topicDialogBackdrop" onClick={() => setTopicDialogOpen(false)}>
            <dialog open className="topicDialog" onClick={(e) => e.stopPropagation()}>
              <div className="dialogHeader">
                <div className="dialogTitle">题目详情</div>
                <button className="ghost" onClick={() => setTopicDialogOpen(false)}>
                  关闭
                </button>
              </div>
              <div className="dialogBody">
                <div className="dialogTopicTitle">{topic.title}</div>
                <div className="dialogTopicContent">{topic.content}</div>
              </div>
            </dialog>
          </div>
        ) : null}
      </main>
    </div>
  )
}
