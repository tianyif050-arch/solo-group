import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export type InterviewMode = 'solo' | 'group'

type InterviewModeContextValue = {
  interviewMode: InterviewMode
  setInterviewMode: (mode: InterviewMode) => void
}

const InterviewModeContext = createContext<InterviewModeContextValue | null>(null)

function readInitialMode(): InterviewMode {
  try {
    const v = localStorage.getItem('interview_mode')
    if (v === 'solo' || v === 'group') return v
  } catch {}
  return 'solo'
}

export function InterviewModeProvider({ children }: { children: ReactNode }) {
  const [interviewMode, _setInterviewMode] = useState<InterviewMode>(() => readInitialMode())

  const value = useMemo<InterviewModeContextValue>(() => {
    const setInterviewMode = (mode: InterviewMode) => {
      _setInterviewMode(mode)
      try {
        localStorage.setItem('interview_mode', mode)
      } catch {}
    }
    return { interviewMode, setInterviewMode }
  }, [interviewMode])

  return <InterviewModeContext.Provider value={value}>{children}</InterviewModeContext.Provider>
}

export function useInterviewMode() {
  const ctx = useContext(InterviewModeContext)
  if (!ctx) throw new Error('useInterviewMode must be used within InterviewModeProvider')
  return ctx
}
