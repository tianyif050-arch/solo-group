import { Link } from 'react-router-dom'
import { useBodyClass } from '@/useBodyClass'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getOrCreateGroupSessionId } from '@/utils/groupSession'
import Topbar from '@/components/Topbar'

type Member = { id: string; name: string; avatar_url: string }
type GroupChatReply = { session_id: string; member_id: string; text: string; audio_url?: string | null }

type ChatMsg = {
  id: string
  role: 'user' | 'member'
  memberId?: string
  memberName?: string
  memberAvatarUrl?: string
  text: string
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

export default function GroupChatPage() {
  useDemoStylesheet()
  useBodyClass('groupBody')

  const envAny = (import.meta as any).env || {}
  const apiBase = useMemo(
    () => String(envAny.VITE_API_URL || envAny.VITE_BACKEND_URL || 'http://127.0.0.1:8799').trim().replace(/\/+$/, ''),
    [envAny],
  )

  const [members, setMembers] = useState<Member[]>([])
  const [statusText, setStatusText] = useState('加载中')
  const [activeMemberId, setActiveMemberId] = useState<string>('')
  const [selectedMemberId, setSelectedMemberId] = useState<string>('')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMsg[]>([])

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioQueueRef = useRef<Array<{ url: string; memberId: string }>>([])
  const playingRef = useRef(false)

  const speakTextFallback = (text: string, roleHint: string) => {
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
        const idx = hashRole(roleHint) % zhVoices.length
        u.voice = zhVoices[idx] || null
      }
      synth.speak(u)
      setActiveMemberId(roleHint)
    } catch {}
  }

  const playNext = () => {
    if (playingRef.current) return
    const next = audioQueueRef.current.shift()
    if (!next) return
    const { url, memberId } = next
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current
    playingRef.current = true
    setActiveMemberId(memberId)
    a.src = url
    a.onended = () => {
      setActiveMemberId(memberId)
      playingRef.current = false
      playNext()
    }
    a.onerror = () => {
      playingRef.current = false
      playNext()
    }
    void a.play().catch(() => {
      playingRef.current = false
      playNext()
    })
  }

  const enqueueAudio = (url: string, memberId: string) => {
    const u = String(url || '').trim()
    if (!u) return
    audioQueueRef.current.push({ url: u, memberId })
    playNext()
  }

  useEffect(() => {
    let canceled = false
    const load = async () => {
      setStatusText('加载中')
      try {
        const res = await fetch(`${apiBase}/api/group/members`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json().catch(() => null)) as any
        const list: Member[] = Array.isArray(data?.members) ? data.members : []
        if (canceled) return
        setMembers(list)
        if (!selectedMemberId && list.length) setSelectedMemberId(list[0].id)
        setStatusText('已就绪')
      } catch (e: any) {
        if (canceled) return
        setStatusText(`加载失败：${String(e?.message || e || 'unknown')}`)
      }
    }
    load()
    return () => {
      canceled = true
    }
  }, [apiBase, selectedMemberId])

  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members])

  const send = async () => {
    const t = input.trim()
    const mid = String(selectedMemberId || '').trim()
    if (!t || !mid) return
    const sid = getOrCreateGroupSessionId()
    setInput('')
    setMessages((prev) => [
      ...prev,
      { id: `u_${Date.now()}_${Math.random().toString(16).slice(2)}`, role: 'user', text: t },
    ])
    try {
      const res = await fetch(`${apiBase}/api/group_chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, user_text: t, member_id: mid }),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(msg || `HTTP ${res.status}`)
      }
      const data = (await res.json().catch(() => null)) as GroupChatReply | null
      const text = String(data?.text || '').trim()
      const audioUrl = String((data as any)?.audio_url || '').trim()
      const mem = memberById[mid]
      if (text) {
        setMessages((prev) => [
          ...prev,
          {
            id: `m_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            role: 'member',
            memberId: mid,
            memberName: mem?.name || mid,
            memberAvatarUrl: mem?.avatar_url || '',
            text,
          },
        ])
      }
      if (audioUrl) {
        enqueueAudio(audioUrl, mid)
      } else if (text) {
        speakTextFallback(text, mid)
      }
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { id: `e_${Date.now()}`, role: 'member', memberId: 'system', memberName: '系统', text: `发送失败：${String(e?.message || e)}` },
      ])
    }
  }

  return (
    <div>
      <Topbar
        right={
          <>
            <div className="statusPill">GROUP 群聊</div>
            <div className="statusPill">{statusText}</div>
          </>
        }
      />

      <main style={{ maxWidth: 980, margin: '0 auto', padding: 16 }}>
        <section style={{ background: '#fff', borderRadius: 16, padding: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {members.map((m) => {
              const isActive = activeMemberId === m.id
              const isSelected = selectedMemberId === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedMemberId(m.id)}
                  style={{
                    border: isSelected ? '2px solid #9a79fc' : '1px solid rgba(0,0,0,0.08)',
                    background: isActive ? 'rgba(154,121,252,0.12)' : '#fff',
                    borderRadius: 14,
                    padding: 10,
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  <img
                    src={m.avatar_url}
                    alt={m.name}
                    width={40}
                    height={40}
                    style={{ borderRadius: 12, boxShadow: isActive ? '0 0 0 3px rgba(154,121,252,0.35)' : 'none' }}
                  />
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: '#3d3671' }}>{m.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>{m.id}</div>
                  </div>
                </button>
              )
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
            说明：点击头像选择“当前说话组员”（member_id）。播放音频时会自动高亮对应头像。
          </div>
        </section>

        <section style={{ background: '#fff', borderRadius: 16, padding: 16, minHeight: 360 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((m) => {
              if (m.role === 'user') {
                return (
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{ background: '#9a79fc', color: '#fff', padding: '10px 12px', borderRadius: 14, maxWidth: '78%' }}>
                      {m.text}
                    </div>
                  </div>
                )
              }
              const avatar = m.memberAvatarUrl || memberById[m.memberId || '']?.avatar_url || ''
              return (
                <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {avatar ? <img src={avatar} alt="" width={36} height={36} style={{ borderRadius: 12 }} /> : null}
                  <div style={{ maxWidth: '78%' }}>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{m.memberName || '组员'}</div>
                    <div style={{ background: 'rgba(0,0,0,0.04)', padding: '10px 12px', borderRadius: 14 }}>{m.text}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section style={{ marginTop: 12, background: '#fff', borderRadius: 16, padding: 12, display: 'flex', gap: 10 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入你想说的话…"
            style={{ flex: 1, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 12, padding: '10px 12px', outline: 'none' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send()
            }}
          />
          <button
            onClick={() => void send()}
            style={{
              border: 'none',
              background: '#9a79fc',
              color: '#fff',
              padding: '0 16px',
              borderRadius: 12,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            发送
          </button>
        </section>
      </main>
    </div>
  )
}
