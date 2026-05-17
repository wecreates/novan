import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import {
  Activity, Clock, Settings as SettingsIcon,
  Target, ShieldAlert, Bot, Building2, Brain,
  GitBranch, AlertOctagon, CheckSquare, BarChart3, Lightbulb, GraduationCap, Cpu,
  Shield, ScanSearch, ShieldCheck, Terminal, Siren, GitMerge, Lock, BookOpen, TrendingUp, Rocket,
} from 'lucide-react'
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
  { to: '/strategic-home', icon: Rocket,       label: 'Strategic Home' },
  { to: '/mission-intelligence', icon: Brain,  label: 'Mission Intelligence' },
  { to: '/executive-war-room',   icon: TrendingUp, label: 'Executive War Room' },
  { to: '/company-operations',   icon: Building2,  label: 'Company Operations' },
  { to: '/image-studio',         icon: Lightbulb,  label: 'Image Studio' },
  { to: '/capability-gap',       icon: ScanSearch, label: 'Capability Gaps' },
  { to: '/cognition',            icon: Brain,      label: 'Cognition' },
  { to: '/truth',                icon: ShieldCheck,label: 'Truth' },
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
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)]">
      <Sidebar />
      <div className="flex-1 min-w-0 overflow-hidden">
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
      </div>
    </div>
  )
}
