import { useEffect } from 'react'

export function useDemoStylesheet() {
  useEffect(() => {
    const demoStyleUrl = new URL('./assets/style.css', import.meta.url).href
    const id = 'demo-stylesheet'
    const existing = document.getElementById(id) as HTMLLinkElement | null
    if (existing) return

    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href = demoStyleUrl
    document.head.appendChild(link)
  }, [])
}
