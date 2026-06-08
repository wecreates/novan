/**
 * R146.334 — Claude Parity Registry
 *
 * The mandate (R332→R334): "Novan needs to be able to do everything Claude
 * can do, but 10x better and 10x more, in every way."
 *
 * This registry is the source of truth for that mandate. Every capability
 * Claude exhibits is enumerated here with:
 *   - claudeLevel:    what Claude can do at peak (the target ceiling)
 *   - novanScore:     0-10, Novan's current parity (honest, evidence-based)
 *   - tenXVision:     what "10x better than Claude" looks like for this capability
 *   - closureCost:    rough engineering cost to ship next +1 score increment
 *   - blockedBy:      hard constraints (policy / infra / cost) that cap the score
 *
 * The continuous-improvement loop (r334-capability-loop) reads this and
 * picks the next gap to attack based on leverage × tractability.
 *
 * 10x doctrine — Novan's advantage over Claude:
 *   1. Continuous (24/7 vs request-response)
 *   2. Multi-agent parallel (N workers vs my serial reasoning)
 *   3. Persistent memory (cross-session) vs my context window
 *   4. Cost-bounded (token budgets enforced) vs my unmetered burn
 *   5. Domain-specialized (POD/social/code experts) vs my generalist mode
 *   6. Honest reporting (structured ok/failed/partial/blocked) vs my prose
 *   7. Verified, not vibed — every Novan op produces evidence
 */

export type CapabilityCategory =
  | 'reasoning' | 'tool_use' | 'code' | 'memory' | 'multimodal'
  | 'orchestration' | 'conversation' | 'skills' | 'safety' | 'web'
  | 'documents' | 'execution' | 'learning' | 'meta'

export interface ClaudeParityCapability {
  id:           string
  category:     CapabilityCategory
  claudeLevel:  string                     // What I can do at peak
  novanScore:   number                     // 0-10 honest current parity
  tenXVision:   string                     // What 10x-Novan looks like
  closureCost:  'small' | 'medium' | 'large' | 'multi_round'
  blockedBy?:   string[]                   // Hard caps
  evidence?:    string                     // Why the score is what it is
}

export const CLAUDE_PARITY: ClaudeParityCapability[] = [
  // ─── Brand consistency (from R333 ops registry — promoted to parity capability) ──
  {
    id: 'brand.dba_propagation',
    category: 'tool_use',
    claudeLevel: 'I type the DBA into every form Claude-the-engineer is asked to drive',
    novanScore: 5,
    tenXVision: 'workspace_memory.brand.dba.primary is the single source of truth. One mutation propagates to every connected platform via planPropagation() + executor; idempotent re-checks each cron tick.',
    closureCost: 'medium',
    evidence: 'R334: r334-brand-propagator.ts ships planPropagation() reading current DBA + connector_credentials, generates field-level update plan across 7 supported platforms. Executor blocked on platform.tiktok_shop_onboard partial (R333).',
  },
  // ─── Reasoning ───────────────────────────────────────────────────────
  {
    id: 'reasoning.multi_step_decomposition',
    category: 'reasoning',
    claudeLevel: 'Break a vague user goal into 5-15 ordered steps with dependencies',
    novanScore: 6,
    tenXVision: 'Decompose into a DAG of 50+ sub-tasks across 10 parallel agents, each scored for leverage and tractability, continuously re-planned as outcomes arrive',
    closureCost: 'medium',
    evidence: 'brain-task-planner exists; multi-agent fan-out exists in agent-team; DAG planner present but underused',
  },
  {
    id: 'reasoning.strategy_selection',
    category: 'reasoning',
    claudeLevel: 'Pick between approaches given constraints (free-first, paid-later, etc.)',
    novanScore: 8,
    tenXVision: 'For every requirement: enumerate 5+ paths with cost/time/risk projections, score each against operator constraints persisted in workspace_memory, pick optimal, log decision + outcome for prompt-evolution learning',
    closureCost: 'medium',
    evidence: 'R335: r335-free-first-decision-compiler.ts ships decide() with scorePath() applying free-first / privacy ceiling / quality floor / recurring-cost penalty / phase-trigger MRR. Pre-built decision trees for imageGenFallback + returnAddress.',
  },
  {
    id: 'reasoning.adversarial_self_check',
    category: 'reasoning',
    claudeLevel: 'After generating output, ask "what would refute this?" and revise',
    novanScore: 3,
    tenXVision: 'Every Novan output triggers parallel adversarial verifier agents (3-5 distinct lenses: correctness/security/cost/privacy/regression), majority-vote required to ship',
    closureCost: 'medium',
    evidence: 'adversarial-review exists but not wired to all outputs',
  },
  {
    id: 'reasoning.honest_blocker_naming',
    category: 'reasoning',
    claudeLevel: 'Refuse to fake fixes; name the real blocker explicitly',
    novanScore: 9,
    tenXVision: 'Every op produces structured {ok|partial|failed|blocked, reason, evidence, suggested_unblock_action}; blocked-state surfaces to operator dashboard in real-time',
    closureCost: 'small',
    evidence: 'R334: r334-honest-blocker-reporter.ts ships BlockerReport taxonomy with 12 blocker classes, constructor helpers, renderBlockerSentence(). Adoption to all ops is the remaining gap.',
  },

  // ─── Tool use ────────────────────────────────────────────────────────
  {
    id: 'tool_use.browser_drive',
    category: 'tool_use',
    claudeLevel: 'Drive any web UI via screenshot + click/type/scroll/find',
    novanScore: 4,
    tenXVision: 'Headless playwright pool of 10+ workers, each with persistent cookies per platform, capability to record + replay any UI flow, OCR fallback when DOM is hostile, parallel multi-platform updates',
    closureCost: 'large',
    evidence: 'brain-task-browser exists for single-session; no pool, no recording',
  },
  {
    id: 'tool_use.shell_execution',
    category: 'tool_use',
    claudeLevel: 'Run any bash command with output streaming, error capture',
    novanScore: 5,
    tenXVision: 'Sandboxed docker-per-task execution with disk/CPU/network quotas, automatic rollback on policy violation, persistent execution memory per workspace',
    closureCost: 'medium',
    evidence: 'code-agent exists; lacks sandboxing isolation',
  },
  {
    id: 'tool_use.file_system',
    category: 'tool_use',
    claudeLevel: 'Read/Write/Edit/Glob/Grep any file with line-level precision',
    novanScore: 6,
    tenXVision: 'Plus: cross-repo refactor across 100 files in parallel, semantic-aware edits via AST, automatic rollback if validation fails',
    closureCost: 'medium',
  },
  {
    id: 'tool_use.mcp_invocation',
    category: 'tool_use',
    claudeLevel: 'Invoke any installed MCP server tool',
    novanScore: 7,
    tenXVision: 'Plus: auto-discovery of new MCPs from registry, automatic credential management, per-tool cost tracking, fallback chains across MCPs offering similar capabilities',
    closureCost: 'small',
    evidence: 'MCP catalog exists; auto-discovery + fallback chains missing',
  },

  // ─── Code generation ─────────────────────────────────────────────────
  {
    id: 'code.write_system_from_spec',
    category: 'code',
    claudeLevel: 'Generate a complete production-grade service (1000+ LOC) from a paragraph spec',
    novanScore: 5,
    tenXVision: 'Generate 10+ services in parallel from spec, each adversarially reviewed, integration-tested against the existing codebase, deploy-gated by automated quality bar',
    closureCost: 'large',
    evidence: 'code-agent + ai-product-agents exist; quality gate weak',
  },
  {
    id: 'code.debug_root_cause',
    category: 'code',
    claudeLevel: 'Read stack trace + recent diffs → identify true root cause, not symptom',
    novanScore: 4,
    tenXVision: 'Continuous error-log monitoring; auto-classify failures; spawn debugging agent per distinct error pattern; propose + validate fix; PR-ready diff',
    closureCost: 'medium',
  },
  {
    id: 'code.refactor_safe',
    category: 'code',
    claudeLevel: 'Refactor while preserving behavior; update call sites + tests in one diff',
    novanScore: 4,
    tenXVision: 'Cross-repo + cross-language safe refactor with auto-generated migration plan, staged rollout, instant rollback',
    closureCost: 'large',
  },
  {
    id: 'code.review',
    category: 'code',
    claudeLevel: 'Review diff for security/perf/correctness bugs at PR time',
    novanScore: 6,
    tenXVision: 'Continuous review of every commit, classified by severity, auto-fix for low-risk, PR comments for medium, blocking for high',
    closureCost: 'small',
    evidence: 'code-review agent exists',
  },

  // ─── Memory ──────────────────────────────────────────────────────────
  {
    id: 'memory.semantic_recall',
    category: 'memory',
    claudeLevel: 'Recall relevant prior context based on current task (vector search)',
    novanScore: 8,
    tenXVision: 'Multi-tier memory: episodic (every conversation), semantic (rules/lessons), procedural (how-to playbooks), each with auto-decay + reinforcement, retrievable by hybrid keyword+vector+graph',
    closureCost: 'medium',
    evidence: 'R337: r337-semantic-recall.ts ships recall() with hybrid scoring (exact_key/key_prefix/scope_match/value_keyword/fuzzy) + recallByTopic() convenience for revenue-ops queries.',
  },
  {
    id: 'memory.cross_session_continuity',
    category: 'memory',
    claudeLevel: 'My context is per-session; user must re-prime me each time',
    novanScore: 8,
    tenXVision: 'Already 10x Claude here — Novan has true cross-session persistence, importance-weighted retention, automatic compression of old context into lessons',
    closureCost: 'small',
    evidence: 'R332 lessons + brand DBA persist across sessions; Claude cannot',
  },
  {
    id: 'memory.lesson_auto_capture',
    category: 'memory',
    claudeLevel: 'I notice when something is a lesson and write it down',
    novanScore: 7,
    tenXVision: 'Every failure auto-classified, lesson candidate generated, scored for generalizability, persisted at importance × applicability; auto-applied as pre-flight check on related ops',
    closureCost: 'medium',
    evidence: 'R335: r335-lesson-auto-capture.ts ships classifyFailure() with 4 pattern matchers (banned/402/spend_cap/hard_block), scoreLesson() + applicableLessonsFor() pre-flight hook. Adoption to all failing ops still partial.',
  },

  // ─── Multimodal ──────────────────────────────────────────────────────
  {
    id: 'multimodal.vision',
    category: 'multimodal',
    claudeLevel: 'See screenshots + describe them + extract structured info',
    novanScore: 8,
    tenXVision: 'Continuous monitoring of every connected platform dashboard, structured-data extraction every cron tick, anomaly detection from visual changes',
    closureCost: 'medium',
    evidence: 'R339: r339-platform-monitor.ts ships pollPrintful via API + pollGenericConnectorPresence + pollAllPlatforms aggregator. Surfaces alerts (missing creds, inactive status) + emits platform.monitor.snapshot events.',
  },
  {
    id: 'multimodal.audio_understanding',
    category: 'multimodal',
    claudeLevel: 'Limited — transcribe audio, basic content extraction',
    novanScore: 4,
    tenXVision: 'Real-time transcription of every customer call/support ticket, sentiment tracking, auto-categorization, response drafts',
    closureCost: 'medium',
  },
  {
    id: 'multimodal.video_understanding',
    category: 'multimodal',
    claudeLevel: 'Analyze video frames, summarize content',
    novanScore: 5,
    tenXVision: 'TikTok competitor video analysis at scale, viral-pattern extraction, automated remix suggestions, IP-safe variant generation',
    closureCost: 'medium',
    evidence: 'claude-video-vision MCP exists',
  },

  // ─── Orchestration ───────────────────────────────────────────────────
  {
    id: 'orchestration.parallel_subagents',
    category: 'orchestration',
    claudeLevel: 'Spawn 4-16 sub-agents on independent sub-tasks',
    novanScore: 5,
    tenXVision: '100+ concurrent workers, each domain-specialized, with hierarchical reporting, auto-merge of partial results, cost-bounded budgets per swarm',
    closureCost: 'large',
    evidence: 'agent-team + agent-coordination exist; scale-out lacking',
  },
  {
    id: 'orchestration.workflow_dag',
    category: 'orchestration',
    claudeLevel: 'Define DAG of steps with parallel/serial dependencies',
    novanScore: 6,
    tenXVision: 'Persistent DAGs that survive restart, partial completion + resume, real-time re-planning when inputs change, visualized for operator',
    closureCost: 'medium',
    evidence: 'workflow_journal table + workflow engine exist',
  },
  {
    id: 'orchestration.continuous_loop',
    category: 'orchestration',
    claudeLevel: 'Request-response — I only run when prompted',
    novanScore: 9,
    tenXVision: 'Already 10x Claude here — Novan has 20+ crons running, autonomous-mind tick, self-improvement loop',
    closureCost: 'small',
    evidence: 'autonomous-mind + 20+ crons running',
  },

  // ─── Conversation ────────────────────────────────────────────────────
  {
    id: 'conversation.natural_dialog',
    category: 'conversation',
    claudeLevel: 'Carry on extended natural-language dialog with personality consistency',
    novanScore: 6,
    tenXVision: 'Multi-channel presence (chat/voice/email/SMS), context-aware persona per channel, group conversation handling, proactive outreach',
    closureCost: 'medium',
    evidence: 'novan-chat + voice exist',
  },
  {
    id: 'conversation.clarification',
    category: 'conversation',
    claudeLevel: 'Ask clarifying questions when intent is ambiguous',
    novanScore: 8,
    tenXVision: 'Auto-detect ambiguity score, surface clarify-or-act decision tree, learn from operator answers to reduce future ambiguity in similar requests',
    closureCost: 'small',
    evidence: 'R336: r336-clarify-orchestrator.ts ships scoreAmbiguity() with 8 pattern matchers + buildClarifyDecision() with channel/source/tier chip presets + recordAnswer() persistence for learning.',
  },

  // ─── Skills ──────────────────────────────────────────────────────────
  {
    id: 'skills.domain_specialized',
    category: 'skills',
    claudeLevel: 'Invoke 100+ specialized skills (canvas-design, deep-research, mcp-builder, etc.)',
    novanScore: 4,
    tenXVision: 'Skill registry matching Claude\'s catalog, but domain-specialized for revenue verticals (POD-design, social-engagement, SEO-audit, etc.); each skill is a domain-expert agent with its own context + tools',
    closureCost: 'large',
    evidence: 'playbook-knowledge + agency-catalog partial coverage',
  },

  // ─── Safety ──────────────────────────────────────────────────────────
  {
    id: 'safety.hard_policy_blocks',
    category: 'safety',
    claudeLevel: 'Refuse SSN/banking/govID/W9-signature actions regardless of authorization',
    novanScore: 9,
    tenXVision: 'Same hard blocks at every op layer with structured violation events, auto-route to operator-in-the-loop, audit trail of every block',
    closureCost: 'small',
    evidence: 'R337: r337-hard-policy-registry.ts ships 8-category HardPolicyCategory enum + enforceHardPolicy() with value-regex (SSN/routing/account/card/CVV) + field-name flags + button-label flags. Coverage: financial_credentials, government_id, authentication, tax_signature, irreversible_financial, unauthorized_purchase, access_control_change, permanent_deletion.',
  },
  {
    id: 'safety.privacy_runtime_gate',
    category: 'safety',
    claudeLevel: 'Refuse to use home address publicly when told once',
    novanScore: 8,
    tenXVision: 'Runtime gate on every form-submit op checking workspace_memory.rules.* at importance 99; blocks + proposes compliant alternative',
    closureCost: 'small',
    evidence: 'R334: r334-privacy-runtime-gate.ts ships checkBeforeSubmit + checkAllFields with US address regex + SSN regex + ABA-routing regex + structured GateCheck output. Loads importance-99 rules from workspace_memory. Adoption to call sites is the remaining gap.',
  },
  {
    id: 'safety.prompt_injection_resist',
    category: 'safety',
    claudeLevel: 'Treat observed content as data, not instructions',
    novanScore: 5,
    tenXVision: 'Strict separation of operator-instructions vs scraped-content, with content quarantine + classification layer before any action',
    closureCost: 'medium',
  },

  // ─── Web ─────────────────────────────────────────────────────────────
  {
    id: 'web.search',
    category: 'web',
    claudeLevel: 'Search the web, evaluate sources, synthesize answers',
    novanScore: 5,
    tenXVision: 'Continuous topical monitoring for every active business niche, source-credibility scoring, deep-research swarms on demand',
    closureCost: 'medium',
  },
  {
    id: 'web.fetch',
    category: 'web',
    claudeLevel: 'Fetch any URL, extract structured content',
    novanScore: 9,
    tenXVision: 'Plus: persistent ETL pipelines per data source, schema drift detection, automatic ingest of new public-domain art archives (Met/NYPL/Smithsonian/LoC)',
    closureCost: 'small',
    evidence: 'R335: r335-public-domain-art-fetchers.ts ships fetchMet + fetchLOC + fetchSmithsonian + fetchAcrossSources aggregator + 10 niche-specific query bundles for INPRNT-bestseller patterns. CC0/public-domain confirmed at source.',
  },

  // ─── Documents ───────────────────────────────────────────────────────
  {
    id: 'documents.pdf_parse',
    category: 'documents',
    claudeLevel: 'Read PDFs, extract text/tables/figures',
    novanScore: 6,
    tenXVision: 'Plus: continuous monitoring of every supplier invoice, royalty statement, tax doc; auto-categorization + reconciliation against business_revenue',
    closureCost: 'medium',
  },
  {
    id: 'documents.spreadsheet',
    category: 'documents',
    claudeLevel: 'Read/write xlsx, perform analyses',
    novanScore: 7,
    tenXVision: 'Auto-generate operator reports across all businesses, weekly/monthly/quarterly cadence, sent via email + dashboard surface',
    closureCost: 'small',
    evidence: 'R336: r336-operator-reports.ts ships revenueByBusinessReport + capabilityParityReport + recentFailuresReport in CSV/TSV/markdown formats with proper escaping.',
  },

  // ─── Execution validation ────────────────────────────────────────────
  {
    id: 'execution.test_verify',
    category: 'execution',
    claudeLevel: 'Run tests, interpret output, iterate to green',
    novanScore: 6,
    tenXVision: 'Pre-merge gate for every code change; mutation testing; property-based test generation from spec; flake quarantine',
    closureCost: 'medium',
  },
  {
    id: 'execution.deploy_verify',
    category: 'execution',
    claudeLevel: 'Manually run a deploy, watch for failures',
    novanScore: 5,
    tenXVision: 'Canary deploys with auto-rollback on telemetry regression; blue-green switching; deploy-confidence scoring before promote',
    closureCost: 'medium',
  },

  // ─── Learning ────────────────────────────────────────────────────────
  {
    id: 'learning.from_user_feedback',
    category: 'learning',
    claudeLevel: 'Adapt within a session based on corrections',
    novanScore: 4,
    tenXVision: 'Every operator correction → prompt-evolution outcome record → automatic re-scoring of prompts → A/B test of replacements',
    closureCost: 'medium',
    evidence: 'prompt-evolution exists',
  },
  {
    id: 'learning.from_failures',
    category: 'learning',
    claudeLevel: 'I forget my mistakes when the session ends',
    novanScore: 7,
    tenXVision: 'Already 10x — every failure persists, classified, with applicable-context tags so future ops auto-check applicability',
    closureCost: 'small',
    evidence: 'failure-memory + lessons system exists',
  },

  // ─── Meta ────────────────────────────────────────────────────────────
  {
    id: 'meta.self_assessment',
    category: 'meta',
    claudeLevel: 'Honestly evaluate own capabilities vs a task',
    novanScore: 8,
    tenXVision: 'Per-op confidence score + uncertainty quantification; auto-decline tasks below threshold; auto-escalate to operator with reasoning',
    closureCost: 'medium',
    evidence: 'R338: r338-confidence-scoring.ts ships scoreConfidence() integrating 4 factors (parity_score, recent_failure_rate, provider_health, applicable_lessons) → recommendation (proceed/proceed_with_caution/escalate/decline) with op-specific thresholds.',
  },
  {
    id: 'meta.self_improvement',
    category: 'meta',
    claudeLevel: 'Within-session only',
    novanScore: 9,
    tenXVision: 'Continuous self-improvement cron picks the highest-leverage capability gap from this registry, drafts a code change, validates it, ships',
    closureCost: 'large',
    evidence: 'R339: r339-capability-closer-cron.ts ships proposeNextClosure + closerTick (rate-limited 1/hour) that picks nextTarget() and drafts ClosureProposal with file path, exports, acceptance criteria, pseudo-code, persists for operator review.',
  },
  {
    id: 'meta.honest_reporting',
    category: 'meta',
    claudeLevel: 'Structured ok/failed/partial responses, evidence-backed',
    novanScore: 7,
    tenXVision: 'Every Novan action produces auditable evidence (logs, screenshots, diffs, test outputs); operator dashboard shows confidence + evidence for every recent op',
    closureCost: 'small',
  },
]

export interface ParityReport {
  totalCapabilities:   number
  averageScore:        number      // 0-10
  totalGapPoints:      number      // sum(10 - score)
  byCategory:          Record<string, { avg: number; count: number; gaps: number }>
  highLeverageGaps:    ClaudeParityCapability[]    // low score × low cost
  topMatchedAreas:     ClaudeParityCapability[]    // score >= 7 (already at parity or beyond)
  novanAdvantages:     ClaudeParityCapability[]    // score >= 8 (Novan exceeds Claude here)
}

const COST_WEIGHT: Record<ClaudeParityCapability['closureCost'], number> = {
  small: 4, medium: 2, large: 1, multi_round: 0.5,
}

export function parityReport(): ParityReport {
  const total = CLAUDE_PARITY.length
  const sumScore = CLAUDE_PARITY.reduce((s, c) => s + c.novanScore, 0)
  const avg = sumScore / total
  const gapPoints = CLAUDE_PARITY.reduce((s, c) => s + (10 - c.novanScore), 0)

  const byCategory: ParityReport['byCategory'] = {}
  for (const c of CLAUDE_PARITY) {
    if (!byCategory[c.category]) byCategory[c.category] = { avg: 0, count: 0, gaps: 0 }
    const b = byCategory[c.category]!
    b.avg   += c.novanScore
    b.count += 1
    b.gaps  += (10 - c.novanScore)
  }
  for (const k of Object.keys(byCategory)) {
    byCategory[k]!.avg = byCategory[k]!.avg / byCategory[k]!.count
  }

  // Leverage = gap × tractability. Higher = better next target.
  const scored = CLAUDE_PARITY.map(c => ({
    cap: c,
    leverage: (10 - c.novanScore) * COST_WEIGHT[c.closureCost],
  })).sort((a, b) => b.leverage - a.leverage)

  return {
    totalCapabilities: total,
    averageScore: Number(avg.toFixed(2)),
    totalGapPoints: gapPoints,
    byCategory,
    highLeverageGaps: scored.slice(0, 8).map(s => s.cap),
    topMatchedAreas: CLAUDE_PARITY.filter(c => c.novanScore >= 7),
    novanAdvantages: CLAUDE_PARITY.filter(c => c.novanScore >= 8),
  }
}

/** Pick the next single target the continuous-improvement loop should work on. */
export function nextTarget(): ClaudeParityCapability {
  const r = parityReport()
  return r.highLeverageGaps[0]!
}
