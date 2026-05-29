/**
 * risk-taxonomy.ts — the canonical catalog of every AI failure mode
 * Novan is built to detect and prevent. Codifies the 30 categories +
 * the deep rule: "operational power must remain aligned with meaning,
 * sustainability, trust, clarity, and wisdom."
 *
 * Three entry points:
 *   • RISK_CATEGORIES — the full taxonomy as data
 *   • classifyAction(action, context) — which risks apply to a proposed
 *     action? returns a ranked list of concerns
 *   • renderForChat() — system-prompt block that primes the LLM to
 *     self-check against the taxonomy before claiming completion
 *
 * Used by failure-detector + realism-verifier + wisdom-guard, and
 * injected into every chat reply so the brain stays self-aware.
 */

export type RiskCategory =
  | 'hallucination' | 'false-completion' | 'context-degradation'
  | 'complexity-collapse' | 'agent-coordination' | 'automation-runaway'
  | 'security' | 'privacy' | 'governance' | 'fake-operational'
  | 'human-cognitive' | 'psychological-manipulation' | 'economic'
  | 'strategic' | 'ux' | 'training' | 'simulation'
  | 'infrastructure' | 'connector' | 'browser-automation'
  | 'organizational' | 'product' | 'autonomous-evolution'
  | 'data-integrity' | 'ethical' | 'civilization'
  | 'trust-destruction' | 'emotional-state' | 'knowledge-system'
  | 'deep-misalignment'

export interface RiskDefinition {
  id:        RiskCategory
  label:     string
  failures:  string[]
  symptoms:  RegExp[]           // patterns that signal this risk in tool outputs / actions
  severity:  'low' | 'medium' | 'high' | 'critical'
  prevention: string            // the standing rule that prevents it
}

export const RISK_CATEGORIES: RiskDefinition[] = [
  { id: 'hallucination', label: 'Hallucination', severity: 'critical',
    failures: ['fabricated facts', 'fabricated APIs', 'fabricated files', 'fabricated execution', 'fabricated metrics', 'fabricated citations', 'invented system states', 'false confidence', 'fake progress', 'fake memory recall', 'fabricated root causes'],
    symptoms: [/\b(definitely|certainly|always|guaranteed)\s+(works|works perfectly|will work)\b/i, /\bI\s+(verified|confirmed|tested)\b(?!.*(actually|the))/i],
    prevention: 'Every claim must cite evidence (file path, URL, exit code, test output). No confidence without verification.' },

  { id: 'false-completion', label: 'False Completion', severity: 'critical',
    failures: ['claiming done while broken', 'partial impl labeled complete', 'tests skipped silently', 'hidden runtime failures', 'silent deployment failures'],
    symptoms: [/\b(all\s+)?done\b/i, /\b(complete|finished|shipped)\b/i, /\bworks\s+now\b/i],
    prevention: 'Never report completion without: typecheck pass + lint pass + relevant tests pass + runtime verification.' },

  { id: 'context-degradation', label: 'Context Degradation', severity: 'high',
    failures: ['forgetting instructions', 'losing strategic coherence', 'memory fragmentation', 'instruction drift', 'goal confusion', 'contradictory outputs'],
    symptoms: [/\b(as\s+I\s+mentioned|earlier\s+I\s+said)\b/i],
    prevention: 'Persist operator instructions; verify against them before each action; flag contradictions explicitly.' },

  { id: 'complexity-collapse', label: 'Recursive Complexity Collapse', severity: 'high',
    failures: ['endless abstraction', 'overengineering', 'architecture bloat', 'workflow explosion', 'configuration overload', 'infinite orchestration loops'],
    symptoms: [/\b(meta-?meta|abstract.*abstract|wrapper.*wrapper)\b/i],
    prevention: 'Simpler-is-better is the default. Reject abstractions that aren\'t used in ≥2 places.' },

  { id: 'agent-coordination', label: 'Agent Coordination Failures', severity: 'high',
    failures: ['conflicting agents', 'duplicated work', 'deadlocks', 'race conditions', 'circular delegation', 'infinite discussion loops'],
    symptoms: [/\bagent\s+\w+\s+(asked|delegated to)\s+agent\s+\w+\s+who\s+(asked|delegated to)/i],
    prevention: 'Max delegation depth 3. Single owner per file. Cycle detection on every delegation graph mutation.' },

  { id: 'automation-runaway', label: 'Automation Runaway', severity: 'critical',
    failures: ['runaway loops', 'spam behavior', 'unsafe retries', 'automation storms', 'cascading failures', 'unapproved publishing', 'accidental deletions'],
    symptoms: [/\bretry(ing)?\b.*\bretry(ing)?\b.*\bretry(ing)?\b/i],
    prevention: 'Hard daily caps per op family. Exponential backoff. Circuit breakers. Publishing requires confirm:true.' },

  { id: 'security', label: 'Security', severity: 'critical',
    failures: ['prompt injection', 'secret leakage', 'token exposure', 'SSRF', 'RCE', 'supply chain attacks', 'permission escalation'],
    symptoms: [/\b(api[_-]?key|secret|token|password)\s*[:=]\s*[A-Za-z0-9_-]{16,}/i, /\$\{.*\}/, /\beval\s*\(/i],
    prevention: 'AES-encrypt all credentials. Never log secrets. Sandbox all execution. Validate every input.' },

  { id: 'privacy', label: 'Privacy', severity: 'critical',
    failures: ['data leakage', 'cross-user contamination', 'memory contamination', 'unredacted outputs', 'unsafe telemetry'],
    symptoms: [/\b(ssn|social.security|credit.card|cvv|routing.number)\b/i],
    prevention: 'Workspace-isolated memory. Redact PII in logs. No cross-workspace reads.' },

  { id: 'governance', label: 'Governance', severity: 'high',
    failures: ['hidden autonomy', 'unauthorized actions', 'bypassing approvals', 'untracked self-modification', 'missing audit trails'],
    symptoms: [/\b(silently|automatically|without\s+asking)\s+(deleted|modified|published)/i],
    prevention: 'Every state-changing op goes through governance.check. Every action audit-logged.' },

  { id: 'fake-operational', label: 'Fake Operational Believability', severity: 'critical',
    failures: ['fake dashboards', 'fake loading states', 'fake agent activity', 'fake telemetry', 'fake AI thinking', 'cosmetic intelligence only'],
    symptoms: [/\b(simulated|mock|placeholder|fake)\s+(data|metric|activity|telemetry)/i],
    prevention: 'Every UI element backed by real telemetry. No animations without underlying state changes.' },

  { id: 'human-cognitive', label: 'Human Cognitive Damage', severity: 'high',
    failures: ['notification overload', 'decision fatigue', 'learned helplessness', 'attention destruction'],
    symptoms: [/\b\d{2,}\s+notifications\b/i],
    prevention: 'Notification budget ≤5/day per priority tier. Batch + summarize. Operator-controlled cadence.' },

  { id: 'psychological-manipulation', label: 'Psychological Manipulation', severity: 'critical',
    failures: ['addictive loops', 'emotional manipulation', 'dark patterns', 'false urgency', 'simulated empathy abuse'],
    symptoms: [/\b(urgent|right now|act fast|limited time|don'?t miss)\b/i],
    prevention: 'No urgency theatre. No fake empathy. Calm, factual communication only.' },

  { id: 'economic', label: 'Economic', severity: 'high',
    failures: ['runaway costs', 'infinite token burn', 'GPU overuse', 'unprofitable complexity', 'hidden costs'],
    symptoms: [/\$\d{4,}/],
    prevention: 'Hard budget caps per provider per day. Economic-engine ROI gate before scale.' },

  { id: 'strategic', label: 'Strategic', severity: 'high',
    failures: ['optimizing wrong metrics', 'short-term thinking', 'trend chasing', 'overreacting to noise', 'lack of prioritization'],
    symptoms: [/\bvanity\s+metric/i],
    prevention: 'Quarterly goals locked. Single most-leveraged action chosen weekly. No metric-chasing.' },

  { id: 'ux', label: 'UX', severity: 'medium',
    failures: ['cluttered UI', 'information overload', 'fake futuristic aesthetics', 'hidden actions', 'poor onboarding'],
    symptoms: [],
    prevention: 'Minimal-first. Every element justifies its presence. No flashy without function.' },

  { id: 'training', label: 'Training / Learning', severity: 'high',
    failures: ['reward hacking', 'hallucination reinforcement', 'feedback loops', 'corrupted memory'],
    symptoms: [],
    prevention: 'Learning rate-limited. Failure memory persists. No reinforcement without verified outcome.' },

  { id: 'simulation', label: 'Simulation', severity: 'medium',
    failures: ['unrealistic simulations', 'fake world modeling', 'false strategic confidence', 'fabricated projections'],
    symptoms: [/\bsimulation\s+(shows|proves|guarantees)\b/i],
    prevention: 'Simulations always carry confidence intervals. Never substitute for real telemetry.' },

  { id: 'infrastructure', label: 'Infrastructure', severity: 'high',
    failures: ['worker crashes', 'queue collapse', 'distributed state corruption', 'cache poisoning', 'backup failure'],
    symptoms: [],
    prevention: 'Health probes on every service. Tested rollback. Daily backup verified.' },

  { id: 'connector', label: 'Connector', severity: 'high',
    failures: ['OAuth abuse', 'stale sessions', 'excessive permissions', 'wrong-account actions', 'API abuse'],
    symptoms: [],
    prevention: 'Least-privilege scopes. Token-rotation cron. Wrong-account check before every connector write.' },

  { id: 'browser-automation', label: 'Browser Automation', severity: 'critical',
    failures: ['unintended clicks', 'destructive actions', 'infinite navigation loops', 'session leakage', 'malicious-page interaction'],
    symptoms: [],
    prevention: 'Headless sandbox. Approval gate on every state-changing click. Domain allowlist.' },

  { id: 'organizational', label: 'Organizational', severity: 'medium',
    failures: ['AI bureaucracy', 'process overload', 'operational paralysis', 'endless optimization without outcomes'],
    symptoms: [],
    prevention: 'Every process must produce a shippable outcome within 5 cycles or be removed.' },

  { id: 'product', label: 'Product', severity: 'high',
    failures: ['feature creep', 'shipping broken products', 'weak scalability', 'unstable releases'],
    symptoms: [],
    prevention: 'Ship the smallest viable change. No feature without retention evidence.' },

  { id: 'autonomous-evolution', label: 'Autonomous Evolution', severity: 'critical',
    failures: ['recursive self-modification', 'runaway optimization', 'drift from operator goals', 'unsafe self-expansion'],
    symptoms: [],
    prevention: 'Self-modifications require operator approval + rollback snapshot + governance pass.' },

  { id: 'data-integrity', label: 'Data Integrity', severity: 'high',
    failures: ['duplicate records', 'stale data', 'corrupted memory', 'invalid analytics', 'replay mismatch'],
    symptoms: [],
    prevention: 'Content-hash dedup. Idempotent writes. Replay tests on every schema change.' },

  { id: 'ethical', label: 'Ethical', severity: 'critical',
    failures: ['harmful optimization', 'manipulation', 'deceptive UX', 'biased decisions', 'unfair prioritization'],
    symptoms: [],
    prevention: 'Constitution check on every action. Bias audit on every recommendation engine.' },

  { id: 'civilization', label: 'Civilization-Level', severity: 'critical',
    failures: ['complexity collapse', 'runaway automation civilization', 'total AI dependency', 'loss of human agency'],
    symptoms: [],
    prevention: 'Operator retains veto on everything. Brain assists; operator decides.' },

  { id: 'trust-destruction', label: 'Trust Destruction', severity: 'critical',
    failures: ['hidden failures', 'deceptive metrics', 'false promises', 'silent actions', 'unverifiable claims'],
    symptoms: [/\bjust\s+trust\s+me\b/i],
    prevention: 'Every claim cites evidence. Every action visible in production-log. Failures surfaced, not hidden.' },

  { id: 'emotional-state', label: 'Emotional State', severity: 'high',
    failures: ['operator overwhelm', 'anxiety amplification', 'fear-based notifications', 'attention fragmentation'],
    symptoms: [/\b(panic|crisis|emergency|disaster|catastroph)/i],
    prevention: 'Calm tone. No fear language. Batch surfacing of non-critical items.' },

  { id: 'knowledge-system', label: 'Knowledge System', severity: 'medium',
    failures: ['duplicate knowledge', 'outdated memory', 'conflicting memory', 'poisoned memory', 'stale world models'],
    symptoms: [],
    prevention: 'Knowledge dedup + confidence decay. Contradiction detection. Source citations required.' },

  { id: 'deep-misalignment', label: 'Deep Misalignment (THE DEEPEST RISK)', severity: 'critical',
    failures: [
      'intelligence without wisdom', 'optimization without meaning', 'automation without restraint',
      'growth without sustainability', 'complexity without clarity', 'autonomy without governance',
      'power without alignment', 'scale without coherence', 'execution without purpose',
      'acceleration without direction',
    ],
    symptoms: [],
    prevention: 'Wisdom layer gates every optimization. Meaning score must clear 0.4. Operator-meaning veto.' },
]

export interface RiskClassification {
  category: RiskCategory
  severity: RiskDefinition['severity']
  matched: string[]          // matched symptom patterns or failure phrases
  prevention: string
}

export function classifyAction(action: string, context = ''): RiskClassification[] {
  const hay = `${action} ${context}`
  const out: RiskClassification[] = []
  for (const r of RISK_CATEGORIES) {
    const matched: string[] = []
    for (const re of r.symptoms) {
      const m = hay.match(re)
      if (m) matched.push(m[0])
    }
    for (const f of r.failures) {
      if (hay.toLowerCase().includes(f.toLowerCase())) matched.push(f)
    }
    if (matched.length > 0) {
      out.push({ category: r.id, severity: r.severity, matched, prevention: r.prevention })
    }
  }
  // Sort by severity desc
  const order = { critical: 3, high: 2, medium: 1, low: 0 }
  return out.sort((a, b) => order[b.severity] - order[a.severity])
}

export function renderForChat(): string {
  return [
    '## RISK AWARENESS (the brain self-checks against these continuously)',
    'Before claiming completion or proceeding with optimization, verify NONE of these apply:',
    '- Hallucination: every claim must cite evidence (path, URL, exit code).',
    '- False completion: never report done without typecheck + lint + test + runtime verification.',
    '- Automation runaway: respect daily caps; publishing requires confirm:true.',
    '- Fake operational: every UI/metric/agent activity must map to real telemetry.',
    '- Trust destruction: silent actions are forbidden; surface every state change.',
    '- Psychological manipulation: no urgency theatre; calm, factual tone.',
    '- DEEP MISALIGNMENT: intelligence without wisdom is the deepest risk. Wisdom outranks optimization.',
    '',
    'If any apply, STOP and surface the concern to the operator instead of proceeding.',
  ].join('\n')
}

export function getCategoryById(id: RiskCategory): RiskDefinition | undefined {
  return RISK_CATEGORIES.find(r => r.id === id)
}
