/**
 * business-templates.ts — 5 named business templates (BO14).
 *
 * Extends `workspace-seed.ts` so a brand-new workspace can be
 * instantiated with sector-aware defaults instead of a bare skeleton.
 *
 * Honest scope:
 *   - A template captures: default revenue target ($10k floor minimum
 *     per SPEC §11.7), suggested channel platforms, recommended
 *     playbooks to surface in chat injection, and default agents to
 *     provision.
 *   - The template does NOT create real business rows, connector OAuth,
 *     or scheduled production — those are operator decisions taken
 *     after onboarding. The template just biases the initial state.
 */

import { v7 as uuidv7 } from 'uuid'

export type BusinessTemplateKey =
  | 'generic'
  | 'ecommerce'
  | 'saas'
  | 'content'
  | 'services'

export interface BusinessTemplate {
  key:                 BusinessTemplateKey
  name:                string
  description:         string
  targetMonthlyUsd:    number    // default revenue target — must be ≥ 10_000
  suggestedChannels:   string[]  // platform names from connector catalog
  suggestedPlaybooks:  string[]  // filenames under apps/api/knowledge/
  defaultAgents:       string[]  // bootstrap agent identifiers
  notes:               string
}

export const BUSINESS_TEMPLATES: Record<BusinessTemplateKey, BusinessTemplate> = {
  generic: {
    key: 'generic',
    name: 'Generic business',
    description: 'Baseline template. Use when no sector-specific fit applies.',
    targetMonthlyUsd: 10_000,
    suggestedChannels: [],
    suggestedPlaybooks: ['operator-runbook.md'],
    defaultAgents: ['ceo-orchestrator', 'knowledge-curator', 'cost-analyst'],
    notes: 'Starts at the $10k floor. Operator picks channels + playbooks after onboarding.',
  },
  ecommerce: {
    key: 'ecommerce',
    name: 'E-commerce',
    description: 'Print-on-demand, dropship, or owned-inventory storefronts.',
    targetMonthlyUsd: 15_000,
    suggestedChannels: ['etsy', 'shopify', 'printful', 'instagram', 'tiktok'],
    suggestedPlaybooks: ['print-on-demand.md', 'multi-channel-operations.md', 'social-media-playbook.md'],
    defaultAgents: ['ceo-orchestrator', 'pricing-engine', 'listing-quality-team', 'knowledge-curator'],
    notes: 'POD pricing engine + 5 platform connectors. Default target above floor to account for fees + COGS.',
  },
  saas: {
    key: 'saas',
    name: 'SaaS',
    description: 'Subscription software with self-serve onboarding + retention focus.',
    targetMonthlyUsd: 20_000,
    suggestedChannels: ['shopify'],
    suggestedPlaybooks: ['operator-runbook.md'],
    defaultAgents: ['ceo-orchestrator', 'cost-analyst', 'eval-runner', 'knowledge-curator'],
    notes: 'Heavier on cost-analyst + eval-runner. Retention metrics matter more than acquisition velocity.',
  },
  content: {
    key: 'content',
    name: 'Content / media',
    description: 'YouTube + short-form + newsletter monetization.',
    targetMonthlyUsd: 10_000,
    suggestedChannels: ['youtube', 'tiktok', 'instagram'],
    suggestedPlaybooks: ['youtube-automation.md', 'social-media-playbook.md', 'multi-channel-operations.md'],
    defaultAgents: ['ceo-orchestrator', 'short-form-engine', 'channel-acquisition', 'knowledge-curator'],
    notes: 'Short-form engine + channel acquisition prioritized. Lowest reasonable floor.',
  },
  services: {
    key: 'services',
    name: 'Services / agency',
    description: 'Productized services or boutique agency operations.',
    targetMonthlyUsd: 12_000,
    suggestedChannels: ['instagram'],
    suggestedPlaybooks: ['operator-runbook.md', 'social-media-playbook.md'],
    defaultAgents: ['ceo-orchestrator', 'sales-ops', 'knowledge-curator'],
    notes: 'Outreach-heavy. Sales-ops agent does qualification + scheduling.',
  },
}

/** Validate a template — used by workspace-seed before applying. */
export function getTemplate(key: BusinessTemplateKey | string): BusinessTemplate {
  const t = BUSINESS_TEMPLATES[key as BusinessTemplateKey]
  if (!t) return BUSINESS_TEMPLATES.generic
  if (t.targetMonthlyUsd < 10_000) {
    // Defense in depth — every template must respect the floor.
    throw new Error(`template ${t.key} violates $10k floor (target=${t.targetMonthlyUsd})`)
  }
  return t
}

/** List all available templates for operator UI / API surface. */
export function listTemplates(): BusinessTemplate[] {
  return Object.values(BUSINESS_TEMPLATES)
}

/** Apply a template to a workspace by emitting a `workspace.template_applied`
 *  event. The event payload becomes the source of truth for which
 *  defaults the operator picked at onboarding; downstream services
 *  (chat injection, agent provisioning) read it lazily. */
export async function applyTemplateToWorkspace(
  workspaceId: string,
  key: BusinessTemplateKey,
): Promise<{ applied: BusinessTemplateKey; targetMonthlyUsd: number }> {
  const t = getTemplate(key)
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type: 'workspace.template_applied', workspaceId,
      payload: {
        templateKey: t.key,
        targetMonthlyUsd: t.targetMonthlyUsd,
        suggestedChannels: t.suggestedChannels,
        suggestedPlaybooks: t.suggestedPlaybooks,
        defaultAgents: t.defaultAgents,
      },
      traceId: uuidv7(), correlationId: workspaceId, causationId: null,
      source: 'business-templates', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[business-templates]', e.message); return null })
  } catch { /* DB unavailable — tolerated */ }
  return { applied: t.key, targetMonthlyUsd: t.targetMonthlyUsd }
}
