export type InterviewKind = 'solo' | 'group'

export type InterviewRecord = {
  id: string
  kind: InterviewKind
  createdAt: number
  title: string
  scoreOverall?: number
  grade?: string
  runId?: string
  apiBase?: string
  payload?: any
}

const KEY = 'interview_records_v1'

function safeParse(raw: string | null) {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function loadInterviewRecords(): InterviewRecord[] {
  try {
    const data = safeParse(localStorage.getItem(KEY))
    if (!Array.isArray(data)) return []
    return data
      .filter(Boolean)
      .map((r: any) => ({
        id: String(r.id || ''),
        kind: (String(r.kind || 'solo') as InterviewKind) || 'solo',
        createdAt: Number(r.createdAt) || Date.now(),
        title: String(r.title || ''),
        scoreOverall: typeof r.scoreOverall === 'number' ? r.scoreOverall : undefined,
        grade: r.grade != null ? String(r.grade) : undefined,
        runId: r.runId != null ? String(r.runId) : undefined,
        apiBase: r.apiBase != null ? String(r.apiBase) : undefined,
        payload: r.payload,
      }))
      .filter((r) => r.id && (r.kind === 'solo' || r.kind === 'group'))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  } catch {
    return []
  }
}

export function upsertInterviewRecord(rec: InterviewRecord) {
  const r: InterviewRecord = {
    ...rec,
    id: String(rec.id || '').trim(),
    title: String(rec.title || '').trim(),
    createdAt: Number(rec.createdAt) || Date.now(),
  }
  if (!r.id) return
  try {
    const all = loadInterviewRecords()
    const idx = all.findIndex((x) => x.id === r.id)
    if (idx >= 0) all[idx] = { ...all[idx], ...r }
    else all.unshift(r)
    const limited = all.slice(0, 200)
    localStorage.setItem(KEY, JSON.stringify(limited))
  } catch {}
}

export function getInterviewRecordById(id: string): InterviewRecord | null {
  const target = String(id || '').trim()
  if (!target) return null
  const all = loadInterviewRecords()
  return all.find((x) => x.id === target) || null
}

