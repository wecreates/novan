/**
 * BrainTasksPage — directive console for the brain.
 *
 * Operator types natural-language tasks, sees the planned operations,
 * watches results stream back. Companion to the autonomous loops:
 * those run on a cron, this is the on-demand interface.
 */
import { useEffect, useState } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { BrainTaskBar } from '../components/BrainTaskBar.js'
import { Terminal, Zap, ShieldCheck, Globe, Monitor, Database, Search, AlertTriangle } from 'lucide-react'
import { API_BASE as BASE } from '../api.js'

interface Op {
  op:          string
  description: string
  risk:        'low' | 'medium' | 'high' | 'critical'
}

const CATEGORY_ICONS: Record<string, typeof Terminal> = {
  browser:   Globe,
  desktop:   Monitor,
  db:        Database,
  issue:     AlertTriangle,
  proposal:  Zap,
  safety:    ShieldCheck,
  code:      Search,
  platform:  Terminal,
  providers: ShieldCheck,
  mind:      Zap,
  web:       Globe,
}

const RISK_COLOR: Record<Op['risk'], string> = {
  low:      'text-[var(--success)]',
  medium:   'text-[var(--info)]',
  high:     'text-[var(--warning)]',
  critical: 'text-[var(--error)]',
}

const EXAMPLE_TASKS = [
  'show recent issues',
  'check the safety flags',
  'run a health check on all endpoints',
  'find any bugs and fix them automatically',
  'search the codebase for TODO comments',
  'list the 5 most recent reasoning chains',
  'open example.com and tell me the h1',
  'validate all the AI providers',
]

export default function BrainTasksPage() {
  const { workspaceId } = useWorkspace()
  const [ops, setOps] = useState<Op[]>([])

  useEffect(() => {
    void fetch(`${BASE}/api/v1/brain/task/operations`)
      .then(r => r.json())
      .then((j: { data: Op[] }) => setOps(j.data))
      .catch(() => null)
  }, [])

  const grouped = ops.reduce<Record<string, Op[]>>((acc, o) => {
    const cat = o.op.split('.')[0] ?? 'other'
    acc[cat] = acc[cat] ?? []
    acc[cat].push(o)
    return acc
  }, {})

  return (
    <div className="min-h-screen bg-bg text-primary p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Terminal className="w-6 h-6 text-[var(--accent)]" /> Brain Tasks
        </h1>
        <p className="text-sm text-muted mt-1">
          Tell the brain what to do in plain English. It plans, you approve high-risk steps, it executes.
          Financial actions are hard-blocked.
        </p>
      </header>

      <section className="mb-6">
        <BrainTaskBar workspaceId={workspaceId} />
      </section>

      {/* Quick examples */}
      <section className="mb-6">
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Try one</h2>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_TASKS.map(t => (
            <ExamplePill key={t} text={t} />
          ))}
        </div>
      </section>

      {/* Capability catalog */}
      <section>
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
          {ops.length} operations available
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cat, list]) => {
            const Icon = CATEGORY_ICONS[cat] ?? Terminal
            return (
              <div key={cat} className="border border-[var(--border)] rounded-lg p-3 bg-[var(--surface)]">
                <div className="flex items-center gap-2 mb-2 text-sm font-medium">
                  <Icon className="w-4 h-4 text-[var(--accent)]" />
                  <span className="capitalize">{cat}</span>
                  <span className="text-[10px] text-faint ml-auto">{list.length}</span>
                </div>
                <ul className="text-xs space-y-1">
                  {list.map(o => (
                    <li key={o.op} className="flex items-start gap-2">
                      <span className={`text-[10px] uppercase tracking-wider mt-0.5 ${RISK_COLOR[o.risk]}`}>{o.risk}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono">{o.op}</div>
                        <div className="text-muted text-[11px]">{o.description}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function ExamplePill({ text }: { text: string }) {
  function copyToBar() {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
    }
  }
  return (
    <button onClick={copyToBar} className="px-2.5 py-1 text-xs rounded-full bg-[var(--surface-elev)] border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
      {text}
    </button>
  )
}
