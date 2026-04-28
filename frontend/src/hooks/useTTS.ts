import { useCallback, useEffect, useState } from 'react'
import { enqueueAudioUrl, stopAudioQueue, subscribeAudio, unlockAudio } from '@/utils/audioQueue'

export type UseTTSOptions = {
  rate?: number
  pitch?: number
  volume?: number
}

export function useTTS(options?: UseTTSOptions) {
  const [isSupported, setIsSupported] = useState(false)
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)

  useEffect(() => {
    return subscribeAudio((s) => {
      setIsSupported(Boolean(s.isSupported))
      setIsUnlocked(Boolean(s.isUnlocked))
      setIsSpeaking(Boolean(s.isPlaying))
    })
  }, [])

  const cancel = useCallback(() => {
    stopAudioQueue()
  }, [])

  const unlock = useCallback(() => {
    return unlockAudio()
  }, [])

  const speak = useCallback(
    async (text: string) => {
      const t = String(text || '').trim()
      if (!t) return
      if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('/')) {
        enqueueAudioUrl(t)
      }
    },
    [],
  )

  useEffect(() => {
    return () => stopAudioQueue()
  }, [])

  return {
    isSupported,
    isUnlocked,
    isSpeaking,
    unlock,
    speak,
    cancel,
  }
}
