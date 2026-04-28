import { useInterviewMode } from '@/interviewMode'
import { useBodyClass } from '@/useBodyClass'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { stopAudioQueue, unlockAudioWithMic } from '@/utils/audioQueue'
import Topbar from '@/components/Topbar'

type SubtitleLine = {
  tsMs: number
  text: string
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

export default function SetupPage() {
  useDemoStylesheet()
  useBodyClass('debugBody')

  const { interviewMode, setInterviewMode } = useInterviewMode()
  const navigate = useNavigate()

  const micGain = useMemo(() => {
    const v = Number(String(((import.meta as any).env || {}).VITE_MIC_GAIN || '3'))
    return Number.isFinite(v) && v > 0 ? v : 3
  }, [])

  const [statusText, setStatusText] = useState('未连接')
  const [camStatusText, setCamStatusText] = useState('未开始')
  const [asrStatusText, setAsrStatusText] = useState('未识别')

  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState<string>(() => {
    try {
      return localStorage.getItem('debug_camera_device_id') || 'default'
    } catch {
      return 'default'
    }
  })
  const [micId, setMicId] = useState<string>(() => {
    try {
      return localStorage.getItem('debug_mic_device_id') || 'default'
    } catch {
      return 'default'
    }
  })

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [subtitleLines, setSubtitleLines] = useState<SubtitleLine[]>([])
  const [subtitlePartial, setSubtitlePartial] = useState('')
  const [audioRms, setAudioRms] = useState(0)
  const [wsMsgCount, setWsMsgCount] = useState(0)

  const [isVideoActive, setIsVideoActive] = useState(false)
  const [isVoiceChecked, setIsVoiceChecked] = useState(false)
  const [asrEnabled, setAsrEnabled] = useState(false)
  const [asrWarning, setAsrWarning] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const wsHelloReceivedRef = useRef(false)
  const wsLastMsgTsRef = useRef(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioSrcRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcRef = useRef<ScriptProcessorNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioSampleRateRef = useRef<number>(0)
  const audioBytesSentRef = useRef(0)
  const audioRmsTickRef = useRef(0)

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    setCameraDevices(devices.filter((d) => d.kind === 'videoinput'))
    setMicDevices(devices.filter((d) => d.kind === 'audioinput'))
  }, [])

  useEffect(() => {
    refreshDevices()
  }, [refreshDevices])

  useEffect(() => {
    if (!cameraId || cameraId === 'default') return
    if (!cameraDevices.length) return
    if (cameraDevices.some((d) => d.deviceId === cameraId)) return
    setCameraId('default')
  }, [cameraDevices, cameraId])

  useEffect(() => {
    if (!micId || micId === 'default') return
    if (!micDevices.length) return
    if (micDevices.some((d) => d.deviceId === micId)) return
    setMicId('default')
  }, [micDevices, micId])

  useEffect(() => {
    return () => {
      stopAudioQueue()
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('debug_camera_device_id', cameraId)
    } catch {}
  }, [cameraId])

  useEffect(() => {
    try {
      localStorage.setItem('debug_mic_device_id', micId)
    } catch {}
  }, [micId])

  const startVideo = useCallback(async () => {
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
    streamRef.current = stream
    if (videoRef.current) videoRef.current.srcObject = stream
    setIsVideoActive(true)
    setCamStatusText('已开始')
  }, [cameraId])

  const stopVideo = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setIsVideoActive(false)
    setCamStatusText('未开始')
  }, [])

  const stopAudioStreaming = useCallback(() => {
    setIsVoiceChecked(false)
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
  }, [])

  const connectWs = useCallback(async () => {
    if (wsRef.current) {
      try {
        wsRef.current.close()
      } catch {}
      wsRef.current = null
      wsHelloReceivedRef.current = false
    }
    const backendWsUrls: string[] = []
    const envAny = (import.meta as any).env || {}
    const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
    const wsProto = pageIsHttps ? 'wss' : 'ws'
    const groupWs = String(envAny.VITE_GROUP_WS_URL || '').trim()
    if (groupWs) backendWsUrls.push(groupWs)
    const commonWs = String(envAny.VITE_WS_URL || '').trim()
    if (commonWs) backendWsUrls.push(commonWs)
    const groupApi = String(envAny.VITE_GROUP_API_URL || '').trim()
    if (groupApi) {
      try {
        const u = new URL(groupApi)
        const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
        backendWsUrls.push(`${proto}//${u.host}/ws`)
      } catch {}
    }
    if (interviewMode === 'group') {
      backendWsUrls.push(`${wsProto}://127.0.0.1:8800/ws`)
      try {
        if (String(window.location.port || '') === '5173') {
          backendWsUrls.push(`${wsProto}://${window.location.host}/ws`)
        }
      } catch {}
    } else {
      try {
        backendWsUrls.push(`${wsProto}://${window.location.host}/ws`)
      } catch {}
    }

    const candidates = Array.from(new Set(backendWsUrls.filter(Boolean)))

    wsHelloReceivedRef.current = false
    wsLastMsgTsRef.current = 0
    setWsMsgCount(0)

    return await new Promise<{ asrEnabled: boolean; asrWarning: string }>((resolve, reject) => {
      let settled = false
      const timeoutId = window.setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`WS 连接超时：${candidates.join(' | ')}`))
      }, 8000)

      const tryConnect = (idx: number) => {
        if (settled) return
        if (idx >= candidates.length) {
          window.clearTimeout(timeoutId)
          settled = true
          reject(
            new Error(
              `WebSocket 连接失败：${candidates.join(' | ') || 'GROUP 模式请配置 VITE_WS_URL / VITE_GROUP_WS_URL'}（请确认 8800 群面后端已启动：python -m group_interview_demo.server --port 8800）`,
            ),
          )
          return
        }
        setStatusText('连接中')
        const ws = new WebSocket(candidates[idx])
        wsRef.current = ws
        wsHelloReceivedRef.current = false
        let advanced = false

        const attemptTimer = window.setTimeout(() => {
          if (settled || advanced) return
          next()
        }, 2500)

        const next = () => {
          if (settled || advanced) return
          advanced = true
          window.clearTimeout(attemptTimer)
          try {
            ws.close()
          } catch {}
          tryConnect(idx + 1)
        }

        ws.onopen = () => {
          window.clearTimeout(attemptTimer)
          setStatusText('已连接')
          window.setTimeout(() => {
            if (settled || advanced) return
            if (!wsHelloReceivedRef.current) next()
          }, 4500)
        }

        ws.onerror = () => {
          window.clearTimeout(attemptTimer)
          next()
        }

        ws.onmessage = (evt) => {
          let msg: any
          try {
            msg = JSON.parse(String(evt.data || ''))
          } catch {
            return
          }
          wsLastMsgTsRef.current = Date.now()
          setWsMsgCount((c) => c + 1)
          if (msg.type === 'hello') {
            const enabled = Boolean(msg.asr_enabled)
            const warning = String(msg.asr_warning || '')
            wsHelloReceivedRef.current = true
            setAsrEnabled(enabled)
            setAsrWarning(warning)
            if (enabled) setAsrStatusText('已连接')
            else setAsrStatusText('未启用')
            if (warning) setSubtitlePartial(warning)
            window.clearTimeout(timeoutId)
            settled = true
            resolve({ asrEnabled: enabled, asrWarning: warning })
          } else if (msg.type === 'user_partial') {
            setAsrStatusText('识别中')
            setSubtitlePartial(String(msg.text || ''))
          } else if (msg.type === 'user_final') {
            const t = String(msg.text || '').trim()
            if (!t) return
            setSubtitleLines((prev) => [...prev, { tsMs: Number(msg.ts_ms) || Date.now(), text: t }].slice(-120))
            setSubtitlePartial('')
            setAsrStatusText('已识别')
          }
        }

        ws.onclose = () => {
          if (settled) return
          window.clearTimeout(attemptTimer)
          if (!wsHelloReceivedRef.current) {
            next()
            return
          }
          setAsrStatusText('已断开')
        }
      }

      tryConnect(0)
    })
  }, [interviewMode])

  const startAudioStreaming = useCallback(async (hello: { asrEnabled: boolean; asrWarning: string }) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WS 未连接')
    if (audioStreamRef.current) {
      stopAudioStreaming()
    }

    const constraints: MediaStreamConstraints =
      micId && micId !== 'default' ? { audio: { deviceId: { exact: micId }, channelCount: 1 }, video: false } : { audio: { channelCount: 1 }, video: false }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (e: any) {
      const name = String(e?.name || '')
      if (name === 'OverconstrainedError' || name === 'NotFoundError') {
        setMicId('default')
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false })
      }
      if (name === 'NotReadableError') {
        throw new Error('NotReadableError：麦克风被占用或无法启动（请关闭占用麦克风的 App/网页后重试）')
      }
      throw e
    }
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
    const ctx = new AudioCtx()
    try {
      if (ctx.state === 'suspended') await ctx.resume()
    } catch {}
    if (ctx.state !== 'running') {
      throw new Error(`AudioContext 未运行（state=${ctx.state}），请再次点击“开始调试”以激活麦克风权限`)
    }
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    audioCtxRef.current = ctx
    audioSrcRef.current = source
    audioProcRef.current = processor
    audioStreamRef.current = stream
    audioSampleRateRef.current = ctx.sampleRate

    processor.onaudioprocess = (e) => {
      const currWs = wsRef.current
      if (!currWs || currWs.readyState !== WebSocket.OPEN) return
      const input = e.inputBuffer.getChannelData(0)
      if ((audioRmsTickRef.current++ & 7) === 0) {
        let sum = 0
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
        const rms = Math.sqrt(sum / Math.max(1, input.length))
        setAudioRms(rms)
      }
      if (!hello.asrEnabled) return
      const down = downsampleBuffer(input, audioSampleRateRef.current, 16000)
      if (micGain !== 1) {
        for (let i = 0; i < down.length; i++) {
          const s = down[i] * micGain
          down[i] = s < -1 ? -1 : s > 1 ? 1 : s
        }
      }
      const pcm16 = floatTo16BitPCM(down)
      try {
        currWs.send(pcm16.buffer)
        audioBytesSentRef.current += pcm16.byteLength
      } catch {}
    }

    source.connect(processor)
    processor.connect(ctx.destination)
    setIsVoiceChecked(true)
    if (!hello.asrEnabled) {
      setAsrStatusText('未启用')
      if (hello.asrWarning) setSubtitlePartial(hello.asrWarning)
      return
    }
    setAsrStatusText('识别中')
  }, [micId, stopAudioStreaming])

  useEffect(() => {
    return () => {
      stopVideo()
      stopAudioStreaming()
      try {
        wsRef.current?.close()
      } catch {}
      wsRef.current = null
    }
  }, [stopAudioStreaming, stopVideo])

  const startDebug = async () => {
    setStatusText('检查中')
    try {
      await refreshDevices()
      await startVideo()
    } catch (e) {
      setStatusText('未连接')
      setCamStatusText('失败')
      throw e
    }

    if (interviewMode === 'solo') {
      // SOLO 走 HTTP /api/chat + 浏览器本地识别，不依赖 /ws
      setStatusText('已连接')
      setAsrStatusText('本地识别')
      setSubtitlePartial('')
      setIsVoiceChecked(true)
      return
    }

    setAsrStatusText('连接中')
    setSubtitleLines([])
    setSubtitlePartial('')
    const hello = await connectWs()
    await startAudioStreaming(hello)
  }

  const canEnter = isVideoActive && isVoiceChecked

  const onPrimaryClick = async () => {
    // 用户点击时做一次强制解锁：申请麦克风 + 静音 TTS，避免后续“无法发声”
    await unlockAudioWithMic()
    if (!canEnter) {
      try {
        await startDebug()
      } catch (e) {
        alert(`调试失败：${e}`)
      }
      return
    }
    stopVideo()
    stopAudioStreaming()
    try {
      wsRef.current?.close()
    } catch {}
    wsRef.current = null
    navigate(interviewMode === 'solo' ? '/solo' : '/group')
  }

  const copyAll = async () => {
    const all = subtitleLines.map((l) => `[${fmtTime(l.tsMs)}] ${l.text}`).join('\n')
    try {
      await navigator.clipboard.writeText(all)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = all
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
  }

  return (
    <>
      <Topbar
        right={
          <div id="status" className="statusPill">
            {statusText}
          </div>
        }
      />

      <main className="debugMain">
        <div className="debugHeader">
          <div className="debugTitle">调试页</div>
          <div className="debugActions">
            <div className="modePill">
              <span className="modeLabel">当前类型：</span>
              <select
                className="modeSelect"
                value={interviewMode}
                onChange={(e) => setInterviewMode(e.target.value as 'solo' | 'group')}
              >
                <option value="solo">SOLO 单人</option>
                <option value="group">GROUP 群面</option>
              </select>
            </div>
            <button className="primary" onClick={onPrimaryClick}>
              {canEnter ? '开始面试' : '开始调试'}
            </button>
          </div>
        </div>

        <div className="debugGrid">
          <section className="debugCard">
            <div className="debugCardHeader">
              <div className="debugCardTitle">摄像头预览</div>
              <div className="pillLight">{camStatusText}</div>
            </div>

            <div className="deviceRow">
              <select className="deviceSelect" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                <option value="default">默认摄像头</option>
                {cameraDevices.map((d, idx) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `摄像头 ${idx + 1}`}
                  </option>
                ))}
              </select>
              <button className="ghost" onClick={refreshDevices}>
                刷新
              </button>
            </div>
            <div className="deviceRow">
              <select className="deviceSelect" value={micId} onChange={(e) => setMicId(e.target.value)}>
                <option value="default">默认麦克风</option>
                {micDevices.map((d, idx) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `麦克风 ${idx + 1}`}
                  </option>
                ))}
              </select>
              <button className="ghost" onClick={refreshDevices}>
                刷新
              </button>
            </div>

            <div className="previewBox">
              <video ref={videoRef} autoPlay playsInline muted />
              {!isVideoActive ? <div className="previewHint">点击“开始调试”并允许权限后显示画面</div> : null}
            </div>
          </section>

          <section className="debugCard">
            <div className="debugCardHeader">
              <div className="debugCardTitle">实时字幕</div>
              <div className="pillLight">
                {asrStatusText}
                {wsMsgCount ? ` · WS:${wsMsgCount}` : ''}
                {audioRms ? ` · Mic:${audioRms.toFixed(3)}` : ''}
              </div>
            </div>

            <div className="subtitleBox">
              {subtitleLines.length === 0 ? <div className="subtitleHint">开始调试后，对着麦克风说话，字幕会实时显示</div> : null}
              {subtitleLines.map((l) => (
                <div key={`${l.tsMs}-${l.text}`} className="subtitleLine">
                  <span className="subtitleTime">[{fmtTime(l.tsMs)}]</span> {l.text}
                </div>
              ))}
              {subtitlePartial ? (
                <div className="subtitleLine subtitlePartial">
                  <span className="subtitleTime">[... ]</span> {subtitlePartial}
                </div>
              ) : null}
            </div>

            <div className="debugBtnRow">
              <button
                className="ghost"
                onClick={() => {
                  setSubtitleLines([])
                  setSubtitlePartial('')
                }}
              >
                清空字幕
              </button>
              <button className="ghost" onClick={copyAll} disabled={subtitleLines.length === 0}>
                复制全文
              </button>
            </div>
          </section>
        </div>
      </main>
    </>
  )
}
