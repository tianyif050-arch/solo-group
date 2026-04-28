import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { enqueueAudioUrl, stopAudioQueue, subscribeAudio } from '@/utils/audioQueue'
import { getOrCreateSoloSessionId, getSoloResumeUrl } from '@/utils/soloSession'

export type InterviewMode = 'solo' | 'group'
export type InterviewTransport = 'ws' | 'poll' | 'http' | 'auto'

export type UseInterviewSocketOptions = {
  mode: InterviewMode
  backendUrl?: string
  transport?: InterviewTransport
  autoConnect?: boolean
  preferWebSpeech?: boolean
  speakResponses?: boolean
  pollUrl?: string
}

type ServerMsg =
  | { type: 'hello'; run_id?: string; asr_enabled?: boolean; asr_warning?: string }
  | { type: 'agent_speak'; text?: string; content?: string; audio_url?: string; speaker_id?: string; speaker_name?: string; role?: string; ts_ms?: number }
  | { type: 'user_partial'; text?: string }
  | { type: 'user_final'; text?: string; ts_ms?: number }
  | { type: 'stage'; stage?: string; content?: string; ts_ms?: number }
  | { type: 'done' | 'stopped'; run_id?: string }
  | { type: string; [k: string]: any }

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
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function getWebSpeechRecognitionCtor(): any | null {
  const w = window as any
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

function normalizeSpeechError(err: any): string {
  return String(err || '').trim().toLowerCase()
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

export function useInterviewSocket(opts: UseInterviewSocketOptions) {
  const options = useMemo(() => {
    const envAny = (import.meta as any).env || {}
    const backendUrl = String(opts.backendUrl || envAny.VITE_API_URL || envAny.VITE_BACKEND_URL || 'http://127.0.0.1:8799').trim()
    const wsUrl = String(envAny.VITE_WS_URL || '').trim()
    return {
      mode: opts.mode,
      backendUrl,
      wsUrl,
      transport: opts.transport || 'auto',
      autoConnect: opts.autoConnect ?? true,
      preferWebSpeech: opts.preferWebSpeech ?? true,
      speakResponses: opts.speakResponses ?? false,
      pollUrl: String(opts.pollUrl || '').trim(),
    }
  }, [opts.autoConnect, opts.backendUrl, opts.mode, opts.pollUrl, opts.preferWebSpeech, opts.speakResponses, opts.transport])

  const [isConnected, setIsConnected] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isUserSpeaking, setIsUserSpeaking] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [lastError, setLastError] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const wsUrlRef = useRef('')
  const pollTimerRef = useRef<number | null>(null)
  const speakingTimerRef = useRef<number | null>(null)
  const desiredListeningRef = useRef(false)
  const wasSpeakingRef = useRef(false)

  const finalTranscriptRef = useRef('')
  const recognitionRef = useRef<any | null>(null)
  const recognitionRestartTimerRef = useRef<number | null>(null)
  const recognitionWatchdogTimerRef = useRef<number | null>(null)
  const recognitionLastEventTsRef = useRef<number>(0)
  const sessionIdRef = useRef<string>('')

  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioSrcRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcRef = useRef<ScriptProcessorNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioSampleRateRef = useRef<number>(0)
  const userSpeakingUntilRef = useRef<number>(0)

  const pushSoloDebug = useCallback((line: string) => {
    try {
      window.dispatchEvent(new CustomEvent('solo_debug', { detail: line }))
    } catch {}
  }, [])

  const speakTextFallback = useCallback((text: string, roleHint?: string) => {
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
        const idx = hashRole(String(roleHint || 'interviewer')) % zhVoices.length
        u.voice = zhVoices[idx] || null
      }
      synth.speak(u)
    } catch {}
  }, [])

  const stopVoicePlayback = useCallback(() => {
    stopAudioQueue()
  }, [])

  const toHttpBase = useCallback(() => {
    const base = String(options.backendUrl || '').trim() || 'http://127.0.0.1:8799'
    return base.replace(/\/+$/, '')
  }, [options.backendUrl])

  const handleServerMsg = useCallback(
    (raw: any) => {
      const msg = raw as ServerMsg
      if (msg.type === 'hello') {
        return
      }
      if (msg.type === 'user_partial') {
        const t = String((msg as any).text || '')
        setTranscript(`${finalTranscriptRef.current}${t}`)
        return
      }
      if (msg.type === 'user_final') {
        const t = String((msg as any).text || '').trim()
        if (!t) return
        finalTranscriptRef.current = `${finalTranscriptRef.current}${t} `
        setTranscript(finalTranscriptRef.current.trimEnd())
        return
      }
      if (msg.type === 'agent_speak') {
        const content = String((msg as any).content || (msg as any).text || '')
        const t = content.trim()
        if (!t) return
        console.log('[SOLO][WS] 收到后端回答文本:', t)
        pushSoloDebug(`[SOLO][WS] 收到文本: ${t}`)
        setAiResponse(t)

        const rel = String((msg as any).audio_url || '').trim()
        if (options.speakResponses && options.mode === 'solo') {
          speakTextFallback(t, String((msg as any).speaker_id || (msg as any).role || 'interviewer'))
        } else if (options.speakResponses && rel) {
          const abs = `${toHttpBase()}${rel.startsWith('/') ? '' : '/'}${rel}`
          enqueueAudioUrl(abs)
        } else if (options.speakResponses) {
          speakTextFallback(t, String((msg as any).speaker_id || (msg as any).role || 'interviewer'))
        }
        return
      }
      if (msg.type === 'done' || msg.type === 'stopped') {
        return
      }
    },
    [options.speakResponses, pushSoloDebug, speakTextFallback, toHttpBase],
  )

  const ensureSessionId = useCallback(() => {
    if (sessionIdRef.current) return sessionIdRef.current
    const sid = getOrCreateSoloSessionId()
    sessionIdRef.current = sid
    return sid
  }, [])

  const startSoloHttpSession = useCallback(async () => {
    setLastError('')
    const sid = ensureSessionId()
    const resumeUrl = getSoloResumeUrl()
    const url = `${toHttpBase()}/api/solo/start`
    pushSoloDebug(`[SOLO][HTTP] POST /api/solo/start sid=${sid}`)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ session_id: sid, resume_url: resumeUrl || undefined }),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(msg || `HTTP ${res.status}`)
      }
      const data = (await res.json().catch(() => null)) as any
      const reply = String(data?.text || data?.content || '').trim()
      const dataUri = String(data?.audio_data_uri || '').trim()
      if (reply) {
        pushSoloDebug(`[SOLO][HTTP] opening: ${reply}`)
        setAiResponse(reply)
        if (dataUri) {
          enqueueAudioUrl(dataUri)
          window.setTimeout(() => {
            if (!wasSpeakingRef.current) speakTextFallback(reply, 'interviewer')
          }, 260)
        } else {
          speakTextFallback(reply, 'interviewer')
        }
      }
      return true
    } catch (e: any) {
      const msg = String(e?.message || e || 'solo start failed')
      pushSoloDebug(`[SOLO][HTTP] /api/solo/start 失败: ${msg}`)
      setLastError(msg)
      return false
    }
  }, [ensureSessionId, pushSoloDebug, speakTextFallback, toHttpBase])

  const sendChatHttp = useCallback(
    async (text: string) => {
      const t = String(text || '').trim()
      if (!t) return false
      setLastError('')
      const sid = ensureSessionId()
      const url = `${toHttpBase()}/api/chat`
      const resumeUrl = getSoloResumeUrl()
      pushSoloDebug(`[SOLO][HTTP] POST /api/chat sid=${sid}`)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify({ session_id: sid, user_text: t, resume_url: resumeUrl || undefined }),
        })
        if (!res.ok) {
          const msg = await res.text().catch(() => '')
          throw new Error(msg || `HTTP ${res.status}`)
        }
        const data = (await res.json().catch(() => null)) as any
        const reply = String(data?.text || data?.content || '').trim()
        const dataUri = String(data?.audio_data_uri || '').trim()
        if (reply) {
          pushSoloDebug(`[SOLO][HTTP] 收到文本: ${reply}`)
          setAiResponse(reply)
        }

        if (options.speakResponses && reply) {
          if (dataUri) {
            enqueueAudioUrl(dataUri)
            window.setTimeout(() => {
              if (!wasSpeakingRef.current) speakTextFallback(reply, 'interviewer')
            }, 260)
          } else {
            speakTextFallback(reply, 'interviewer')
          }
        }
        return true
      } catch (e: any) {
        const msg = String(e?.message || e || 'chat failed')
        pushSoloDebug(`[SOLO][HTTP] /api/chat 失败: ${msg}`)
        setLastError(msg)
        return false
      }
    },
    [ensureSessionId, options.speakResponses, pushSoloDebug, speakTextFallback, toHttpBase],
  )

  const sendText = useCallback(
    (text: string) => {
      if (options.mode === 'solo' && (options.transport === 'http' || options.transport === 'auto')) {
        void sendChatHttp(text)
        return true
      }
      const ws = wsRef.current
      const t = String(text || '').trim()
      if (!t) return false
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(
          JSON.stringify({
            type: 'user_text',
            text: t,
            ts_ms: Date.now(),
            mode: options.mode === 'group' ? 'GROUP' : 'SOLO',
          }),
        )
        return true
      } catch {
        return false
      }
    },
    [options.mode, options.transport, sendChatHttp],
  )

  const startSession = useCallback(
    (discussMinutes?: number) => {
      if (options.mode === 'solo' && (options.transport === 'http' || options.transport === 'auto')) {
        ensureSessionId()
        void startSoloHttpSession()
        return true
      }
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      const dm = discussMinutes == null ? undefined : Number(discussMinutes)
      pushSoloDebug(`[SOLO][WS] send start${dm != null && Number.isFinite(dm) ? ` (discuss_minutes=${dm})` : ''}`)
      try {
        ws.send(
          JSON.stringify({
            type: 'start',
            ...(dm != null && Number.isFinite(dm) ? { discuss_minutes: dm } : {}),
            ts_ms: Date.now(),
            mode: options.mode === 'group' ? 'GROUP' : 'SOLO',
          }),
        )
        return true
      } catch {
        return false
      }
    },
    [ensureSessionId, options.mode, options.transport, pushSoloDebug, startSoloHttpSession],
  )

  const stopAudioStreaming = useCallback(() => {
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
    setIsListening(false)
  }, [])

  const startBackendAudioStreaming = useCallback(async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WS 未连接')
    if (audioStreamRef.current) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false })
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
    if (ctx.state !== 'running') throw new Error(`AudioContext 未运行（state=${ctx.state}）`)
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(8192, 1, 1)
    audioCtxRef.current = ctx
    audioSrcRef.current = source
    audioProcRef.current = processor
    audioStreamRef.current = stream
    audioSampleRateRef.current = ctx.sampleRate

    processor.onaudioprocess = (e) => {
      const currWs = wsRef.current
      if (!currWs || currWs.readyState !== WebSocket.OPEN) return
      const input = e.inputBuffer.getChannelData(0)
      const down = downsampleBuffer(input, audioSampleRateRef.current, 16000)
      const now = Date.now()
      let acc = 0
      for (let i = 0; i < down.length; i++) acc += down[i] * down[i]
      const rms = Math.sqrt(acc / Math.max(1, down.length))
      if (rms >= 0.015) userSpeakingUntilRef.current = now + 350
      setIsUserSpeaking(now < userSpeakingUntilRef.current)
      const pcm16 = floatTo16BitPCM(down)
      try {
        currWs.send(pcm16.buffer)
      } catch {}
    }

    source.connect(processor)
    processor.connect(ctx.destination)
    setIsListening(true)
  }, [])

  const stopWebSpeech = useCallback(() => {
    if (recognitionRestartTimerRef.current) {
      window.clearTimeout(recognitionRestartTimerRef.current)
      recognitionRestartTimerRef.current = null
    }
    if (recognitionWatchdogTimerRef.current) {
      window.clearInterval(recognitionWatchdogTimerRef.current)
      recognitionWatchdogTimerRef.current = null
    }
    const rec = recognitionRef.current
    recognitionRef.current = null
    if (!rec) return
    try {
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
    } catch {}
    try {
      rec.stop()
    } catch {}
    setIsListening(false)
  }, [])

  const startWebSpeech = useCallback(async () => {
    const Ctor = getWebSpeechRecognitionCtor()
    if (!Ctor) throw new Error('当前浏览器不支持 Web Speech API')
    if (recognitionRef.current) return
    // 先做一次麦克风权限预检，避免“已点开始但一直没有转写”。
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      s.getTracks().forEach((t) => t.stop())
    } catch (e: any) {
      throw new Error(`麦克风不可用：${String(e?.message || e || 'permission denied')}`)
    }

    const rec = new Ctor()
    recognitionRef.current = rec
    recognitionLastEventTsRef.current = Date.now()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (evt: any) => {
      recognitionLastEventTsRef.current = Date.now()
      let interim = ''
      let finalText = ''
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const r = evt.results[i]
        const t = String(r?.[0]?.transcript || '')
        if (r.isFinal) finalText += t
        else interim += t
      }
      if (finalText.trim()) {
        setIsUserSpeaking(false)
        finalTranscriptRef.current = `${finalTranscriptRef.current}${finalText.trim()} `
        setTranscript(finalTranscriptRef.current.trimEnd())
        sendText(finalText)
      } else {
        setIsUserSpeaking(Boolean(interim.trim()))
        setTranscript(`${finalTranscriptRef.current}${interim}`)
      }
    }
    rec.onerror = (e: any) => {
      recognitionLastEventTsRef.current = Date.now()
      const raw = String(e?.error || e?.message || e || 'Web Speech error')
      const msg = normalizeSpeechError(raw)
      // no-speech 常见且可恢复，不作为用户错误提示。
      if (msg === 'no-speech') setLastError('')
      else setLastError(raw)
      setIsListening(false)
      // 大多数错误（如 no-speech / network）都可重试；权限类错误不自动重启。
      const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(msg)
      if (!fatal && desiredListeningRef.current) {
        if (recognitionRestartTimerRef.current) window.clearTimeout(recognitionRestartTimerRef.current)
        recognitionRestartTimerRef.current = window.setTimeout(() => {
          recognitionRestartTimerRef.current = null
          if (!desiredListeningRef.current || recognitionRef.current) return
          void startWebSpeech().catch(() => {})
        }, msg === 'no-speech' ? 120 : 350)
      }
    }
    rec.onend = () => {
      recognitionLastEventTsRef.current = Date.now()
      if (recognitionRef.current === rec) recognitionRef.current = null
      setIsListening(false)
      // 某些浏览器会在静音时自动结束识别，保持“开始面试”状态时自动续接。
      if (desiredListeningRef.current) {
        if (recognitionRestartTimerRef.current) window.clearTimeout(recognitionRestartTimerRef.current)
        recognitionRestartTimerRef.current = window.setTimeout(() => {
          recognitionRestartTimerRef.current = null
          if (!desiredListeningRef.current || recognitionRef.current) return
          void startWebSpeech().catch(() => {})
        }, 200)
      }
    }

    try {
      rec.start()
    } catch (e: any) {
      recognitionRef.current = null
      throw e
    }
    if (recognitionWatchdogTimerRef.current) window.clearInterval(recognitionWatchdogTimerRef.current)
    recognitionWatchdogTimerRef.current = window.setInterval(() => {
      if (!desiredListeningRef.current) return
      if (recognitionRef.current !== rec) return
      const idleMs = Date.now() - recognitionLastEventTsRef.current
      // 部分浏览器会“挂住”不再产出结果，这里主动重启一次。
      if (idleMs > 10000) {
        try {
          rec.stop()
        } catch {}
      }
    }, 2500)
    setIsListening(true)
  }, [sendText])

  useEffect(() => {
    return subscribeAudio((s) => {
      const isPlaying = Boolean(s.isPlaying)
      setIsSpeaking(isPlaying)
      const justEnded = wasSpeakingRef.current && !isPlaying
      wasSpeakingRef.current = isPlaying
      if (justEnded && desiredListeningRef.current && Number(s.queueLength || 0) <= 0) {
        try {
          void startWebSpeech()
        } catch {}
      }
    })
  }, [startWebSpeech])

  const disconnect = useCallback(() => {
    desiredListeningRef.current = false
    if (recognitionRestartTimerRef.current) {
      window.clearTimeout(recognitionRestartTimerRef.current)
      recognitionRestartTimerRef.current = null
    }
    if (recognitionWatchdogTimerRef.current) {
      window.clearInterval(recognitionWatchdogTimerRef.current)
      recognitionWatchdogTimerRef.current = null
    }
    stopWebSpeech()
    stopAudioStreaming()
    stopVoicePlayback()
    if (pollTimerRef.current) window.clearInterval(pollTimerRef.current)
    pollTimerRef.current = null
    if (speakingTimerRef.current) window.clearTimeout(speakingTimerRef.current)
    speakingTimerRef.current = null
    try {
      wsRef.current?.close()
    } catch {}
    wsRef.current = null
    wsUrlRef.current = ''
    setIsConnected(false)
  }, [stopAudioStreaming, stopVoicePlayback, stopWebSpeech])

  const connectWs = useCallback(async () => {
    disconnect()
    setLastError('')
    const candidates: string[] = []

    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      candidates.push(`${proto}://${window.location.host}/ws`)
    } catch {}

    const explicit = String(options.wsUrl || '').trim()
    if (explicit) candidates.push(explicit)

    try {
      const b = String(options.backendUrl || '').trim()
      if (b) {
        const u = new URL(b)
        const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:'
        const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
        if (!pageIsHttps || wsProto === 'wss:') {
          candidates.push(`${wsProto}//${u.host}/ws`)
        }
      }
    } catch {}

    const uniq = Array.from(new Set(candidates.filter(Boolean)))
    if (!uniq.length) throw new Error('WS 地址不可用')

    const connectOnce = (wsUrl: string) =>
      new Promise<void>((resolve, reject) => {
        let settled = false
        pushSoloDebug(`[SOLO][WS] connecting -> ${wsUrl}`)

        const fail = (e: any) => {
          if (settled) return
          settled = true
          reject(e)
        }

        let ws: WebSocket
        try {
          ws = new WebSocket(wsUrl)
        } catch (e) {
          fail(e)
          return
        }

        wsRef.current = ws
        wsUrlRef.current = wsUrl

        const timerId = window.setTimeout(() => {
          try {
            ws.close()
          } catch {}
        }, 5000)

        ws.onopen = () => {
          window.clearTimeout(timerId)
          setIsConnected(true)
          pushSoloDebug(`[SOLO][WS] connected -> ${wsUrl}`)
          try {
            ws.send(
              JSON.stringify({
                type: 'client_hello',
                mode: options.mode === 'group' ? 'GROUP' : 'SOLO',
                ts_ms: Date.now(),
              }),
            )
          } catch {}
          settled = true
          resolve()
        }

        ws.onerror = () => {
          window.clearTimeout(timerId)
          try {
            ws.close()
          } catch {}
          fail(new Error(`WebSocket 连接失败：${wsUrl}`))
        }

        ws.onclose = () => {
          window.clearTimeout(timerId)
          if (wsRef.current === ws) {
            wsRef.current = null
            setIsConnected(false)
          }
          if (!settled) fail(new Error(`WebSocket 连接失败：${wsUrl}`))
        }

        ws.onmessage = (evt) => {
          let msg: any
          try {
            msg = JSON.parse(String(evt.data || ''))
          } catch {
            return
          }
          handleServerMsg(msg)
        }
      })

    let lastErr: any = null
    for (const u of uniq) {
      try {
        await connectOnce(u)
        return
      } catch (e) {
        lastErr = e
        pushSoloDebug(`[SOLO][WS] connect failed -> ${u}`)
      }
    }

    throw lastErr || new Error('WebSocket 连接失败')
  }, [disconnect, handleServerMsg, options.backendUrl, options.mode, options.wsUrl, pushSoloDebug])

  const connectPoll = useCallback(async () => {
    disconnect()
    setLastError('')
    const url = options.pollUrl
    if (!url) throw new Error('pollUrl 未配置')

    let since = 0
    const tick = async () => {
      try {
        const u = new URL(url)
        u.searchParams.set('since', String(since))
        u.searchParams.set('mode', options.mode === 'group' ? 'GROUP' : 'SOLO')
        const res = await fetch(u.toString(), { credentials: 'omit' })
        if (!res.ok) return
        const data = await res.json()
        const items: any[] = Array.isArray(data?.items) ? data.items : []
        for (const it of items) {
          const ts = Number(it?.ts_ms || 0)
          if (ts > since) since = ts
          handleServerMsg(it)
        }
        setIsConnected(true)
      } catch {}
    }

    await tick()
    pollTimerRef.current = window.setInterval(tick, 1200)
  }, [disconnect, handleServerMsg, options.mode, options.pollUrl])

  const connect = useCallback(async () => {
    try {
      if (options.mode === 'solo' && (options.transport === 'http' || options.transport === 'auto')) {
        setIsConnected(true)
        ensureSessionId()
        return
      }
      if (options.transport === 'ws') {
        await connectWs()
        return
      }
      if (options.transport === 'poll') {
        await connectPoll()
        return
      }
      try {
        await connectWs()
      } catch (e) {
        if (options.pollUrl) {
          await connectPoll()
        } else {
          throw e
        }
      }
    } catch (e: any) {
      setLastError(String(e?.message || e || 'connect failed'))
      throw e
    }
  }, [connectPoll, connectWs, options.pollUrl, options.transport])

  const startListening = useCallback(async () => {
    setLastError('')
    desiredListeningRef.current = true
    if (options.preferWebSpeech && getWebSpeechRecognitionCtor()) {
      await startWebSpeech()
      return
    }
    if (options.mode === 'solo') {
      throw new Error('当前浏览器不支持语音转写（建议使用 Chrome，并通过 localhost 访问）')
    }
    await startBackendAudioStreaming()
  }, [options.mode, options.preferWebSpeech, startBackendAudioStreaming, startWebSpeech])

  const stopListening = useCallback(() => {
    desiredListeningRef.current = false
    if (recognitionRestartTimerRef.current) {
      window.clearTimeout(recognitionRestartTimerRef.current)
      recognitionRestartTimerRef.current = null
    }
    if (recognitionWatchdogTimerRef.current) {
      window.clearInterval(recognitionWatchdogTimerRef.current)
      recognitionWatchdogTimerRef.current = null
    }
    stopWebSpeech()
    stopAudioStreaming()
    setIsUserSpeaking(false)
  }, [stopAudioStreaming, stopWebSpeech])

  const clear = useCallback(() => {
    finalTranscriptRef.current = ''
    setTranscript('')
    setAiResponse('')
    setLastError('')
    sessionIdRef.current = ''
    try {
      sessionStorage.removeItem('solo_session_id_v1')
    } catch {}
  }, [])

  useEffect(() => {
    if (!options.autoConnect) return
    connect().catch(() => {})
    return () => {
      disconnect()
      stopAudioQueue()
    }
  }, [connect, disconnect, options.autoConnect])

  return {
    isConnected,
    isListening,
    isSpeaking,
    isUserSpeaking,
    transcript,
    aiResponse,
    lastError,
    wsUrl: wsUrlRef.current,
    connect,
    disconnect,
    startListening,
    stopListening,
    sendText,
    startSession,
    clear,
  }
}
