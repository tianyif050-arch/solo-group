const sessionKey = 'solo_session_id_v1'
const resumeUrlKey = 'solo_resume_url_v1'

export function getOrCreateSoloSessionId() {
  try {
    const existing = sessionStorage.getItem(sessionKey)
    if (existing && String(existing).trim()) return String(existing).trim()
  } catch {}
  let sid = ''
  try {
    sid = String((crypto as any)?.randomUUID?.() || '').trim()
  } catch {}
  if (!sid) sid = `sid_${Math.random().toString(16).slice(2)}_${Date.now()}`
  try {
    sessionStorage.setItem(sessionKey, sid)
  } catch {}
  return sid
}

export function getSoloResumeUrl() {
  try {
    return String(sessionStorage.getItem(resumeUrlKey) || '').trim()
  } catch {
    return ''
  }
}

export function setSoloResumeUrl(url: string) {
  const u = String(url || '').trim()
  try {
    if (!u) sessionStorage.removeItem(resumeUrlKey)
    else sessionStorage.setItem(resumeUrlKey, u)
  } catch {}
}

