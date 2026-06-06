import React, { Suspense } from 'react'
import { Routes, Route, Navigate, NavLink, useSearchParams, useNavigate } from 'react-router-dom'
import {
  Brain, MessageSquare, BookOpen, Home, Compass, Search,
  HelpCircle, Settings as SettingsIcon,
  Volume2, VolumeX, Eye as EyeIcon,
  Mountain, SmilePlus, Bot, Layers as LayersIcon, FlaskConical, MapPin, Crown, MicOff,
  Bell, ChevronLeft, ChevronRight, ChevronDown,
  Maximize2, SlidersHorizontal, AudioLines, ArrowUp,
  Sunrise, Lightbulb, Plug, Bug, Terminal,
} from 'lucide-react'
import { UIModeProvider, useUIMode, UI_MODES } from './design/ui-mode.js'
import { Toaster } from './components/Toaster.js'
import { isAudioEnabled, setAudioEnabled, tone } from './design/audio.js'
import { RouteErrorBoundary } from './design/ErrorBoundary.js'
import { GlobalPalette } from './design/GlobalPalette.js'
import { useThemeAndShortcuts } from './hooks/useThemeAndShortcuts.js'
import { useBrainKeepWarm } from './hooks/useBrainKeepWarm.js'
import { useApiLiveness } from './hooks/useApiLiveness.js'
import { useMicPermission } from './hooks/useMicPermission.js'
import { useSelfCheckStatus, type SelfCheckTone } from './hooks/useSelfCheckStatus.js'
import { useBrainUptime } from './hooks/useBrainUptime.js'
import { useWorkspace } from './contexts/WorkspaceContext.js'
import { GlassEqualizerBar } from './components/voice-visuals/GlassEqualizerBar.js'
import { useVoiceVisual } from './contexts/VoiceVisualContext.js'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher.js'

// ─── Eager pages (always-on-startup paths) ──────────────────────────
// Only the routes the operator hits in the first second of any session
// load eagerly. Everything else lazy-loads on demand → ~80% smaller
// initial bundle, vite cold start in <500ms.
import WarRoom              from './pages/WarRoom.js'
import TalkPage             from './pages/TalkPage.js'
import BlueprintPage        from './pages/BlueprintPage.js'
import HomeDashboardPage    from './pages/HomeDashboardPage.js'
import AnomaliesPage        from './pages/AnomaliesPage.js'
import ChatActionsInboxPage from './pages/ChatActionsInboxPage.js'
import PromptLabPage        from './pages/PromptLabPage.js'
import SetupPage            from './pages/SetupPage.js'
import NarrativePage        from './pages/NarrativePage.js'
import MissionPage          from './pages/MissionPage.js'
import HelpPage             from './pages/HelpPage.js'
import Settings             from './pages/Settings.js'
import { Shell }            from './shell/Shell.js'
import { InstallPrompt }    from './pwa/InstallPrompt.js'

// ─── Lazy pages (everything else) ───────────────────────────────────
// `React.lazy` + Vite's `import()` produces a separate JS chunk per
// page. Initial visit pays only for the route the operator opens.
const BrainPage              = React.lazy(() => import('./pages/BrainPage.js'))
const BrainHomePage          = React.lazy(() => import('./pages/BrainHomePage.js'))
const StrategicHomePage      = React.lazy(() => import('./pages/StrategicHomePage.js'))
const IdeasPage              = React.lazy(() => import('./pages/IdeasPage.js'))
const SkillLibraryPage       = React.lazy(() => import('./pages/SkillLibraryPage.js'))
const ConnectorsPage         = React.lazy(() => import('./pages/ConnectorsPage.js'))
const TodayPage              = React.lazy(() => import('./pages/TodayPage.js'))
const MainPage               = React.lazy(() => import('./pages/MainPage.js'))
const WelcomePage            = React.lazy(() => import('./pages/WelcomePage.js'))
const IssuesPage             = React.lazy(() => import('./pages/IssuesPage.js'))
const BrainTasksPage         = React.lazy(() => import('./pages/BrainTasksPage.js'))
const NotificationsPage      = React.lazy(() => import('./pages/NotificationsPage.js'))
const ResearchEnginePage     = React.lazy(() => import('./pages/ResearchEnginePage.js'))
const BusinessDetailPage     = React.lazy(() => import('./pages/BusinessDetailPage.js'))
const BrainErrorsPage        = React.lazy(() => import('./pages/BrainErrorsPage.js'))
const MissionIntelligencePage= React.lazy(() => import('./pages/MissionIntelligencePage.js'))
const ExecutiveWarRoomPage   = React.lazy(() => import('./pages/ExecutiveWarRoomPage.js'))
const CompanyOperationsPage  = React.lazy(() => import('./pages/CompanyOperationsPage.js'))
const ImageStudioPage        = React.lazy(() => import('./pages/ImageStudioPage.js'))
const CapabilityGapPage      = React.lazy(() => import('./pages/CapabilityGapPage.js'))
const CognitionPage          = React.lazy(() => import('./pages/CognitionPage.js'))
const TruthPage              = React.lazy(() => import('./pages/TruthPage.js'))
const EconomyPage            = React.lazy(() => import('./pages/EconomyPage.js'))
const AuditTrailPage         = React.lazy(() => import('./pages/AuditTrailPage.js'))
const RuntimePage            = React.lazy(() => import('./pages/RuntimePage.js'))
const NotificationDriversPage= React.lazy(() => import('./pages/NotificationDriversPage.js'))
const CodeProposalsPage      = React.lazy(() => import('./pages/CodeProposalsPage.js'))
const SearchPage             = React.lazy(() => import('./pages/SearchPage.js'))
const OperatorInputPage      = React.lazy(() => import('./pages/OperatorInputPage.js'))
const SystemMapPage          = React.lazy(() => import('./pages/SystemMapPage.js'))
const CodePatchesPage        = React.lazy(() => import('./pages/CodePatchesPage.js'))
const CommerceWarRoomPage    = React.lazy(() => import('./pages/CommerceWarRoomPage.js'))
const TrustGovernancePage    = React.lazy(() => import('./pages/TrustGovernancePage.js'))
const FabricPage             = React.lazy(() => import('./pages/FabricPage.js'))
const IdentityPage           = React.lazy(() => import('./pages/IdentityPage.js'))
const SimulationPage         = React.lazy(() => import('./pages/SimulationPage.js'))
const VoicePage              = React.lazy(() => import('./pages/VoicePage.js'))
const VoiceAnalyticsPage     = React.lazy(() => import('./pages/VoiceAnalyticsPage.js'))
const CreativeWorkspacePage  = React.lazy(() => import('./pages/CreativeWorkspacePage.js'))
const CreativeBrainPage      = React.lazy(() => import('./pages/CreativeBrainPage.js'))
const WarRoomCreativePage    = React.lazy(() => import('./pages/WarRoomCreativePage.js'))
const StrategicConsolePage   = React.lazy(() => import('./pages/StrategicConsolePage.js'))
const Timeline               = React.lazy(() => import('./pages/Timeline.js'))
// R128 — Mobile PWA chat surface.
const MobileChatPage            = React.lazy(() => import('./pages/MobileChatPage.js'))
// R130 — Mobile sign-in via QR / quick link.
const QuickLinkIssuePage        = React.lazy(() => import('./pages/QuickLinkIssuePage.js'))
const QuickLinkRedeemPage       = React.lazy(() => import('./pages/QuickLinkRedeemPage.js'))

// R125 — Brain showcase (presentation / "show-off" mode).
const BrainShowcasePage         = React.lazy(() => import('./pages/BrainShowcasePage.js'))
const FrontierLedgerPage        = React.lazy(() => import('./pages/FrontierLedgerPage.js'))
const VoiceLibraryPage          = React.lazy(() => import('./pages/VoiceLibraryPage.js'))
const PulseShellPage            = React.lazy(() => import('./pages/PulseShellPage.js'))
const ProposalsPage             = React.lazy(() => import('./pages/ProposalsPage.js'))
import { GlobalCommandBar } from './components/CommandBar.js'

// R124 — Legal & Compliance pages (consume R122 backend routes).
const Soc2ControlsPage          = React.lazy(() => import('./pages/legal/Soc2ControlsPage.js'))
const OperationalReadinessPage  = React.lazy(() => import('./pages/legal/OperationalReadinessPage.js'))
const LockIntegrityPage         = React.lazy(() => import('./pages/legal/LockIntegrityPage.js'))
const RecoveryPlaybooksPage     = React.lazy(() => import('./pages/legal/RecoveryPlaybooksPage.js'))

const GoalsPage              = React.lazy(() => import('./pages/GoalsPage.js'))
const RisksPage              = React.lazy(() => import('./pages/RisksPage.js'))
const AgentsPage             = React.lazy(() => import('./pages/AgentsPage.js'))
const BusinessesPage         = React.lazy(() => import('./pages/BusinessesPage.js'))
const MemoryBrowser          = React.lazy(() => import('./pages/MemoryBrowserPage.js'))
const WorkflowsPage          = React.lazy(() => import('./pages/WorkflowsPage.js'))
const DeadLetterPage         = React.lazy(() => import('./pages/DeadLetterPage.js'))
const ApprovalsPage          = React.lazy(() => import('./pages/ApprovalsPage.js'))
const AnalyticsPage          = React.lazy(() => import('./pages/AnalyticsPage.js'))
const InsightsPage           = React.lazy(() => import('./pages/InsightsPage.js'))
const LearningCenterPage     = React.lazy(() => import('./pages/LearningCenterPage.js'))
const InsightReviewPage      = React.lazy(() => import('./pages/InsightReviewPage.js'))
const PatternExplorerPage    = React.lazy(() => import('./pages/PatternExplorerPage.js'))
const RecommendationQueuePage= React.lazy(() => import('./pages/RecommendationQueuePage.js'))
const MemoryQualityPage      = React.lazy(() => import('./pages/MemoryQualityPage.js'))
const FeedbackHistoryPage    = React.lazy(() => import('./pages/FeedbackHistoryPage.js'))
const AgentControlPage       = React.lazy(() => import('./pages/AgentControlPage.js'))
const RemoteComputePage      = React.lazy(() => import('./pages/RemoteComputePage.js'))
const ProviderSettingsPage   = React.lazy(() => import('./pages/ProviderSettingsPage.js'))
const ProviderHealthPage     = React.lazy(() => import('./pages/ProviderHealthPage.js'))
const CostDashboardPage      = React.lazy(() => import('./pages/CostDashboardPage.js'))
const BudgetDashboardPage    = React.lazy(() => import('./pages/BudgetDashboardPage.js'))
const RemoteUsagePage        = React.lazy(() => import('./pages/RemoteUsagePage.js'))
const ProviderSpendPage      = React.lazy(() => import('./pages/ProviderSpendPage.js'))
const WorkerSpendPage        = React.lazy(() => import('./pages/WorkerSpendPage.js'))
const KillSwitchPage         = React.lazy(() => import('./pages/KillSwitchPage.js'))
const BudgetAlertsPage       = React.lazy(() => import('./pages/BudgetAlertsPage.js'))
const RunawayJobsPage        = React.lazy(() => import('./pages/RunawayJobsPage.js'))
const RuntimeSettingsPage    = React.lazy(() => import('./pages/RuntimeSettingsPage.js'))
const WarRoomRuntimePage     = React.lazy(() => import('./pages/WarRoomRuntimePage.js'))
const LaunchGatePage         = React.lazy(() => import('./pages/LaunchGatePage.js'))
const AuditPage              = React.lazy(() => import('./pages/AuditPage.js'))
const PatchApprovalsPage     = React.lazy(() => import('./pages/PatchApprovalsPage.js'))
const SandboxPage            = React.lazy(() => import('./pages/SandboxPage.js'))
const IncidentsPage          = React.lazy(() => import('./pages/IncidentsPage.js'))
const LearningRuntimePage    = React.lazy(() => import('./pages/LearningRuntimePage.js'))
const OrchestratorPage       = React.lazy(() => import('./pages/OrchestratorPage.js'))
const LaunchLockPage         = React.lazy(() => import('./pages/LaunchLockPage.js'))
const EvolutionPage          = React.lazy(() => import('./pages/EvolutionPage.js'))
const TenantPage             = React.lazy(() => import('./pages/TenantPage.js'))
const SecurityPage           = React.lazy(() => import('./pages/SecurityPage.js'))
const SecurityTeamPage       = React.lazy(() => import('./pages/SecurityTeamPage.js'))
const LaunchTonightPage      = React.lazy(() => import('./pages/LaunchTonightPage.js'))
const AccountPage            = React.lazy(() => import('./pages/AccountPage.js'))
const VoiceProfilesPage      = React.lazy(() => import('./pages/VoiceProfilesPage.js'))
const AgencyPage             = React.lazy(() => import('./pages/AgencyPage.js'))
const SelfCheckPage          = React.lazy(() => import('./pages/SelfCheckPage.js'))
// R146.101 — UI for the experiments + autonomy budget + AI video studio
const AutonomyBudgetPage     = React.lazy(() => import('./pages/AutonomyBudgetPage.js'))
const ExperimentsPage        = React.lazy(() => import('./pages/ExperimentsPage.js'))
const AIVideoStudioPage      = React.lazy(() => import('./pages/AIVideoStudioPage.js'))

// ─── Pinned sidebar items ───────────────────────────────────────────
// Restrained to the surfaces an operator opens daily. Everything else
// lives behind ⌘K. The set mirrors second-brain UIs (Notion, Obsidian,
// Reflect, mem.ai) — pinned-vs-palette is the key UX dichotomy.
const PINNED_ITEMS = [
  // Daily landing — recap + priority + quick links
  { to: '/today',     icon: Sunrise,       label: 'Today' },
  { to: '/brain',     icon: Brain,         label: 'Brain' },
  { to: '/agency',    icon: Crown,         label: 'Agency' },
  { to: '/mission',   icon: Mountain,      label: 'Missions' },
  // Session-built operator surfaces — frequent daily use
  { to: '/ideas',         icon: Lightbulb,  label: 'Ideas' },
  { to: '/issues',        icon: Bug,        label: 'Issues' },
  { to: '/tasks',         icon: Terminal,   label: 'Tasks' },
  { to: '/connectors',    icon: Plug,       label: 'Connectors' },
  // Deeper surfaces
  { to: '/memory',    icon: SmilePlus,     label: 'Memory' },
  { to: '/agents',    icon: Bot,           label: 'Agents' },
  { to: '/timeline',  icon: LayersIcon,    label: 'Timeline' },
  { to: '/simulation', icon: FlaskConical, label: 'Simulations' },
  { to: '/insights',  icon: MapPin,        label: 'Insights' },
] as const

// Prefetch the lazy chunk for a pinned item as soon as the operator
// hovers/focuses its sidebar button. By the time the click registers
// the JS bundle is already in the browser cache.
const PINNED_PREFETCH: Record<string, () => Promise<unknown>> = {
  '/today':      () => import('./pages/TodayPage.js'),
  '/brain':      () => import('./pages/BrainHomePage.js'),
  '/agency':     () => import('./pages/AgencyPage.js'),
  '/mission':    () => import('./pages/MissionPage.js'),
  '/ideas':      () => import('./pages/IdeasPage.js'),
  '/issues':     () => import('./pages/IssuesPage.js'),
  '/tasks':      () => import('./pages/BrainTasksPage.js'),
  '/notifications': () => import('./pages/NotificationsPage.js'),
  '/research':      () => import('./pages/ResearchEnginePage.js'),
  '/connectors': () => import('./pages/ConnectorsPage.js'),
  '/memory':     () => import('./pages/MemoryBrowserPage.js'),
  '/agents':     () => import('./pages/AgentsPage.js'),
  '/timeline':   () => import('./pages/Timeline.js'),
  '/simulation': () => import('./pages/SimulationPage.js'),
  '/insights':   () => import('./pages/InsightsPage.js'),
}

function NovanWordmark({ collapsed }: { collapsed: boolean }) {
  return (
    <a href="/" title="Novan" aria-label="Novan home"
       className="flex items-center gap-2.5 px-3 h-12 hover:opacity-90 transition-opacity">
      <div className="w-6 h-6 flex items-center justify-center shrink-0">
        <img src="/icon.svg" alt="" className="w-6 h-6" />
      </div>
      {!collapsed && (
        <span className="text-[15px] font-medium tracking-[0.18em] text-[var(--text-primary)] select-none">
          NOVAN
        </span>
      )}
    </a>
  )
}

function SidebarItem({
  to, icon: Icon, label, collapsed, prefetch,
}: { to: string; icon: typeof Brain; label: string; collapsed: boolean; prefetch?: () => void }) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      aria-label={label}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 px-3 py-2 mx-2 rounded-lg text-[13px] transition-colors focus-ring ${
          isActive
            ? 'bg-[rgba(139,124,255,0.12)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
            isActive
              ? 'bg-[rgba(139,124,255,0.18)] text-[var(--accent-active)]'
              : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]'
          }`}>
            <Icon className="w-[15px] h-[15px]" strokeWidth={1.6} />
          </span>
          {!collapsed && <span className="truncate">{label}</span>}
          {isActive && !collapsed && (
            <span aria-hidden className="absolute right-3 w-1 h-1 rounded-full bg-[var(--accent-active)]" />
          )}
        </>
      )}
    </NavLink>
  )
}

function OperatorPresence({ collapsed }: { collapsed: boolean }) {
  const { workspaceId } = useWorkspace()
  const selfCheck = useSelfCheckStatus(workspaceId)
  const brain     = useBrainUptime()
  const dotColor  = !brain.alive ? 'var(--accent-critical)' : toneColor(selfCheck.tone)
  const dotTitle  = !brain.alive
    ? 'API unreachable — supervisor will respawn if it crashed'
    : selfCheck.tone === 'unknown'
      ? `Brain alive · ${brain.uptimeHuman} · self-check pending`
      : selfCheck.tone === 'healthy'
        ? `Brain alive · ${brain.uptimeHuman} · self-check healthy`
        : selfCheck.tone === 'slow'
          ? `Brain alive · ${brain.uptimeHuman} · self-check found slow routes`
          : `Brain alive · ${brain.uptimeHuman} · self-check found ${selfCheck.failCount} failure${selfCheck.failCount === 1 ? '' : 's'}`

  return (
    <div className="border-t border-[var(--border)]">
      {/* Brain liveness — uptime + self-check rolled into one chip.
         Click → opens /self-check for the regression detail. */}
      <NavLink to="/self-check"
        title={dotTitle}
        aria-label="Brain liveness · self-check"
        className={({ isActive }) =>
          `flex items-center gap-2 px-4 py-2 transition-colors focus-ring ${
            isActive ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]'
          }`
        }>
        <span aria-hidden className="relative shrink-0 flex items-center justify-center w-3 h-3">
          {brain.alive && (
            <span className="absolute inline-flex h-full w-full rounded-full opacity-50 animate-ping"
              style={{ background: dotColor, animationDuration: '2.4s' }} />
          )}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: dotColor }} />
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider leading-tight">Brain</div>
            <div className="text-[10px] text-[var(--text-secondary)] font-mono leading-tight truncate">
              {brain.alive ? brain.uptimeHuman : 'reconnecting…'}
            </div>
          </div>
        )}
      </NavLink>

      <NavLink to="/account"
        title="Account · templates · theme"
        aria-label="Open account settings"
        className={({ isActive }) =>
          `flex items-center gap-2.5 px-4 py-3 transition-colors focus-ring ${
            isActive
              ? 'bg-[var(--surface-hover)]'
              : 'hover:bg-[var(--surface-hover)]'
          }`
        }>
        <div className="relative shrink-0">
          <div className="w-7 h-7 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-strong)]" />
          <span aria-hidden
            className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-[var(--accent-healthy)] border-2 border-[var(--bg-surface)]"
            title="Online" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[12px] text-[var(--text-primary)] leading-tight truncate">Operator</div>
            <div className="text-[10px] text-[var(--text-muted)] leading-tight truncate">Master Access</div>
          </div>
        )}
      </NavLink>
    </div>
  )
}

function toneColor(tone: SelfCheckTone): string {
  switch (tone) {
    case 'healthy':   return 'var(--accent-healthy)'
    case 'slow':      return 'var(--accent-warning)'
    case 'degraded':  return 'var(--accent-critical)'
    case 'unknown':   return 'var(--text-muted)'
  }
}

function Sidebar({
  collapsed, onToggle,
}: { collapsed: boolean; onToggle: () => void }) {
  const prefetch = (to: string) => () => { PINNED_PREFETCH[to]?.().catch(() => {}) }

  return (
    <nav
      className={`relative shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--bg-surface)] transition-[width] duration-200 ease-out ${
        collapsed ? 'w-[64px]' : 'w-[224px]'
      }`}
      aria-label="Primary"
    >
      <NovanWordmark collapsed={collapsed} />

      {/* Collapse toggle — pinned to the outside edge of the sidebar */}
      <button
        onClick={onToggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="absolute -right-3 top-[18px] w-6 h-6 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-strong)] hover:border-[var(--text-muted)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors z-10 focus-ring"
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>

      {/* Nav */}
      <div className="flex-1 mt-2 flex flex-col gap-0.5 overflow-y-auto">
        {PINNED_ITEMS.map(({ to, icon, label }) => (
          <SidebarItem key={to} to={to} icon={icon} label={label}
            collapsed={collapsed} prefetch={prefetch(to)} />
        ))}
        <div className="mx-4 my-2 h-px bg-[var(--border)]" />
        <SidebarItem to="/account?tab=workspace" icon={SettingsIcon} label="Settings" collapsed={collapsed} />
      </div>

      {/* Operator footer */}
      <OperatorPresence collapsed={collapsed} />
    </nav>
  )
}

export default function App() {
  useThemeAndShortcuts()
  useBrainKeepWarm()
  useApiLiveness()
  return (
    <UIModeProvider>
      <AppShell />
      <Toaster />
    </UIModeProvider>
  )
}

function AppShell() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const screenshotMode = searchParams.get('screenshot') === '1'
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  // Persist sidebar state across reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState<boolean>(() => {
    try { return localStorage.getItem('novan:sidebar') === 'collapsed' } catch { return false }
  })
  React.useEffect(() => {
    try { localStorage.setItem('novan:sidebar', sidebarCollapsed ? 'collapsed' : 'expanded') } catch {}
  }, [sidebarCollapsed])

  // Global keyboard shortcuts — Notion/Obsidian-style.
  //   ⌘K / Ctrl+K — palette
  //   ⌘1..⌘5      — jump to pinned items (Brain / Talk / Narrative / Home / Mission)
  //   Esc         — close palette
  React.useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      // ⌘K or ⌘⇧P → toggle palette (both open the same surface — content
      // + route search). VSCode/Sublime users expect ⌘⇧P as a route palette.
      if (cmd && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); setPaletteOpen(o => !o); return
      }
      if (cmd && e.shiftKey && (e.key === 'p' || e.key === 'P' || e.key === 'P')) {
        e.preventDefault(); setPaletteOpen(o => !o); return
      }
      if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false); return
      }
      if (cmd && !e.shiftKey && !e.altKey && /^[1-5]$/.test(e.key)) {
        // Don't hijack ⌘1..⌘5 when the user is typing in an input/textarea.
        const t = e.target as HTMLElement | null
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
        const idx = Number(e.key) - 1
        const target = PINNED_ITEMS[idx]
        if (target) { e.preventDefault(); navigate(target.to) }
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [paletteOpen, navigate])

  // Hide entire chrome in screenshot mode — just render the route
  if (screenshotMode) {
    return (
      <div className="h-screen overflow-hidden bg-bg">
        <RouteErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <AppRoutes />
          </Suspense>
        </RouteErrorBoundary>
      </div>
    )
  }

  // R124 — opt-in v2 shell. Set `novan.shell.v2 = "1"` in localStorage
  // to render the new minimal folder-tree chrome instead of the legacy
  // Sidebar + AppHeader. Both render the same routes; the only
  // difference is the wrapping chrome. Toggle freely without code change.
  let useV2Shell = false
  try { useV2Shell = typeof window !== 'undefined' && window.localStorage?.getItem('novan.shell.v2') === '1' } catch { /* tolerated */ }

  if (useV2Shell) {
    return (
      <Shell>
        <RouteErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <AppRoutes />
          </Suspense>
        </RouteErrorBoundary>
        <GlobalPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <InstallPrompt />
      </Shell>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)]">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
      />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <AppHeader onOpenPalette={() => setPaletteOpen(true)} />
        {/* Route container — vertical scroll allowed; horizontal locked
           to prevent rogue overflows from creating sideways scrollbars.
           Full-bleed pages (Brain, BrainHome) use their own
           `relative w-full h-full` and fit within the viewport, so they
           never trigger scrolling. Content pages (Narrative, Agency,
           Account, etc.) overflow naturally and scroll here. */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <RouteErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <AppRoutes />
            </Suspense>
          </RouteErrorBoundary>
        </div>
        <AskNovanBar />
      </div>
      <GlobalPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <InstallPrompt />
    </div>
  )
}

function AppHeader({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { mode, setMode } = useUIMode()
  const [focusOpen, setFocusOpen] = React.useState(false)
  const [audioOn, setAudioOn] = React.useState(() => isAudioEnabled())
  const focusRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!focusOpen) return
    const fn = (e: MouseEvent) => {
      if (focusRef.current && !focusRef.current.contains(e.target as Node)) setFocusOpen(false)
    }
    window.addEventListener('mousedown', fn)
    return () => window.removeEventListener('mousedown', fn)
  }, [focusOpen])

  const toggleAudio = () => {
    const next = !audioOn
    setAudioEnabled(next); setAudioOn(next)
    if (next) tone('confirm')
  }

  const currentMode = UI_MODES.find(m => m.id === mode)

  return (
    <header className="h-14 shrink-0 px-5 flex items-center gap-4 border-b border-[var(--border)] bg-[var(--bg-primary)]/80 backdrop-blur-sm">
      {/* Centered focus selector */}
      <div className="flex-1 flex items-center justify-center">
        <div ref={focusRef} className="relative">
          <button onClick={() => setFocusOpen(s => !s)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-[var(--surface-hover)] transition-colors text-[13px] focus-ring">
            <span className="text-[var(--text-muted)]">Active Focus</span>
            <span className="text-[var(--text-primary)] font-medium">{currentMode?.label ?? 'Focus'}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          </button>
          {focusOpen && (
            <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 panel-elevated dropdown-in min-w-[200px] z-dropdown overflow-hidden">
              {UI_MODES.map(m => (
                <button key={m.id} onClick={() => { setMode(m.id); setFocusOpen(false); tone('select') }}
                  className={`w-full text-left px-3 py-2 text-[12px] flex items-center gap-2 hover:bg-[var(--surface-hover)] transition-colors ${
                    mode === m.id ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                  }`}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: m.accent }} />
                  <span className="flex-1">{m.label}</span>
                  {mode === m.id && <span className="text-[10px] text-[var(--accent-active)]">active</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-2">
        {/* Big ⌘K search trigger */}
        <button onClick={onOpenPalette}
          className="hidden sm:flex items-center gap-2.5 h-9 w-[280px] px-3 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-strong)] text-left text-[12px] text-[var(--text-muted)] transition-colors focus-ring">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">Search anything…</span>
          <kbd className="text-[10px] text-[var(--text-muted)] font-mono">⌘K</kbd>
        </button>
        {/* Compact icon trigger on small screens */}
        <button onClick={onOpenPalette}
          aria-label="Search"
          className="sm:hidden w-9 h-9 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-strong)] text-[var(--text-muted)] flex items-center justify-center transition-colors focus-ring">
          <Search className="w-4 h-4" />
        </button>

        {/* Audio toggle */}
        <button onClick={toggleAudio}
          title={audioOn ? 'Sound on' : 'Sound off'}
          aria-label={audioOn ? 'Mute sounds' : 'Unmute sounds'}
          className="w-9 h-9 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-strong)] flex items-center justify-center transition-colors focus-ring">
          {audioOn
            ? <Volume2 className="w-4 h-4 text-[var(--text-secondary)]" />
            : <VolumeX className="w-4 h-4 text-[var(--text-muted)]" />}
        </button>

        {/* Notification bell — placeholder for now (drives notifications page) */}
        <NavLink to="/notifications"
          aria-label="Notifications"
          className="relative w-9 h-9 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-strong)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring">
          <Bell className="w-4 h-4" />
          <span aria-hidden className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[var(--accent-active)]" />
        </NavLink>
      </div>
    </header>
  )
}

function AskNovanBar() {
  const navigate = useNavigate()
  const [input, setInput] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  // Hide on the dedicated Talk page (it has its own composer)
  // and in the brain immersive view if the page wants the full screen.
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (path.startsWith('/talk') || path.startsWith('/voice')) return null

  // Submit: create a Talk conversation and send the user there.
  // The Talk page will pick up the seed message from sessionStorage so
  // the operator's typing isn't lost when navigating.
  const submit = async () => {
    const text = input.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      sessionStorage.setItem('novan:seed-message', text)
      navigate('/talk')
    } finally {
      setInput('')
      setSubmitting(false)
    }
  }

  return (
    <div className="shrink-0 px-5 pb-5 pt-2 bg-[var(--bg-primary)]">
      <div className="max-w-3xl mx-auto flex items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); void submit() }}
          className="flex-1 h-12 px-4 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-strong)] focus-within:border-[var(--accent-active)] flex items-center gap-3 transition-colors">
          <input value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Novan anything…"
            aria-label="Ask Novan anything"
            className="flex-1 bg-transparent outline-none text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
          {/* Glass equalizer — shows live voice activity. Hidden when
             the operator has disabled it in voice-visual settings. */}
          <EqualizerSlot />
          <button type="button"
            onClick={() => navigate('/voice')}
            aria-label="Voice"
            title="Voice"
            className="w-7 h-7 rounded-full hover:bg-[var(--surface-hover)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <AudioLines className="w-3.5 h-3.5" />
          </button>
          <button type="submit"
            disabled={!input.trim() || submitting}
            aria-label="Send"
            className="w-7 h-7 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-[var(--text-primary)] transition-colors">
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        </form>
        {/* Right-side utility buttons (mirrors the reference) */}
        <button title="Display options"
          aria-label="Display options"
          className="w-10 h-10 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-strong)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-ring">
          <SlidersHorizontal className="w-4 h-4" />
        </button>
        <button title="Fullscreen"
          aria-label="Toggle fullscreen"
          onClick={() => {
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
            else document.documentElement.requestFullscreen().catch(() => {})
          }}
          className="w-10 h-10 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-strong)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-ring">
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

function RouteFallback() {
  // Structured skeleton that approximates page chrome (header + a few
  // panels) so the layout doesn't snap when the real route mounts.
  return (
    <div className="p-6 max-w-6xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-3 w-24 rounded bg-[var(--bg-elevated)] mb-3" />
        <div className="h-6 w-64 rounded bg-[var(--bg-elevated)] mb-2" />
        <div className="h-3 w-96 max-w-full rounded bg-[var(--bg-elevated)] opacity-60" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="h-28 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]" />
        <div className="h-28 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]" />
        <div className="h-28 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]" />
        <div className="h-28 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]" />
      </div>
    </div>
  )
}

function AppRoutes() {
  return (
    <>
      <GlobalCommandBar />
        <Routes>
          {/* R146.326 — minimal main page on "/" */}
          <Route path="/"            element={<MainPage />} />
          {/* R146.328 (#4) — onboarding */}
          <Route path="/welcome"     element={<WelcomePage />} />
          <Route path="/today-classic" element={<Navigate to="/today" replace />} />
          <Route path="/today"          element={<TodayPage />} />
          <Route path="/blueprint"      element={<BlueprintPage />} />
          <Route path="/strategic-home" element={<StrategicHomePage />} />
          <Route path="/ideas"          element={<IdeasPage />} />
          <Route path="/skill-library"  element={<SkillLibraryPage />} />
          <Route path="/connectors"     element={<ConnectorsPage />} />
          <Route path="/issues"         element={<IssuesPage />} />
          <Route path="/tasks"          element={<BrainTasksPage />} />
          <Route path="/notifications"  element={<NotificationsPage />} />
          <Route path="/research"       element={<ResearchEnginePage />} />
          <Route path="/businesses/:id" element={<BusinessDetailPage />} />
          <Route path="/brain/errors"   element={<BrainErrorsPage />} />
          <Route path="/mission-intelligence" element={<MissionIntelligencePage />} />
          <Route path="/executive-war-room"   element={<ExecutiveWarRoomPage />} />
          <Route path="/company-operations"   element={<CompanyOperationsPage />} />
          <Route path="/image-studio"         element={<ImageStudioPage />} />
          <Route path="/creative"             element={<CreativeWorkspacePage />} />
          <Route path="/creative/workspace"   element={<CreativeWorkspacePage />} />
          <Route path="/creative/brain"       element={<CreativeBrainPage />} />
          <Route path="/war-room/creative"    element={<WarRoomCreativePage />} />
          <Route path="/strategic"            element={<StrategicConsolePage />} />
          <Route path="/capability-gap"       element={<CapabilityGapPage />} />
          <Route path="/cognition"            element={<CognitionPage />} />
          <Route path="/truth"                element={<TruthPage />} />
          <Route path="/economy"              element={<EconomyPage />} />
          <Route path="/audit-trail"          element={<AuditTrailPage />} />
          <Route path="/runtime"              element={<RuntimePage />} />
          <Route path="/home"                 element={<HomeDashboardPage />} />
          <Route path="/anomalies"            element={<AnomaliesPage />} />
          <Route path="/chat-actions"         element={<ChatActionsInboxPage />} />
          <Route path="/prompts"              element={<PromptLabPage />} />
          <Route path="/setup"                element={<SetupPage />} />
          <Route path="/proposals"            element={<CodeProposalsPage />} />
          <Route path="/notifications"        element={<NotificationDriversPage />} />
          <Route path="/search"               element={<SearchPage />} />
          <Route path="/operator-input"       element={<OperatorInputPage />} />
          <Route path="/system-map"           element={<SystemMapPage />} />
          <Route path="/patches"              element={<CodePatchesPage />} />
          <Route path="/commerce"             element={<CommerceWarRoomPage />} />
          <Route path="/trust-governance"     element={<TrustGovernancePage />} />
          <Route path="/fabric"               element={<FabricPage />} />
          <Route path="/identity"             element={<IdentityPage />} />
          <Route path="/simulation"           element={<SimulationPage />} />
          <Route path="/mission"              element={<MissionPage />} />
          <Route path="/talk"                 element={<TalkPage />} />
          <Route path="/narrative"            element={<NarrativePage />} />
          <Route path="/voice"                element={<VoicePage />} />
          <Route path="/voice/analytics"      element={<VoiceAnalyticsPage />} />
          <Route path="/brain"                element={<BrainHomePage />} />
          <Route path="/brain/graph"          element={<BrainPage />} />
          <Route path="/war-room"    element={<WarRoom />} />
          <Route path="/timeline"    element={<Timeline />} />
          <Route path="/goals"       element={<GoalsPage />} />
          <Route path="/risks"       element={<RisksPage />} />
          <Route path="/agents"         element={<AgentsPage />} />
          <Route path="/agents/control" element={<AgentControlPage />} />
          <Route path="/businesses"  element={<BusinessesPage />} />
          <Route path="/memory"      element={<MemoryBrowser />} />
          <Route path="/workflows"   element={<WorkflowsPage />} />
          <Route path="/dead-letter" element={<DeadLetterPage />} />
          <Route path="/approvals"   element={<ApprovalsPage />} />
          <Route path="/analytics"                element={<AnalyticsPage />} />
          <Route path="/insights"              element={<InsightsPage />} />
          <Route path="/learning"              element={<LearningCenterPage />} />
          <Route path="/learning/insights"     element={<InsightReviewPage />} />
          <Route path="/learning/patterns"     element={<PatternExplorerPage />} />
          <Route path="/learning/recommendations" element={<RecommendationQueuePage />} />
          <Route path="/learning/memory-quality"  element={<MemoryQualityPage />} />
          <Route path="/learning/feedback"     element={<FeedbackHistoryPage />} />
          <Route path="/compute"               element={<RemoteComputePage />} />
          <Route path="/compute/settings"      element={<ProviderSettingsPage />} />
          <Route path="/compute/health"        element={<ProviderHealthPage />} />
          <Route path="/compute/cost"          element={<CostDashboardPage />} />
          <Route path="/governor"              element={<BudgetDashboardPage />} />
          <Route path="/governor/usage"        element={<RemoteUsagePage />} />
          <Route path="/governor/providers"    element={<ProviderSpendPage />} />
          <Route path="/governor/workers"      element={<WorkerSpendPage />} />
          <Route path="/governor/kill-switches" element={<KillSwitchPage />} />
          <Route path="/governor/alerts"       element={<BudgetAlertsPage />} />
          <Route path="/governor/runaway"      element={<RunawayJobsPage />} />
          <Route path="/compute/runtime"         element={<RuntimeSettingsPage />} />
          <Route path="/compute/war-room"          element={<WarRoomRuntimePage />} />
          <Route path="/launch"                    element={<LaunchGatePage />} />
          <Route path="/audit"                     element={<AuditPage />} />
          <Route path="/patch-approvals"           element={<PatchApprovalsPage />} />
          <Route path="/sandbox"                   element={<SandboxPage />} />
          <Route path="/incidents"                 element={<IncidentsPage />} />
          <Route path="/learning-runtime"          element={<LearningRuntimePage />} />
          <Route path="/orchestrator"              element={<OrchestratorPage />} />
          <Route path="/launch-tonight"            element={<LaunchTonightPage />} />
          <Route path="/launch-lock"               element={<LaunchLockPage />} />
          <Route path="/evolution"                 element={<EvolutionPage />} />
          <Route path="/tenant"                    element={<TenantPage />} />
          <Route path="/security"                  element={<SecurityPage />} />
          <Route path="/security-team"             element={<SecurityTeamPage />} />
          <Route path="/help"                      element={<HelpPage />} />
          <Route path="/settings"              element={<Settings />} />
          <Route path="/account"               element={<AccountPage />} />
          <Route path="/voice-profiles"        element={<VoiceProfilesPage />} />
          <Route path="/agency"                element={<AgencyPage />} />
          {/* R146.101 — operator surfaces for the new ops shipped this week */}
          <Route path="/autonomy-budgets"      element={<AutonomyBudgetPage />} />
          <Route path="/experiments"           element={<ExperimentsPage />} />
          <Route path="/ai-video-studio"       element={<AIVideoStudioPage />} />
          <Route path="/self-check"            element={<SelfCheckPage />} />
          {/* R128 — Mobile PWA chat (start_url for installed PWA) */}
          <Route path="/m/chat"                      element={<MobileChatPage />} />
          {/* R130 — Quick-link mobile sign-in */}
          <Route path="/m/sign-in"                   element={<QuickLinkIssuePage />} />
          <Route path="/m/auth"                      element={<QuickLinkRedeemPage />} />
          {/* R125 — Brain showcase / presentation mode */}
          <Route path="/brain/showcase"              element={<BrainShowcasePage />} />
          {/* R146.108 — Frontier ledger / capability catalog UI */}
          <Route path="/brain/frontier"              element={<FrontierLedgerPage />} />
          {/* R146.110 — Free voice library + previews */}
          <Route path="/voice/library"               element={<VoiceLibraryPage />} />
          {/* R146.114 — Pulse-style shell (kzzy47/Pulse template) */}
          <Route path="/pulse"                       element={<PulseShellPage />} />
          <Route path="/proposals"                   element={<ProposalsPage />} />
          <Route path="/brain/pulse"                 element={<PulseShellPage />} />
          {/* R124 — Legal & Compliance (consumes R122 backend routes) */}
          <Route path="/legal/soc2"                  element={<Soc2ControlsPage />} />
          <Route path="/legal/operational-readiness" element={<OperationalReadinessPage />} />
          <Route path="/legal/lock-integrity"        element={<LockIntegrityPage />} />
          <Route path="/legal/recovery-playbooks"    element={<RecoveryPlaybooksPage />} />
          <Route path="*"          element={<Navigate to="/war-room" replace />} />
        </Routes>
    </>
  )
}

// Reads the voice-visual setting so the equalizer is hidden when the
// operator disables it. Kept here (instead of inside AskNovanBar) so a
// quick toggle doesn't remount the whole bar. Pairs with a tiny mic-
// state indicator: muted-mic icon when the browser blocked / never
// granted mic access — so the operator knows listening won't work
// even if the equalizer animates from TTS playback.
function EqualizerSlot() {
  const { settings, audio } = useVoiceVisual()
  const mic = useMicPermission()
  if (!settings.equalizerEnabled) return null
  const micBlocked = mic === 'denied' || mic === 'unsupported'
  const showMic    = !audio.isMuted && (micBlocked || mic === 'prompt')
  return (
    <>
      {showMic && (
        <button
          type="button"
          onClick={async () => {
            // Trying to open the mic when state is 'prompt' triggers
            // the browser's permission dialog. We don't keep the
            // stream — this is a one-shot prompt.
            if (mic !== 'prompt') return
            try {
              const s = await navigator.mediaDevices.getUserMedia({ audio: true })
              s.getTracks().forEach(t => t.stop())
            } catch { /* user declined, state will flip to denied */ }
          }}
          title={
            mic === 'denied'      ? 'Microphone blocked — listening unavailable. Re-enable in browser site settings.'
            : mic === 'unsupported' ? 'Microphone not available in this browser'
            : 'Click to grant microphone access for voice listening'
          }
          aria-label="Microphone permission state"
          className="w-6 h-6 rounded-full flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors focus-ring"
        >
          <MicOff className={`w-3 h-3 ${mic === 'denied' ? 'text-[var(--accent-critical)]' : ''}`} />
        </button>
      )}
      <GlassEqualizerBar width={72} height={16} className="opacity-90 mx-1" />
    </>
  )
}
