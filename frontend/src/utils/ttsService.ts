export type TTSVoicePickOptions = {
  lang?: string
}

export type TTSSpeakOptions = {
  lang?: string
  rate?: number
  pitch?: number
  volume?: number
  voice?: SpeechSynthesisVoice | null
  debugLabel?: string
  role?: string
  onstart?: () => void
  onend?: () => void
  onerror?: (e: any) => void
}

type TTSState = {
  isSupported: boolean
  isUnlocked: boolean
  isSpeaking: boolean
  voicesReady: boolean
  voice: SpeechSynthesisVoice | null
}

const unlockedKey = 'speech_unlocked'
const listeners = new Set<(s: TTSState) => void>()

const state: TTSState = {
  isSupported:
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof (window as any).SpeechSynthesisUtterance !== 'undefined',
  isUnlocked: false,
  isSpeaking: false,
  voicesReady: false,
  voice: null,
}

if (typeof window !== 'undefined') {
  ;(window as any)._activeUtterance = (window as any)._activeUtterance ?? null
}

function hashString(input: string) {
  const s = String(input || '')
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function readUnlockedFromSession() {
  try {
    return sessionStorage.getItem(unlockedKey) === '1'
  } catch {
    return false
  }
}

state.isUnlocked = readUnlockedFromSession()

function emit() {
  for (const fn of listeners) {
    try {
      fn({ ...state })
    } catch {}
  }
}

export function subscribeTTS(fn: (s: TTSState) => void) {
  listeners.add(fn)
  try {
    fn({ ...state })
  } catch {}
  return () => {
    listeners.delete(fn)
  }
}

function pickZhCnVoice(voices: SpeechSynthesisVoice[], lang: string) {
  const want = String(lang || '').toLowerCase()
  const isZh = want.startsWith('zh')
  if (!voices.length) return null

  const byLang = voices.filter((v) => String(v.lang || '').toLowerCase().startsWith(want))
  const zh = isZh ? voices.filter((v) => String(v.lang || '').toLowerCase().startsWith('zh')) : []
  const zhCn = isZh ? zh.filter((v) => String(v.lang || '').toLowerCase().startsWith('zh-cn')) : []

  const findBy = (list: SpeechSynthesisVoice[], pred: (v: SpeechSynthesisVoice) => boolean) => {
    for (const v of list) if (pred(v)) return v
    return null
  }

  const microsoftXiaoxiao =
    findBy(zhCn, (v) => /microsoft/i.test(String(v.name || '')) && /xiaoxiao/i.test(String(v.name || ''))) ||
    findBy(zh, (v) => /microsoft/i.test(String(v.name || '')) && /xiaoxiao/i.test(String(v.name || '')))

  const googlePutonghua =
    findBy(zhCn, (v) => /google/i.test(String(v.name || '')) && /(普通话|mandarin)/i.test(String(v.name || ''))) ||
    findBy(zh, (v) => /google/i.test(String(v.name || '')) && /(普通话|mandarin)/i.test(String(v.name || '')))

  return microsoftXiaoxiao || googlePutonghua || byLang[0] || zhCn[0] || zh[0] || voices[0] || null
}

function pickHighQualityZhVoice(voices: SpeechSynthesisVoice[]) {
  const v = voices || []
  if (!v.length) return null
  const hasZh = (x: SpeechSynthesisVoice) => String(x.lang || '').toLowerCase().includes('zh')
  const name = (x: SpeechSynthesisVoice) => String(x.name || '')
  const zh = v.filter(hasZh)
  const byName = (re: RegExp) => zh.find((x) => re.test(name(x))) || null
  return (
    byName(/premium/i) ||
    byName(/ting[- ]?ting/i) ||
    byName(/xiaoxiao/i) ||
    byName(/yunxi/i) ||
    null
  )
}

function pickReliableZhVoice(voices: SpeechSynthesisVoice[]) {
  const v = voices || []
  if (!v.length) return null
  const hasZh = (x: SpeechSynthesisVoice) => String(x.lang || '').toLowerCase().includes('zh')
  const name = (x: SpeechSynthesisVoice) => String(x.name || '')
  return (
    pickHighQualityZhVoice(v) ||
    v.find((x) => hasZh(x) && /google/i.test(name(x))) ||
    v.find((x) => hasZh(x) && /microsoft/i.test(name(x))) ||
    v.find((x) => String(x.lang || '').toLowerCase() === 'zh-cn') ||
    v.find((x) => hasZh(x)) ||
    null
  )
}

function pickRolePitch(role: string | undefined) {
  const r = String(role || '').trim()
  if (!r) return 0.95
  const key = r.toLowerCase()
  if (key.includes('hr')) return 0.92
  if (key.includes('leader') || key.includes('主管') || key.includes('总监')) return 0.88
  if (key.includes('业务') || key.includes('面试官') || key.includes('interviewer')) return 0.95
  const choices = [0.9, 0.95, 1.05]
  return choices[hashString(r) % choices.length]
}

function pickRoleVoice(voices: SpeechSynthesisVoice[], role: string | undefined) {
  const r = String(role || '').trim()
  const zh = (voices || []).filter((v) => String(v.lang || '').toLowerCase().includes('zh'))
  if (!zh.length) return null
  if (!r) return pickReliableZhVoice(voices) || zh[0] || null
  const idx = hashString(r) % zh.length
  return zh[idx] || null
}

export function cancelTTS() {
  if (!state.isSupported) return
  // 每次发声前/路由切换时，建议先 cancel() 清空队列，避免卡死或叠音
  try {
    window.speechSynthesis.cancel()
  } catch {}
  try {
    ;(window as any)._activeUtterance = null
  } catch {}
  state.isSpeaking = false
  emit()
}

let voicesReadyPromise: Promise<SpeechSynthesisVoice[]> | null = null

export function ensureVoicesReady(timeoutMs = 2500): Promise<SpeechSynthesisVoice[]> {
  if (!state.isSupported) return Promise.resolve([])
  // 语音包通常是异步加载：首次进入页面时 getVoices() 可能为空，需要等待 voiceschanged
  const existing = window.speechSynthesis.getVoices?.() || []
  if (existing.length) {
    state.voicesReady = true
    state.voice = pickZhCnVoice(existing, 'zh-CN')
    emit()
    return Promise.resolve(existing)
  }

  if (voicesReadyPromise) return voicesReadyPromise

  voicesReadyPromise = new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const v = window.speechSynthesis.getVoices?.() || []
      state.voicesReady = v.length > 0
      state.voice = pickZhCnVoice(v, 'zh-CN')
      emit()
      resolve(v)
      voicesReadyPromise = null
    }

    const timer = window.setTimeout(finish, Math.max(200, timeoutMs))

    const handler = () => {
      window.clearTimeout(timer)
      finish()
    }

    const prev = (window.speechSynthesis as any).onvoiceschanged
    try {
      ;(window.speechSynthesis as any).onvoiceschanged = handler
    } catch {}
    try {
      window.speechSynthesis.addEventListener('voiceschanged', handler)
    } catch {}

    const pollId = window.setInterval(() => {
      const v = window.speechSynthesis.getVoices?.() || []
      if (v.length) {
        window.clearInterval(pollId)
        window.clearTimeout(timer)
        finish()
      }
    }, 120)

    window.setTimeout(() => {
      try {
        window.speechSynthesis.removeEventListener('voiceschanged', handler)
      } catch {}
      try {
        ;(window.speechSynthesis as any).onvoiceschanged = prev
      } catch {}
      try {
        window.clearInterval(pollId)
      } catch {}
      window.clearTimeout(timer)
      finish()
    }, Math.max(200, timeoutMs) + 50)
  })

  return voicesReadyPromise
}

export function pickVoice(voices: SpeechSynthesisVoice[], opts?: TTSVoicePickOptions) {
  const lang = String(opts?.lang || 'zh-CN')
  return pickZhCnVoice(voices, lang)
}

export async function unlockTTS() {
  if (!state.isSupported) return false
  // 必须在“用户手势(click)”的同一次调用栈中触发 speak()，否则可能被浏览器自动播放策略拦截
  await ensureVoicesReady(2000)
  try {
    window.speechSynthesis.cancel()
  } catch {}

  try {
    const u = new SpeechSynthesisUtterance(' ')
    u.lang = 'zh-CN'
    u.rate = 1
    u.pitch = 1
    u.volume = 0
    if (state.voice) u.voice = state.voice
    window.speechSynthesis.speak(u)
  } catch {}

  state.isUnlocked = true
  try {
    sessionStorage.setItem(unlockedKey, '1')
  } catch {}
  emit()
  return true
}

export async function unlockTTSWithMic() {
  // 物理点击时同时申请麦克风权限 + 播放一段静音 TTS，可最大化解除自动播放限制
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    s.getTracks().forEach((t) => t.stop())
  } catch {}
  return await unlockTTS()
}

export async function speakTTS(text: string, options?: TTSSpeakOptions) {
  if (!state.isSupported) throw new Error('当前浏览器不支持 Web Speech API')
  const t = humanizeTextForTTS(String(text || ''))
  if (!t) return
  if (!state.isUnlocked) throw new Error('语音未激活：请先点击“进入面试室并开启语音”')

  await ensureVoicesReady(2500)

  const lang = String(options?.lang || 'zh-CN')
  const rate = typeof options?.rate === 'number' ? options.rate : 0.9
  const pitch = typeof options?.pitch === 'number' ? options.pitch : pickRolePitch(options?.role)
  const volume = typeof options?.volume === 'number' ? options.volume : 1
  const debugLabel = String(options?.debugLabel || 'TTS')

  try {
    window.speechSynthesis.cancel()
  } catch {}
  try {
    window.speechSynthesis.resume()
  } catch {}

  console.log(`[${debugLabel}] speak:`, t)

  return await new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(t)

    try {
      ;(window as any)._activeUtterance = u
    } catch {}

    u.lang = lang
    u.rate = rate
    u.pitch = pitch
    u.volume = volume
    try {
      const voices = window.speechSynthesis.getVoices?.() || []
      const roleVoice = pickRoleVoice(voices, options?.role)
      const zhVoice = pickReliableZhVoice(voices) || pickZhCnVoice(voices, lang) || null
      u.voice = options?.voice || roleVoice || zhVoice || state.voice || null
    } catch {
      u.voice = options?.voice || state.voice || null
    }

    u.onstart = () => {
      state.isSpeaking = true
      emit()
      console.log(`[${debugLabel}] onstart`)
      try {
        options?.onstart?.()
      } catch {}
    }
    u.onend = () => {
      state.isSpeaking = false
      emit()
      console.log(`[${debugLabel}] onend`)
      try {
        options?.onend?.()
      } catch {}
      try {
        if ((window as any)._activeUtterance === u) (window as any)._activeUtterance = null
      } catch {}
      resolve()
    }
    u.onerror = (e: any) => {
      state.isSpeaking = false
      emit()
      console.log(`[${debugLabel}] onerror:`, e)
      try {
        options?.onerror?.(e)
      } catch {}
      try {
        if ((window as any)._activeUtterance === u) (window as any)._activeUtterance = null
      } catch {}
      reject(e)
    }

    try {
      window.speechSynthesis.speak(u)
      try {
        window.speechSynthesis.resume()
      } catch {}
    } catch (e) {
      state.isSpeaking = false
      emit()
      try {
        if ((window as any)._activeUtterance === u) (window as any)._activeUtterance = null
      } catch {}
      reject(e)
    }
  })
}

type StreamKey = string

let activeUtterCount = 0
let playChain: Promise<void> = Promise.resolve()
const streamBuffers = new Map<StreamKey, string>()
const streamTimers = new Map<StreamKey, number>()

function splitByPunctuationRegex(input: string) {
  const s = String(input || '')
  const out: string[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '。' || ch === '？' || ch === '！' || ch === '?' || ch === '!' || ch === '，' || ch === ',' || ch === '.' || ch === '\n') {
      const seg = s.slice(start, i + 1).trim()
      if (seg) out.push(seg)
      start = i + 1
    }
  }
  return { segments: out, rest: s.slice(start) }
}

async function speakNoCancel(text: string, options?: TTSSpeakOptions) {
  if (!state.isSupported) throw new Error('当前浏览器不支持 Web Speech API')
  const t = humanizeTextForTTS(String(text || ''))
  if (!t) return
  if (!state.isUnlocked) throw new Error('语音未激活：请先点击“进入面试室并开启语音”')
  await ensureVoicesReady(2500)

  const lang = String(options?.lang || 'zh-CN')
  const rate = typeof options?.rate === 'number' ? options.rate : 0.9
  const pitch = typeof options?.pitch === 'number' ? options.pitch : pickRolePitch(options?.role)
  const volume = typeof options?.volume === 'number' ? options.volume : 1
  const debugLabel = String(options?.debugLabel || 'TTS')

  console.log(`[${debugLabel}] enqueue:`, t)

  return await new Promise<void>((resolve) => {
    let u: SpeechSynthesisUtterance
    try {
      u = new SpeechSynthesisUtterance(t)
      ;(window as any)._activeUtterance = u
    } catch {
      resolve()
      return
    }

    u.lang = lang
    u.rate = rate
    u.pitch = pitch
    u.volume = volume
    try {
      const voices = window.speechSynthesis.getVoices?.() || []
      const roleVoice = pickRoleVoice(voices, options?.role)
      const zhVoice = pickReliableZhVoice(voices) || pickZhCnVoice(voices, lang) || null
      u.voice = options?.voice || roleVoice || zhVoice || state.voice || null
    } catch {
      u.voice = options?.voice || state.voice || null
    }

    u.onstart = () => {
      activeUtterCount++
      state.isSpeaking = activeUtterCount > 0
      emit()
      try {
        options?.onstart?.()
      } catch {}
    }
    const done = () => {
      activeUtterCount = Math.max(0, activeUtterCount - 1)
      state.isSpeaking = activeUtterCount > 0
      emit()
      try {
        if ((window as any)._activeUtterance === u) (window as any)._activeUtterance = null
      } catch {}
      try {
        options?.onend?.()
      } catch {}
      resolve()
    }
    u.onend = done
    u.onerror = () => done()

    try {
      window.speechSynthesis.speak(u)
      try {
        window.speechSynthesis.resume()
      } catch {}
    } catch {
      done()
    }
  })
}

function humanizeTextForTTS(input: string) {
  let s = String(input || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  s = s.replace(/^(assistant|ai|面试官)[:：]\s*/i, '')
  s = s.replace(/(嗯|好|那|其实|我明白|明白)(?![，,。！？!?])/g, '$1，')

  const punct = new Set(['，', ',', '。', '！', '？', '!', '?', '.', '\n'])
  const out: string[] = []
  let run = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (punct.has(ch)) {
      if (run) {
        out.push(run)
        run = ''
      }
      out.push(ch === '\n' ? '，' : ch)
      continue
    }
    run += ch
    if (run.length >= 22) {
      out.push(run)
      out.push('，')
      run = ''
    }
  }
  if (run) out.push(run)
  s = out.join('')
  s = s.replace(/，，+/g, '，')
  return s.trim()
}

export function resetTTSQueue() {
  playChain = Promise.resolve()
  streamBuffers.clear()
  for (const id of streamTimers.values()) {
    try {
      window.clearTimeout(id)
    } catch {}
  }
  streamTimers.clear()
  cancelTTS()
}

export function enqueueTTS(text: string, options?: TTSSpeakOptions) {
  const t = String(text || '').trim()
  if (!t) return Promise.resolve()
  playChain = playChain.then(() => speakNoCancel(t, options)).catch(() => {})
  return playChain
}

export function pushTTSStreamChunk(opts: { streamKey: string; text: string; role?: string; lang?: string; debugLabel?: string }) {
  const key = String(opts.streamKey || 'default')
  const chunk = String(opts.text || '')
  if (!chunk) return
  const prev = streamBuffers.get(key) || ''
  const merged = `${prev}${chunk}`
  const { segments, rest } = splitByPunctuationRegex(merged)
  streamBuffers.set(key, rest)

  for (const seg of segments) {
    enqueueTTS(seg, { lang: opts.lang || 'zh-CN', role: opts.role, debugLabel: opts.debugLabel || 'TTS' })
  }

  const oldTimer = streamTimers.get(key)
  if (oldTimer) {
    try {
      window.clearTimeout(oldTimer)
    } catch {}
  }
  const timerId = window.setTimeout(() => {
    const pending = String(streamBuffers.get(key) || '').trim()
    if (pending) {
      streamBuffers.set(key, '')
      enqueueTTS(pending, { lang: opts.lang || 'zh-CN', role: opts.role, debugLabel: opts.debugLabel || 'TTS' })
    }
  }, 260)
  streamTimers.set(key, timerId)
}

export function flushTTSStream(streamKey: string, options?: { role?: string; lang?: string; debugLabel?: string }) {
  const key = String(streamKey || 'default')
  const pending = String(streamBuffers.get(key) || '').trim()
  streamBuffers.set(key, '')
  const oldTimer = streamTimers.get(key)
  if (oldTimer) {
    try {
      window.clearTimeout(oldTimer)
    } catch {}
  }
  streamTimers.delete(key)
  if (pending) {
    enqueueTTS(pending, { lang: options?.lang || 'zh-CN', role: options?.role, debugLabel: options?.debugLabel || 'TTS' })
  }
}
