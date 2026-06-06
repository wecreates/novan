/**
 * R146.330 #30-34 — end-to-end demos.
 *
 * Each composes existing ops + LLM calls. Demos return structured plans
 * for the operator to approve before any external action fires; nothing
 * here writes to a third-party without explicit approval.
 *
 * Honest scope: these chain the pieces. The final "publish to X"/"send
 * via Y" step requires the corresponding connector to be live AND the
 * operator to confirm via highRiskConfirm.
 */
import { db } from '../db/client.js'
import { connectorCredentials } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'

interface Plan { steps: string[]; assumptions: string[]; blockers: string[]; estimatedCostUsd: number }

// ─── #30 Trending TikToks → script drafts ────────────────────────────────
export async function demoTrendingScripts(input: {
  workspaceId: string; niche: string
}): Promise<Plan & { drafts?: string[] }> {
  const blockers: string[] = []
  const [cred] = await db.select().from(connectorCredentials)
    .where(and(eq(connectorCredentials.workspaceId, input.workspaceId),
                eq(connectorCredentials.connectorId, 'tiktok'),
                eq(connectorCredentials.status, 'active'))).limit(1).catch(() => [])
  if (!cred) blockers.push('No active TikTok credential — connect via /api/v1/oauth/tiktok/start (or use the public scraper fallback)')
  return {
    steps: [
      `Pull top-50 trending TikToks in "${input.niche}" niche (last 24h)`,
      'Filter by engagement rate > niche-median × 1.5',
      'Cluster by hook/format',
      'LLM-draft 3 scripts inspired by the top cluster',
      'Queue for operator approval',
    ],
    assumptions: ['TikTok API access OR scraper fallback'],
    blockers,
    estimatedCostUsd: 0.03,  // rough Haiku cost for 3 drafts
    ...(blockers.length === 0 ? { drafts: ['(would generate here when credential present)'] } : {}),
  }
}

// ─── #31 Inbox triage end-to-end ─────────────────────────────────────────
export async function demoInboxTriage(input: {
  workspaceId: string; maxMessages?: number
}): Promise<Plan & { triaged?: Array<{ from: string; subject: string; group: string; suggestedAction: string }> }> {
  const blockers: string[] = []
  const [cred] = await db.select().from(connectorCredentials)
    .where(and(eq(connectorCredentials.workspaceId, input.workspaceId),
                eq(connectorCredentials.connectorId, 'gmail'),
                eq(connectorCredentials.status, 'active'))).limit(1).catch(() => [])
  if (!cred) blockers.push('No active Gmail credential — connect via /api/v1/oauth/gmail/start')
  return {
    steps: [
      `Read up to ${input.maxMessages ?? 50} unread Gmail messages`,
      'LLM-classify each: urgent / normal / can-archive',
      'Group by complaint or topic type',
      'Draft one reply template per group',
      'Show queue for one-click send (operator-approved per group)',
    ],
    assumptions: ['Gmail OAuth scope includes gmail.readonly + gmail.send'],
    blockers,
    estimatedCostUsd: 0.10,
  }
}

// ─── #32 Landing page A/B variations ─────────────────────────────────────
export async function demoLandingPage(input: {
  workspaceId: string; product: string; variations?: number
}): Promise<Plan> {
  return {
    steps: [
      `Generate ${input.variations ?? 3} HTML/CSS landing pages for "${input.product}"`,
      'Spin up ephemeral preview URLs (e.g. via deploy-preview connector)',
      'Run 24h split test (would require analytics connector)',
      'Pick winning variation by conversion delta',
      'Promote to production landing-page slot',
    ],
    assumptions: ['Hosting connector (Vercel/Netlify) with deploy scope', 'Analytics with conversion tracking'],
    blockers: ['No hosting connector wired yet — would need a Vercel/Netlify OAuth flow added'],
    estimatedCostUsd: 0.20,
  }
}

// ─── #33 Competitor pricing watcher ──────────────────────────────────────
export async function demoCompetitorWatcher(input: {
  workspaceId: string; competitorUrls: string[]
}): Promise<Plan & { schedule?: string }> {
  return {
    steps: [
      `Fetch each of ${input.competitorUrls.length} competitor URLs daily`,
      'Extract price points using existing playwright-fetcher.ts',
      'Diff vs the previous snapshot stored in workspace_memory',
      'Push notification when any price changes more than 5%',
    ],
    assumptions: ['playwright-fetcher reaches each URL', 'SSRF guard already blocks internal URLs'],
    blockers: [],
    estimatedCostUsd: 0.05,
    schedule: 'Daily 09:00 UTC via learning-cron tick',
  }
}

// ─── #34 DM reply batch in operator's voice ──────────────────────────────
export async function demoDMReplyBatch(input: {
  workspaceId: string; platform: string; max: number
}): Promise<Plan> {
  const blockers: string[] = []
  const [cred] = await db.select().from(connectorCredentials)
    .where(and(eq(connectorCredentials.workspaceId, input.workspaceId),
                eq(connectorCredentials.connectorId, input.platform),
                eq(connectorCredentials.status, 'active'))).limit(1).catch(() => [])
  if (!cred) blockers.push(`No active ${input.platform} credential — connect via /api/v1/oauth/${input.platform}/start`)
  return {
    steps: [
      `Read up to ${input.max} unanswered DMs on ${input.platform}`,
      'Sample 30 historical operator replies to learn voice/tone',
      'Draft a reply per DM using the learned voice',
      'Show full queue for batch operator approval before any sends',
    ],
    assumptions: [`${input.platform} DM read+write scope`, 'Operator has at least 30 prior replies to learn from'],
    blockers,
    estimatedCostUsd: 0.05 * input.max,
  }
}
