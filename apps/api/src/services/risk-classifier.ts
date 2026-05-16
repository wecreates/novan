/**
 * Risk Classifier — pure classification logic, no side effects.
 *
 * Classifies a build task into one or more risk categories and
 * returns an overall risk level. No DB writes, no external calls.
 *
 * Risk categories:
 *   dependency   — package.json, lock files
 *   auth         — auth/jwt/session/password/login
 *   payment      — stripe/billing/invoice/subscription
 *   database     — schema.ts, migrations, pgTable
 *   billing      — provider billing, budget limits
 *   security     — api_key/secret/credential/token env
 *   destructive  — delete/drop/truncate patterns
 *   large_patch  — >500 lines changed
 *   orchestration — server.ts, app.ts, main.ts
 *   deployment   — .github/workflows, dockerfile
 */

export type RiskCategory =
  | 'dependency'
  | 'auth'
  | 'payment'
  | 'database'
  | 'billing'
  | 'security'
  | 'destructive'
  | 'large_patch'
  | 'orchestration'
  | 'deployment'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface RiskClassification {
  riskLevel:      RiskLevel
  riskCategories: RiskCategory[]
  riskReason:     string
  requiresApproval: boolean
}

interface TaskContext {
  title:       string
  description: string
  filePath?:   string | null | undefined
  category:    string
  severity:    string
  blastRadius: string
}

// ─── Pattern definitions ───────────────────────────────────────────────────────

interface CategoryRule {
  category:   RiskCategory
  pathPatterns: RegExp[]
  titlePatterns: RegExp[]
  level:      RiskLevel
  reason:     string
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'auth',
    pathPatterns: [
      /\bauth\b/i, /\bjwt\b/i, /\bsession\b/i, /\bpassword\b/i,
      /\blogin\b/i, /\btoken\b/i, /\boauth\b/i, /\bsso\b/i,
    ],
    titlePatterns: [
      /\bauth\b/i, /\bjwt\b/i, /\bsession\b/i, /\bpassword\b/i,
      /\blogin\b/i, /\bauthenticat/i, /\bauthoriz/i,
    ],
    level: 'critical',
    reason: 'Modifies authentication or session logic — security-critical system',
  },
  {
    category: 'payment',
    pathPatterns: [
      /\bstripe\b/i, /\bbilling\b/i, /\binvoice\b/i, /\bsubscription\b/i,
      /\bpayment\b/i, /\bcheckout\b/i, /\bwebhook.*stripe/i,
    ],
    titlePatterns: [
      /\bstripe\b/i, /\bbilling\b/i, /\binvoice\b/i, /\bsubscription\b/i,
      /\bpayment\b/i, /\bpurchase\b/i,
    ],
    level: 'critical',
    reason: 'Modifies payment or billing logic — financial-critical system',
  },
  {
    category: 'database',
    pathPatterns: [
      /\bschema\.ts\b/i, /\bmigration/i, /\bpgTable\b/i,
      /\/db\//i, /\/migrations\//i,
    ],
    titlePatterns: [
      /\bschema\b/i, /\bmigration\b/i, /\bdatabase\b/i,
      /\bpgTable\b/i, /\btable\b.*\bcreate/i, /\bdrop\b.*\btable/i,
    ],
    level: 'critical',
    reason: 'Modifies database schema or migrations — data-integrity-critical',
  },
  {
    category: 'dependency',
    pathPatterns: [
      /\bpackage\.json\b/i, /\bpackage-lock\.json\b/i,
      /\byarn\.lock\b/i, /\bpnpm-lock\.yaml\b/i,
      /\bCargo\.toml\b/i, /\brequirements\.txt\b/i,
    ],
    titlePatterns: [
      /\bdependenc/i, /\bpackage\.json\b/i, /\bupgrade\b/i,
      /\binstall\b.*\bpackage/i,
    ],
    level: 'high',
    reason: 'Modifies package dependencies — may introduce breaking changes',
  },
  {
    category: 'security',
    pathPatterns: [
      /\bsecret\b/i, /\bcredential\b/i, /\bapi.?key\b/i,
      /\b\.env\b/i, /\bencrypt\b/i, /\bcrypt\b/i,
    ],
    titlePatterns: [
      /\bsecret\b/i, /\bcredential\b/i, /\bapi.?key\b/i,
      /\bencrypt\b/i, /\bsecuri/i, /\bvulnerab/i,
    ],
    level: 'high',
    reason: 'Modifies security-sensitive code or secret handling',
  },
  {
    category: 'billing',
    pathPatterns: [
      /\bcost.governor\b/i, /\bbudget\b/i, /\bspend\b/i,
      /\bprovider.*bill/i, /\bai.?usage\b/i,
    ],
    titlePatterns: [
      /\bbudget\b/i, /\bspend\b/i, /\bcost\b.*\blimit/i,
      /\bbilling\b.*\bprovider/i,
    ],
    level: 'high',
    reason: 'Modifies cost governance or budget limit logic',
  },
  {
    category: 'orchestration',
    pathPatterns: [
      /\bserver\.ts\b/i, /\bapp\.ts\b/i, /\bmain\.ts\b/i,
      /\bindex\.ts\b$/, /\bbootstrap\b/i, /\bstartup\b/i,
    ],
    titlePatterns: [
      /\bserver\b/i, /\bbootstrap\b/i, /\bstartup\b/i,
      /\borchestrat/i, /\bregister.*route/i, /\broute.*register/i,
    ],
    level: 'high',
    reason: 'Modifies server bootstrap or orchestration entry point',
  },
  {
    category: 'deployment',
    pathPatterns: [
      /\.github\/workflows\//i, /\bDockerfile\b/i,
      /\bdocker-compose\b/i, /\bkubernetes\b/i,
      /\bhelmfile\b/i, /\bterraform\b/i, /\.ya?ml$/i,
    ],
    titlePatterns: [
      /\bdeploy\b/i, /\bdocker\b/i, /\bci\/cd\b/i,
      /\bkubernetes\b/i, /\bgithub.action/i,
    ],
    level: 'high',
    reason: 'Modifies deployment or CI/CD configuration',
  },
  {
    category: 'destructive',
    pathPatterns: [],
    titlePatterns: [
      /\bdelete\b/i, /\bdrop\b/i, /\btruncate\b/i,
      /\bremove\b.*\btable\b/i, /\bpurge\b/i, /\bwipe\b/i,
      /\bclear\b.*\bdata\b/i,
    ],
    level: 'high',
    reason: 'Task description suggests destructive data operations',
  },
]

// ─── Level ordering ────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<RiskLevel, number> = {
  low: 0, medium: 1, high: 2, critical: 3,
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b
}

// ─── Main classifier ───────────────────────────────────────────────────────────

export function classifyRisk(task: TaskContext): RiskClassification {
  const matched = new Map<RiskCategory, CategoryRule>()
  const filePath = task.filePath ?? ''
  const title    = task.title
  const desc     = task.description

  for (const rule of CATEGORY_RULES) {
    let hit = false

    // Check file path patterns
    if (filePath) {
      for (const p of rule.pathPatterns) {
        if (p.test(filePath)) { hit = true; break }
      }
    }

    // Check title + description patterns
    if (!hit) {
      for (const p of rule.titlePatterns) {
        if (p.test(title) || p.test(desc)) { hit = true; break }
      }
    }

    if (hit) matched.set(rule.category, rule)
  }

  // large_patch — based on blast radius
  if (task.blastRadius === 'critical' || task.blastRadius === 'high') {
    if (!matched.has('large_patch')) {
      matched.set('large_patch', {
        category: 'large_patch',
        pathPatterns: [],
        titlePatterns: [],
        level: 'medium',
        reason: `High blast radius (${task.blastRadius}) — may affect many systems`,
      })
    }
  }

  // Severity escalation — critical findings always need approval
  if (task.severity === 'critical' && matched.size === 0) {
    // No category matched but finding is critical — flag as medium risk
    return {
      riskLevel: 'medium',
      riskCategories: [],
      riskReason: 'Critical severity finding requires review even without specific risk category',
      requiresApproval: true,
    }
  }

  if (matched.size === 0) {
    return {
      riskLevel: 'low',
      riskCategories: [],
      riskReason: 'No risk categories matched — safe to dispatch automatically',
      requiresApproval: false,
    }
  }

  // Aggregate
  let level: RiskLevel = 'low'
  const reasons: string[] = []

  for (const [, rule] of matched) {
    level = maxLevel(level, rule.level)
    reasons.push(rule.reason)
  }

  const requiresApproval = LEVEL_ORDER[level] >= LEVEL_ORDER['high']

  return {
    riskLevel: level,
    riskCategories: [...matched.keys()],
    riskReason: reasons.join('; '),
    requiresApproval,
  }
}
