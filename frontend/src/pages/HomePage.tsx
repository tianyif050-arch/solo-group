import { Link } from 'react-router-dom'
import { useInterviewMode } from '@/interviewMode'
import { useBodyClass } from '@/useBodyClass'
import { useDemoStylesheet } from '@/useDemoStylesheet'
import { useRef, useState } from 'react'
import { getOrCreateSoloSessionId, setSoloResumeUrl } from '@/utils/soloSession'
import Topbar from '@/components/Topbar'

export default function HomePage() {
  useDemoStylesheet()
  useBodyClass('homeBody')

  const { interviewMode, setInterviewMode } = useInterviewMode()

  const baseUrl = (import.meta as any).env?.BASE_URL || '/'
  const heroBoardHref = `${baseUrl}images/hero-board.png`
  const heroMascotHref = `${baseUrl}images/hero-mascot.png`

  const feature1IconHref = `${baseUrl}images/feature-interview.png`
  const feature2IconHref = `${baseUrl}icons/assess.png`
  const feature3IconHref = `${baseUrl}icons/plan.png`

  const resumeInputRef = useRef<HTMLInputElement>(null)
  const [resumeFileName, setResumeFileName] = useState<string | null>(null)
  const [resumeStatus, setResumeStatus] = useState<string>('')

  const pickResume = () => resumeInputRef.current?.click()
  const uploadResume = async (f: File) => {
    const envAny = (import.meta as any).env || {}
    const apiBase = String(envAny.VITE_API_URL || envAny.VITE_BACKEND_URL || 'http://127.0.0.1:8799').trim().replace(/\/+$/, '')
    const sid = getOrCreateSoloSessionId()
    const fd = new FormData()
    fd.append('session_id', sid)
    fd.append('file', f)
    setResumeStatus('上传中…')
    try {
      const urls = ['/api/upload_resume', `${apiBase}/api/upload_resume`].filter(Boolean)
      let lastErr: any = null
      let data: any = null
      for (const u of urls) {
        try {
          const res = await fetch(u, { method: 'POST', body: fd })
          if (!res.ok) {
            const msg = await res.text().catch(() => '')
            throw new Error(msg || `HTTP ${res.status}`)
          }
          data = await res.json().catch(() => null)
          lastErr = null
          break
        } catch (e) {
          lastErr = e
        }
      }
      if (lastErr) throw lastErr
      const url = String(data?.file_url || '').trim()
      if (url) setSoloResumeUrl(url)
      setResumeStatus(url ? '已上传' : '上传失败（后端未返回 file_url）')
    } catch (e: any) {
      const msg = String(e?.message || e || 'unknown')
      if (msg.includes('Failed to fetch')) {
        setResumeStatus('上传失败：Failed to fetch（请确认 8799 后端已启动且 /api/upload_resume 可访问）')
        return
      }
      setResumeStatus(`上传失败：${msg}`)
    }
  }

  return (
    <>
      <Topbar
        right={
          <>
            <div className="modePill">
              <span className="modeLabel">模式：</span>
              <select
                className="modeSelect"
                value={interviewMode}
                onChange={(e) => setInterviewMode(e.target.value as 'solo' | 'group')}
              >
                <option value="solo">SOLO 面试</option>
                <option value="group">GROUP 群面</option>
              </select>
            </div>
            <button className="ghost">注册</button>
            <button className="primary">登录</button>
            <button className="ghost iconBtn" aria-label="menu">
              ≡
            </button>
          </>
        }
      />

      <main className="homeMain">
        <section className="hero">
          <div className="heroLeft">
            <div className="heroTitle">AI Mock Interview</div>
            <div className="heroSubtitle">
              Practice with AI,
              <br />
              grow your confidence.
            </div>
            <div className="heroBtns">
              <Link className="linkBtnPrimary" to="/setup">
                开始模拟面试
              </Link>
              <button className="ghost heroJobBtn">
                UI设计师实习
                <span className="heroJobArrow" aria-hidden="true">
                  →
                </span>
              </button>
            </div>
          </div>
          <div className="heroRight">
            <div className="heroVisual">
              <img className="heroBoard" src={heroBoardHref} alt="" />
              <img className="heroMascot" src={heroMascotHref} alt="" />
            </div>
          </div>
        </section>

        <section className="homeFeatures">
          <div className="featureCard">
            <img className="featureIconImg" src={feature1IconHref} alt="" />
            <div className="featureTitle">真实面试模拟</div>
            <div className="featureText">模拟真实面试场景，还原面试官追问节奏。支持自定义岗位、难度与题型，随时随地反复练习。</div>
          </div>
          <div className="featureCard">
            <img className="featureIconImg" src={feature2IconHref} alt="" />
            <div className="featureTitle">AI 智能评估</div>
            <div className="featureText">多维度分析你的回答逻辑、表达流畅度、专业匹配度与自信心状态，生成可量化的面试表现报告。</div>
          </div>
          <div className="featureCard">
            <img className="featureIconImg featureIconZoom" src={feature3IconHref} alt="" />
            <div className="featureTitle">专属提升方案</div>
            <div className="featureText">根据你的薄弱项，生成个性化的面试提升计划与答题优化建议，帮你稳步提高面试能力。</div>
          </div>
        </section>

        <section className="resumeCard">
          <div className="resumeRow">
            <div className="resumeHint">
              点击或拖拽上传你的简历（支持格式：word、pdf），让面试官更了解你
              {resumeFileName ? <span className="resumeFile">已选择：{resumeFileName}</span> : null}
            </div>
            <input
              ref={resumeInputRef}
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                setResumeFileName(f?.name ?? null)
                if (f) void uploadResume(f)
              }}
            />
            <button className="primary" onClick={pickResume}>
              上传简历
            </button>
          </div>
          {resumeStatus ? <div className="resumeHint">{resumeStatus}</div> : null}
        </section>
      </main>
    </>
  )
}
