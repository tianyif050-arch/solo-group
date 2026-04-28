import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, BookText, Bot, Clock3, Eye, Gauge, Goal, MessageSquareWarning, Pause, PieChart, Play } from 'lucide-react'
import { useInterviewSocket } from '@/hooks/useInterviewSocket'
import { useTTS } from '@/hooks/useTTS'
import { stopAudioQueue, unlockAudioWithMic } from '@/utils/audioQueue'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import Topbar from '@/components/Topbar'
import { upsertInterviewRecord } from '@/utils/interviewArchive'

type Message = {
  role: 'ai' | 'user'
  content: string
  facialScore?: number
  voiceScore?: number
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function radarPoints(values01: number[]) {
  const outer: Array<[number, number]> = [
    [130, 25],
    [200, 62],
    [200, 138],
    [130, 176],
    [60, 138],
    [60, 62],
  ]
  const cx = outer.reduce((a, p) => a + p[0], 0) / outer.length
  const cy = outer.reduce((a, p) => a + p[1], 0) / outer.length
  const pts = outer.map((p, idx) => {
    const f = clamp01(values01[idx] ?? 0)
    const x = cx + (p[0] - cx) * f
    const y = cy + (p[1] - cy) * f
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return pts.join(' ')
}

function fmtMmSs(sec: number) {
  const s = Math.max(0, Math.floor(sec))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export default function SoloInterview() {
  const figmaHomeMenu = new URL('../../../.figma/image/mo5sl2um-itgag4l.svg', import.meta.url).href
  const examinerHref = new URL('../../assets/static/examiner.svg', import.meta.url).href

  useDemoStylesheet()

  const interview = useInterviewSocket({
    mode: 'solo',
    backendUrl: String(((import.meta as any).env || {}).VITE_API_URL || ((import.meta as any).env || {}).VITE_BACKEND_URL || 'http://127.0.0.1:8799'),
    transport: 'http',
    autoConnect: false,
    preferWebSpeech: true,
    speakResponses: true,
  })
  const tts = useTTS()

  const [interviewView, setInterviewView] = useState<'solo' | 'report'>('solo')
  const [messages] = useState<Message[]>([{ role: 'ai', content: '你好！欢迎使用 AI 面试官 Pro。点击开启摄像头！' }])
  const [isVideoActive, setIsVideoActive] = useState(false)
  const [facialScore, setFacialScore] = useState(50)
  const [voiceScore, setVoiceScore] = useState(50)
  const [timeLeftSec, setTimeLeftSec] = useState(30 * 60)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [speakingSpeedPct, setSpeakingSpeedPct] = useState(75)
  const [eyeContactPct, setEyeContactPct] = useState(60)
  const [filterWordsPct, setFilterWordsPct] = useState(2)
  const [mvpAiResponse, setMvpAiResponse] = useState('')
  const [mvpAiSpeaking, setMvpAiSpeaking] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const [reportData, setReportData] = useState<{
    facialScore: number
    voiceScore: number
    messages: Message[]
    radarValues01: number[]
  } | null>(null)

  const candidateVideoRef = useRef<HTMLVideoElement>(null)
  const isInitialized = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const transcriptTextRef = useRef('')
  const facialScoreRef = useRef(50)
  const lastTextLenRef = useRef(0)
  const lastTextTsRef = useRef<number | null>(null)
  const sessionStartedRef = useRef(false)
  const sessionStartedAtRef = useRef<number>(0)
  const sessionStartSentRef = useRef(false)
  const transcriptDebounceRef = useRef<number | null>(null)
  const aiDebounceRef = useRef<number | null>(null)
  const aiSpeakingTimerRef = useRef<number | null>(null)
  const lastSpokenRef = useRef('')
  const audioUnlockedByClickRef = useRef(false)

  const pushSoloDebug = (line: string) => {
    const s = String(line || '')
    try {
      console.log(s)
    } catch {}
  }

  const unlockAudioByClick = async () => {
    // 关键：必须由用户真实点击触发一次 speak()，才能解除浏览器“自动播放/无交互不发声”限制
    if (audioUnlockedByClickRef.current) return
    pushSoloDebug('[SOLO][TTS] 用户点击开始面试：尝试解锁语音合成权限')
    try {
      const silentWavDataUri =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
      const a = new Audio(silentWavDataUri)
      a.volume = 0
      pushSoloDebug('[SOLO][AUDIO] unlock new Audio("").play()')
      await a.play()
      try {
        a.pause()
      } catch {}
    } catch (e) {
      pushSoloDebug(`[SOLO][AUDIO] unlock play() 失败(可忽略): ${String((e as any)?.message || e || 'unknown')}`)
    }
    let ok = false
    try {
      ok = await unlockAudioWithMic()
    } catch {
      ok = false
    }
    audioUnlockedByClickRef.current = ok
  }

  const handleStart = async () => {
    // 关键：手动激活（Manual Activation）
    // 1) 必须在用户点击回调里，先执行一次 new Audio('').play()，否则浏览器可能拦截后续音频播放
    // 2) 如有 AudioContext，也在此处 resume 一次，进一步解除自动播放限制
    // 3) 只有在完成解锁后，才允许建立 WebSocket 连接并开始面试
    pushSoloDebug('[SOLO] handleStart: begin manual activation')

    try {
      const silentWavDataUri =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
      const a = new Audio(silentWavDataUri)
      a.volume = 0
      pushSoloDebug('[SOLO][AUDIO] dummy play() for autoplay unlock')
      await a.play()
      try {
        a.pause()
      } catch {}
    } catch (e) {
      pushSoloDebug(`[SOLO][AUDIO] dummy play failed(可忽略): ${String((e as any)?.message || e || 'unknown')}`)
    }

    try {
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
      if (AudioCtx) {
        const ctx = new AudioCtx()
        pushSoloDebug(`[SOLO][AudioContext] resume for autoplay unlock, state=${String(ctx.state)}`)
        if (ctx.state === 'suspended') await ctx.resume()
        try {
          await ctx.close()
        } catch {}
      }
    } catch (e) {
      pushSoloDebug(`[SOLO][AudioContext] resume failed: ${String((e as any)?.message || e || 'unknown')}`)
    }

    await unlockAudioByClick()
    setIsActive(true)
    pushSoloDebug('[SOLO] isActive=true, starting interview...')
    await startInterview()
  }

  const aiBubbleText = useMemo(() => String(interview.aiResponse || mvpAiResponse || '').trim(), [interview.aiResponse, mvpAiResponse])
  const aiSpeaking = Boolean(tts.isSpeaking || interview.isSpeaking || mvpAiSpeaking)

  useEffect(() => {
    if (interviewView !== 'solo' || !streamRef.current) return
    if (candidateVideoRef.current) {
      candidateVideoRef.current.srcObject = streamRef.current
    }
  }, [interviewView])

  useEffect(() => {
    transcriptTextRef.current = String(interview.transcript || '')
  }, [interview.transcript])

  useEffect(() => {
    facialScoreRef.current = facialScore
  }, [facialScore])

  useEffect(() => {
    if (interviewView !== 'solo') return
    setTimeLeftSec(30 * 60)
    setElapsedSec(0)
    sessionStartedRef.current = false
    sessionStartedAtRef.current = 0
    setSpeakingSpeedPct(75)
    setEyeContactPct(60)
    setFilterWordsPct(2)
    lastTextLenRef.current = transcriptTextRef.current.length
    lastTextTsRef.current = Date.now()

    const timerId = window.setInterval(() => {
      setTimeLeftSec((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)

    const elapsedId = window.setInterval(() => {
      if (!sessionStartedRef.current) return
      const t0 = sessionStartedAtRef.current
      if (!t0) return
      setElapsedSec(Math.floor((Date.now() - t0) / 1000))
    }, 250)

    const analyticsId = window.setInterval(() => {
      const now = Date.now()
      const lastTs = lastTextTsRef.current ?? now
      const dtSec = Math.max(0.5, (now - lastTs) / 1000)
      const text = transcriptTextRef.current
      const len = text.length
      const lastLen = lastTextLenRef.current
      const deltaLen = Math.max(0, len - lastLen)
      const charsPerMin = (deltaLen / dtSec) * 60
      const speedTarget = Math.max(0, Math.min(100, Math.round((charsPerMin / 300) * 100)))
      setSpeakingSpeedPct((prev) => Math.round(prev * 0.7 + speedTarget * 0.3))

      const eyeTarget = Math.max(0, Math.min(100, Math.round(((facialScoreRef.current - 40) / 60) * 100)))
      setEyeContactPct((prev) => Math.round(prev * 0.7 + eyeTarget * 0.3))

      const fillerWords = ['嗯', '额', '就是', '然后', '那个', '其实', '可能', '我觉得']
      const fillerCount = fillerWords.reduce((acc, w) => acc + (text.split(w).length - 1), 0)
      const per100 = (fillerCount / Math.max(1, len)) * 100
      const fillerTarget = Math.max(0, Math.min(100, Math.round(per100 * 6)))
      setFilterWordsPct((prev) => Math.round(prev * 0.7 + fillerTarget * 0.3))

      lastTextLenRef.current = len
      lastTextTsRef.current = now
    }, 2000)

    return () => {
      window.clearInterval(timerId)
      window.clearInterval(elapsedId)
      window.clearInterval(analyticsId)
    }
  }, [interviewView])

  useEffect(() => {
    return () => {
      stopAudioQueue()
    }
  }, [])

  useEffect(() => {
    return () => {
      interview.disconnect()
      if (transcriptDebounceRef.current) window.clearTimeout(transcriptDebounceRef.current)
      if (aiDebounceRef.current) window.clearTimeout(aiDebounceRef.current)
      if (aiSpeakingTimerRef.current) window.clearTimeout(aiSpeakingTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const handler = (evt: any) => {
      const line = String(evt?.detail || '').trim()
      if (!line) return
      pushSoloDebug(line)
    }
    try {
      window.addEventListener('solo_debug', handler as any)
    } catch {}
    return () => {
      try {
        window.removeEventListener('solo_debug', handler as any)
      } catch {}
    }
  }, [])

  const startVideo = async () => {
    if (isInitialized.current) {
      if (streamRef.current) {
        if (candidateVideoRef.current && !candidateVideoRef.current.srcObject) {
          candidateVideoRef.current.srcObject = streamRef.current
        }
      }
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      })
      streamRef.current = stream

      if (candidateVideoRef.current) {
        candidateVideoRef.current.srcObject = stream
      }
      setIsVideoActive(true)
      isInitialized.current = true

      setInterval(() => {
        setFacialScore((prev) => {
          const delta = Math.floor(Math.random() * 10) - 5
          const next = Math.min(100, Math.max(40, prev + delta))
          return next
        })
      }, 1000)
    } catch (err) {
      alert('无法获取摄像头权限！')
    }
  }

  const startInterview = async () => {
    // 注意：WebSocket 连接必须发生在“用户点击解锁”之后
    try {
      if (!isVideoActive) await startVideo()
    } catch {}
    if (!sessionStartedRef.current) {
      sessionStartedRef.current = true
      sessionStartedAtRef.current = Date.now()
      setElapsedSec(0)
    }
    try {
      await interview.connect()
    } catch {}
    if (!sessionStartSentRef.current) {
      const ok = interview.startSession()
      sessionStartSentRef.current = ok
    }
    try {
      await interview.startListening()
    } catch (e) {
      alert(`语音识别启动失败：${e}`)
    }
  }

  const stopInterviewListening = () => {
    interview.stopListening()
  }

  const clearTranscript = () => {
    interview.clear()
    setMvpAiResponse('')
    setMvpAiSpeaking(false)
  }

  const stopInterviewDevices = () => {
    interview.stopListening()
    try {
      interview.disconnect()
    } catch {}
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (candidateVideoRef.current) {
      candidateVideoRef.current.srcObject = null
    }
    isInitialized.current = false
    setIsVideoActive(false)
    setMvpAiResponse('')
    setMvpAiSpeaking(false)
    setElapsedSec(0)
    sessionStartedRef.current = false
    sessionStartedAtRef.current = 0
    sessionStartSentRef.current = false
  }

  const finishInterviewToReport = () => {
    const transcriptLen = Math.max(0, String(transcriptTextRef.current || interview.transcript || '').trim().length)
    const comm = clamp01(voiceScore / 100)
    const logic = clamp01(transcriptLen / 240)
    const prof = clamp01((transcriptLen / 260) * 0.7 + (1 - Math.min(15, Math.max(0, filterWordsPct)) / 15) * 0.3)
    const conf = clamp01((eyeContactPct * 0.55 + facialScore * 0.45) / 100)
    const improv = clamp01((1 - Math.abs(speakingSpeedPct - 75) / 75) * 0.7 + (1 - Math.min(10, Math.max(0, filterWordsPct)) / 10) * 0.3)
    const stable = clamp01(facialScore / 100)
    try {
      const overall = Math.round((facialScore + voiceScore) / 2)
      upsertInterviewRecord({
        id: `solo_${Date.now()}`,
        kind: 'solo',
        createdAt: Date.now(),
        title: '单面',
        scoreOverall: overall,
        payload: {
          facialScore,
          voiceScore,
          eyeContactPct,
          speakingSpeedPct,
          filterWordsPct,
          transcript: String(transcriptTextRef.current || interview.transcript || '').trim(),
          messages: [...messages],
          radarValues01: [comm, logic, prof, conf, improv, stable],
        },
      })
    } catch {}
    stopInterviewDevices()
    setReportData({
      facialScore,
      voiceScore,
      messages: [...messages],
      radarValues01: [comm, logic, prof, conf, improv, stable],
    })
    setInterviewView('report')
  }

  const copyTranscript = async () => {
    const fullText = String(interview.transcript || '').trim()
    if (!fullText) return
    try {
      await navigator.clipboard.writeText(fullText)
      alert('字幕已复制')
    } catch {
      alert('复制失败，请手动复制')
    }
  }

  useEffect(() => {
    if (interview.aiResponse) {
      setMvpAiResponse('')
      setMvpAiSpeaking(false)
      return
    }
    if (!interview.transcript) return
    if (aiDebounceRef.current) window.clearTimeout(aiDebounceRef.current)
    aiDebounceRef.current = window.setTimeout(() => {
      const t = String(interview.transcript || '').trim()
      if (!t) return
      const snippet = t.length > 60 ? t.slice(-60) : t
      setMvpAiResponse(`收到：${snippet}`)
      setMvpAiSpeaking(true)
      if (aiSpeakingTimerRef.current) window.clearTimeout(aiSpeakingTimerRef.current)
      aiSpeakingTimerRef.current = window.setTimeout(() => setMvpAiSpeaking(false), 1500)
    }, 1200)
  }, [interview.aiResponse, interview.transcript])

  useEffect(() => {
    lastSpokenRef.current = String(interview.aiResponse || '')
  }, [interview.aiResponse])

  useEffect(() => {
    const t = String(interview.transcript || '').trim()
    if (!t) return
    if (transcriptDebounceRef.current) window.clearTimeout(transcriptDebounceRef.current)
    transcriptDebounceRef.current = window.setTimeout(() => {
      if (!t) return
      const vScore = Math.min(100, 30 + t.length)
      setVoiceScore(vScore)
    }, 600)
  }, [interview.transcript])

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-[#d7ccfe] text-[#3d3671]">
      <Topbar
        right={
          <>
            {interviewView === 'solo' ? (
              <button className="primary" onClick={finishInterviewToReport}>
                结束面试
              </button>
            ) : null}
            <button className="ghost iconBtn" aria-label="menu">
              <img src={figmaHomeMenu} alt="menu" className="h-5 w-5" />
            </button>
          </>
        }
      />

      <main className="mx-auto w-full min-h-[calc(100vh-72px)] max-w-7xl px-5 py-6">
        {interviewView === 'solo' ? (
          <div className="rounded-2xl bg-[#efe7fd] p-3">
            {!isActive ? (
              <div className="fixed inset-0 z-50 grid place-items-center bg-black/10">
                <button
                  onClick={async () => {
                    // 关键：必须先“手动激活音频”，再连接 WebSocket
                    await handleStart()
                  }}
                  className="h-14 rounded-2xl bg-[#9a79fc] px-8 text-lg font-semibold text-white shadow-xl"
                >
                  开始面试（点击激活语音）
                </button>
              </div>
            ) : null}
            <div className="grid gap-3 rounded-2xl bg-[#efe7fd] lg:h-[calc(100vh-96px)] lg:grid-cols-[1.3fr_0.9fr_1fr]">
              <section className="rounded-2xl bg-[#f9f6ff] p-3">
                <div className="flex h-full flex-col gap-3">
                  <div className="relative flex-1 overflow-hidden rounded-[16px] border-2 border-[#725ac5] bg-[#e7e4ee]">
                    <div className="grid h-full w-full place-items-center">
                      <img src={examinerHref} alt="" className="w-[min(84%,460px)] select-none" draggable={false} />
                    </div>
                    <div className="absolute left-4 top-2 text-sm font-semibold text-[#3d3671]">AI考官</div>
                    {aiSpeaking ? (
                      <div className="absolute right-4 top-2 rounded-full bg-[#9a79fc] px-3 py-1 text-xs font-semibold text-white">面试官正在说话...</div>
                    ) : null}
                    {aiBubbleText ? (
                      <div className="absolute left-4 top-10 max-w-[88%] rounded-2xl bg-white/90 px-3 py-2 text-sm font-semibold text-[#3d3671] shadow">
                        {aiBubbleText}
                      </div>
                    ) : null}
                    <div
                      className={`absolute bottom-3 left-1/2 h-[12px] w-[68%] max-w-[520px] -translate-x-1/2 rounded-[18px] bg-gradient-to-r from-[#39c6b7] via-[#67e29e] via-[#b9ec9c] via-[#f9dd88] to-[#efa397] ${
                        aiSpeaking ? 'animate-pulse' : ''
                      }`}
                    />
                    <div className="absolute bottom-2 right-4 text-[22px] font-semibold text-white sm:text-[26px]">{fmtMmSs(elapsedSec)}</div>
                  </div>
                  <div className="relative flex-1 overflow-hidden rounded-[16px] border-2 border-[#725ac5] bg-[#e7e4ee]">
                    <video
                      ref={candidateVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`h-full w-full object-cover ${isVideoActive ? 'opacity-100' : 'opacity-0'}`}
                    />
                    <div className="absolute left-4 top-2 text-sm font-semibold text-[#3d3671]">考生</div>
                    <div className="absolute bottom-3 left-1/2 h-[12px] w-[68%] max-w-[520px] -translate-x-1/2 rounded-[18px] bg-gradient-to-r from-[#39c6b7] via-[#67e29e] via-[#b9ec9c] via-[#f9dd88] to-[#efa397]" />
                    <div className="absolute bottom-2 right-4 text-[22px] font-semibold text-white sm:text-[26px]">{fmtMmSs(elapsedSec)}</div>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl bg-[#f9f6ff] p-4">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <h3 className="text-xl font-semibold">实时字幕</h3>
                  <button
                    onClick={() => {
                      if (interview.isListening) stopInterviewListening()
                      else if (!isActive) handleStart()
                      else startInterview()
                    }}
                    className="inline-flex h-9 items-center gap-2 rounded-xl bg-[#d7ccfe] px-4 text-sm font-semibold text-[#3d3671]"
                  >
                    {interview.isListening ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {interview.isListening ? '停止监听' : '开始面试'}
                  </button>
                </div>
                {interview.isListening && interview.isUserSpeaking ? <div className="mb-2 text-sm font-semibold text-[#725ac5]">正在听取语音...</div> : null}
                <div className="h-[calc(100%-48px)] overflow-y-auto rounded-2xl bg-[#e7e4ee] p-3 text-sm leading-relaxed text-[#3d3671]/70">
                  {String(interview.transcript || '').trim() ? <span>{interview.transcript}</span> : <span>点击“开始面试”后，这里会显示实时转译。</span>}
                </div>
                {interview.lastError ? <div className="mt-2 text-xs text-[#9f1239]">{interview.lastError}</div> : null}
                {!tts.isSupported ? <div className="mt-2 text-xs text-[#9f1239]">当前浏览器不支持语音播报</div> : null}
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={clearTranscript} className="h-9 rounded-xl bg-[#efe7fd] px-3 text-sm font-semibold">
                    清空字幕
                  </button>
                  <button onClick={copyTranscript} className="h-9 rounded-xl bg-[#efe7fd] px-3 text-sm font-semibold" disabled={!String(interview.transcript || '').trim()}>
                    复制全文
                  </button>
                </div>
              </section>

              <aside className="rounded-2xl bg-[#f9f6ff] p-4">
                <div className="mb-3 flex items-center gap-2 text-xl font-semibold text-[#3d3671]">
                  <BarChart3 className="h-5 w-5 text-[#725ac5]" />
                  <span>实时数据分析</span>
                </div>
                <div className="space-y-3">
                  <div className="rounded-xl border border-[#725ac5] bg-[#f9f6ff] px-4 py-3">
                    <div className="flex h-10 items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-lg font-semibold">
                        <Clock3 className="h-5 w-5 text-[#725ac5]" />
                        当前剩余时间
                      </span>
                      <span className="text-lg font-semibold">
                        {String(Math.floor(timeLeftSec / 60)).padStart(2, '0')}:{String(timeLeftSec % 60).padStart(2, '0')}
                      </span>
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#725ac5] bg-[#f9f6ff] px-4 py-3">
                    <div className="flex h-10 items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-lg font-semibold">
                        <Gauge className="h-5 w-5 text-[#725ac5]" />
                        Speaking Speed
                      </span>
                      <span className="text-lg font-semibold">{speakingSpeedPct}%</span>
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#725ac5] bg-[#f9f6ff] px-4 py-3">
                    <div className="flex h-10 items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-lg font-semibold">
                        <Eye className="h-5 w-5 text-[#725ac5]" />
                        Eye Contact
                      </span>
                      <span className="text-lg font-semibold">{eyeContactPct}%</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full border border-[#3d3671] bg-[#efe7fd]">
                      <div className="h-full rounded-full bg-gradient-to-r from-[#c6a9ed] to-[#c6a9ed00]" style={{ width: `${eyeContactPct}%` }} />
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#725ac5] bg-[#f9f6ff] px-4 py-3">
                    <div className="flex h-10 items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-lg font-semibold">
                        <MessageSquareWarning className="h-5 w-5 text-[#725ac5]" />
                        Filter Words
                      </span>
                      <span className="text-lg font-semibold">{filterWordsPct}%</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full border border-[#3d3671] bg-[#efe7fd]">
                      <div className="h-full rounded-full bg-gradient-to-r from-[#c6a9ed] to-[#c6a9ed00]" style={{ width: `${filterWordsPct}%` }} />
                    </div>
                  </div>
                  <div className="rounded-xl bg-[#efe7fd] p-4">
                    <p className="text-lg font-semibold">当前题目</p>
                    <div className="mt-3 rounded-xl bg-[#f9f6ff] px-4 py-4 text-base font-semibold leading-normal">“游戏npc的越狱事件”</div>
                  </div>
                </div>
              </aside>
            </div>
            <div className="mt-3 rounded-2xl bg-[#f9f6ff] p-4">
              <div className="mb-2 text-sm font-semibold text-[#3d3671]/70">实时对话</div>
              <div className="space-y-2 text-sm text-[#3d3671]">
                <div className="rounded-xl bg-[#efe7fd] px-3 py-2">
                  <span className="font-semibold">你：</span>
                  <span>{String(interview.transcript || '').trim() ? interview.transcript : '（等待你开始说话）'}</span>
                </div>
                <div className="rounded-xl bg-[#efe7fd] px-3 py-2">
                  <span className="font-semibold">AI：</span>
                  <span>{aiBubbleText ? aiBubbleText : '（等待 AI 回答）'}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto rounded-2xl bg-[#efe7fd] p-3">
            <div className="space-y-4">
              <section className="rounded-2xl bg-[#b7a8ff] px-5 py-4 text-white">
                <div className="flex items-center justify-between gap-6">
                  <div className="flex items-center gap-4">
                    <div className="grid h-16 w-16 place-items-center rounded-full bg-[#d7ccfe] text-[#725ac5]">
                      <Bot className="h-8 w-8" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xl font-semibold">Nice work today</div>
                      <div className="flex items-end gap-2">
                        <span className="text-xl font-semibold">{Math.round(((reportData?.facialScore ?? 50) + (reportData?.voiceScore ?? 50)) / 2)}</span>
                        <span className="text-sm text-white/80">分</span>
                        <span className="text-base font-semibold">超过 {Math.min(99, Math.max(1, Math.round(((reportData?.voiceScore ?? 50) * 0.78))))}% 竞争对手</span>
                      </div>
                      <div className="text-sm text-white/80">查看你的表现评价报告</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="grid h-16 w-24 place-items-center rounded-xl bg-[#d7ccfe]/70">
                      <img src={examinerHref} alt="" className="h-10 w-10 select-none" draggable={false} />
                    </div>
                  </div>
                </div>
              </section>

              <div className="grid grid-cols-[1fr_0.98fr] gap-4">
                <div className="space-y-4">
                  <section className="rounded-2xl bg-[#f9f6ff] p-4">
                    <div className="mb-3 flex items-center gap-2 text-xl font-semibold text-[#3d3671]">
                      <PieChart className="h-5 w-5 text-[#725ac5]" />
                      总评分
                    </div>
                    <div className="flex items-center justify-center rounded-xl bg-white p-4">
                      <svg width="260" height="220" viewBox="0 0 260 220" className="text-[#725ac5]">
                        <polygon points="130,25 200,62 200,138 130,176 60,138 60,62" fill="#efe7fd" stroke="#c6b8ff" strokeWidth="1.5" />
                        <polygon points="130,48 180,75 180,125 130,152 80,125 80,75" fill="#d7ccfe" stroke="#b4a4f8" strokeWidth="1.5" />
                        <polygon points="130,66 167,86 167,114 130,134 93,114 93,86" fill="#b7a8ff" stroke="#9a79fc" strokeWidth="1.5" />
                        <polygon
                          points={radarPoints(reportData?.radarValues01 || [0.55, 0.55, 0.55, 0.55, 0.55, 0.55])}
                          fill="rgba(154,121,252,0.34)"
                          stroke="rgba(114,90,197,0.92)"
                          strokeWidth="2.2"
                        />
                        <text x="130" y="15" textAnchor="middle" className="fill-[#3d3671]" fontSize="12">
                          沟通表达
                        </text>
                        <text x="220" y="80" textAnchor="middle" className="fill-[#3d3671]" fontSize="12">
                          逻辑结构
                        </text>
                        <text x="220" y="138" textAnchor="middle" className="fill-[#3d3671]" fontSize="12">
                          专业匹配度
                        </text>
                        <text x="130" y="206" textAnchor="middle" className="fill-[#3d3671]" fontSize="12">
                          自信表现
                        </text>
                        <text x="40" y="138" textAnchor="middle" className="fill-[#3d3671]" fontSize="12">
                          临场反应
                        </text>
                        <text x="40" y="80" textAnchor="middle" className="fill-[#3d3671]" fontSize="12">
                          情绪稳定度
                        </text>
                      </svg>
                    </div>
                  </section>

                  <section className="rounded-2xl bg-[#f9f6ff] p-4">
                    <div className="mb-3 flex items-center gap-2 text-xl font-semibold text-[#3d3671]">
                      <BookText className="h-5 w-5 text-[#725ac5]" />
                      题目复现
                    </div>
                    <div className="rounded-xl border border-[#d7ccfe] bg-white p-3">
                      <div className="mb-2 text-lg font-semibold">Q1 自我介绍</div>
                      <div className="grid grid-cols-[1fr_110px] gap-3">
                        <div className="rounded-xl bg-[#efe7fd] p-3">
                          <div className="mb-2 text-sm font-semibold">你的回答</div>
                          <div className="text-xs leading-relaxed text-[#3d3671]/80">
                            {(reportData?.messages.find((m) => m.role === 'user')?.content || '本次面试未记录到有效回答内容。').slice(0, 90)}
                          </div>
                          <div className="mt-3 text-xs text-[#3d3671]/60">
                            得分：{Math.round(((reportData?.facialScore ?? 50) * 0.45) + ((reportData?.voiceScore ?? 50) * 0.55))}/100
                          </div>
                        </div>
                        <div className="grid place-items-center rounded-xl bg-[#d7ccfe] text-[#725ac5]">
                          <Play className="h-6 w-6" />
                        </div>
                      </div>
                    </div>
                  </section>
                </div>

                <div className="space-y-4">
                  <section className="rounded-2xl bg-[#f9f6ff] p-4">
                    <div className="mb-3 flex items-center gap-2 text-xl font-semibold text-[#3d3671]">
                      <BarChart3 className="h-5 w-5 text-[#725ac5]" />
                      能力分析
                    </div>
                    <div className="space-y-3">
                      <div className="rounded-xl bg-white p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-base font-semibold">表达能力</span>
                          <span className="text-xs text-[#3d3671]/60">点击查看详细分析</span>
                        </div>
                        <div className="text-xs leading-relaxed text-[#3d3671]/80">语速：偏快 7% · 停顿控制：较好 · 口头禅：需改进</div>
                      </div>
                      <div className="rounded-xl bg-white p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-base font-semibold">内容质量</span>
                          <span className="text-xs text-[#3d3671]/60">点击查看详细分析</span>
                        </div>
                        <div className="text-xs leading-relaxed text-[#3d3671]/80">回答具体度：高 90% · 结构完成：高 95% · 案例说服：中等</div>
                      </div>
                      <div className="rounded-xl bg-white p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-base font-semibold">面试状态</span>
                          <span className="text-xs text-[#3d3671]/60">点击查看详细分析</span>
                        </div>
                        <div className="text-xs leading-relaxed text-[#3d3671]/80">眼神接触：稳定 80% · 表情自然度：良好 · 紧张波动：前五分钟波动大</div>
                      </div>
                    </div>
                  </section>

                  <div className="grid grid-cols-2 gap-3">
                    <section className="rounded-2xl bg-[#f9f6ff] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-xl font-semibold">高光表现</h3>
                        <span className="text-xs text-[#3d3671]/60">点击查看详细分析</span>
                      </div>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#9fe086]" />
                          自我介绍清晰简洁
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#9fe086]" />
                          产品案例回答有层次
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#9fe086]" />
                          面对追问保持冷静
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#9fe086]" />
                          快速进入面试状态
                        </div>
                      </div>
                    </section>
                    <section className="rounded-2xl bg-[#f9f6ff] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-xl font-semibold">问题点诊断</h3>
                        <span className="text-xs text-[#3d3671]/60">点击查看详细分析</span>
                      </div>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#ffcc57]" />
                          遇到压力题时停顿明显
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#ffcc57]" />
                          数据表达不够具体
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#ffcc57]" />
                          口头禅和多余词汇仍较多
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              <section className="rounded-2xl bg-[#f9f6ff] p-4">
                <div className="mb-3 flex items-center gap-2 text-xl font-semibold text-[#3d3671]">
                  <Goal className="h-5 w-5 text-[#725ac5]" />
                  推荐训练计划
                </div>
                <div className="rounded-xl bg-white p-4 text-sm leading-relaxed text-[#3d3671]/80">
                  建议优先训练：1）压力追问应答结构；2）数据表达具体化；3）口头禅控制。建议连续 7 天进行每天 15 分钟专项训练，并复盘关键问题。
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
