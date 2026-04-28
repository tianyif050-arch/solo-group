import { Home, Bot, User } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function FooterIcons() {
  return (
    <div className="footer-icons-container">
      <Link to="/" className="footer-icon-item active">
        <Home size={24} />
        <span>首页</span>
      </Link>
      <Link to="/setup" className="footer-icon-item">
        <Bot size={24} />
        <span>面试</span>
      </Link>
      <Link to="/growth" className="footer-icon-item">
        <User size={24} />
        <span>我的</span>
      </Link>

      <style>{`
        .footer-icons-container {
          display: flex;
          justify-content: space-around;
          align-items: center;
          padding: 16px 0;
          background: #fff;
          border-top: 1px solid #eaeaea;
          margin-top: 40px;
        }
        .footer-icon-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          color: #666;
          text-decoration: none;
          font-size: 12px;
          gap: 4px;
        }
        .footer-icon-item.active {
          color: #007bff;
        }
        .footer-icon-item:hover {
          color: #007bff;
        }
      `}</style>
    </div>
  )
}
