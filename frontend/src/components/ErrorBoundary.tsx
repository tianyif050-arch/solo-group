import React from 'react'

type Props = React.PropsWithChildren<{
  title?: string
}>

type State = {
  error: Error | null
  info: React.ErrorInfo | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info })
    try {
      console.error('[AppErrorBoundary]', error, info)
    } catch {}
  }

  render() {
    if (!this.state.error) return this.props.children

    const title = this.props.title || '页面渲染失败'
    const message = String(this.state.error?.message || this.state.error || 'unknown')
    const stack = String(this.state.error?.stack || '')
    const compStack = String(this.state.info?.componentStack || '')

    return (
      <div style={{ minHeight: '100vh', padding: 16, fontFamily: 'ui-sans-serif, system-ui, -apple-system' }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 12 }}>{title}</div>
        <div style={{ opacity: 0.8, marginBottom: 8 }}>{message}</div>
        <pre style={{ whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.05)', padding: 12, borderRadius: 10 }}>
          {stack}
          {compStack ? `\n\n${compStack}` : ''}
        </pre>
        <div style={{ marginTop: 12, opacity: 0.7, fontSize: 12 }}>
          打开浏览器控制台（Console）可看到更完整的报错与调用栈。
        </div>
      </div>
    )
  }
}

