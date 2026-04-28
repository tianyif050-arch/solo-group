import { useLocation } from 'react-router-dom'
import { useBodyClass } from '@/useBodyClass'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import { useEffect, useMemo, useState } from 'react'
import Topbar from '@/components/Topbar'
import { upsertInterviewRecord } from '@/utils/interviewArchive'

type Report = {
  run_id?: string
  scores?: {
    overall?: number
    grade?: string
    initiative_ice_breaking?: number
    resilience_eq?: number
    logical_thinking?: number
    empathy_teamwork?: number
    business_acumen?: number
  }
  summary?: {
    role?: string
    one_liner?: string
    highlights?: string[]
    red_flags?: string[]
  }
  raw?: {
    user_utterance_turns?: number
    talk_share?: number
    keyword_coverage?: number
    interruptions_received?: number
    interruptions_made?: number
  }
}

function fmtPct01(x: any) {
  const v = typeof x === 'number' ? x : 0
  return `${(v * 100).toFixed(1)}%`
}

function fmt1(x: any) {
  const v = typeof x === 'number' ? x : 0
  return v.toFixed(1)
}

export default function ReportPage() {
  useDemoStylesheet()
  useBodyClass('reportBody')

  const location = useLocation()
  const runId = useMemo(() => new URLSearchParams(location.search).get('run_id')?.trim() || '', [location.search])
  const apiBase = useMemo(() => {
    const v = new URLSearchParams(location.search).get('api_base')?.trim() || ''
    return v.replace(/\/+$/, '')
  }, [location.search])

  const heroBgHref = useMemo(() => new URL('../assets/.figma/image/screenshot_624_416.png', import.meta.url).href, [])
  const mascotHref = useMemo(() => new URL('../assets/.figma/image/screenshot_638_1276.png', import.meta.url).href, [])

  const [statusText, setStatusText] = useState(runId ? '加载中' : '缺少 run_id')
  const [report, setReport] = useState<Report | null>(null)

  useEffect(() => {
    if (!runId) return
    let stopped = false
    let timer = 0

    const load = async () => {
      try {
        const reportUrl = apiBase
          ? `${apiBase}/api/report/${encodeURIComponent(runId)}`
          : `/api/report/${encodeURIComponent(runId)}`
        const res = await fetch(reportUrl, { cache: 'no-store' })
        if (!res.ok) {
          setStatusText('报告生成中')
          return
        }
        const data = (await res.json()) as Report
        if (stopped) return
        setReport(data)
        setStatusText('已生成')
        try {
          const scoreOverall = typeof data?.scores?.overall === 'number' ? data.scores.overall : undefined
          const grade = data?.scores?.grade != null ? String(data.scores.grade) : undefined
          const rawRole = String(data?.summary?.role || '群面')
          const title = rawRole === '观察者' ? '面试者' : rawRole
          upsertInterviewRecord({
            id: `group_${runId}`,
            kind: 'group',
            createdAt: Date.now(),
            title,
            scoreOverall,
            grade,
            runId,
            apiBase: apiBase || undefined,
            payload: data,
          })
        } catch {}
        if (timer) window.clearInterval(timer)
      } catch {
        setStatusText('连接失败')
      }
    }

    load()
    timer = window.setInterval(load, 1200)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [runId])

  const s = report?.scores || {}
  const sm = report?.summary || {}
  const raw = report?.raw || {}
  const roleLabel = String(sm.role || '-')
  const roleText = roleLabel === '观察者' ? '面试者' : roleLabel

  return (
    <div>
      <Topbar
        right={
          <>
            <div className="statusPill">面试总结</div>
            <div className="statusPill">{statusText}</div>
          </>
        }
      />

      <main className="reportMain">
        <section className="reportHero">
          <img className="reportHeroBg" src={heroBgHref} alt="" />
          <div className="reportHeroContent">
            <div>
              <div className="reportHeroTitle">本次面试总结</div>
              <div className="reportHeroScore">
                <div className="reportScore">{fmt1(s.overall)}</div>
                <div className="reportScoreUnit">/ 100 · {String(s.grade || '-')}</div>
              </div>
              <div className="reportHeroMeta">
                角色：<span className="reportHeroMetaValue">{roleText}</span>
              </div>
              <div className="reportHeroOneLiner">{String(sm.one_liner || '报告生成中…')}</div>
            </div>
            <img className="reportHeroMascot" src={mascotHref} alt="" />
          </div>
        </section>

        <section className="reportGrid">
          <div className="reportCard">
            <div className="reportCardHead">
              <div className="reportCardTitle">核心能力评分</div>
              <div className="reportPill">1-100</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">全局观与破冰力</div>
              <div className="reportTopicPre">{fmt1(s.initiative_ice_breaking)}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">抗压与情绪颗粒度</div>
              <div className="reportTopicPre">{fmt1(s.resilience_eq)}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">逻辑与结构化思维</div>
              <div className="reportTopicPre">{fmt1(s.logical_thinking)}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">倾听与协同配合</div>
              <div className="reportTopicPre">{fmt1(s.empathy_teamwork)}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">业务敏锐度</div>
              <div className="reportTopicPre">{fmt1(s.business_acumen)}</div>
            </div>
          </div>

          <div className="reportCard">
            <div className="reportCardHead">
              <div className="reportCardTitle">关键数据</div>
              <div className="reportPill soft">概览</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">发言次数</div>
              <div className="reportTopicPre">{String(raw.user_utterance_turns ?? '-')}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">话语占比</div>
              <div className="reportTopicPre">{fmtPct01(raw.talk_share)}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">关键词覆盖率</div>
              <div className="reportTopicPre">{fmtPct01(raw.keyword_coverage)}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">被打断次数</div>
              <div className="reportTopicPre">{String(raw.interruptions_received ?? '-')}</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicHint">主动打断次数</div>
              <div className="reportTopicPre">{String(raw.interruptions_made ?? '-')}</div>
            </div>
          </div>

          <div className="reportCard">
            <div className="reportCardHead">
              <div className="reportCardTitle">高光时刻</div>
              <div className="reportPill">建议保留</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicPre">
                {(sm.highlights && sm.highlights.length ? sm.highlights : ['（暂无显著高光）']).map((x, i) => (
                  <div key={i}>- {x}</div>
                ))}
              </div>
            </div>
          </div>

          <div className="reportCard">
            <div className="reportCardHead">
              <div className="reportCardTitle">致命雷区</div>
              <div className="reportPill soft">重点规避</div>
            </div>
            <div className="reportTopicBox">
              <div className="reportTopicPre">
                {(sm.red_flags && sm.red_flags.length ? sm.red_flags : ['（暂无明显雷区）']).map((x, i) => (
                  <div key={i}>- {x}</div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
