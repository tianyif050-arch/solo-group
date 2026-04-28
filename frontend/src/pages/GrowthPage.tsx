import Topbar from '@/components/Topbar'
import { useBodyClass } from '@/useBodyClass'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import { Link } from 'react-router-dom'
import { loadInterviewRecords } from '@/utils/interviewArchive'
import { useEffect, useState } from 'react'

export default function GrowthPage() {
  useDemoStylesheet()
  useBodyClass('homeBody')

  const [records, setRecords] = useState(() => loadInterviewRecords())

  useEffect(() => {
    const refresh = () => setRecords(loadInterviewRecords())
    refresh()
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'interview_records_v1') refresh()
    }
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  return (
    <>
      <Topbar />
      <main className="homeMain">
        <section className="resumeCard">
          <div className="featureTitle">我的</div>
          <div className="featureText">每次面试结束后会自动存档。点击记录查看分数详情。</div>
        </section>
        <section className="homeFeatures" style={{ marginTop: 12 }}>
          {records.length ? (
            records.map((r) => {
              const label = r.kind === 'group' ? '群面' : '单面'
              const scoreText =
                typeof r.scoreOverall === 'number'
                  ? `${Math.round(r.scoreOverall)}${r.grade ? ` · ${String(r.grade)}` : ''}`
                  : r.grade
                    ? String(r.grade)
                    : '-'
              const when = new Date(r.createdAt).toLocaleString()
              const to =
                r.kind === 'group' && r.runId
                  ? `/report?run_id=${encodeURIComponent(r.runId)}${r.apiBase ? `&api_base=${encodeURIComponent(r.apiBase)}` : ''}`
                  : `/growth/record/${encodeURIComponent(r.id)}`
              const title = r.title === '观察者' ? '面试者' : r.title
              return (
                <Link key={r.id} className="featureCard" to={to} style={{ textDecoration: 'none' }}>
                  <div className="featureTitle" style={{ marginTop: 4 }}>
                    {label} · {title || '面试'}
                  </div>
                  <div className="featureText" style={{ marginTop: 6 }}>
                    分数：{scoreText}
                  </div>
                  <div className="featureText" style={{ marginTop: 6, fontSize: 12 }}>
                    时间：{when}
                  </div>
                </Link>
              )
            })
          ) : (
            <div className="featureCard">
              <div className="featureTitle" style={{ marginTop: 4 }}>
                暂无记录
              </div>
              <div className="featureText" style={{ marginTop: 6 }}>
                去“面试”完成一次 SOLO 或 GROUP，结束后会自动出现在这里。
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  )
}
