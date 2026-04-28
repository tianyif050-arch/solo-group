export type AudioState = {
  isSupported: boolean
  isUnlocked: boolean
  isPlaying: boolean
  queueLength: number
}

const unlockedKey = 'audio_unlocked_v1'

const state: AudioState = {
  isSupported: typeof Audio !== 'undefined',
  isUnlocked: false,
  isPlaying: false,
  queueLength: 0,
}

const listeners = new Set<(s: AudioState) => void>()

type AudioQueueItem = {
  url: string
  onStart?: () => void
  onEnded?: () => void
  onError?: () => void
}

const queue: AudioQueueItem[] = []
let currentAudio: HTMLAudioElement | null = null
let currentItem: AudioQueueItem | null = null

function readUnlockedFromSession() {
  try {
    return sessionStorage.getItem(unlockedKey) === '1'
  } catch {
    return false
  }
}

state.isUnlocked = readUnlockedFromSession()

function emit() {
  state.queueLength = queue.length
  for (const fn of listeners) {
    try {
      fn({ ...state })
    } catch {}
  }
}

export function subscribeAudio(fn: (s: AudioState) => void) {
  listeners.add(fn)
  try {
    fn({ ...state })
  } catch {}
  return () => {
    listeners.delete(fn)
  }
}

export async function unlockAudio() {
  if (!state.isSupported) return false
  if (state.isUnlocked) return true
  const silentWavDataUri =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
  let ok = false
  try {
    const a = new Audio('')
    a.volume = 0
    await a.play()
    try {
      a.pause()
    } catch {}
    ok = true
  } catch {
    try {
      const a = new Audio(silentWavDataUri)
      a.volume = 0
      await a.play()
      try {
        a.pause()
      } catch {}
      ok = true
    } catch {}
  }
  if (!ok) {
    emit()
    return false
  }
  state.isUnlocked = true
  try {
    sessionStorage.setItem(unlockedKey, '1')
  } catch {}
  emit()
  return true
}

export async function unlockAudioWithMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    s.getTracks().forEach((t) => t.stop())
  } catch {}
  return await unlockAudio()
}

async function playNext() {
  if (!state.isSupported) return
  if (state.isPlaying) return
  const next = queue.shift()
  emit()
  if (!next) return

  currentItem = next
  try {
    next.onStart?.()
  } catch {}

  const a = new Audio(next.url)
  currentAudio = a
  a.preload = 'auto'
  state.isPlaying = true
  emit()

  const cleanup = () => {
    const item = currentItem
    currentItem = null
    if (currentAudio === a) currentAudio = null
    state.isPlaying = false
    emit()
    void playNext()
    try {
      item?.onEnded?.()
    } catch {}
  }

  a.onended = cleanup
  a.onerror = () => {
    const item = currentItem
    try {
      item?.onError?.()
    } catch {}
    cleanup()
  }

  try {
    await a.play()
    if (!state.isUnlocked) {
      state.isUnlocked = true
      try {
        sessionStorage.setItem(unlockedKey, '1')
      } catch {}
      emit()
    }
  } catch {
    cleanup()
  }
}

export function enqueueAudioUrl(url: string, opts?: { onStart?: () => void; onEnded?: () => void; onError?: () => void }) {
  const u = String(url || '').trim()
  if (!u) return
  queue.push({ url: u, ...(opts || {}) })
  emit()
  void playNext()
}

export function stopAudioQueue() {
  queue.length = 0
  try {
    currentAudio?.pause()
  } catch {}
  currentAudio = null
  currentItem = null
  state.isPlaying = false
  emit()
}
