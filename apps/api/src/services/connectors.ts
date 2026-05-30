/**
 * connectors.ts — Universal connector foundation.
 *
 * Three concerns:
 *
 *   1. REGISTRY — known connector definitions (kind: github, slack, …).
 *      Registered once at boot via `seedConnectorRegistry()`. Each
 *      entry declares: authType, supported actions, blocked actions,
 *      risk level, and a `handler` that performs the actual API call.
 *      Handlers ship as `not_implemented` stubs until the SDK is wired.
 *
 *   2. ACCOUNTS — per-workspace linked accounts. Credentials live in
 *      secrets_vault; this layer just tracks status, permission, scopes.
 *
 *   3. ACTION RUNTIME — the 7-stage pipeline every action must traverse:
 *      intent → permission → policy → dry_run → approval → execute → log.
 *      Each stage is its own function; the orchestrator (`dispatch`)
 *      stops the moment a stage rejects.
 *
 * Hard rules (enforced in code, not just policy):
 *   - Purchase / payment / banking intents BLOCK at policy stage
 *     regardless of approval. Constant list, not config.
 *   - Plaintext credentials NEVER leave this module. The handler call
 *     receives a *resolver* that fetches the secret on demand.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  connectors, connectorAccounts, connectorActions, events, secretsVault,
  connectorKillSwitches, connectorRateLimits,
} from '../db/schema.js'
import { revealSecret } from './secrets-vault.js'

// ── Types ─────────────────────────────────────────────────────────────

export type AuthType   = 'oauth' | 'api_key' | 'token' | 'session' | 'webhook'
export type RiskLevel  = 'low' | 'medium' | 'high'
export type Permission = 'read' | 'draft' | 'publish' | 'admin'

export type ActionPhase =
  | 'queued' | 'permission_check' | 'policy_check' | 'dry_run'
  | 'awaiting_approval' | 'approved' | 'executing'
  | 'completed' | 'failed' | 'blocked' | 'rejected'

export interface ConnectorDef {
  id:               string
  name:             string
  category:         string
  description:      string
  authType:         AuthType
  defaultScopes:    string[]
  optionalScopes?:  string[]
  /** Per-action descriptor: name + minimum permission tier + risk. */
  actions:          ConnectorActionDef[]
  /** Permanently blocked at the connector level. Never overridden. */
  blockedActions:   string[]
  iconKey?:         string
  // ── Authorization & signup metadata ──────────────────────────────
  // Mark `metadataVerified: true` only when the URLs have been
  // navigated and confirmed correct by the maintainer. Unverified
  // entries are surfaced to operators with a warning banner.
  metadataVerified?:      boolean
  officialWebsiteUrl?:    string
  signupUrl?:             string
  loginUrl?:              string
  oauthAuthorizationUrl?: string
  developerAppSetupUrl?:  string
  apiKeyCreationUrl?:     string
  docsUrl?:               string
  pricingUrl?:            string
  statusPageUrl?:         string
  permissionExplanation?: string
  accountRequired?:       boolean
  supportsOauth?:         boolean
  supportsApiKey?:        boolean
  supportsSessionAuth?:   boolean
  freeTierAvailable?:     boolean
}

export interface ConnectorActionDef {
  /** Fully qualified name, e.g. 'github.create_issue' */
  name:             string
  /** Minimum permission tier required. */
  minPermission:    Permission
  /** Risk level — medium+ requires approval. */
  risk:             RiskLevel
  /** Required granted scopes (subset of connector's defaultScopes). */
  requiredScopes?:  string[]
  /** Optional handler — runs the real API call. Returns the result. */
  handler?:         ConnectorHandler
  /** Optional dry-run — returns what WOULD happen. Pure preview. */
  dryRun?:          DryRunFn
}

export interface ConnectorContext {
  workspaceId:  string
  accountId:    string
  connectorId:  string
  /** Lazy secret resolver — handler calls this only if it needs creds.
   *  Calling it writes a security_audits row in secrets-vault. */
  getSecret:    () => Promise<string>
  /** Granted scopes on this account row. */
  scopes:       string[]
  /** Operator-set permission tier on this account. */
  permission:   Permission
}

export type ConnectorHandler = (
  ctx:    ConnectorContext,
  params: Record<string, unknown>,
) => Promise<unknown>

export type DryRunFn = (
  ctx:    ConnectorContext,
  params: Record<string, unknown>,
) => Promise<{ summary: string; affected?: Record<string, unknown> }>

// ── Universal hard-block list ─────────────────────────────────────────
// These intent fragments BLOCK at policy stage no matter what. They are
// not configurable. They cover the categories the master prompt names:
// purchases, payments, banking, account deletion, crypto, transfers.
const HARD_BLOCK_PATTERNS = [
  // Purchases / payments
  /\bpurchase\b/i, /\bcheckout\b/i, /\bpayment\b/i, /\bpay[\s_-]?now\b/i,
  /\bcharge[\s_-]?card\b/i, /\benter[\s_-]?card\b/i, /\bcredit[\s_-]?card\b/i,
  /\bdebit[\s_-]?card\b/i, /\benter[\s_-]?cvv\b/i, /\bsave[\s_-]?card\b/i,
  /\bsubscribe\b(?!.*newsletter)/i, /\bbilling\b/i, /\binvoice[\s_-]?pay\b/i,
  // Money movement
  /\btransfer[\s_-]?funds\b/i, /\bwire[\s_-]?transfer\b/i,
  /\bach[\s_-]?(transfer|debit|credit)\b/i, /\bwithdraw[\s_-]?funds\b/i,
  /\bdeposit[\s_-]?funds\b/i,
  // Crypto
  /\bcrypto[\s_-]?(send|transfer|trade)\b/i, /\bsend[\s_-]?crypto\b/i,
  /\bswap[\s_-]?(eth|btc|sol|usdc|usdt)\b/i, /\bapprove[\s_-]?spending\b/i,
  // Ad spend
  /\bboost[\s_-]?post\b/i, /\bbuy[\s_-]?ad\b/i, /\bpromote[\s_-]?paid\b/i,
  /\bad[\s_-]?spend\b/i, /\bfund[\s_-]?campaign\b/i,
  // Account destruction
  /\bclose[\s_-]?account\b/i, /\bdelete[\s_-]?account\b/i,
  /\bdeactivate[\s_-]?account\b/i,
  // Banking / payout settings
  /\bchange[\s_-]?bank\b/i, /\badd[\s_-]?bank/i, /\bremove[\s_-]?bank/i,
  /\bpayout[\s_-]?settings\b/i, /\brouting[\s_-]?number\b/i,
] as const

export function isHardBlocked(intentOrAction: string): boolean {
  for (const re of HARD_BLOCK_PATTERNS) if (re.test(intentOrAction)) return true
  return false
}

// ── In-process handler registry ───────────────────────────────────────
// We keep handler fns in process memory keyed by action name. The DB
// stores definitions but not function references.
const HANDLERS = new Map<string, { handler?: ConnectorHandler; dryRun?: DryRunFn }>()

export function registerActionHandler(actionName: string, def: { handler?: ConnectorHandler; dryRun?: DryRunFn }) {
  HANDLERS.set(actionName, def)
}

function getActionImpl(actionName: string) {
  return HANDLERS.get(actionName)
}

// ── Helpers ───────────────────────────────────────────────────────────

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: (payload['actionId'] as string) ?? uuidv7(),
    causationId: null, source: 'api/connectors', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[connectors]', e.message); return null })
}

function permTier(p: Permission): number {
  return p === 'admin' ? 4 : p === 'publish' ? 3 : p === 'draft' ? 2 : 1
}

function permSufficient(have: Permission, need: Permission): boolean {
  return permTier(have) >= permTier(need)
}

// ── Registry ──────────────────────────────────────────────────────────

/**
 * Idempotent: upserts each definition by id. Run on every API boot so
 * code changes to the registry propagate without manual SQL.
 */
export async function seedConnectorRegistry(defs: ConnectorDef[]) {
  const now = Date.now()
  for (const d of defs) {
    const implemented = d.actions.some(a => !!a.handler)
    // Register handlers in-process
    for (const a of d.actions) {
      registerActionHandler(a.name, {
        ...(a.handler ? { handler: a.handler } : {}),
        ...(a.dryRun  ? { dryRun:  a.dryRun  } : {}),
      })
    }
    const row = {
      id:               d.id,
      name:             d.name,
      category:         d.category,
      description:      d.description,
      authType:         d.authType,
      defaultScopes:    d.defaultScopes,
      optionalScopes:   d.optionalScopes ?? [],
      supportedActions: d.actions.map(a => a.name),
      blockedActions:   d.blockedActions,
      riskLevel:        d.actions.reduce<RiskLevel>((acc, a) =>
        a.risk === 'high' ? 'high' : (a.risk === 'medium' && acc !== 'high') ? 'medium' : acc, 'low'),
      implemented,
      officialWebsiteUrl:    d.officialWebsiteUrl    ?? null,
      signupUrl:             d.signupUrl             ?? null,
      loginUrl:              d.loginUrl              ?? null,
      oauthAuthorizationUrl: d.oauthAuthorizationUrl ?? null,
      developerAppSetupUrl:  d.developerAppSetupUrl  ?? null,
      apiKeyCreationUrl:     d.apiKeyCreationUrl     ?? null,
      docsUrl:               d.docsUrl               ?? null,
      pricingUrl:            d.pricingUrl            ?? null,
      statusPageUrl:         d.statusPageUrl         ?? null,
      permissionExplanation: d.permissionExplanation ?? null,
      accountRequired:       d.accountRequired       ?? true,
      supportsOauth:         d.supportsOauth         ?? (d.authType === 'oauth'),
      supportsApiKey:        d.supportsApiKey        ?? (d.authType === 'api_key' || d.authType === 'token'),
      supportsSessionAuth:   d.supportsSessionAuth   ?? (d.authType === 'session'),
      freeTierAvailable:     d.freeTierAvailable     ?? false,
      metadataVerifiedAt:    d.metadataVerified      ? now : null,
      iconKey:               d.iconKey ?? null,
      updatedAt:        now,
    }
    // Atomic upsert keyed on the connectors primary key — replaces the
    // prior SELECT-then-INSERT/UPDATE that could race two concurrent
    // seedConnectorRegistry() calls into a duplicate-key crash.
    await db.insert(connectors)
      .values({ ...row, createdAt: now })
      .onConflictDoUpdate({ target: connectors.id, set: row })
      .catch((e: unknown) => {
        console.error('[connectors] seed upsert failed for', d.id, (e as Error).message)
      })
  }
}

export async function listConnectors() {
  return db.select().from(connectors).orderBy(connectors.category, connectors.name).catch(() => [])
}

export async function getConnector(id: string) {
  return db.select().from(connectors).where(eq(connectors.id, id)).limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[connectors]', e.message); return null })
}

// ── Accounts ──────────────────────────────────────────────────────────

export async function listAccounts(workspaceId: string) {
  return db.select().from(connectorAccounts)
    .where(eq(connectorAccounts.workspaceId, workspaceId))
    .orderBy(desc(connectorAccounts.updatedAt))
    .catch(() => [])
}

export async function getAccount(workspaceId: string, id: string) {
  return db.select().from(connectorAccounts)
    .where(and(eq(connectorAccounts.id, id), eq(connectorAccounts.workspaceId, workspaceId)))
    .limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[connectors]', e.message); return null })
}

export interface CreateAccountInput {
  workspaceId:      string
  connectorId:      string
  label:            string
  externalAccount?: string
  secretRef?:       string                  // FK to secrets_vault.id
  grantedScopes?:   string[]
  permission?:      Permission
  metadata?:        Record<string, unknown>
  createdBy?:       string
}

export async function createAccount(input: CreateAccountInput) {
  const def = await getConnector(input.connectorId)
  if (!def) throw new Error(`unknown connector: ${input.connectorId}`)
  const now = Date.now()
  const row = {
    id:              uuidv7(),
    workspaceId:     input.workspaceId,
    connectorId:     input.connectorId,
    label:           input.label,
    externalAccount: input.externalAccount ?? null,
    secretRef:       input.secretRef ?? null,
    grantedScopes:   input.grantedScopes ?? [],
    permission:      input.permission ?? 'read',
    status:          'active' as const,
    health:          'unknown' as const,
    lastActionAt:    null,
    lastHealthAt:    null,
    metadata:        input.metadata ?? {},
    createdBy:       input.createdBy ?? 'operator',
    createdAt:       now,
    updatedAt:       now,
  }
  const inserted = await db.insert(connectorAccounts).values(row).returning().then(r => r[0]).catch(() => undefined)
  if (!inserted) throw new Error('account insert failed')
  await emit(input.workspaceId, 'connector.account_created', {
    accountId: inserted.id, connectorId: input.connectorId, label: input.label,
  })
  return inserted
}

export async function updateAccountStatus(
  workspaceId: string, id: string, status: 'active' | 'paused' | 'revoked' | 'expired',
) {
  const now = Date.now()
  const row = await db.update(connectorAccounts)
    .set({ status, updatedAt: now })
    .where(and(eq(connectorAccounts.id, id), eq(connectorAccounts.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (row) await emit(workspaceId, 'connector.account_status_changed', { accountId: id, status })
  return row ?? null
}

export async function setAccountPermission(
  workspaceId: string, id: string, permission: Permission,
) {
  const row = await db.update(connectorAccounts)
    .set({ permission, updatedAt: Date.now() })
    .where(and(eq(connectorAccounts.id, id), eq(connectorAccounts.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (row) await emit(workspaceId, 'connector.account_permission_changed', { accountId: id, permission })
  return row ?? null
}

// ── Kill switches ─────────────────────────────────────────────────────

export interface KillSwitchState {
  allBlocked:       boolean
  categoryBlocked:  string[]
  connectorBlocked: string[]
  reason:           string | null
}

export async function getKillSwitch(workspaceId: string): Promise<KillSwitchState> {
  const row = await db.select().from(connectorKillSwitches)
    .where(eq(connectorKillSwitches.workspaceId, workspaceId))
    .limit(1).then(r => r[0]).catch(() => undefined)
  return {
    allBlocked:       row?.allBlocked       ?? false,
    categoryBlocked:  row?.categoryBlocked  ?? [],
    connectorBlocked: row?.connectorBlocked ?? [],
    reason:           row?.reason           ?? null,
  }
}

export async function setKillSwitch(
  workspaceId: string,
  patch: { allBlocked?: boolean; categoryBlocked?: string[]; connectorBlocked?: string[]; reason?: string | null },
  by: string,
) {
  const now = Date.now()
  const existing = await db.select().from(connectorKillSwitches)
    .where(eq(connectorKillSwitches.workspaceId, workspaceId))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (existing) {
    await db.update(connectorKillSwitches)
      .set({ ...patch, setBy: by, setAt: now, updatedAt: now })
      .where(eq(connectorKillSwitches.workspaceId, workspaceId))
      .catch((e: Error) => { console.error('[connectors]', e.message); return null })
  } else {
    await db.insert(connectorKillSwitches).values({
      workspaceId,
      allBlocked:       patch.allBlocked       ?? false,
      categoryBlocked:  patch.categoryBlocked  ?? [],
      connectorBlocked: patch.connectorBlocked ?? [],
      reason:           patch.reason           ?? null,
      setBy:            by,
      setAt:            now,
      updatedAt:        now,
    }).catch((e: Error) => { console.error('[connectors]', e.message); return null })
  }
  await emit(workspaceId, 'connector.kill_switch_changed', { ...patch, by })
  return getKillSwitch(workspaceId)
}

// ── Rate limiting ─────────────────────────────────────────────────────

const DEFAULT_PER_MIN = 60

/** Returns null if within limit; otherwise a reason string. */
async function checkRateLimit(
  workspaceId: string, accountId: string, action: string,
): Promise<string | null> {
  // Lookup most-specific override: (account+action) > (account) > (workspace)
  const overrides = await db.select().from(connectorRateLimits)
    .where(eq(connectorRateLimits.workspaceId, workspaceId))
    .catch(() => [])
  let maxPerMin = DEFAULT_PER_MIN
  const exact = overrides.find(o => o.accountId === accountId && o.action === action)
  const acctAll = overrides.find(o => o.accountId === accountId && !o.action)
  const wsAll = overrides.find(o => !o.accountId && !o.action)
  if (exact)        maxPerMin = exact.maxPerMinute
  else if (acctAll) maxPerMin = acctAll.maxPerMinute
  else if (wsAll)   maxPerMin = wsAll.maxPerMinute

  // Count last 60s of executed/awaiting actions for this (account, action)
  const since = Date.now() - 60_000
  const rows = await db.select({ c: sql<number>`COUNT(*)` })
    .from(connectorActions)
    .where(and(
      eq(connectorActions.workspaceId, workspaceId),
      eq(connectorActions.accountId, accountId),
      eq(connectorActions.action, action),
      gte(connectorActions.createdAt, since),
    ))
    .catch(() => [{ c: 0 }] as Array<{ c: number }>)
  const count = Number(rows[0]?.c ?? 0)
  if (count >= maxPerMin) {
    return `rate_limit: ${count}/${maxPerMin} for ${action} in last 60s`
  }
  return null
}

// ── Action runtime — the 7-stage pipeline ─────────────────────────────

export interface DispatchInput {
  workspaceId: string
  accountId:   string
  action:      string                   // e.g. 'github.create_issue'
  intent:      string                   // human-readable description
  params:      Record<string, unknown>
  initiatedBy?: string
  correlationId?: string
}

export interface DispatchResult {
  actionId:  string
  phase:     ActionPhase
  blocked?:  boolean
  blockedReason?: string
  awaitingApproval?: boolean
  dryRunPreview?: { summary: string; affected?: Record<string, unknown> }
  result?:   unknown
  error?:    string
}

/**
 * Dispatch an action through the full pipeline. Returns as soon as the
 * pipeline either:
 *   - blocks (hard rules → phase 'blocked')
 *   - waits for approval (phase 'awaiting_approval')
 *   - completes (phase 'completed' | 'failed')
 *
 * For 'awaiting_approval': caller must later call `approveAction()` or
 * `rejectAction()`. Approval triggers execution + log persistence.
 */
export async function dispatchAction(input: DispatchInput): Promise<DispatchResult> {
  const now = Date.now()
  const actionId = uuidv7()

  // ── 0a. Kill switch — checked before any DB lookups for speed ────
  const kill = await getKillSwitch(input.workspaceId)
  if (kill.allBlocked) {
    return {
      actionId, phase: 'blocked', blocked: true,
      blockedReason: `kill_switch: all connector actions paused${kill.reason ? ` (${kill.reason})` : ''}`,
    }
  }

  // ── 0b. Persist queued row ───────────────────────────────────────
  const account = await getAccount(input.workspaceId, input.accountId)
  if (!account) {
    return { actionId, phase: 'failed', error: 'account not found' }
  }
  if (account.status !== 'active') {
    return { actionId, phase: 'blocked', blocked: true, blockedReason: `account status is ${account.status}` }
  }

  // Connector + category kill checks (need connectorId from account)
  if (kill.connectorBlocked.includes(account.connectorId)) {
    return {
      actionId, phase: 'blocked', blocked: true,
      blockedReason: `kill_switch: connector '${account.connectorId}' paused`,
    }
  }
  // Category check requires the connector def
  const connRow = await getConnector(account.connectorId)
  if (connRow && kill.categoryBlocked.includes(connRow.category)) {
    return {
      actionId, phase: 'blocked', blocked: true,
      blockedReason: `kill_switch: category '${connRow.category}' paused`,
    }
  }

  // ── 0c. Rate limit ───────────────────────────────────────────────
  const rl = await checkRateLimit(input.workspaceId, input.accountId, input.action)
  if (rl) {
    await persistAction(actionId, input, account.connectorId, 'blocked', {
      blockedReason: rl, requiresApproval: false,
    })
    await emit(input.workspaceId, 'connector.action_rate_limited', {
      actionId, action: input.action, reason: rl,
    })
    return { actionId, phase: 'blocked', blocked: true, blockedReason: rl }
  }

  const def = connRow ?? await getConnector(account.connectorId)
  if (!def) {
    return { actionId, phase: 'failed', error: `connector ${account.connectorId} not registered` }
  }

  // Look up the action definition in supported list
  if (!def.supportedActions.includes(input.action)) {
    return { actionId, phase: 'failed', error: `action '${input.action}' not supported by ${def.id}` }
  }
  if (def.blockedActions.includes(input.action)) {
    return { actionId, phase: 'blocked', blocked: true, blockedReason: `action '${input.action}' is blocked at connector level` }
  }

  // ── 1. Intent stage — hard-block by intent text ──────────────────
  if (isHardBlocked(input.action) || isHardBlocked(input.intent)) {
    await persistAction(actionId, input, account.connectorId, 'blocked', {
      blockedReason: 'matches hard-block pattern (purchase/payment/banking/destructive)',
      requiresApproval: false,
    })
    await emit(input.workspaceId, 'connector.action_blocked', {
      actionId, action: input.action, reason: 'hard-block pattern',
    })
    return {
      actionId, phase: 'blocked', blocked: true,
      blockedReason: 'purchase/payment/banking/destructive intents are permanently blocked',
    }
  }

  // We need the per-action descriptor (risk, minPermission, requiredScopes).
  // Definitions are seeded in-process; reach for the handler entry.
  const impl = getActionImpl(input.action)
  // Locate the descriptor by scanning the in-process registry (cheap; small).
  const desc = ACTION_DESCRIPTORS.get(input.action)
  if (!desc) {
    // No descriptor = action is declared in DB but not in code. Refuse honestly.
    return {
      actionId, phase: 'failed',
      error: `action '${input.action}' has no in-process descriptor (handler not wired)`,
    }
  }

  // ── 2. Permission tier ───────────────────────────────────────────
  if (!permSufficient(account.permission as Permission, desc.minPermission)) {
    await persistAction(actionId, input, account.connectorId, 'blocked', {
      blockedReason: `permission '${account.permission}' < required '${desc.minPermission}'`,
      requiresApproval: false,
    })
    return {
      actionId, phase: 'blocked', blocked: true,
      blockedReason: `account permission is '${account.permission}', action requires '${desc.minPermission}'`,
    }
  }

  // ── 3. Scope check ───────────────────────────────────────────────
  if (desc.requiredScopes?.length) {
    const granted = new Set(account.grantedScopes)
    const missing = desc.requiredScopes.filter(s => !granted.has(s))
    if (missing.length > 0) {
      await persistAction(actionId, input, account.connectorId, 'blocked', {
        blockedReason: `missing scopes: ${missing.join(', ')}`,
        requiresApproval: false,
      })
      return {
        actionId, phase: 'blocked', blocked: true,
        blockedReason: `missing OAuth scopes: ${missing.join(', ')}`,
      }
    }
  }

  // ── 4. Dry run ───────────────────────────────────────────────────
  let preview: { summary: string; affected?: Record<string, unknown> } | undefined
  if (impl?.dryRun) {
    const ctx = await buildContext(account, def.id)
    preview = await impl.dryRun(ctx, input.params).catch((e) => ({
      summary: `dry-run failed: ${(e as Error).message}`,
    }))
  } else {
    // Synthetic preview from intent
    preview = { summary: input.intent || `would execute ${input.action}` }
  }

  // ── 5. Approval gate ─────────────────────────────────────────────
  const requiresApproval = desc.risk === 'medium' || desc.risk === 'high'
  if (requiresApproval) {
    await persistAction(actionId, input, account.connectorId, 'awaiting_approval', {
      requiresApproval: true,
      riskLevel:        desc.risk,
      dryRunPreview:    preview,
    })
    await emit(input.workspaceId, 'connector.action_awaiting_approval', {
      actionId, action: input.action, risk: desc.risk, preview,
    })
    return {
      actionId, phase: 'awaiting_approval',
      awaitingApproval: true, dryRunPreview: preview,
    }
  }

  // ── 6. Execute (low-risk path — no approval needed) ──────────────
  if (!impl?.handler) {
    await persistAction(actionId, input, account.connectorId, 'failed', {
      errorMessage: `handler not implemented for '${input.action}'`,
      requiresApproval: false,
      riskLevel: desc.risk,
      dryRunPreview: preview,
    })
    return {
      actionId, phase: 'failed',
      error: `handler not implemented for '${input.action}' — connector definition exists but SDK calls are not wired`,
    }
  }

  return executeNow(actionId, input, def.id, account, impl.handler, desc.risk, preview)
}

/** Operator approval — runs the handler. */
export async function approveAction(workspaceId: string, actionId: string, approver: string): Promise<DispatchResult> {
  const row = await db.select().from(connectorActions)
    .where(and(eq(connectorActions.id, actionId), eq(connectorActions.workspaceId, workspaceId)))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (!row) return { actionId, phase: 'failed', error: 'action not found' }
  if (row.phase !== 'awaiting_approval') {
    return { actionId, phase: row.phase as ActionPhase, error: `cannot approve: phase is '${row.phase}'` }
  }

  const account = await getAccount(workspaceId, row.accountId)
  if (!account) return { actionId, phase: 'failed', error: 'account vanished' }
  const def = await getConnector(account.connectorId)
  if (!def) return { actionId, phase: 'failed', error: 'connector vanished' }
  const impl = getActionImpl(row.action)

  await db.update(connectorActions)
    .set({ approvedBy: approver, approvedAt: Date.now(), phase: 'approved', updatedAt: Date.now() })
    .where(eq(connectorActions.id, actionId))
    .catch((e: Error) => { console.error('[connectors]', e.message); return null })
  await emit(workspaceId, 'connector.action_approved', { actionId, approver })

  if (!impl?.handler) {
    await db.update(connectorActions)
      .set({ phase: 'failed', errorMessage: 'handler not implemented', updatedAt: Date.now() })
      .where(eq(connectorActions.id, actionId)).catch((e: Error) => { console.error('[connectors]', e.message); return null })
    return {
      actionId, phase: 'failed',
      error: `handler not implemented for '${row.action}'`,
    }
  }

  return executeNow(
    actionId,
    { workspaceId, accountId: row.accountId, action: row.action, intent: row.intent, params: row.params as Record<string, unknown> },
    def.id, account, impl.handler, row.riskLevel as RiskLevel,
    (row.dryRunPreview as { summary: string; affected?: Record<string, unknown> } | null) ?? undefined,
  )
}

export async function rejectAction(workspaceId: string, actionId: string, by: string, reason: string) {
  const now = Date.now()
  const row = await db.update(connectorActions)
    .set({ phase: 'rejected', rejectedBy: by, rejectedAt: now, rejectionReason: reason, updatedAt: now })
    .where(and(eq(connectorActions.id, actionId), eq(connectorActions.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (row) await emit(workspaceId, 'connector.action_rejected', { actionId, by, reason })
  return row ?? null
}

// ── Action descriptors (in-process; built during seed) ────────────────
const ACTION_DESCRIPTORS = new Map<string, {
  risk: RiskLevel
  minPermission: Permission
  requiredScopes?: string[]
}>()

export function registerActionDescriptor(name: string, desc: {
  risk: RiskLevel; minPermission: Permission; requiredScopes?: string[]
}) {
  ACTION_DESCRIPTORS.set(name, desc)
}

// ── Internal helpers ──────────────────────────────────────────────────

async function persistAction(
  actionId: string,
  input: DispatchInput,
  connectorId: string,
  phase: ActionPhase,
  extra: Partial<typeof connectorActions.$inferInsert> = {},
) {
  const now = Date.now()
  await db.insert(connectorActions).values({
    id:               actionId,
    workspaceId:      input.workspaceId,
    accountId:        input.accountId,
    connectorId,
    action:           input.action,
    intent:           input.intent,
    params:           input.params,
    riskLevel:        (extra.riskLevel as string) ?? 'low',
    phase,
    blockedReason:    null,
    dryRunPreview:    null,
    requiresApproval: false,
    approvedBy:       null,
    approvedAt:       null,
    rejectedBy:       null,
    rejectedAt:       null,
    rejectionReason:  null,
    startedAt:        null,
    completedAt:      null,
    result:           null,
    errorMessage:     null,
    initiatedBy:      input.initiatedBy ?? 'operator',
    correlationId:    input.correlationId ?? null,
    createdAt:        now,
    updatedAt:        now,
    ...extra,
  }).catch((e: Error) => { console.error('[connectors]', e.message); return null })
}

async function buildContext(
  account: typeof connectorAccounts.$inferSelect,
  connectorId: string,
): Promise<ConnectorContext> {
  return {
    workspaceId: account.workspaceId,
    accountId:   account.id,
    connectorId,
    getSecret:   async () => {
      if (!account.secretRef) throw new Error('account has no linked secret')
      // R146.68 — proactive token refresh. Before revealing, check
      // account.metadata.expiresAt (stamped by R146.49 on every prior
      // refresh + by completeCallback on initial grant). If within 60s
      // of expiry, refresh now so the handler downstream sees a fresh
      // token instead of provider 401s. Connectors silently broke ~1h
      // after grant before this wiring; this is the missing link
      // between R146.48's lock helper and the actual provider calls.
      const meta = (account.metadata as { expiresAt?: number } | null) ?? {}
      if (typeof meta.expiresAt === 'number' && meta.expiresAt < Date.now() + 60_000) {
        try {
          const { refreshAccessToken } = await import('./connector-oauth.js')
          const r = await refreshAccessToken({
            workspaceId: account.workspaceId,
            accountId:   account.id,
            requestedBy: `connector:${account.id}`,
          })
          if (r.ok) {
            // Re-read metadata so this closure picks up the new
            // expiresAt for any subsequent getSecret() in the same call.
            const refreshed = await db.select().from(connectorAccounts)
              .where(eq(connectorAccounts.id, account.id)).limit(1)
              .then(rows => rows[0]).catch(() => null)
            if (refreshed) account.metadata = refreshed.metadata
          } else if (r.reason === 'revoked') {
            // Provider returned 400 invalid_grant — operator must
            // re-OAuth. Surface a clear error instead of letting the
            // handler crash with a 401 it can't interpret.
            throw new Error(`connector ${connectorId} account ${account.id} revoked by provider — operator must re-authorize`)
          }
          // Other refresh failures (network, missing refresh_secret,
          // etc) fall through and the handler retries with the stale
          // token; if it 401s, the operator at least gets a clean
          // error chain from the handler itself.
        } catch (e) {
          // Only surface revoked errors; everything else is best-effort.
          if (e instanceof Error && /revoked/.test(e.message)) throw e
        }
      }
      const v = await revealSecret(account.secretRef, `connector:${account.id}`, 'connector action runtime')
      if (!v) throw new Error('secret could not be revealed')
      return v
    },
    scopes:      account.grantedScopes,
    permission:  account.permission as Permission,
  }
}

async function executeNow(
  actionId: string,
  input: DispatchInput,
  connectorId: string,
  account: typeof connectorAccounts.$inferSelect,
  handler: ConnectorHandler,
  risk: RiskLevel,
  preview?: { summary: string; affected?: Record<string, unknown> },
): Promise<DispatchResult> {
  const startedAt = Date.now()
  await db.update(connectorActions)
    .set({ phase: 'executing', startedAt, riskLevel: risk, dryRunPreview: preview ?? null, updatedAt: startedAt })
    .where(eq(connectorActions.id, actionId)).catch((e: Error) => { console.error('[connectors]', e.message); return null })
  // First-time insert path — when called from dispatchAction without prior persist
  await persistAction(actionId, input, connectorId, 'executing', {
    riskLevel: risk, dryRunPreview: preview ?? null,
  }).catch((e: Error) => { console.error('[connectors]', e.message); return null })

  try {
    const ctx = await buildContext(account, connectorId)
    const result = await handler(ctx, input.params)
    const completedAt = Date.now()
    await db.update(connectorActions)
      .set({ phase: 'completed', completedAt, result: (result ?? null), updatedAt: completedAt })
      .where(eq(connectorActions.id, actionId)).catch((e: Error) => { console.error('[connectors]', e.message); return null })
    await db.update(connectorAccounts)
      .set({ lastActionAt: completedAt, updatedAt: completedAt })
      .where(eq(connectorAccounts.id, account.id)).catch((e: Error) => { console.error('[connectors]', e.message); return null })
    await emit(input.workspaceId, 'connector.action_completed', {
      actionId, action: input.action, durationMs: completedAt - startedAt,
    })
    return { actionId, phase: 'completed', result, ...(preview ? { dryRunPreview: preview } : {}) }
  } catch (e) {
    const msg = (e as Error).message
    const failedAt = Date.now()
    await db.update(connectorActions)
      .set({ phase: 'failed', completedAt: failedAt, errorMessage: msg, updatedAt: failedAt })
      .where(eq(connectorActions.id, actionId)).catch((e: Error) => { console.error('[connectors]', e.message); return null })
    // Failures count as "last action" too — operators need to see signs of
    // life even when calls fail (auth issues, network outages, etc.).
    await db.update(connectorAccounts)
      .set({ lastActionAt: failedAt, updatedAt: failedAt })
      .where(eq(connectorAccounts.id, account.id)).catch((e: Error) => { console.error('[connectors]', e.message); return null })
    await emit(input.workspaceId, 'connector.action_failed', { actionId, action: input.action, error: msg })
    return { actionId, phase: 'failed', error: msg }
  }
}

// ── Queries ───────────────────────────────────────────────────────────

export async function listActions(workspaceId: string, opts: { phase?: ActionPhase; limit?: number } = {}) {
  const conds = [eq(connectorActions.workspaceId, workspaceId)]
  if (opts.phase) conds.push(eq(connectorActions.phase, opts.phase))
  return db.select().from(connectorActions)
    .where(and(...conds))
    .orderBy(desc(connectorActions.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500))
    .catch(() => [])
}

export async function listPendingApprovals(workspaceId: string) {
  return db.select().from(connectorActions)
    .where(and(
      eq(connectorActions.workspaceId, workspaceId),
      eq(connectorActions.phase, 'awaiting_approval'),
    ))
    .orderBy(desc(connectorActions.createdAt))
    .limit(200).catch(() => [])
}

// Suppress unused-import warning on secretsVault — referenced by JSDoc only
void secretsVault
