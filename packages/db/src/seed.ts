/**
 * @ops/db — seed script
 * Inserts realistic demo data for all tables.
 * Idempotent: uses ON CONFLICT DO NOTHING.
 * Run: pnpm --filter @ops/db db:seed
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { v7 as uuidv7 } from 'uuid'
import {
  workspaces,
  workflowDefinitions,
  agents,
  businesses,
  memories,
  events,
  opportunities,
  risks,
  strategicGoals,
  insights,
  briefings,
  briefingItems,
  notifications,
  aiUsage,
} from './schema.js'

const sql = postgres(process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/ops', { max: 1 })
const db = drizzle(sql)

const WS_ID = 'default'
const NOW = Date.now()
const DAY = 86_400_000

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seed<T>(label: string, fn: () => Promise<T>): Promise<void> {
  try {
    await fn()
    console.log(`✓ ${label}`)
  } catch (err) {
    console.error(`✗ ${label}:`, err instanceof Error ? err.message : err)
  }
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const BIZ_1 = uuidv7()
const BIZ_2 = uuidv7()
const BIZ_3 = uuidv7()

const WF_1 = uuidv7()
const WF_2 = uuidv7()
const WF_3 = uuidv7()

const AGENT_1 = uuidv7()
const AGENT_2 = uuidv7()

const BRIEFING_1 = uuidv7()
const BRIEFING_2 = uuidv7()

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Seeding Novan database…\n')

  // 1. Workspace
  await seed('workspaces', () =>
    db.insert(workspaces).values([{
      id:        WS_ID,
      name:      'Acme Corp',
      slug:      'acme-corp',
      plan:      'pro',
      ownerId:   'user_acme_owner',
      settings:  { theme: 'dark', timezone: 'America/New_York', aiProvider: 'anthropic' },
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW,
    }]).onConflictDoNothing()
  )

  // 2. Businesses
  await seed('businesses', () =>
    db.insert(businesses).values([
      {
        id:          BIZ_1,
        workspaceId: WS_ID,
        name:        'Acme Corp',
        domain:      'acme.com',
        industry:    'SaaS',
        stage:       'growth',
        health:      'green',
        metrics:     { mrr: 185000, churnRate: 0.02, nps: 72, activeUsers: 3400 },
        metadata:    { founded: 2019, employees: 48, headquarters: 'New York, NY' },
        createdAt:   NOW - 30 * DAY,
        updatedAt:   NOW,
      },
      {
        id:          BIZ_2,
        workspaceId: WS_ID,
        name:        'Beta Ventures',
        domain:      'betaventures.io',
        industry:    'Fintech',
        stage:       'early',
        health:      'yellow',
        metrics:     { mrr: 22000, churnRate: 0.05, nps: 51, activeUsers: 410 },
        metadata:    { founded: 2022, employees: 12, headquarters: 'Austin, TX' },
        createdAt:   NOW - 20 * DAY,
        updatedAt:   NOW - DAY,
      },
      {
        id:          BIZ_3,
        workspaceId: WS_ID,
        name:        'Gamma Analytics',
        domain:      'gammaanalytics.com',
        industry:    'Data & Analytics',
        stage:       'scale',
        health:      'green',
        metrics:     { mrr: 540000, churnRate: 0.01, nps: 81, activeUsers: 12000 },
        metadata:    { founded: 2017, employees: 130, headquarters: 'San Francisco, CA' },
        createdAt:   NOW - 60 * DAY,
        updatedAt:   NOW,
      },
    ]).onConflictDoNothing()
  )

  // 3. Workflow definitions
  await seed('workflowDefinitions', () =>
    db.insert(workflowDefinitions).values([
      {
        id:          WF_1,
        workspaceId: WS_ID,
        name:        'Daily Executive Briefing',
        description: 'Aggregates signals from all sources and generates a prioritized executive briefing',
        version:     3,
        steps:       [
          { id: 'fetch-signals', type: 'fetch', config: { sources: ['events', 'risks', 'opportunities'] } },
          { id: 'rank-items',   type: 'ai',    config: { model: 'claude-3-5-sonnet-20241022', temperature: 0.3 } },
          { id: 'send-briefing', type: 'notify', config: { channels: ['email', 'slack'] } },
        ],
        triggers:    [{ type: 'schedule', cron: '0 8 * * 1-5', timezone: 'America/New_York' }],
        retryPolicy: { maxAttempts: 3, backoffMs: 5000, backoffMultiplier: 2 },
        timeout:     600_000,
        tags:        ['briefing', 'daily', 'executive'],
        isActive:    true,
        createdAt:   NOW - 25 * DAY,
        updatedAt:   NOW - DAY,
      },
      {
        id:          WF_2,
        workspaceId: WS_ID,
        name:        'Opportunity Scanner',
        description: 'Scans business metrics and market signals to identify new opportunities',
        version:     2,
        steps:       [
          { id: 'ingest-metrics',  type: 'fetch', config: { sources: ['businesses', 'events'] } },
          { id: 'score-signals',   type: 'ai',    config: { model: 'claude-3-5-haiku-20241022', temperature: 0.5 } },
          { id: 'create-opps',     type: 'write',  config: { table: 'opportunities' } },
        ],
        triggers:    [{ type: 'schedule', cron: '0 6 * * *', timezone: 'UTC' }],
        retryPolicy: { maxAttempts: 2, backoffMs: 3000, backoffMultiplier: 1.5 },
        timeout:     300_000,
        tags:        ['opportunities', 'scanning', 'ai'],
        isActive:    true,
        createdAt:   NOW - 15 * DAY,
        updatedAt:   NOW - 2 * DAY,
      },
      {
        id:          WF_3,
        workspaceId: WS_ID,
        name:        'Risk Monitor',
        description: 'Continuously monitors risk indicators and escalates critical issues',
        version:     1,
        steps:       [
          { id: 'fetch-risks',   type: 'fetch', config: { sources: ['risks', 'events'] } },
          { id: 'evaluate',      type: 'ai',    config: { model: 'claude-3-5-sonnet-20241022', temperature: 0.2 } },
          { id: 'alert-if-high', type: 'conditional', config: { threshold: 0.7 } },
        ],
        triggers:    [{ type: 'schedule', cron: '*/30 * * * *', timezone: 'UTC' }],
        retryPolicy: { maxAttempts: 3, backoffMs: 2000, backoffMultiplier: 2 },
        timeout:     120_000,
        tags:        ['risk', 'monitoring', 'alerts'],
        isActive:    true,
        createdAt:   NOW - 10 * DAY,
        updatedAt:   NOW - 3 * DAY,
      },
    ]).onConflictDoNothing()
  )

  // 4. Agents
  await seed('agents', () =>
    db.insert(agents).values([
      {
        id:           AGENT_1,
        workspaceId:  WS_ID,
        name:         'Strategist',
        description:  'High-level planning agent that synthesizes signals into strategic recommendations',
        type:         'llm',
        status:       'idle',
        capabilities: ['briefing', 'opportunity-scoring', 'goal-alignment', 'risk-assessment'],
        config:       { model: 'claude-3-5-sonnet-20241022', maxTokens: 8192, temperature: 0.4 },
        lastActiveAt: NOW - 2 * 60 * 1000,
        heartbeatAt:  NOW - 30 * 1000,
        createdAt:    NOW - 20 * DAY,
        updatedAt:    NOW - 30 * 1000,
      },
      {
        id:           AGENT_2,
        workspaceId:  WS_ID,
        name:         'Operator',
        description:  'Execution agent responsible for running workflows, monitoring queues, and handling retries',
        type:         'workflow',
        status:       'running',
        capabilities: ['workflow-execution', 'retry-handling', 'approval-routing', 'notification-dispatch'],
        config:       { concurrency: 5, timeoutMs: 300_000, queues: ['default', 'priority', 'briefing'] },
        lastActiveAt: NOW - 5 * 1000,
        heartbeatAt:  NOW - 5 * 1000,
        createdAt:    NOW - 20 * DAY,
        updatedAt:    NOW - 5 * 1000,
      },
    ]).onConflictDoNothing()
  )

  // 5. Memories (10 rows)
  await seed('memories', () =>
    db.insert(memories).values([
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'fact',
        content:     'Acme Corp achieved 185K MRR in Q1 2026, up 22% QoQ.',
        summary:     'MRR hit 185K (+22% QoQ)',
        confidence:  0.98,
        tags:        ['finance', 'mrr', 'growth'],
        source:      'briefing',
        sourceRef:   BRIEFING_1,
        createdAt:   NOW - 5 * DAY,
        updatedAt:   NOW - 5 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'observation',
        content:     'Customer churn spiked to 4.8% in the enterprise segment during March due to a pricing change.',
        summary:     'Enterprise churn spike 4.8% (March)',
        confidence:  0.85,
        tags:        ['churn', 'enterprise', 'pricing'],
        source:      'analytics',
        createdAt:   NOW - 8 * DAY,
        updatedAt:   NOW - 8 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'decision',
        content:     'Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.',
        summary:     'AI roadmap accelerated; mobile deferred to Q3',
        confidence:  1.0,
        tags:        ['strategy', 'roadmap', 'ai'],
        source:      'meeting',
        sourceRef:   'meeting-2026-04-01',
        createdAt:   NOW - 12 * DAY,
        updatedAt:   NOW - 12 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'lesson',
        content:     'Outbound campaigns perform 2.3x better when triggered within 24h of a product usage milestone.',
        summary:     'Milestone-triggered outbound 2.3x more effective',
        confidence:  0.88,
        tags:        ['sales', 'outbound', 'timing'],
        source:      'experiment',
        createdAt:   NOW - 20 * DAY,
        updatedAt:   NOW - 20 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'goal',
        content:     'Reach 250K MRR by end of Q2 2026 by expanding into mid-market accounts.',
        summary:     '250K MRR by Q2 2026',
        confidence:  0.9,
        tags:        ['goal', 'mrr', 'mid-market'],
        source:      'planning',
        createdAt:   NOW - 14 * DAY,
        updatedAt:   NOW - 14 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'strategic',
        content:     'Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.',
        summary:     'Gamma partnership = 12K user distribution opportunity',
        confidence:  0.75,
        tags:        ['partnerships', 'distribution', 'gamma'],
        source:      'briefing',
        createdAt:   NOW - 3 * DAY,
        updatedAt:   NOW - 3 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'operational',
        content:     'Weekly AI batch processing runs consume an average of $340 in API costs; caching embeddings cuts this by 60%.',
        summary:     'AI costs $340/week; caching saves 60%',
        confidence:  0.95,
        tags:        ['costs', 'ai', 'optimization'],
        source:      'monitoring',
        createdAt:   NOW - 6 * DAY,
        updatedAt:   NOW - 6 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'idea',
        content:     'Build an AI-powered competitive intelligence digest that summarizes competitor product releases weekly.',
        summary:     'Weekly AI competitor digest idea',
        confidence:  0.7,
        tags:        ['product', 'competitive-intelligence', 'idea'],
        source:      'brainstorm',
        createdAt:   NOW - 9 * DAY,
        updatedAt:   NOW - 9 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'observation',
        content:     'The free-to-paid conversion rate increased from 6.2% to 9.1% after adding contextual upgrade prompts.',
        summary:     'Conversion rate improved to 9.1% (+2.9pp)',
        confidence:  0.93,
        tags:        ['conversion', 'growth', 'freemium'],
        source:      'analytics',
        createdAt:   NOW - 4 * DAY,
        updatedAt:   NOW - 4 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        type:        'fact',
        content:     'Support ticket volume correlates (r=0.82) with the number of new features released per sprint.',
        summary:     'Feature velocity drives support volume (r=0.82)',
        confidence:  0.87,
        tags:        ['support', 'engineering', 'velocity'],
        source:      'analysis',
        createdAt:   NOW - 11 * DAY,
        updatedAt:   NOW - 11 * DAY,
      },
    ]).onConflictDoNothing()
  )

  // 6. Events (20 rows)
  await seed('events', () => {
    const makeEvent = (
      type: string,
      payload: Record<string, unknown>,
      source: string,
      daysAgo: number,
    ) => ({
      id:            uuidv7(),
      type,
      workspaceId:   WS_ID,
      payload,
      traceId:       uuidv7(),
      correlationId: uuidv7(),
      source,
      version:       1,
      createdAt:     NOW - daysAgo * DAY,
    })

    return db.insert(events).values([
      makeEvent('workflow.run.completed',    { workflowId: WF_1, durationMs: 4821, status: 'completed' }, 'workflow-engine', 0.1),
      makeEvent('briefing.generated',        { briefingId: BRIEFING_1, itemCount: 12, generatedMs: 3200 }, 'briefing-service', 0.2),
      makeEvent('opportunity.identified',    { title: 'Mid-market expansion', score: 0.84, type: 'strategic' }, 'opportunity-scanner', 0.5),
      makeEvent('risk.detected',             { title: 'Churn acceleration risk', severity: 'high', riskScore: 0.72 }, 'risk-monitor', 0.8),
      makeEvent('agent.heartbeat',           { agentId: AGENT_2, status: 'running', activeJobs: 2 }, 'agent-operator', 1),
      makeEvent('workflow.run.completed',    { workflowId: WF_2, durationMs: 9134, status: 'completed' }, 'workflow-engine', 1.1),
      makeEvent('goal.progress.updated',     { goalId: 'goal-mrr-250k', progress: 0.74, delta: 0.06 }, 'goal-tracker', 1.5),
      makeEvent('insight.created',           { insightId: uuidv7(), category: 'revenue', confidence: 0.88 }, 'ai-analyst', 2),
      makeEvent('approval.requested',        { runId: uuidv7(), operationLabel: 'Send pricing email to enterprise list', risk: 'medium' }, 'approval-service', 2.2),
      makeEvent('approval.resolved',         { approvalId: uuidv7(), status: 'approved', resolvedBy: 'user_acme_owner' }, 'approval-service', 2.3),
      makeEvent('risk.escalated',            { riskId: uuidv7(), severity: 'critical', title: 'Key account renewal at risk' }, 'risk-monitor', 3),
      makeEvent('workflow.run.failed',       { workflowId: WF_3, error: 'Rate limit exceeded on AI provider', attempt: 2 }, 'workflow-engine', 3.5),
      makeEvent('briefing.generated',        { briefingId: BRIEFING_2, itemCount: 9, generatedMs: 2780 }, 'briefing-service', 4),
      makeEvent('opportunity.status.changed',{ opportunityId: uuidv7(), from: 'identified', to: 'evaluating' }, 'ops-api', 4.5),
      makeEvent('memory.created',            { memoryType: 'lesson', tags: ['sales', 'outbound'] }, 'memory-service', 5),
      makeEvent('agent.status.changed',      { agentId: AGENT_1, from: 'running', to: 'idle' }, 'agent-controller', 6),
      makeEvent('workflow.run.completed',    { workflowId: WF_1, durationMs: 5102, status: 'completed' }, 'workflow-engine', 7),
      makeEvent('ai.usage.logged',           { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', tokens: 12400, costUsd: 0.037 }, 'ai-usage-tracker', 8),
      makeEvent('notification.sent',         { channel: 'slack', title: 'New critical risk detected', type: 'error' }, 'notification-service', 9),
      makeEvent('goal.completed',            { title: 'Q1 NPS target ≥70', progress: 1.0, completedAt: NOW - 10 * DAY }, 'goal-tracker', 10),
    ]).onConflictDoNothing()
  })

  // 7. Opportunities (5 rows)
  await seed('opportunities', () =>
    db.insert(opportunities).values([
      {
        id:                 uuidv7(),
        workspaceId:        WS_ID,
        businessId:         BIZ_1,
        title:              'Mid-market expansion via inside sales',
        description:        'Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months.',
        type:               'strategic',
        status:             'evaluating',
        priority:           90,
        valuePotential:     60000,
        confidence:         0.84,
        category:           'growth',
        evidence:           [{ type: 'analysis', note: 'TAM in 50-200 employee segment: 8,400 companies' }],
        tags:               ['sales', 'mid-market', 'expansion'],
        estimatedROI:       4.2,
        estimatedEffort:    'high',
        riskLevel:          'medium',
        strategicAlignment: 0.91,
        score:              0.84,
        scoreBreakdown:     { roi: 0.88, effort: 0.6, risk: 0.75, alignment: 0.91 },
        linkedMemoryIds:    [],
        linkedWorkflowIds:  [],
        createdAt:          NOW - 3 * DAY,
        updatedAt:          NOW - DAY,
      },
      {
        id:                 uuidv7(),
        workspaceId:        WS_ID,
        businessId:         BIZ_1,
        title:              'AI-powered onboarding automation',
        description:        'Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4.',
        type:               'automation',
        status:             'identified',
        priority:           80,
        valuePotential:     28000,
        confidence:         0.78,
        category:           'retention',
        evidence:           [{ type: 'user-research', note: '64% of churned users cited slow onboarding' }],
        tags:               ['ai', 'onboarding', 'retention'],
        estimatedROI:       3.1,
        estimatedEffort:    'medium',
        riskLevel:          'low',
        strategicAlignment: 0.85,
        score:              0.79,
        scoreBreakdown:     { roi: 0.77, effort: 0.8, risk: 0.9, alignment: 0.85 },
        linkedMemoryIds:    [],
        linkedWorkflowIds:  [],
        createdAt:          NOW - 5 * DAY,
        updatedAt:          NOW - 2 * DAY,
      },
      {
        id:                 uuidv7(),
        workspaceId:        WS_ID,
        businessId:         BIZ_3,
        title:              'Gamma Analytics distribution partnership',
        description:        'Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one.',
        type:               'business',
        status:             'evaluating',
        priority:           95,
        valuePotential:     120000,
        confidence:         0.72,
        category:           'partnerships',
        evidence:           [{ type: 'conversation', note: 'Initial partnership call held 2026-05-02' }],
        tags:               ['partnership', 'distribution', 'enterprise'],
        estimatedROI:       6.5,
        estimatedEffort:    'medium',
        riskLevel:          'low',
        strategicAlignment: 0.94,
        score:              0.88,
        scoreBreakdown:     { roi: 0.95, effort: 0.8, risk: 0.9, alignment: 0.94 },
        linkedMemoryIds:    [],
        linkedWorkflowIds:  [],
        createdAt:          NOW - 2 * DAY,
        updatedAt:          NOW - DAY,
      },
      {
        id:                 uuidv7(),
        workspaceId:        WS_ID,
        businessId:         BIZ_1,
        title:              'Annual plan upsell campaign',
        description:        'Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure.',
        type:               'revenue',
        status:             'identified',
        priority:           75,
        valuePotential:     42000,
        confidence:         0.88,
        category:           'monetization',
        evidence:           [{ type: 'cohort-analysis', note: '6mo+ users have 1.2% monthly churn vs 3.4% overall' }],
        tags:               ['upsell', 'annual-plan', 'retention'],
        estimatedROI:       2.8,
        estimatedEffort:    'low',
        riskLevel:          'low',
        strategicAlignment: 0.82,
        score:              0.83,
        scoreBreakdown:     { roi: 0.73, effort: 0.95, risk: 0.9, alignment: 0.82 },
        linkedMemoryIds:    [],
        linkedWorkflowIds:  [],
        createdAt:          NOW - 7 * DAY,
        updatedAt:          NOW - 3 * DAY,
      },
      {
        id:                 uuidv7(),
        workspaceId:        WS_ID,
        businessId:         BIZ_2,
        title:              'Beta Ventures fintech integration',
        description:        'Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical.',
        type:               'operational',
        status:             'identified',
        priority:           55,
        valuePotential:     15000,
        confidence:         0.65,
        category:           'product',
        evidence:           [{ type: 'customer-request', note: 'Feature request submitted by Beta Ventures CTO' }],
        tags:               ['fintech', 'api', 'integration'],
        estimatedROI:       1.8,
        estimatedEffort:    'high',
        riskLevel:          'medium',
        strategicAlignment: 0.6,
        score:              0.57,
        scoreBreakdown:     { roi: 0.48, effort: 0.4, risk: 0.7, alignment: 0.6 },
        linkedMemoryIds:    [],
        linkedWorkflowIds:  [],
        createdAt:          NOW - 10 * DAY,
        updatedAt:          NOW - 6 * DAY,
      },
    ]).onConflictDoNothing()
  )

  // 8. Risks (5 rows)
  await seed('risks', () =>
    db.insert(risks).values([
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_1,
        title:       'Key account renewal at risk',
        description: 'Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days.',
        severity:    'critical',
        probability: 0.68,
        impact:      0.95,
        riskScore:   0.65,
        category:    'revenue',
        status:      'open',
        mitigations: [
          { action: 'Schedule executive business reviews', owner: 'CS lead', dueDate: NOW + 7 * DAY },
          { action: 'Activate dedicated success manager', owner: 'ops', dueDate: NOW + 3 * DAY },
        ],
        detectedAt:  NOW - 2 * DAY,
        createdAt:   NOW - 2 * DAY,
        updatedAt:   NOW - DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_1,
        title:       'AI provider rate limit exposure',
        description: 'Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures.',
        severity:    'high',
        probability: 0.55,
        impact:      0.7,
        riskScore:   0.39,
        category:    'technical',
        status:      'open',
        mitigations: [
          { action: 'Implement exponential backoff and queue smoothing', owner: 'engineering', dueDate: NOW + 14 * DAY },
          { action: 'Apply for Anthropic tier-3 upgrade', owner: 'ops', dueDate: NOW + 7 * DAY },
        ],
        detectedAt:  NOW - 4 * DAY,
        createdAt:   NOW - 4 * DAY,
        updatedAt:   NOW - 2 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_2,
        title:       'Beta Ventures burn rate',
        description: 'Beta Ventures has 7 months of runway at current burn. Without new funding or revenue growth, they may need to cut the Acme subscription.',
        severity:    'medium',
        probability: 0.4,
        impact:      0.3,
        riskScore:   0.12,
        category:    'customer',
        status:      'monitoring',
        mitigations: [
          { action: 'Offer flexible billing terms and usage-based discount', owner: 'sales', dueDate: NOW + 30 * DAY },
        ],
        detectedAt:  NOW - 7 * DAY,
        createdAt:   NOW - 7 * DAY,
        updatedAt:   NOW - 5 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_1,
        title:       'Competitor feature parity threat',
        description: 'A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months.',
        severity:    'high',
        probability: 0.6,
        impact:      0.65,
        riskScore:   0.39,
        category:    'competitive',
        status:      'open',
        mitigations: [
          { action: 'Accelerate differentiating AI features to Q2', owner: 'product', dueDate: NOW + 45 * DAY },
          { action: 'Brief sales team on competitive objection handling', owner: 'sales-enablement', dueDate: NOW + 10 * DAY },
        ],
        detectedAt:  NOW - 9 * DAY,
        createdAt:   NOW - 9 * DAY,
        updatedAt:   NOW - 4 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_1,
        title:       'Data privacy compliance gap',
        description: 'GDPR audit identified that AI-generated memory records may contain PII that is not subject to automated deletion schedules.',
        severity:    'medium',
        probability: 0.35,
        impact:      0.55,
        riskScore:   0.19,
        category:    'compliance',
        status:      'in_progress',
        mitigations: [
          { action: 'Implement PII scanning on memory ingestion', owner: 'engineering', dueDate: NOW + 21 * DAY },
          { action: 'Add automated expiry to memory records with detected PII', owner: 'engineering', dueDate: NOW + 28 * DAY },
        ],
        detectedAt:  NOW - 12 * DAY,
        createdAt:   NOW - 12 * DAY,
        updatedAt:   NOW - 3 * DAY,
      },
    ]).onConflictDoNothing()
  )

  // 9. Strategic goals (3 rows)
  await seed('strategicGoals', () =>
    db.insert(strategicGoals).values([
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_1,
        title:       'Reach 250K MRR by end of Q2 2026',
        description: 'Drive revenue growth through mid-market expansion, annual plan conversions, and reduced churn.',
        status:      'active',
        horizon:     'quarter',
        targetDate:  NOW + 47 * DAY,
        progress:    0.74,
        keyResults:  [
          { kr: 'Close 8 new mid-market accounts', target: 8, current: 5 },
          { kr: 'Convert 100 monthly subs to annual', target: 100, current: 68 },
          { kr: 'Reduce churn to <2%', target: 0.02, current: 0.028 },
        ],
        owners:      ['ceo', 'vp-sales'],
        tags:        ['revenue', 'growth', 'q2-2026'],
        createdAt:   NOW - 14 * DAY,
        updatedAt:   NOW - DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_1,
        title:       'Ship AI-native v2 product by Q3 2026',
        description: 'Rebuild core user experience around AI workflows, autonomous briefings, and proactive insights.',
        status:      'active',
        horizon:     'annual',
        targetDate:  NOW + 138 * DAY,
        progress:    0.31,
        keyResults:  [
          { kr: 'Launch AI briefings to 100% of accounts', target: 1.0, current: 0.15 },
          { kr: 'Achieve 70% weekly active usage of AI features', target: 0.7, current: 0.22 },
          { kr: 'NPS score ≥80 post-launch', target: 80, current: null },
        ],
        owners:      ['cto', 'vp-product'],
        tags:        ['product', 'ai', 'q3-2026'],
        createdAt:   NOW - 30 * DAY,
        updatedAt:   NOW - 5 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        businessId:  BIZ_1,
        title:       'Establish first strategic partnership by Q2 2026',
        description: 'Close a go-to-market partnership with a complementary data or analytics platform.',
        status:      'active',
        horizon:     'quarter',
        targetDate:  NOW + 47 * DAY,
        progress:    0.4,
        keyResults:  [
          { kr: 'Sign partnership agreement with Gamma Analytics', target: 1, current: 0 },
          { kr: 'Generate 50 qualified leads via partner channel', target: 50, current: 0 },
        ],
        owners:      ['ceo', 'vp-partnerships'],
        tags:        ['partnerships', 'q2-2026'],
        createdAt:   NOW - 10 * DAY,
        updatedAt:   NOW - 2 * DAY,
      },
    ]).onConflictDoNothing()
  )

  // 10. Insights (5 rows)
  await seed('insights', () =>
    db.insert(insights).values([
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Revenue concentration risk: top 5 accounts = 38% of MRR',
        body:        'Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.',
        category:    'revenue',
        confidence:  0.93,
        source:      'ai-analyst',
        tags:        ['concentration', 'risk', 'mrr'],
        dismissed:   false,
        actedOn:     false,
        createdAt:   NOW - DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Onboarding completion at day-3 predicts 90-day retention with 79% accuracy',
        body:        'Analysis of 2,400 accounts shows that users who complete the onboarding checklist within 3 days have a 91% retention rate at 90 days vs 41% for those who do not. Prioritising onboarding nudges in the first 72 hours is the highest-leverage retention lever available.',
        category:    'product',
        confidence:  0.88,
        source:      'ai-analyst',
        tags:        ['onboarding', 'retention', 'prediction'],
        dismissed:   false,
        actedOn:     true,
        createdAt:   NOW - 3 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Tuesday morning sends outperform Friday sends by 31% in email open rate',
        body:        'Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.',
        category:    'marketing',
        confidence:  0.81,
        source:      'ai-analyst',
        tags:        ['email', 'timing', 'campaigns'],
        dismissed:   false,
        actedOn:     false,
        createdAt:   NOW - 5 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'AI workflow usage correlates with 2.1x higher NPS',
        body:        'Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.',
        category:    'product',
        confidence:  0.85,
        source:      'ai-analyst',
        tags:        ['ai', 'nps', 'satisfaction'],
        dismissed:   false,
        actedOn:     false,
        createdAt:   NOW - 7 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Opportunity pipeline value increased 48% in the last 30 days',
        body:        'The combined estimated value of opportunities in "identified" and "evaluating" status grew from $148K to $219K over the past 30 days. Top contributors: Gamma Analytics partnership ($120K) and mid-market expansion ($60K). If both convert, H2 revenue targets are materially de-risked.',
        category:    'strategic',
        confidence:  0.79,
        source:      'ai-analyst',
        tags:        ['opportunities', 'pipeline', 'growth'],
        dismissed:   false,
        actedOn:     false,
        createdAt:   NOW - 2 * DAY,
      },
    ]).onConflictDoNothing()
  )

  // 11. Briefings (2 rows) + briefing items
  await seed('briefings', () =>
    db.insert(briefings).values([
      {
        id:          BRIEFING_1,
        workspaceId: WS_ID,
        status:      'ready',
        requestedBy: 'system',
        traceId:     uuidv7(),
        windowMs:    86_400_000,
        summary:     'Strong week overall. Revenue pipeline growing. One critical risk (key account renewals) requires immediate action. AI feature adoption accelerating.',
        generatedAt: NOW - 5 * DAY,
        createdAt:   NOW - 5 * DAY,
      },
      {
        id:          BRIEFING_2,
        workspaceId: WS_ID,
        status:      'ready',
        requestedBy: 'system',
        traceId:     uuidv7(),
        windowMs:    86_400_000,
        summary:     'Steady progress on Q2 goals. Partnership evaluation with Gamma Analytics advancing. Monitor AI rate-limit risk closely. Three workflow runs completed without issues.',
        generatedAt: NOW - DAY,
        createdAt:   NOW - DAY,
      },
    ]).onConflictDoNothing()
  )

  await seed('briefingItems', () =>
    db.insert(briefingItems).values([
      {
        id:          uuidv7(),
        briefingId:  BRIEFING_1,
        workspaceId: WS_ID,
        section:     'top_priorities',
        title:       'Activate key account retention plan',
        body:        'Three enterprise accounts (combined ARR 210K) are at renewal risk. Escalate to CS lead immediately and schedule executive business reviews.',
        confidence:  0.91,
        isLowConfidence: false,
        source:      'risks',
        priority:    100,
        metadata:    { riskSeverity: 'critical' },
        createdAt:   NOW - 5 * DAY,
      },
      {
        id:          uuidv7(),
        briefingId:  BRIEFING_1,
        workspaceId: WS_ID,
        section:     'opportunities',
        title:       'Gamma Analytics partnership ready to advance',
        body:        'Initial call complete. Next step: send term sheet for co-sell agreement. Potential 120K revenue in year one.',
        confidence:  0.78,
        isLowConfidence: false,
        source:      'opportunities',
        priority:    90,
        metadata:    { opportunityType: 'business' },
        createdAt:   NOW - 5 * DAY,
      },
      {
        id:          uuidv7(),
        briefingId:  BRIEFING_2,
        workspaceId: WS_ID,
        section:     'risks',
        title:       'AI provider rate limits approaching capacity',
        body:        'Usage at 82% of tier-2 limits. Engineering should implement queue smoothing before next batch run.',
        confidence:  0.87,
        isLowConfidence: false,
        source:      'events',
        priority:    80,
        metadata:    { category: 'technical' },
        createdAt:   NOW - DAY,
      },
      {
        id:          uuidv7(),
        briefingId:  BRIEFING_2,
        workspaceId: WS_ID,
        section:     'next_actions',
        title:       'Schedule mid-market outbound campaign for Tuesday',
        body:        'Email analysis shows Tuesday 8-10am outperforms all other slots by 31%. Align campaign timing accordingly.',
        confidence:  0.82,
        isLowConfidence: false,
        source:      'insights',
        priority:    70,
        metadata:    { insightCategory: 'marketing' },
        createdAt:   NOW - DAY,
      },
    ]).onConflictDoNothing()
  )

  // 12. Notifications (5 rows)
  await seed('notifications', () =>
    db.insert(notifications).values([
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Critical risk: Key account renewals at risk',
        body:        'Three enterprise accounts with combined ARR of $210K have not logged in for 45+ days. Renewal dates are within 60 days.',
        type:        'error',
        category:    'risk',
        read:        false,
        dismissed:   false,
        sourceType:  'risk',
        actionUrl:   '/risks',
        createdAt:   NOW - 2 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Executive briefing ready',
        body:        'Your daily briefing for May 13 is ready. 12 items across priorities, risks, and opportunities.',
        type:        'info',
        category:    'workflow',
        read:        true,
        dismissed:   false,
        sourceType:  'briefing',
        sourceId:    BRIEFING_2,
        actionUrl:   '/briefings',
        createdAt:   NOW - DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Approval required: Send pricing email',
        body:        'Workflow "Q2 Pricing Campaign" is awaiting your approval before sending to 3,400 subscribers.',
        type:        'warning',
        category:    'approval',
        read:        false,
        dismissed:   false,
        sourceType:  'workflow_run',
        actionUrl:   '/approvals',
        createdAt:   NOW - 3 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'Goal on track: 250K MRR target',
        body:        'You are 74% toward the Q2 MRR goal with 47 days remaining. Current trajectory suggests on-time completion.',
        type:        'success',
        category:    'goal',
        read:        true,
        dismissed:   false,
        sourceType:  'strategic_goal',
        actionUrl:   '/goals',
        createdAt:   NOW - 4 * DAY,
      },
      {
        id:          uuidv7(),
        workspaceId: WS_ID,
        title:       'New high-confidence opportunity identified',
        body:        'AI scanner identified a partnership opportunity with Gamma Analytics scored at 0.88 — highest in 30 days.',
        type:        'info',
        category:    'opportunity',
        read:        false,
        dismissed:   false,
        sourceType:  'opportunity',
        actionUrl:   '/opportunities',
        createdAt:   NOW - 2 * DAY,
      },
    ]).onConflictDoNothing()
  )

  // 13. AI usage (10 rows)
  await seed('aiUsage', () =>
    db.insert(aiUsage).values([
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 8400,  outputTokens: 1820, costUsd: 0.038, latencyMs: 2340, cached: false, taskType: 'briefing-generation',    timestamp: NOW - 0.2 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-5-haiku-20241022',  promptTokens: 3200,  outputTokens: 640,  costUsd: 0.006, latencyMs: 820,  cached: true,  taskType: 'opportunity-scoring',     timestamp: NOW - 0.5 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 12100, outputTokens: 2400, costUsd: 0.047, latencyMs: 3180, cached: false, taskType: 'risk-evaluation',         timestamp: NOW - DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'openai',    model: 'text-embedding-3-small',     promptTokens: 4800,  outputTokens: 0,    costUsd: 0.001, latencyMs: 310,  cached: false, taskType: 'memory-embedding',        timestamp: NOW - 1.5 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 9600,  outputTokens: 1960, costUsd: 0.041, latencyMs: 2670, cached: true,  taskType: 'insight-generation',      timestamp: NOW - 2 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-5-haiku-20241022',  promptTokens: 2800,  outputTokens: 520,  costUsd: 0.005, latencyMs: 740,  cached: false, taskType: 'opportunity-scoring',     timestamp: NOW - 3 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'openai',    model: 'text-embedding-3-small',     promptTokens: 6200,  outputTokens: 0,    costUsd: 0.001, latencyMs: 290,  cached: false, taskType: 'memory-embedding',        timestamp: NOW - 4 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 7800,  outputTokens: 1640, costUsd: 0.034, latencyMs: 2190, cached: false, taskType: 'briefing-generation',    timestamp: NOW - 5 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-opus-20240229',     promptTokens: 5200,  outputTokens: 1100, costUsd: 0.094, latencyMs: 4820, cached: false, taskType: 'strategic-planning',     timestamp: NOW - 7 * DAY },
      { id: uuidv7(), workspaceId: WS_ID, provider: 'anthropic', model: 'claude-3-5-haiku-20241022',  promptTokens: 1900,  outputTokens: 380,  costUsd: 0.003, latencyMs: 610,  cached: true,  taskType: 'event-classification',   timestamp: NOW - 9 * DAY },
    ]).onConflictDoNothing()
  )

  console.log('\nSeed complete.')
  await sql.end()
}

main().catch((err) => {
  console.error('Fatal seed error:', err)
  process.exit(1)
})
