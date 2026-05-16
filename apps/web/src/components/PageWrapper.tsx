import { useEffect, useState, type ReactNode } from 'react'

export function PageWrapper({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { requestAnimationFrame(() => setVisible(true)) }, [])

  return (
    <div style={{
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : 'translateY(6px)',
      transition: 'opacity 180ms ease, transform 180ms ease',
      height: '100%',
    }}>
      {children}
    </div>
  )
}
