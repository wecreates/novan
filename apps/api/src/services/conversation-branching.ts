/**
 * conversation-branching.ts — fork a conversation at a specific message.
 *
 * Forking:
 *   1. Look up the source conversation + the fork-point message
 *   2. Validate fork point belongs to that conversation, is not superseded
 *   3. Create a new conversation row, recording its origin
 *   4. Copy all non-superseded messages with createdAt <= forkPoint.createdAt
 *      into the new conversation (with new ids, so editing won't leak)
 *
 * The branch_root_id chain lets the UI build a forest from any node:
 *   - root conversation:   branch_root_id = NULL
 *   - first-level branch:  branch_root_id = parent.id
 *   - deeper branches:     branch_root_id = parent.branchRootId (inherits)
 *
 * Pure validation lives in `validateForkRequest`; DB ops in `forkConversation`.
 */
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import { conversations, messages } from '../db/schema.js'
import { and, eq, isNull, lte, or } from 'drizzle-orm'

export interface ForkValidationInput {
  /** Source message we're forking from (must be in the source conversation). */
  forkPointMessage: { id: string; conversationId: string; supersededAt: number | null } | null
  sourceConversation: { id: string; workspaceId: string; branchRootId: string | null } | null
  sourceConversationId: string
}

export type ForkValidationResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Pure validation — no DB calls. Verifies the fork point matches the
 * source conversation and isn't already-superseded (forking from a
 * superseded turn would resurrect a thread the operator deliberately
 * replaced).
 */
export function validateForkRequest(i: ForkValidationInput): ForkValidationResult {
  if (!i.sourceConversation) return { ok: false, reason: 'source conversation not found' }
  if (!i.forkPointMessage)   return { ok: false, reason: 'fork-point message not found' }
  if (i.forkPointMessage.conversationId !== i.sourceConversationId) {
    return { ok: false, reason: 'fork-point message does not belong to source conversation' }
  }
  if (i.forkPointMessage.supersededAt !== null) {
    return { ok: false, reason: 'cannot fork from a superseded message — pick a live message' }
  }
  return { ok: true }
}

/** Resolve the branch root id for a new fork off this parent. */
export function deriveBranchRootId(parent: { id: string; branchRootId: string | null }): string {
  // First-level branches inherit the parent's id; deeper branches inherit
  // the existing branchRootId so the whole tree shares the same root.
  return parent.branchRootId ?? parent.id
}

export interface ForkConversationInput {
  workspaceId:           string
  sourceConversationId:  string
  forkPointMessageId:    string
  /** Optional override for the new conversation's title. */
  title?:                string
}

export type ForkConversationResult =
  | { ok: true;  newConversationId: string; copiedMessageCount: number }
  | { ok: false; reason: string }

export async function forkConversation(i: ForkConversationInput): Promise<ForkConversationResult> {
  const src = await db.select().from(conversations)
    .where(and(
      eq(conversations.workspaceId, i.workspaceId),
      eq(conversations.id, i.sourceConversationId),
    ))
    .limit(1).then(r => r[0] ?? null).catch(() => null)

  const fp = await db.select().from(messages)
    .where(and(
      eq(messages.workspaceId, i.workspaceId),
      eq(messages.id, i.forkPointMessageId),
    ))
    .limit(1).then(r => r[0] ?? null).catch(() => null)

  const validation = validateForkRequest({
    sourceConversation: src ? { id: src.id, workspaceId: src.workspaceId, branchRootId: src.branchRootId } : null,
    forkPointMessage:   fp  ? { id: fp.id,  conversationId: fp.conversationId, supersededAt: fp.supersededAt } : null,
    sourceConversationId: i.sourceConversationId,
  })
  if (!validation.ok) return validation

  // Both guaranteed non-null by validation above; narrow for TS.
  if (!src || !fp) return { ok: false, reason: 'internal: source/fork point disappeared after validation' }

  const newId = uuidv7()
  const now   = Date.now()
  const title = (i.title?.trim() || `${src.title} (branch)`).slice(0, 200)
  const branchRootId = deriveBranchRootId({ id: src.id, branchRootId: src.branchRootId })

  await db.insert(conversations).values({
    id: newId, workspaceId: i.workspaceId, title,
    messageCount: 0, totalTokens: 0, totalCostUsd: 0, archived: false,
    forkedFromConversationId: src.id,
    forkedFromMessageId:      fp.id,
    branchRootId,
    createdAt: now, updatedAt: now,
  }).catch(() => null)

  // Copy all non-superseded messages with createdAt <= fp.createdAt.
  // Superseded turns are skipped — those are the "rolled back" branches
  // of history the operator already replaced, so they shouldn't follow
  // the fork. (Stop+Regenerate already marks the old one supersededAt.)
  const historyRows = await db.select().from(messages)
    .where(and(
      eq(messages.workspaceId, i.workspaceId),
      eq(messages.conversationId, src.id),
      lte(messages.createdAt, fp.createdAt),
      or(isNull(messages.supersededAt), eq(messages.id, fp.id)),
    ))
    .catch(() => [])

  // Stable order; re-mint ids so editing the branch won't mutate parent.
  const ordered = [...historyRows].sort((a, b) => a.createdAt - b.createdAt)
  let copied = 0
  for (const m of ordered) {
    await db.insert(messages).values({
      id: uuidv7(),
      conversationId:  newId,
      workspaceId:     i.workspaceId,
      role:            m.role,
      content:         m.content,
      citations:       m.citations,
      audit:           m.audit ?? null,
      tokens:          m.tokens,
      costUsd:         m.costUsd,
      provider:        m.provider ?? null,
      model:           m.model ?? null,
      streamComplete:  m.streamComplete,
      error:           m.error ?? null,
      // The new branch starts fresh — no carry-over of supersede / cancel
      supersededAt:    null,
      supersededBy:    null,
      regeneratedFrom: null,
      cancelled:       false,
      attachments:     m.attachments ?? [],
      createdAt:       m.createdAt,
    }).catch(() => null)
    copied++
  }

  await db.update(conversations)
    .set({ messageCount: copied, updatedAt: Date.now() })
    .where(eq(conversations.id, newId))
    .catch(() => null)

  return { ok: true, newConversationId: newId, copiedMessageCount: copied }
}

/**
 * List every conversation in a branch tree, given any node in the tree.
 * Returns ordered by createdAt ascending so the operator sees a stable
 * timeline of forks.
 */
export async function listBranchTree(workspaceId: string, anyConversationId: string): Promise<Array<{ id: string; title: string; forkedFromConversationId: string | null; forkedFromMessageId: string | null; createdAt: number; updatedAt: number; messageCount: number }>> {
  const node = await db.select().from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, anyConversationId)))
    .limit(1).then(r => r[0] ?? null).catch(() => null)
  if (!node) return []

  const rootId = node.branchRootId ?? node.id

  // Tree consists of: the root + everything with branchRootId = rootId.
  const all = await db.select({
    id: conversations.id,
    title: conversations.title,
    forkedFromConversationId: conversations.forkedFromConversationId,
    forkedFromMessageId: conversations.forkedFromMessageId,
    createdAt: conversations.createdAt,
    updatedAt: conversations.updatedAt,
    messageCount: conversations.messageCount,
    branchRootId: conversations.branchRootId,
  }).from(conversations)
    .where(and(
      eq(conversations.workspaceId, workspaceId),
      or(eq(conversations.id, rootId), eq(conversations.branchRootId, rootId)),
    ))
    .catch(() => [])

  return all
    .map(({ branchRootId: _br, ...rest }) => rest)
    .sort((a, b) => a.createdAt - b.createdAt)
}
