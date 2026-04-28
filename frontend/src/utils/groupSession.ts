const sessionKey = 'group_session_id_v1'

export function getOrCreateGroupSessionId() {
  try {
    const existing = sessionStorage.getItem(sessionKey)
    if (existing && String(existing).trim()) return String(existing).trim()
  } catch {}
  let sid = ''
  try {
    sid = String((crypto as any)?.randomUUID?.() || '').trim()
  } catch {}
  if (!sid) sid = `gid_${Math.random().toString(16).slice(2)}_${Date.now()}`
  try {
    sessionStorage.setItem(sessionKey, sid)
  } catch {}
  return sid
}

