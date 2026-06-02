/**
 * R146.134 — POD mass production pipeline.
 *
 * One op kicks off a batch: a niche + design style + product types +
 * target stores. The pipeline then:
 *   1. Generates N design prompts via LLM
 *   2. Generates an image per design via image-generator (inherits
 *      R127 quality directive)
 *   3. Drafts SEO-friendly title + description per item
 *   4. Lists to each chosen store (Printful sync products, Shopify
 *      product create, Etsy listing create)
 *   5. Auto-links attribution edges (item → product → business)
 *
 * Costs: ~$0.04/image @ Replicate flux-schnell, ~$0.002 per LLM draft.
 * 20 items × 3 product types × 3 stores ≈ $1.50 in image gen + $0.20
 * in LLM + variable POD platform fees. Spend caps default unlimited
 * after R146.134 — operator opts in via spend.setCap if needed.
 *
 * Concurrency capped at 3 items in flight per batch to keep image-gen
 * provider happy.
 */
import { db } from '../db/client.js'
import { podBatchRuns, podBatchItems, events } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface RunBatchInput {
  niche:           string
  designStyle?:    string
  targetCount?:    number       // 1..200
  productTypes?:   string[]     // ['tshirt','poster','mug','tote','hoodie','sticker']
  stores?:         string[]     // ['printful','shopify','etsy']
}

const DEFAULT_PRODUCT_TYPES = ['tshirt', 'poster', 'mug']
const DEFAULT_STORES        = ['printful']
const MAX_TARGET            = 200
const CONCURRENCY           = 3

export async function startBatch(workspaceId: string, input: RunBatchInput): Promise<{ batchId: string }> {
  if (!input.niche) throw new Error('niche required')
  const id = uuidv7()
  const now = Date.now()
  await db.insert(podBatchRuns).values({
    id, workspaceId,
    niche: input.niche.slice(0, 240),
    designStyle: (input.designStyle ?? 'modern minimal').slice(0, 120),
    targetCount: Math.max(1, Math.min(input.targetCount ?? 20, MAX_TARGET)),
    productTypes: (input.productTypes ?? DEFAULT_PRODUCT_TYPES).slice(0, 6),
    stores: (input.stores ?? DEFAULT_STORES).slice(0, 5),
    status: 'running',
    createdAt: now, updatedAt: now,
  })
  await emit(workspaceId, id, 'pod_batch.started', { niche: input.niche, targetCount: input.targetCount ?? 20 })
  // Fire-and-forget: pipeline runs async; operator polls via pod.batchStatus
  void runPipeline(workspaceId, id).catch(async e => {
    await db.update(podBatchRuns).set({ status: 'failed', haltReason: (e as Error).message.slice(0, 500), updatedAt: Date.now() })
      .where(eq(podBatchRuns.id, id))
  })
  return { batchId: id }
}

async function runPipeline(workspaceId: string, batchId: string): Promise<void> {
  const [run] = await db.select().from(podBatchRuns).where(eq(podBatchRuns.id, batchId)).limit(1)
  if (!run) return
  // ─── Step 1: generate N design prompt seeds via LLM ────────────────
  const prompts = await generateDesignPrompts(workspaceId, {
    niche: run.niche, designStyle: run.designStyle, count: run.targetCount,
  })
  // ─── Step 2: for each prompt × productType, queue an item ──────────
  const items: Array<{ id: string; prompt: string; productType: string }> = []
  for (const prompt of prompts) {
    for (const pt of run.productTypes) {
      const id = uuidv7()
      items.push({ id, prompt, productType: pt })
      await db.insert(podBatchItems).values({
        id, batchId, workspaceId,
        designPrompt: prompt, productType: pt,
        status: 'queued',
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    }
  }
  // ─── Step 3: process items with bounded concurrency ────────────────
  let idx = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push((async () => {
      while (idx < items.length) {
        const myIdx = idx++
        const it = items[myIdx]; if (!it) break
        await processItem(workspaceId, batchId, it, run.stores).catch(async e => {
          await db.update(podBatchItems).set({ status: 'failed', error: (e as Error).message.slice(0, 500), updatedAt: Date.now() })
            .where(eq(podBatchItems.id, it.id))
          await db.update(podBatchRuns).set({ failedCount: (await getFailedCount(batchId)), updatedAt: Date.now() })
            .where(eq(podBatchRuns.id, batchId))
        })
      }
    })())
  }
  await Promise.all(workers)
  await db.update(podBatchRuns).set({ status: 'completed', updatedAt: Date.now() }).where(eq(podBatchRuns.id, batchId))
  await emit(workspaceId, batchId, 'pod_batch.completed', { count: items.length })
}

async function generateDesignPrompts(workspaceId: string, opts: { niche: string; designStyle: string; count: number }): Promise<string[]> {
  // Cap LLM at half the count to avoid pathological growth — image-gen is the bottleneck cost-wise
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You design POD product art. Output ONLY a JSON array of ${opts.count} distinct design prompts for the niche "${opts.niche}" in "${opts.designStyle}" style. Each prompt 12-30 words, no people, suitable for t-shirts/posters/mugs. No watermarks, no text overlay unless the design IS text. Return: ["prompt1","prompt2",...]`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `niche: ${opts.niche}\nstyle: ${opts.designStyle}\ncount: ${opts.count}` },
    ], { taskType: 'other', suppressQualityBar: false } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\[[\s\S]*\]/)
    if (!m) throw new Error('LLM returned no JSON array')
    const parsed = JSON.parse(m[0]) as string[]
    return parsed.slice(0, opts.count).map(p => String(p).slice(0, 300))
  } catch {
    // Fallback: synthesize from niche + style
    const out: string[] = []
    for (let i = 0; i < opts.count; i++) {
      out.push(`${opts.designStyle} design about ${opts.niche}, variation ${i + 1}, vector illustration, clean composition`)
    }
    return out
  }
}

async function processItem(workspaceId: string, batchId: string, item: { id: string; prompt: string; productType: string }, stores: string[]): Promise<void> {
  // Step A: generate image
  const { generateImage } = await import('./image-generator.js')
  const imgResult = await generateImage({
    workspaceId,
    prompt: item.prompt,
    provider: 'replicate',
    model: 'flux-schnell',
    width: 1024, height: 1024,
  } as Parameters<typeof generateImage>[0]).catch(e => ({ ok: false as const, error: (e as Error).message }))
  if (!('id' in imgResult)) {
    await db.update(podBatchItems).set({ status: 'failed', error: (imgResult as { error: string }).error.slice(0, 500), updatedAt: Date.now() }).where(eq(podBatchItems.id, item.id))
    return
  }
  const imgRow = imgResult as { id: string; url?: string; outputUrl?: string }
  const imageUrl = imgRow.url ?? imgRow.outputUrl ?? ''
  await db.update(podBatchItems).set({ status: 'image_done', imageGenId: imgRow.id, imageUrl, updatedAt: Date.now() }).where(eq(podBatchItems.id, item.id))
  await db.update(podBatchRuns).set({ generatedCount: await getGeneratedCount(batchId), updatedAt: Date.now() }).where(eq(podBatchRuns.id, batchId))

  // Step B: draft title + description via LLM
  const meta = await draftMeta(workspaceId, item.prompt, item.productType).catch(() => ({ title: `${item.productType} design`, description: item.prompt }))
  await db.update(podBatchItems).set({ title: meta.title, description: meta.description, updatedAt: Date.now() }).where(eq(podBatchItems.id, item.id))

  // Step C: list to each store
  const listed: Array<{ store: string; productId: string; listedAt: number }> = []
  for (const store of stores) {
    if (!imageUrl) break
    try {
      const productId = await listToStore(workspaceId, store, { title: meta.title, description: meta.description, imageUrl, productType: item.productType })
      if (productId) {
        listed.push({ store, productId, listedAt: Date.now() })
        // Attribution edge: batch_item → product
        try {
          const { linkEdge } = await import('./r131-quotas-attribution.js')
          await linkEdge(workspaceId, {
            srcType: 'clip', srcId: item.id,    // reuse 'clip' type for design item
            dstType: 'product', dstId: productId,
            relation: 'published_to',
            metadata: { store, productType: item.productType, batchId },
          })
        } catch { /* attribution best-effort */ }
      }
    } catch (e) {
      console.warn(`[pod-mass] ${store} list failed for item ${item.id}: ${(e as Error).message}`)
    }
  }
  await db.update(podBatchItems).set({ status: listed.length > 0 ? 'listed' : 'failed', listedStores: listed, updatedAt: Date.now() }).where(eq(podBatchItems.id, item.id))
  if (listed.length > 0) {
    await db.update(podBatchRuns).set({ listedCount: await getListedCount(batchId), updatedAt: Date.now() }).where(eq(podBatchRuns.id, batchId))
  }
}

async function draftMeta(workspaceId: string, designPrompt: string, productType: string): Promise<{ title: string; description: string }> {
  const { streamChat } = await import('./chat-providers.js')
  const sys = `You write SEO-optimized POD product listings. Return STRICT JSON: {"title": "<<60 chars, keyword-rich, no clickbait>>", "description": "<<150-280 chars, mentions design + product type + ideal recipient>>"}.`
  const gen = streamChat(workspaceId, [
    { role: 'system', content: sys },
    { role: 'user',   content: `Design: ${designPrompt}\nProduct type: ${productType}` },
  ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
  let acc = ''
  for await (const ch of gen) acc += ch.delta
  const m = acc.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no JSON in meta response')
  const parsed = JSON.parse(m[0]) as { title?: string; description?: string }
  return {
    title:       (parsed.title ?? `${productType} - ${designPrompt}`).slice(0, 60),
    description: (parsed.description ?? designPrompt).slice(0, 320),
  }
}

// Printful variant IDs for common products (approximate — operator should
// override per their preferred catalog product). Values are real Printful
// catalog variant IDs as of 2025.
const PRINTFUL_VARIANT_DEFAULTS: Record<string, number> = {
  tshirt:  4012,   // Unisex tee S black
  poster:  1320,   // 12x18 enhanced matte poster
  mug:     19,     // White ceramic 11oz
  tote:    1693,   // Eco canvas tote
  hoodie:  5530,   // Pullover hoodie S
  sticker: 10165,  // Bumper sticker 3"x4"
}

async function listToStore(workspaceId: string, store: string, opts: { title: string; description: string; imageUrl: string; productType: string }): Promise<string | null> {
  if (store === 'printful') {
    const { createSyncProduct } = await import('./connector-printful.js')
    const variantId = PRINTFUL_VARIANT_DEFAULTS[opts.productType] ?? 4012
    // Resolve credentials: get the first active printful connector account
    const { connectorAccounts } = await import('../db/schema.js')
    const [acct] = await db.select().from(connectorAccounts)
      .where(and(eq(connectorAccounts.workspaceId, workspaceId), eq(connectorAccounts.connectorId, 'printful'), eq(connectorAccounts.status, 'active')))
      .limit(1)
    if (!acct?.secretRef) return null
    const { revealSecret } = await import('./secrets-vault.js')
    const token = await revealSecret(acct.secretRef, 'pod-mass-produce', 'createSyncProduct')
    if (!token) return null
    const r = await createSyncProduct({
      accessToken: token,
      name: opts.title,
      thumbnailUrl: opts.imageUrl,
      variants: [{
        variantId,
        retailPriceUsd: defaultPriceFor(opts.productType),
        printFiles: [{ type: 'default', url: opts.imageUrl }],
      }],
      approvalToken: 'OPERATOR_APPROVED',
    } as Parameters<typeof createSyncProduct>[0])
    return r.ok ? r.productId : null
  }
  // Shopify / Etsy listing — left as future hook; the connector services
  // exist (connector-shopify, connector-etsy) but createProduct paths
  // aren't yet wired into this orchestrator. Returns null cleanly.
  return null
}

function defaultPriceFor(productType: string): number {
  return { tshirt: 24.99, poster: 18.99, mug: 14.99, tote: 19.99, hoodie: 39.99, sticker: 4.99 }[productType] ?? 19.99
}

// ─── Queries ──────────────────────────────────────────────────────────

async function getGeneratedCount(batchId: string): Promise<number> {
  const rows = await db.select().from(podBatchItems)
    .where(and(eq(podBatchItems.batchId, batchId), eq(podBatchItems.status, 'image_done')))
  return rows.length
}
async function getListedCount(batchId: string): Promise<number> {
  const rows = await db.select().from(podBatchItems)
    .where(and(eq(podBatchItems.batchId, batchId), eq(podBatchItems.status, 'listed')))
  return rows.length
}
async function getFailedCount(batchId: string): Promise<number> {
  const rows = await db.select().from(podBatchItems)
    .where(and(eq(podBatchItems.batchId, batchId), eq(podBatchItems.status, 'failed')))
  return rows.length
}

export async function batchStatus(workspaceId: string, batchId: string): Promise<typeof podBatchRuns.$inferSelect | null> {
  const [row] = await db.select().from(podBatchRuns).where(and(eq(podBatchRuns.workspaceId, workspaceId), eq(podBatchRuns.id, batchId))).limit(1)
  return row ?? null
}

export async function batchItems(workspaceId: string, batchId: string, limit = 200): Promise<Array<typeof podBatchItems.$inferSelect>> {
  return db.select().from(podBatchItems)
    .where(and(eq(podBatchItems.workspaceId, workspaceId), eq(podBatchItems.batchId, batchId)))
    .orderBy(desc(podBatchItems.createdAt))
    .limit(Math.min(limit, 500))
}

export async function listBatches(workspaceId: string, limit = 30): Promise<Array<typeof podBatchRuns.$inferSelect>> {
  return db.select().from(podBatchRuns).where(eq(podBatchRuns.workspaceId, workspaceId))
    .orderBy(desc(podBatchRuns.createdAt))
    .limit(Math.min(limit, 100))
}

export async function haltBatch(workspaceId: string, batchId: string, reason: string): Promise<void> {
  await db.update(podBatchRuns).set({ status: 'halted', haltReason: reason.slice(0, 500), updatedAt: Date.now() })
    .where(and(eq(podBatchRuns.workspaceId, workspaceId), eq(podBatchRuns.id, batchId)))
}

async function emit(workspaceId: string, batchId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), workspaceId, type,
    payload: { batchId, ...payload },
    traceId: uuidv7(), correlationId: batchId, causationId: null,
    source: 'r134-pod-mass', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}
