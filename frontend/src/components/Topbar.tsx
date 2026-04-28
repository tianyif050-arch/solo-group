import { useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'

export default function Topbar({ right }: { right?: React.ReactNode }) {
  const logoHref = useMemo(() => new URL('../assets/static/logo.svg', import.meta.url).href, [])
  const loc = useLocation()
  const path = String(loc.pathname || '')
  const active = path.startsWith('/growth') ? 'growth' : path === '/' ? 'home' : 'setup'

  return (
    <header className="topbar">
      <div className="brand">
        <img className="brandLogo" src={logoHref} alt="logo" />
        <div className="brandText">AI面试训练营</div>
      </div>
      <nav className="nav">
        <Link className={`navItem ${active === 'home' ? 'active' : ''}`} to="/">
          首页
        </Link>
        <Link className={`navItem ${active === 'setup' ? 'active' : ''}`} to="/setup">
          面试
        </Link>
        <Link className={`navItem ${active === 'growth' ? 'active' : ''}`} to="/growth">
          我的
        </Link>
      </nav>
      <div className="topActions">{right}</div>
    </header>
  )
}

