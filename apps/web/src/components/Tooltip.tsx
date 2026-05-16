import { useState, useRef, type ReactNode } from 'react'

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 6,
          padding: '4px 8px',
          background: 'rgba(0,0,0,0.85)',
          color: '#fff',
          borderRadius: 4,
          fontSize: 12,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 1000,
        }}>
          {content}
        </div>
      )}
    </div>
  )
}
