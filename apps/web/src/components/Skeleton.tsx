/**
 * Loading skeleton components for smooth loading states.
 */
import React from 'react'

// Base skeleton animation
const skeletonStyle: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-surface) 50%, var(--bg-elevated) 75%)',
  backgroundSize: '200% 100%',
  animation: 'skeleton-shimmer 1.5s infinite',
  borderRadius: 6,
}

// Inject keyframes once
if (typeof document !== 'undefined') {
  const style = document.getElementById('skeleton-style') ?? (() => {
    const s = document.createElement('style')
    s.id = 'skeleton-style'
    document.head.appendChild(s)
    return s
  })()
  style.textContent = '@keyframes skeleton-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }'
}

export function SkeletonText({ width = '100%', height = 16 }: { width?: string | number; height?: number }) {
  return <div style={{ ...skeletonStyle, width, height, marginBottom: 8 }} />
}

export function SkeletonCard({ height = 120 }: { height?: number }) {
  return <div style={{ ...skeletonStyle, width: '100%', height, borderRadius: 12, marginBottom: 16 }} />
}

export function SkeletonRow() {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center' }}>
      <div style={{ ...skeletonStyle, width: 32, height: 32, borderRadius: '50%', flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <SkeletonText width="60%" height={14} />
        <SkeletonText width="40%" height={12} />
      </div>
    </div>
  )
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      <SkeletonText width="100%" height={40} />
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonText key={i} width="100%" height={48} />
      ))}
    </div>
  )
}
