import React, { Suspense } from 'react'
import { Routes, Route, Navigate, NavLink, useSearchParams } from 'react-router-dom'
import {
  Activity, Clock, Settings as SettingsIcon,
  Target, ShieldAlert, Bot, Building2, Brain,
  GitBranch, AlertOctagon, CheckSquare, BarChart3, Lightbulb, GraduationCap, Cpu,
  Shield, ScanSearch, ShieldCheck, Terminal, Siren, GitMerge, Lock, BookOpen, TrendingUp, Rocket, Coins, Heart, Home, Code2, Bell, Search, Plus, Map as MapIcon, Hammer, ShoppingBag, Network, Wand2, FlaskConical, Compass, MessageSquare,
  Volume2, VolumeX, Eye as EyeIcon,
} from 'lucide-react'
import { UIModeProvider, useUIMode, UI_MODES } from './design/ui-mode.js'
import { isAudioEnabled, setAudioEnabled, tone } from './design/audio.js'
import { RouteErrorBoundary } from './design/ErrorBoundary.js'
import { GlobalPalette } from './design/GlobalPalette.js'
import WarRoom                  from './pages/WarRoom.js'
import StrategicHomePage        from './pages/StrategicHomePage.js'
import { useThemeAndShortcuts } from './hooks/useThemeAndShortcuts.js'
import MissionIntelligencePage  from './pages/MissionIntelligencePage.js'
import ExecutiveWarRoomPage     from './pages/ExecutiveWarRoomPage.js'
import CompanyOperationsPage    from './pages/CompanyOperationsPage.js'
import ImageStudioPage          from './pages/ImageStudioPage.js'
import CapabilityGapPage        from './pages/CapabilityGapPage.js'
import CognitionPage            from './pages/CognitionPage.js'
import TruthPage                from './pages/TruthPage.js'
import EconomyPage              from './pages/EconomyPage.js'
import AuditTrailPage           from './pages/AuditTrailPage.js'
import RuntimePage              from './pages/RuntimePage.js'
import HomeDashboardPage        from './pages/HomeDashboardPage.js'
import NotificationDriversPage  from './pages/NotificationDriversPage.js'
import CodeProposalsPage        from './pages/CodeProposalsPage.js'
import SearchPage               from './pages/SearchPage.js'
import OperatorInputPage        from './pages/OperatorInputPage.js'
import SystemMapPage            from './pages/SystemMapPage.js'
import CodePatchesPage          from './pages/CodePatchesPage.js'
import CommerceWarRoomPage      from './pages/CommerceWarRoomPage.js'
import TrustGovernancePage      from './pages/TrustGovernancePage.js'
import FabricPage               from './pages/FabricPage.js'
import IdentityPage             from './pages/IdentityPage.js'
import SimulationPage           from './pages/SimulationPage.js'
import MissionPage              from './pages/MissionPage.js'
import TalkPage                 from './pages/TalkPage.js'
// BrainPage is lazy-loaded — three.js + drei is ~1.7MB; only paid when /brain is opened
const BrainPage = React.lazy(() => import('./pages/BrainPage.js'))
import Timeline                 from './pages/Timeline.js'
import Settings                 from './pages/Settings.js'
import GoalsPage                from './pages/GoalsPage.js'
import RisksPage                from './pages/RisksPage.js'
import AgentsPage               from './pages/AgentsPage.js'
import BusinessesPage           from './pages/BusinessesPage.js'
import MemoryBrowser            from './pages/MemoryBrowserPage.js'
import WorkflowsPage            from './pages/WorkflowsPage.js'
import DeadLetterPage           from './pages/DeadLetterPage.js'
import ApprovalsPage            from './pages/ApprovalsPage.js'
import AnalyticsPage            from './pages/AnalyticsPage.js'
import InsightsPage             from './pages/InsightsPage.js'
import LearningCenterPage       from './pages/LearningCenterPage.js'
import InsightReviewPage        from './pages/InsightReviewPage.js'
import PatternExplorerPage      from './pages/PatternExplorerPage.js'
import RecommendationQueuePage  from './pages/RecommendationQueuePage.js'
import MemoryQualityPage        from './pages/MemoryQualityPage.js'
import FeedbackHistoryPage      from './pages/FeedbackHistoryPage.js'
import AgentControlPage         from './pages/AgentControlPage.js'
import RemoteComputePage        from './pages/RemoteComputePage.js'
import ProviderSettingsPage     from './pages/ProviderSettingsPage.js'
import ProviderHealthPage       from './pages/ProviderHealthPage.js'
import CostDashboardPage        from './pages/CostDashboardPage.js'
import BudgetDashboardPage      from './pages/BudgetDashboardPage.js'
import RemoteUsagePage          from './pages/RemoteUsagePage.js'
import ProviderSpendPage        from './pages/ProviderSpendPage.js'
import WorkerSpendPage          from './pages/WorkerSpendPage.js'
import KillSwitchPage           from './pages/KillSwitchPage.js'
import BudgetAlertsPage         from './pages/BudgetAlertsPage.js'
import RunawayJobsPage          from './pages/RunawayJobsPage.js'
import RuntimeSettingsPage      from './pages/RuntimeSettingsPage.js'
import WarRoomRuntimePage       from './pages/WarRoomRuntimePage.js'
import LaunchGatePage           from './pages/LaunchGatePage.js'
import AuditPage               from './pages/AuditPage.js'
import PatchApprovalsPage      from './pages/PatchApprovalsPage.js'
import SandboxPage             from './pages/SandboxPage.js'
import IncidentsPage           from './pages/IncidentsPage.js'
import LearningRuntimePage     from './pages/LearningRuntimePage.js'
import OrchestratorPage        from './pages/OrchestratorPage.js'
import LaunchLockPage          from './pages/LaunchLockPage.js'
import HelpPage                from './pages/HelpPage.js'
import EvolutionPage           from './pages/EvolutionPage.js'
import TenantPage              from './pages/TenantPage.js'
import SecurityPage            from './pages/SecurityPage.js'
import SecurityTeamPage        from './pages/SecurityTeamPage.js'
import LaunchTonightPage       from './pages/LaunchTonightPage.js'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher.js'

const NAV_ITEMS = [
  { to: '/brain',                icon: Brain,         label: 'Brain' },
  { to: '/talk',                 icon: MessageSquare, label: 'Talk' },
  { to: '/home',                 icon: Home,       label: 'Home' },
  { to: '/mission',              icon: Compass,    label: 'Mission' },
  { to: '/proposals',            icon: Code2,      label: 'Proposals' },
  { to: '/patches',              icon: Hammer,     label: 'Patches' },
  { to: '/system-map',           icon: MapIcon,    label: 'System Map' },
  { to: '/commerce',             icon: ShoppingBag,label: 'Commerce' },
  { to: '/trust-governance',     icon: Shield,     label: 'Trust & Governance' },
  { to: '/fabric',               icon: Network,    label: 'Fabric' },
  { to: '/identity',             icon: Wand2,      label: 'Identity' },
  { to: '/simulation',           icon: FlaskConical, label: 'Simulation' },
  { to: '/notifications',        icon: Bell,       label: 'Notifications' },
  { to: '/search',               icon: Search,     label: 'Search' },
  { to: '/operator-input',       icon: Plus,       label: 'Operator Input' },
  { to: '/strategic-home', icon: Rocket,       label: 'Strategic Home' },
  { to: '/mission-intelligence', icon: Brain,  label: 'Mission Intelligence' },
  { to: '/executive-war-room',   icon: TrendingUp, label: 'Executive War Room' },
  { to: '/company-operations',   icon: Building2,  label: 'Company Operations' },
  { to: '/image-studio',         icon: Lightbulb,  label: 'Image Studio' },
  { to: '/capability-gap',       icon: ScanSearch, label: 'Capability Gaps' },
  { to: '/cognition',            icon: Brain,      label: 'Cognition' },
  { to: '/truth',                icon: ShieldCheck,label: 'Truth' },
  { to: '/economy',              icon: Coins,      label: 'Economy' },
  { to: '/audit-trail',          icon: Clock,      label: 'Audit Trail' },
  { to: '/runtime',              icon: Heart,      label: 'Runtime 24/7' },
  { to: '/war-room',    icon: Activity,        label: 'War Room' },
  { to: '/timeline',    icon: Clock,           label: 'Timeline' },
  { to: '/goals',       icon: Target,          label: 'Goals' },
  { to: '/risks',       icon: ShieldAlert,     label: 'Risks' },
  { to: '/agents',      icon: Bot,             label: 'Agents' },
  { to: '/businesses',  icon: Building2,       label: 'Businesses' },
  { to: '/memory',      icon: Brain,           label: 'Memory Browser' },
  { to: '/workflows',   icon: GitBranch,       label: 'Workflows' },
  { to: '/dead-letter', icon: AlertOctagon,    label: 'Dead Letter' },
  { to: '/approvals',   icon: CheckSquare,     label: 'Approvals' },
  { to: '/analytics',   icon: BarChart3,       label: 'Analytics' },
  { to: '/insights',    icon: Lightbulb,       label: 'Insights' },
  { to: '/learning',    icon: GraduationCap,   label: 'Learning Center' },
  { to: '/compute',     icon: Cpu,             label: 'Remote Compute' },
  { to: '/governor',    icon: Shield,          label: 'Cost Governor' },
  { to: '/audit',            icon: ScanSearch,  label: 'Audit' },
  { to: '/patch-approvals',  icon: ShieldCheck, label: 'Patch Approvals' },
  { to: '/sandbox',          icon: Terminal,    label: 'Sandbox' },
  { to: '/incidents',        icon: Siren,       label: 'Incidents' },
  { to: '/learning-runtime', icon: Brain,       label: 'Learning Runtime' },
  { to: '/orchestrator',     icon: GitMerge,    label: 'Orchestrator' },
  { to: '/launch-tonight',   icon: Rocket,      label: 'Launch Tonight' },
  { to: '/launch-lock',      icon: Lock,        label: 'Launch Lock' },
  { to: '/evolution',        icon: TrendingUp,  label: 'Evolution' },
  { to: '/tenant',           icon: Building2,   label: 'Tenant & Billing' },
  { to: '/security',         icon: Shield,      label: 'Security' },
  { to: '/security-team',    icon: ShieldAlert, label: 'Security Team' },
  { to: '/help',             icon: BookOpen,    label: 'Help' },
  { to: '/settings',         icon: SettingsIcon, label: 'Settings' },
]

function NovanMark() {
  return (
    <a href="/" title="Novan" aria-label="Novan home"
       className="w-9 h-9 mb-1 flex items-center justify-center rounded-lg bg-black border border-[var(--border)] hover:border-[var(--text-secondary)] transition-colors">
      <img src="/icon.svg" alt="Novan" className="w-6 h-6" />
    </a>
  )
}

function Sidebar() {
  return (
    <nav className="shrink-0 w-12 flex flex-col items-center gap-1 py-3 border-r border-[var(--border)] bg-[var(--bg-surface)]">
      <NovanMark />
      <WorkspaceSwitcher />
      <div className="w-8 border-t border-[var(--border)] my-1" />
      {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            `w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
              isActive
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-secondary)]'
            }`
          }
        >
          <Icon className="w-4 h-4" />
        </NavLink>
      ))}
    </nav>
  )
}

export default function App() {
  useThemeAndShortcuts()
  return (
    <UIModeProvider>
      <AppShell />
    </UIModeProvider>
  )
}

function AppShell() {
  const [searchParams] = useSearchParams()
  const screenshotMode = searchParams.get('screenshot') === '1'
  const [paletteOpen, setPaletteOpen] = React.useState(false)

  // Global Cmd/Ctrl-K opens palette (any page)
  React.useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen(o => !o)
      } else if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [paletteOpen])

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

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <TopControls />
        <div className="flex-1 min-h-0 overflow-hidden">
          <RouteErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <AppRoutes />
            </Suspense>
          </RouteErrorBoundary>
        </div>
      </div>
      <GlobalPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}

function TopControls() {
  const { mode, setMode } = useUIMode()
  const [audioOn, setAudioOn] = React.useState(() => isAudioEnabled())
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', fn)
    return () => window.removeEventListener('mousedown', fn)
  }, [open])

  const toggleAudio = () => {
    const next = !audioOn
    setAudioEnabled(next); setAudioOn(next)
    if (next) tone('confirm')
  }

  const currentMode = UI_MODES.find(m => m.id === mode)

  return (
    <div className="glass border-b border-border px-3 py-1.5 flex items-center gap-2 text-2xs z-overlay">
      <div ref={ref} className="relative">
        <button onClick={() => setOpen(s => !s)}
          className="flex items-center gap-1.5 px-2 py-1 rounded border border-border hover:bg-[var(--surface-hover)] transition-colors duration-fast ease-out">
          <EyeIcon className="w-3 h-3" style={{ color: currentMode?.accent }} />
          <span className="text-muted">Mode:</span>
          <span className="text-primary font-mono">{currentMode?.label ?? 'Focus'}</span>
        </button>
        {open && (
          <div className="absolute top-full mt-1 left-0 panel-elevated dropdown-in min-w-[160px] z-dropdown overflow-hidden">
            {UI_MODES.map(m => (
              <button key={m.id} onClick={() => { setMode(m.id); setOpen(false); tone('select') }}
                className={`w-full text-left px-3 py-1.5 text-2xs flex items-center gap-2 hover:bg-[var(--surface-hover)] transition-colors duration-fast ${
                  mode === m.id ? 'text-primary' : 'text-secondary'
                }`}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.accent }} />
                <span className="font-mono flex-1">{m.label}</span>
                {m.emphasis.length > 0 && <span className="text-faint">{m.emphasis.length} sys</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <button onClick={toggleAudio}
        title={audioOn ? 'Sound on' : 'Sound off'}
        className="p-1 rounded border border-border hover:bg-[var(--surface-hover)] transition-colors duration-fast ease-out">
        {audioOn
          ? <Volume2 className="w-3 h-3 text-secondary" />
          : <VolumeX className="w-3 h-3 text-faint" />}
      </button>

      <span className="text-muted ml-2 hidden md:inline">
        ⌘K palette · ?screenshot=1 hides chrome
      </span>
    </div>
  )
}

function RouteFallback() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="shimmer rounded h-2 w-32" />
    </div>
  )
}

function AppRoutes() {
  return (
        <Routes>
          <Route path="/"            element={<Navigate to="/strategic-home" replace />} />
          <Route path="/strategic-home" element={<StrategicHomePage />} />
          <Route path="/mission-intelligence" element={<MissionIntelligencePage />} />
          <Route path="/executive-war-room"   element={<ExecutiveWarRoomPage />} />
          <Route path="/company-operations"   element={<CompanyOperationsPage />} />
          <Route path="/image-studio"         element={<ImageStudioPage />} />
          <Route path="/capability-gap"       element={<CapabilityGapPage />} />
          <Route path="/cognition"            element={<CognitionPage />} />
          <Route path="/truth"                element={<TruthPage />} />
          <Route path="/economy"              element={<EconomyPage />} />
          <Route path="/audit-trail"          element={<AuditTrailPage />} />
          <Route path="/runtime"              element={<RuntimePage />} />
          <Route path="/home"                 element={<HomeDashboardPage />} />
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
          <Route path="/brain"                element={<BrainPage />} />
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
          <Route path="*"          element={<Navigate to="/war-room" replace />} />
        </Routes>
  )
}
