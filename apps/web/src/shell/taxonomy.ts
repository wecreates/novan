/**
 * taxonomy.ts — Canonical folder tree for the Novan shell.
 *
 * Six top-level groups, single-word labels, max 2 levels deep. Every
 * leaf is a real route. Less-frequently-used pages aren't surfaced
 * here but their routes still resolve — global search + direct URL
 * still work. The taxonomy is the operator's daily navigation, not
 * an exhaustive site map.
 *
 *   Now        — what's happening right now (talk, approvals, alerts)
 *   Businesses — the work being run
 *   Brain      — the capability layer (agents, knowledge, map)
 *   Analytics  — measurement + reflection
 *   Guard      — governance, compliance, safety
 *   Setup      — connectors, settings, account
 */

export interface TreeNode {
  id:        string
  label:     string
  path?:     string
  children?: TreeNode[]
  dynamic?:  boolean
}

export const TAXONOMY: TreeNode[] = [
  {
    id: 'now', label: 'Now', children: [
      { id: 'now.today',         label: 'Today',         path: '/today' },
      { id: 'now.talk',          label: 'Talk',          path: '/talk' },
      { id: 'now.chat',          label: 'Mobile Chat',   path: '/m/chat' },
      { id: 'now.approvals',     label: 'Approvals',     path: '/approvals' },
      { id: 'now.incidents',     label: 'Incidents',     path: '/incidents' },
      { id: 'now.notifications', label: 'Notifications', path: '/notifications' },
      { id: 'now.warroom',       label: 'War Room',      path: '/war-room' },
      { id: 'now.search',        label: 'Search',        path: '/search' },
    ],
  },
  {
    id: 'businesses', label: 'Businesses', children: [
      { id: 'biz.all',       label: 'All',        path: '/businesses' },
      { id: 'biz.portfolio', label: 'Portfolio',  path: '/analytics' },
      { id: 'biz.commerce',  label: 'Commerce',   path: '/commerce' },
      { id: 'biz.mission',   label: 'Mission',    path: '/mission' },
      { id: 'biz.goals',     label: 'Goals',      path: '/goals' },
    ],
  },
  {
    id: 'brain', label: 'Brain', children: [
      { id: 'brain.map',       label: 'Brain Map',   path: '/brain/graph' },
      { id: 'brain.showcase',  label: 'Showcase',    path: '/brain/showcase' },
      { id: 'brain.agents',    label: 'Agents',      path: '/agents' },
      { id: 'brain.workflows', label: 'Workflows',   path: '/workflows' },
      { id: 'brain.memory',    label: 'Memory',      path: '/memory' },
      { id: 'brain.research',  label: 'Research',    path: '/research' },
      { id: 'brain.skills',    label: 'Skills',      path: '/skill-library' },
      { id: 'brain.selfcheck', label: 'Self-check',  path: '/self-check' },
      { id: 'brain.proposals', label: 'Proposals',   path: '/proposals' },
    ],
  },
  {
    id: 'analytics', label: 'Analytics', children: [
      { id: 'an.economy',   label: 'Economy',    path: '/economy' },
      { id: 'an.insights',  label: 'Insights',   path: '/insights' },
      { id: 'an.learning',  label: 'Learning',   path: '/learning' },
      { id: 'an.audit',     label: 'Audit',      path: '/audit-trail' },
      { id: 'an.cost',      label: 'Cost',       path: '/compute/cost' },
    ],
  },
  {
    id: 'guard', label: 'Guard', children: [
      { id: 'guard.blueprint',  label: 'Blueprint',         path: '/blueprint' },
      { id: 'guard.budgets',    label: 'Budgets',           path: '/governor' },
      { id: 'guard.killswitch', label: 'Kill Switches',     path: '/governor/kill-switches' },
      { id: 'guard.soc2',       label: 'Compliance',        path: '/legal/soc2' },
      { id: 'guard.readiness',  label: 'Readiness',         path: '/legal/operational-readiness' },
      { id: 'guard.lock',       label: 'Lock Integrity',    path: '/legal/lock-integrity' },
      { id: 'guard.playbooks',  label: 'Playbooks',         path: '/legal/recovery-playbooks' },
    ],
  },
  {
    id: 'setup', label: 'Setup', children: [
      { id: 'setup.connectors', label: 'Connectors', path: '/connectors' },
      { id: 'setup.voice',      label: 'Voice',      path: '/voice' },
      { id: 'setup.compute',    label: 'Compute',    path: '/compute' },
      { id: 'setup.settings',   label: 'Settings',   path: '/settings' },
      { id: 'setup.account',    label: 'Account',    path: '/account' },
      { id: 'setup.help',       label: 'Help',       path: '/help' },
    ],
  },
]

/** Flatten to all leaf nodes (those with `path` and no children). */
export function listLeaves(nodes: TreeNode[] = TAXONOMY): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (n: TreeNode): void => {
    if (n.path && !n.children) out.push(n)
    n.children?.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

/** Look up the breadcrumb trail for a given route path. Returns []
 *  when the path is unknown (e.g. dynamic route or off-tree). */
export function breadcrumbFor(currentPath: string): TreeNode[] {
  const trail: TreeNode[] = []
  const walk = (n: TreeNode, ancestors: TreeNode[]): boolean => {
    if (n.path === currentPath && !n.children) {
      trail.push(...ancestors, n)
      return true
    }
    if (n.children) {
      for (const c of n.children) {
        if (walk(c, [...ancestors, n])) return true
      }
    }
    return false
  }
  for (const n of TAXONOMY) {
    if (walk(n, [])) break
  }
  return trail
}

/** Find a tree node by its leaf path. */
export function findByPath(path: string, nodes: TreeNode[] = TAXONOMY): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path && !n.children) return n
    if (n.children) {
      const m = findByPath(path, n.children)
      if (m) return m
    }
  }
  return null
}

/** All paths in the taxonomy (for verifying coverage). */
export function allPaths(): string[] {
  return listLeaves().map(l => l.path!).filter(Boolean)
}
