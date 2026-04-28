import Topbar from '@/components/Topbar'
import { useBodyClass } from '@/useBodyClass'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import { getInterviewRecordById } from '@/utils/interviewArchive'
import { useMemo } from 'react'
import { useParams } from 'react-router-dom'

export default function GrowthRecordPage() {
  useDemoStylesheet()
  useBodyClass('homeBody')

  const params = useParams()
  const id = String(params.id || '').trim()
  const rec = useMemo(() => getInterviewRecordById(id), [id])

  const p = rec?.payload || {}
  const messages = Array.isArray(p.messages) ? p.messages : []

  return (
    <>
      <Topbar />
      <main className="homeMain">
        <section className="resumeCard">
          <div className="featureTitle">分数详情</div>
          <div className="featureText">{rec ? `${rec.title || '面试'} · ${new Date(rec.createdAt).toLocaleString()}` : '记录不存在'}</div>
        </section>

        {rec ? (
          <>
            <section className="homeFeatures" style={{ marginTop: 12 }}>
              <div className="featureCard">
                <div className="featureTitle" style={{ marginTop: 4 }}>
                  总分
                </div>
                <div className="featureText" style={{ marginTop: 6 }}>
                  {typeof rec.scoreOverall === 'number' ? Math.round(rec.scoreOverall) : '-'}
                </div>
              </div>
              <div className="featureCard">
                <div className="featureTitle" style={{ marginTop: 4 }}>
                  语音
                </div>
                <div className="featureText" style={{ marginTop: 6 }}>
                  {typeof p.voiceScore === 'number' ? Math.round(p.voiceScore) : '-'}
                </div>
              </div>
              <div className="featureCard">
                <div className="featureTitle" style={{ marginTop: 4 }}>
                  表情
                </div>
                <div className="featureText" style={{ marginTop: 6 }}>
                  {typeof p.facialScore === 'number' ? Math.round(p.facialScore) : '-'}
                </div>
              </div>
            </section>

            <section className="resumeCard" style={{ marginTop: 12 }}>
              <div className="featureTitle" style={{ marginTop: 4 }}>
                字幕/内容
              </div>
              <div className="featureText" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {String(p.transcript || '').trim() || '无字幕'}
              </div>
            </section>

            <section className="resumeCard" style={{ marginTop: 12 }}>
              <div className="featureTitle" style={{ marginTop: 4 }}>
                对话记录
              </div>
              <div className="featureText" style={{ marginTop: 8 }}>
                {messages.length ? '' : '暂无'}
              </div>
              {messages.length ? (
                <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                  {messages.map((m: any, idx: number) => (
                    <div
                      key={`${idx}`}
                      style={{
                        padding: 12,
                        borderRadius: 14,
                        border: '1px solid rgba(114, 90, 197, 0.16)',
                        background: 'rgba(255,255,255,0.55)',
                      }}
                    >
                      <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.8 }}>{String(m.role || 'msg').toUpperCase()}</div>
                      <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{String(m.content || '')}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
    </>
  )
}

