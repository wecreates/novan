/**
 * WarRoomView — R146.115 — chriswesst-style agent row + Kanban ops board.
 *
 * Top: row of agent avatars with role + status pill + current task. Middle:
 * 3-column Kanban (ON DECK | IN PROCESS | COMPLETED). Bottom: quick "+ task"
 * row. Reads agents.list + agents.opsBoard via brain ops.
 *
 * Honest scope: this is a viewer + minimal CRUD. Drag-and-drop between
 * columns is not implemented (would need a 30kB DnD library). Use the
 * "→" button to advance a card to the next column.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_BASE as BASE } from '../api.js'

interface Agent {
  id: string; shortName: string; role: string; avatarHue: number
  status: 'idle' | 'live' | 'offline'; currentTask?: string | null
  lastActiveAt?: number | null
}
interface OpsTask {
  id: string; title: string; ownerAgentId?: string | null
  column: 'on_deck' | 'in_process' | 'completed'
  notes?: string | null; updatedAt: number
}
interface OpsBoard { on_deck: OpsTask[]; in_process: OpsTask[]; completed: OpsTask[] }

async function brainOp<T>(op: string, params: Record<string, unknown> = {}): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}/api/brain/op`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params }), credentials: 'include',
    })
    if (!r.ok) return null
    const data = await r.json() as { result?: T }
    return data.result ?? null
  } catch { return null }
}

function AgentChip({ a }: { a: Agent }) {
  const color = `hsl(${a.avatarHue}, 70%, 60%)`
  const statusColor = a.status === 'live' ? '#22c55e' : a.status === 'offline' ? '#444' : '#a3a3a3'
  return (
    <div style={{
      width: 132, padding: '12px 10px',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 8, fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 14,
          background: `linear-gradient(135deg, ${color} 0%, hsl(${a.avatarHue + 30}, 60%, 35%) 100%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, color: '#000',
          boxShadow: `0 0 8px ${color}66`,
        }}>{a.shortName.slice(0, 1)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>{a.shortName}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.05em' }}>{a.role.slice(0, 18)}</div>
        </div>
        <div style={{ width: 6, height: 6, borderRadius: 3, background: statusColor }} title={a.status} />
      </div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>CURRENT TASK</div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', minHeight: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {a.currentTask || '—'}
      </div>
    </div>
  )
}

function OpsCard({ task, onMove }: { task: OpsTask; onMove: (to: OpsTask['column']) => void }) {
  const nextCol = task.column === 'on_deck' ? 'in_process' : task.column === 'in_process' ? 'completed' : null
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/x-novan-task', task.id); e.dataTransfer.effectAllowed = 'move' }}
      style={{
        padding: '10px 12px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderLeft: `3px solid ${task.column === 'on_deck' ? '#a855f7' : task.column === 'in_process' ? '#ef4444' : '#22c55e'}`,
        borderRadius: 6, marginBottom: 6,
        fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
        cursor: 'grab',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.88)' }}>{task.title}</div>
        {nextCol && (
          <button onClick={() => onMove(nextCol)} title={`Move to ${nextCol}`}
            style={{ background: 'transparent', color: 'rgba(255,255,255,0.5)', border: 'none', cursor: 'pointer', fontSize: 13, padding: 0 }}>→</button>
        )}
      </div>
      {task.notes && <div style={{ marginTop: 4, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>{task.notes.slice(0, 80)}</div>}
    </div>
  )
}

export function WarRoomView(): JSX.Element {
  const [agents, setAgents] = useState<Agent[]>([])
  const [board, setBoard] = useState<OpsBoard>({ on_deck: [], in_process: [], completed: [] })
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [a, b] = await Promise.all([
      brainOp<Agent[]>('agents.list'),
      brainOp<OpsBoard>('agents.opsBoard'),
    ])
    if (a) setAgents(a)
    if (b) setBoard(b)
    // If empty roster on first ever load, seed defaults
    if (a && a.length === 0) {
      await brainOp('agents.seedDefaults')
      const aa = await brainOp<Agent[]>('agents.list')
      if (aa) setAgents(aa)
    }
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const liveCount = useMemo(() => agents.filter(a => a.status === 'live').length, [agents])

  const addTask = async () => {
    if (!newTaskTitle.trim()) return
    await brainOp('agents.opsAdd', { title: newTaskTitle.trim() })
    setNewTaskTitle('')
    await refresh()
  }

  const moveTask = async (id: string, to: OpsTask['column']) => {
    await brainOp('agents.opsMove', { taskId: id, toColumn: to })
    await refresh()
  }

  const onColumnDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  const onColumnDrop = (col: OpsTask['column']) => (e: React.DragEvent) => {
    e.preventDefault()
    const taskId = e.dataTransfer.getData('text/x-novan-task')
    if (taskId) void moveTask(taskId, col)
  }

  return (
    <div style={{
      width: '100%', height: '100%', background: '#000', color: 'rgba(255,255,255,0.9)',
      fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
      overflow: 'auto', padding: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 8 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: '#ffd47a' }}>War Room</h1>
        <span style={{ marginLeft: 12, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
          Agents Live: {liveCount}/{agents.length}
        </span>
        <button onClick={() => void refresh()} disabled={loading} style={{
          marginLeft: 'auto', background: 'transparent', color: 'rgba(255,255,255,0.55)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
          padding: '4px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit',
        }}>{loading ? '...' : '↻ refresh'}</button>
      </div>

      {/* Agent row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
        {agents.map(a => <AgentChip key={a.id} a={a} />)}
        {agents.length === 0 && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>seeding defaults…</div>}
      </div>

      {/* Operations Board */}
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.18em', marginBottom: 8 }}>OPERATIONS BOARD</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        {(['on_deck', 'in_process', 'completed'] as const).map(col => (
          <div key={col}
            onDragOver={onColumnDragOver}
            onDrop={onColumnDrop(col)}
            style={{ background: 'rgba(255,255,255,0.015)', borderRadius: 8, padding: 10, minHeight: 120 }}
          >
            <div style={{ fontSize: 10, letterSpacing: '0.2em', marginBottom: 8, color: col === 'on_deck' ? '#a855f7' : col === 'in_process' ? '#ef4444' : '#22c55e' }}>
              {col.replace('_', ' ').toUpperCase()} · {board[col].length}
            </div>
            {board[col].map(t => <OpsCard key={t.id} task={t} onMove={(to) => void moveTask(t.id, to)} />)}
            {board[col].length === 0 && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>—</div>}
          </div>
        ))}
      </div>

      {/* Quick add */}
      <div style={{ marginTop: 16, display: 'flex', gap: 6 }}>
        <input value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void addTask() }}
          placeholder="+ new task…"
          style={{
            flex: 1, background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.9)',
            border: '1px solid rgba(255,255,255,0.1)', padding: '8px 10px',
            borderRadius: 4, fontFamily: 'inherit', fontSize: 11,
          }} />
        <button onClick={() => void addTask()} disabled={!newTaskTitle.trim()} style={{
          padding: '8px 14px', background: '#ffd47a', color: '#000',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 11,
        }}>add</button>
      </div>
    </div>
  )
}

export default WarRoomView
