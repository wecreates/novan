/**
 * AccountPage — operator profile, brain template picker, theme editor.
 *
 * Three sections:
 *   1. Operator identity card (matches the sidebar footer surface)
 *   2. Brain template gallery — 8 server-side layouts; selected one
 *      persists to localStorage and the Brain page reads it via the
 *      `?template=` query string.
 *   3. Color graph — per-token color pickers that override CSS custom
 *      properties. Saved to localStorage; applied on page load via
 *      initTheme() in main.tsx.
 *
 * No server round-trip for templates or colors yet — keeping this
 * client-only avoids a migration. When workspace-level persistence is
 * needed, swap localStorage for an /api/v1/operator/preferences call.
 */
import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import {
  UserCircle2, Brain, Palette, ChevronRight, RotateCcw, Check, Mic,
  Sparkles, Network, Boxes, Grid3x3, Atom, Orbit, Layers as LayersIcon,
  Settings as SettingsIcon, Plug, Key, Webhook as WebhookIcon, CalendarClock,
  Database, Activity, Cpu, Globe, Shield, Bell,
} from 'lucide-react'
import { PageHeader } from '../components/PageHeader.js'
import {
  THEME_TOKENS, loadOverrides, saveOverrides, applyOverrides,
  type ThemeOverrides,
} from '../design/theme.js'
// Lifted from Settings.tsx — render the live stateful CRUD UIs inline.
import { ApiTokensSection, WebhooksSection, SchedulerSection } from './Settings.js'

// ─── Brain templates (mirrors server BrainTemplate union) ────────────

interface TemplateDef {
  id:        string
  label:     string
  tagline:   string
  icon:      typeof Brain
  /** Hint visualization rendered next to the name (pure SVG, no R3F). */
  preview:   (active: boolean) => React.ReactNode
}

function SvgPreview({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {children}
    </svg>
  )
}

const TEMPLATES: TemplateDef[] = [
  {
    id: 'neural', label: 'Neural',
    tagline: 'Three horizontal layers — like a deep network',
    icon: Brain,
    preview: (active) => (
      <SvgPreview>
        {[20, 50, 80].map(y => Array.from({ length: 6 }, (_, i) => (
          <circle key={`${y}-${i}`} cx={12 + i * 15} cy={y} r={2.4}
            fill={active ? 'var(--accent-active)' : 'currentColor'} />
        )))}
        {[20, 50, 80].map((y, li) => Array.from({ length: 5 }, (_, i) => (
          <line key={`l-${y}-${i}`} x1={12 + i * 15} y1={y} x2={27 + i * 15} y2={[20, 50, 80][(li + 1) % 3] ?? y}
            stroke="currentColor" strokeWidth={0.4} opacity={0.4} />
        )))}
      </SvgPreview>
    ),
  },
  {
    id: 'solar', label: 'Solar',
    tagline: 'Concentric rings on a flat plane',
    icon: Orbit,
    preview: (active) => (
      <SvgPreview>
        {[28, 38, 48].map(r => (
          <circle key={r} cx={50} cy={50} r={r} fill="none" stroke="currentColor" strokeWidth={0.4} opacity={0.4} />
        ))}
        {[28, 38, 48].flatMap(r => Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2
          return <circle key={`${r}-${i}`} cx={50 + Math.cos(a) * r} cy={50 + Math.sin(a) * r} r={1.8}
            fill={active ? 'var(--accent-active)' : 'currentColor'} />
        }))}
      </SvgPreview>
    ),
  },
  {
    id: 'command_core', label: 'Command Core',
    tagline: 'Cubic grid for tight operational visibility',
    icon: Boxes,
    preview: (active) => (
      <SvgPreview>
        {Array.from({ length: 4 }, (_, gx) => Array.from({ length: 4 }, (_, gy) => (
          <rect key={`${gx}-${gy}`} x={18 + gx * 18} y={18 + gy * 18} width={12} height={12}
            fill="none" stroke={active && gx === 1 && gy === 1 ? 'var(--accent-active)' : 'currentColor'}
            strokeWidth={0.6} opacity={gx === 1 && gy === 1 ? 0.9 : 0.5} />
        )))}
      </SvgPreview>
    ),
  },
  {
    id: 'galaxy', label: 'Galaxy',
    tagline: 'Spiral arm — distant, organic',
    icon: Sparkles,
    preview: (active) => (
      <SvgPreview>
        {Array.from({ length: 36 }, (_, i) => {
          const t = i / 36
          const a = t * Math.PI * 5
          const r = 6 + t * 38
          return <circle key={i} cx={50 + Math.cos(a) * r} cy={50 + Math.sin(a) * r} r={1.4 + t * 1.2}
            fill={active ? 'var(--accent-active)' : 'currentColor'} opacity={0.4 + t * 0.6} />
        })}
      </SvgPreview>
    ),
  },
  {
    id: 'runtime_mesh', label: 'Runtime Mesh',
    tagline: 'Sphere of nodes for distributed runtime',
    icon: Network,
    preview: (active) => (
      <SvgPreview>
        <circle cx={50} cy={50} r={36} fill="none" stroke="currentColor" strokeWidth={0.4} opacity={0.3} />
        {Array.from({ length: 24 }, (_, i) => {
          const y = 1 - (i / 23) * 2
          const r = Math.sqrt(1 - y * y) * 32
          const theta = (i * 2 * Math.PI) / 1.618
          return <circle key={i} cx={50 + Math.cos(theta) * r} cy={50 + y * 32} r={1.8}
            fill={active ? 'var(--accent-active)' : 'currentColor'} />
        })}
      </SvgPreview>
    ),
  },
  {
    id: 'agent_swarm', label: 'Agent Swarm',
    tagline: 'Equatorial ring + inner satellites',
    icon: Atom,
    preview: (active) => (
      <SvgPreview>
        <circle cx={50} cy={50} r={32} fill="none" stroke="currentColor" strokeWidth={0.4} opacity={0.4} />
        <circle cx={50} cy={50} r={18} fill="none" stroke="currentColor" strokeWidth={0.4} opacity={0.4} />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2
          return <circle key={i} cx={50 + Math.cos(a) * 32} cy={50 + Math.sin(a) * 32} r={2.2}
            fill={active ? 'var(--accent-active)' : 'currentColor'} />
        })}
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2
          return <circle key={`i-${i}`} cx={50 + Math.cos(a) * 18} cy={50 + Math.sin(a) * 18} r={1.8}
            fill={active ? 'var(--accent-active)' : 'currentColor'} opacity={0.7} />
        })}
      </SvgPreview>
    ),
  },
  {
    id: 'security_grid', label: 'Security Grid',
    tagline: 'Square lattice — auditable, ordered',
    icon: Grid3x3,
    preview: (active) => (
      <SvgPreview>
        {Array.from({ length: 5 }, (_, gx) => Array.from({ length: 5 }, (_, gy) => (
          <circle key={`${gx}-${gy}`} cx={18 + gx * 16} cy={18 + gy * 16} r={2}
            fill={active ? 'var(--accent-active)' : 'currentColor'} />
        )))}
        {Array.from({ length: 5 }, (_, i) => (
          <line key={`h-${i}`} x1={18} y1={18 + i * 16} x2={82} y2={18 + i * 16} stroke="currentColor" strokeWidth={0.3} opacity={0.3} />
        ))}
        {Array.from({ length: 5 }, (_, i) => (
          <line key={`v-${i}`} x1={18 + i * 16} y1={18} x2={18 + i * 16} y2={82} stroke="currentColor" strokeWidth={0.3} opacity={0.3} />
        ))}
      </SvgPreview>
    ),
  },
  {
    id: 'mission_orbit', label: 'Mission Orbit',
    tagline: 'Two inclined orbits — strategy vs execution',
    icon: LayersIcon,
    preview: (active) => (
      <SvgPreview>
        <ellipse cx={50} cy={50} rx={36} ry={14} fill="none" stroke="currentColor" strokeWidth={0.4} opacity={0.5} transform="rotate(20 50 50)" />
        <ellipse cx={50} cy={50} rx={36} ry={14} fill="none" stroke="currentColor" strokeWidth={0.4} opacity={0.5} transform="rotate(-20 50 50)" />
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2
          return <circle key={i} cx={50 + Math.cos(a) * 36 * Math.cos(0.35)} cy={50 + Math.sin(a) * 14}
            r={2} fill={active ? 'var(--accent-active)' : 'currentColor'} />
        })}
      </SvgPreview>
    ),
  },
]

const TEMPLATE_STORAGE_KEY = 'novan:brain-template'

function loadTemplate(): string {
  try { return localStorage.getItem(TEMPLATE_STORAGE_KEY) ?? 'neural' } catch { return 'neural' }
}
function saveTemplate(id: string): void {
  try { localStorage.setItem(TEMPLATE_STORAGE_KEY, id) } catch {}
}

// ─── Page ────────────────────────────────────────────────────────────

export default function AccountPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tabFromUrl = params.get('tab') as 'templates' | 'theme' | 'workspace' | 'integrations' | 'notifications' | null
  const [selectedTemplate, setSelectedTemplate] = useState<string>(loadTemplate)
  const [overrides, setOverrides] = useState<ThemeOverrides>(() => loadOverrides())
  const [openSection, setOpenSection] = useState<'templates' | 'theme' | 'workspace' | 'integrations' | 'notifications'>(
    tabFromUrl ?? 'templates',
  )

  // Keep ?tab=... in sync with state — so deep links work + browser back/forward
  useEffect(() => {
    if (tabFromUrl && tabFromUrl !== openSection) setOpenSection(tabFromUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabFromUrl])
  const setTab = (t: typeof openSection) => {
    setOpenSection(t)
    setParams({ tab: t }, { replace: true })
  }

  const pickTemplate = (id: string) => {
    setSelectedTemplate(id)
    saveTemplate(id)
  }

  const setColor = (token: string, value: string) => {
    const next = { ...overrides, [token]: value }
    setOverrides(next)
    saveOverrides(next)
    applyOverrides(next)
  }

  const resetColor = (token: string) => {
    const next: ThemeOverrides = { ...overrides }
    delete next[token]
    setOverrides(next)
    saveOverrides(next)
    applyOverrides(next)
  }

  const resetAll = () => {
    setOverrides({})
    saveOverrides({})
    applyOverrides({})
  }

  // Group tokens by section
  const grouped = useMemo(() => {
    const out = new Map<string, typeof THEME_TOKENS>()
    for (const t of THEME_TOKENS) {
      const arr = out.get(t.group) ?? []
      arr.push(t)
      out.set(t.group, arr)
    }
    return out
  }, [])

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        breadcrumb="Operator"
        title="Account"
        subtitle="Identity, brain template, theme, and workspace settings. Changes save automatically."
      />

      {/* Identity card */}
      <section className="panel p-5 mb-6 flex items-center gap-4">
        <div className="relative">
          <div className="w-14 h-14 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-strong)] flex items-center justify-center">
            <UserCircle2 className="w-7 h-7 text-[var(--text-muted)]" />
          </div>
          <span aria-hidden
            className="absolute -right-0.5 -bottom-0.5 w-3.5 h-3.5 rounded-full bg-[var(--accent-healthy)] border-2 border-[var(--bg-surface)]" />
        </div>
        <div className="flex-1">
          <div className="text-[15px] font-medium text-[var(--text-primary)]">Operator</div>
          <div className="text-xs text-[var(--text-muted)]">Master access · single-operator workspace</div>
        </div>
      </section>

      {/* Section tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-[var(--border)] overflow-x-auto">
        <SectionTab active={openSection === 'templates'} onClick={() => setTab('templates')}
          icon={<Brain className="w-3.5 h-3.5" />} label="Brain" />
        <SectionTab active={openSection === 'theme'} onClick={() => setTab('theme')}
          icon={<Palette className="w-3.5 h-3.5" />} label="Theme" />
        <SectionTab active={openSection === 'workspace'} onClick={() => setTab('workspace')}
          icon={<SettingsIcon className="w-3.5 h-3.5" />} label="Workspace" />
        <SectionTab active={openSection === 'integrations'} onClick={() => setTab('integrations')}
          icon={<Plug className="w-3.5 h-3.5" />} label="Integrations" />
        <SectionTab active={openSection === 'notifications'} onClick={() => setTab('notifications')}
          icon={<Bell className="w-3.5 h-3.5" />} label="Notifications" />
      </div>

      {/* Templates */}
      {openSection === 'templates' && (
        <section>
          <p className="text-xs text-[var(--text-muted)] mb-4">
            Pick how the Brain renders system clusters. The selection is used the next time you open <span className="text-[var(--text-secondary)]">Brain</span>.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {TEMPLATES.map(t => {
              const Icon = t.icon
              const active = t.id === selectedTemplate
              return (
                <button key={t.id}
                  onClick={() => pickTemplate(t.id)}
                  className={`group relative panel text-left p-3 transition-all hover:border-[var(--border-strong)] focus-ring ${
                    active ? 'ring-1 ring-[var(--accent-active)] border-[var(--accent-active)]' : ''
                  }`}>
                  <div className={`aspect-square mb-3 rounded-md flex items-center justify-center bg-[var(--bg-elevated)] ${
                    active ? 'text-[var(--accent-active)]' : 'text-[var(--text-muted)]'
                  }`}>
                    {t.preview(active)}
                  </div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.6} />
                    <span className="text-[13px] font-medium text-[var(--text-primary)]">{t.label}</span>
                    {active && <Check className="w-3 h-3 text-[var(--accent-active)] ml-auto" />}
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)] leading-snug">{t.tagline}</div>
                </button>
              )
            })}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span>Saved as default for the Brain page.</span>
            <button onClick={() => navigate(`/brain?template=${selectedTemplate}`)}
              className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring">
              Open in Brain <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </section>
      )}

      {/* Theme */}
      {openSection === 'theme' && (
        <section>
          <div className="flex items-start justify-between gap-3 mb-4">
            <p className="text-xs text-[var(--text-muted)] flex-1">
              Override the platform's color tokens. Changes apply live to every page and persist across reloads.
            </p>
            {Object.keys(overrides).length > 0 && (
              <button onClick={resetAll}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--border-strong)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring">
                <RotateCcw className="w-3 h-3" /> Reset all
              </button>
            )}
          </div>

          {Array.from(grouped.entries()).map(([group, tokens]) => (
            <div key={group} className="mb-5">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">{group}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {tokens.map(t => (
                  <ColorRow key={t.id}
                    token={t}
                    value={overrides[t.id] ?? t.default}
                    overridden={overrides[t.id] !== undefined}
                    onChange={(v) => setColor(t.id, v)}
                    onReset={() => resetColor(t.id)} />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Workspace tab — feature flags + retention + workspace identity */}
      {openSection === 'workspace' && (
        <section className="space-y-5">
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">Workspace identity</h3>
            <div className="panel p-4 text-[12px]">
              <div className="grid grid-cols-2 gap-3 text-[var(--text-secondary)]">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Workspace ID</div>
                  <div className="font-mono">default</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Plan</div>
                  <div>Free (single-operator)</div>
                </div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">Feature flags</h3>
            <div className="space-y-1">
              {WORKSPACE_FEATURES.map(f => (
                <div key={f.label} className="panel px-3 py-2 flex items-center gap-3">
                  <span className={`w-1.5 h-1.5 rounded-full ${f.enabled ? 'bg-[var(--accent-healthy)]' : 'bg-[var(--text-muted)]'}`} />
                  <div className="flex-1">
                    <div className="text-[12px] text-[var(--text-primary)]">{f.label}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">{f.desc}</div>
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{f.enabled ? 'on' : 'off'}</span>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-[var(--text-muted)] mt-2">
              Feature flags are read-only here. Toggle via <Link to="/settings" className="underline">advanced settings</Link>.
            </div>
          </div>

          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">Data retention</h3>
            <div className="grid grid-cols-2 gap-2">
              {DATA_RETENTION.map(r => {
                const Icon = r.icon
                return (
                  <div key={r.label} className="panel p-3 flex items-center gap-3">
                    <Icon className="w-4 h-4 text-[var(--text-muted)]" />
                    <div className="flex-1">
                      <div className="text-[12px] text-[var(--text-primary)]">{r.label}</div>
                      <div className="text-[10px] text-[var(--text-muted)]">{r.days} days</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* Integrations tab — live CRUD for tokens/webhooks/scheduler + cards for richer surfaces */}
      {openSection === 'integrations' && (
        <section className="space-y-6">
          {/* Cards for surfaces that have their own dedicated page */}
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">External services</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <IntegrationLink to="/connectors"
                icon={<Plug className="w-4 h-4" />}
                label="Connectors"
                desc="GitHub, Slack, Linear, OpenAI, and 27 more." />
              <IntegrationLink to="/voice-profiles"
                icon={<Mic className="w-4 h-4" />}
                label="Voice profiles"
                desc="Voice personality, wake phrase, provider routing." />
              <IntegrationLink to="/skill-library"
                icon={<Sparkles className="w-4 h-4" />}
                label="Skill library"
                desc="338 instructional skills. Search + apply." />
            </div>
          </div>

          {/* Live CRUD: API tokens */}
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
              <Key className="w-3 h-3" /> API tokens
            </h3>
            <ApiTokensSection />
          </div>

          {/* Live CRUD: Webhooks */}
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
              <WebhookIcon className="w-3 h-3" /> Webhooks
            </h3>
            <WebhooksSection />
          </div>

          {/* Live CRUD: Scheduler */}
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
              <CalendarClock className="w-3 h-3" /> Scheduled triggers
            </h3>
            <SchedulerSection />
          </div>
        </section>
      )}

      {/* Notifications tab — placeholder for now; channels live in /notifications */}
      {openSection === 'notifications' && (
        <section>
          <p className="text-[11px] text-[var(--text-muted)] mb-4">
            Notification routing — which channels get which event severities.
          </p>
          <div className="panel p-4 text-[12px] text-[var(--text-secondary)] space-y-2">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-[var(--text-muted)]" />
              <span>Detailed configuration lives at <Link to="/notifications" className="underline">Notification drivers</Link>.</span>
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              Configured channels appear there: webhook, Pushover, Slack, Discord (when env vars are set).
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

// ─── Sub-data for Workspace tab (mirrors Settings.tsx; kept local to avoid coupling) ──
const WORKSPACE_FEATURES = [
  { label: 'Real-time SSE',          enabled: true,  desc: 'Server-sent events for live updates' },
  { label: 'Memory Vector Search',   enabled: true,  desc: 'Semantic similarity over memories' },
  { label: 'Browser Automation',     enabled: true,  desc: 'Headless browser sessions' },
  { label: 'Executive Briefings',    enabled: true,  desc: 'AI-generated operational summaries' },
  { label: 'Opportunity Tracking',   enabled: true,  desc: 'Automated opportunity identification' },
]

const DATA_RETENTION = [
  { label: 'Events',           days: 30,  icon: Activity },
  { label: 'Memory',           days: 90,  icon: Database },
  { label: 'Workflow Runs',    days: 180, icon: Cpu },
  { label: 'Browser Sessions', days: 7,   icon: Globe },
]

function IntegrationLink({ to, icon, label, desc }: {
  to: string; icon: React.ReactNode; label: string; desc: string
}) {
  return (
    <Link to={to}
      className="panel p-4 flex items-start gap-3 hover:bg-[var(--surface-hover)] focus-ring group">
      <div className="text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-[var(--text-primary)] mb-0.5">{label}</div>
        <div className="text-[11px] text-[var(--text-muted)] leading-snug">{desc}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
    </Link>
  )
}

function SectionTab({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string
}) {
  return (
    <button onClick={onClick}
      className={`relative px-3 py-2 text-[13px] flex items-center gap-2 transition-colors focus-ring ${
        active ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
      }`}>
      {icon}
      {label}
      {active && (
        <span aria-hidden className="absolute -bottom-px left-2 right-2 h-px bg-[var(--accent-active)]" />
      )}
    </button>
  )
}

function ColorRow({ token, value, overridden, onChange, onReset }: {
  token: typeof THEME_TOKENS[number]
  value: string
  overridden: boolean
  onChange: (v: string) => void
  onReset: () => void
}) {
  // <input type="color"> doesn't accept rgba — for the border tokens
  // (which carry alpha) we render a hex picker that strips alpha.
  const colorValue = useMemo(() => hexFromAny(value), [value])

  return (
    <div className="panel p-3 flex items-center gap-3">
      <label className="relative shrink-0 cursor-pointer">
        <div className="w-9 h-9 rounded-md border border-[var(--border-strong)]"
          style={{ background: value }} />
        <input type="color" value={colorValue}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
      </label>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-[var(--text-primary)] truncate">{token.label}</span>
          <span className="text-[10px] font-mono text-[var(--text-muted)] truncate">--{token.id}</span>
        </div>
        <div className="text-[11px] text-[var(--text-muted)] truncate">{token.hint}</div>
      </div>
      {overridden && (
        <button onClick={onReset} title="Reset to default" aria-label="Reset this color"
          className="shrink-0 w-7 h-7 rounded-md border border-[var(--border)] hover:border-[var(--border-strong)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-ring">
          <RotateCcw className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

/** Coerce any CSS color string to a #rrggbb for <input type="color">. */
function hexFromAny(input: string): string {
  if (/^#[0-9a-f]{6}$/i.test(input)) return input
  if (/^#[0-9a-f]{3}$/i.test(input)) {
    return '#' + input.slice(1).split('').map(c => c + c).join('')
  }
  // Fallback for rgba(...) / unknown — sample DOM for the resolved color
  if (typeof document === 'undefined') return '#000000'
  const probe = document.createElement('div')
  probe.style.color = input
  document.body.appendChild(probe)
  const rgb = getComputedStyle(probe).color
  document.body.removeChild(probe)
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb)
  if (!m) return '#000000'
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}
