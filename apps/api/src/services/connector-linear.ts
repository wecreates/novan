/**
 * connector-linear.ts — real Linear handlers via their public GraphQL API.
 *
 * Auth: Linear API key (lin_api_…) stored in vault, fetched via getSecret.
 * Wire protocol: HTTPS POST to https://api.linear.app/graphql
 *
 * Wired actions:
 *   - linear.list_issues   (read)
 *   - linear.read_issue    (read)
 *   - linear.create_issue  (draft → approval required, medium risk)
 *   - linear.update_issue  (draft → approval required, medium risk)
 *
 * Why GraphQL (not REST): Linear has no REST API. We POST GraphQL strings
 * with minimal fields to keep audit payload small.
 */
import type { ConnectorHandler, DryRunFn } from './connectors.js'
import { fetchWithRetry } from './provider-retry.js'

const ENDPOINT = 'https://api.linear.app/graphql'

interface GqlError { message: string }
interface GqlResp<T> { data?: T; errors?: GqlError[] }

async function gql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const out = await fetchWithRetry('linear', ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type':  'application/json',
      'authorization': token,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),   // prevent indefinite hang on Linear API stall
  })
  if (!out.ok) throw new Error(`Linear API ${out.status}: ${out.statusText}`)
  const j = await out.response.json() as GqlResp<T>
  if (j.errors?.length) throw new Error(`Linear GraphQL: ${j.errors.map(e => e.message).join('; ')}`)
  if (!j.data) throw new Error('Linear GraphQL: no data')
  return j.data
}

// ── Handlers ──────────────────────────────────────────────────────────

export const listIssues: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const first = Math.min(Number(params['first'] ?? 25), 100)
  const stateName = typeof params['state'] === 'string' ? String(params['state']) : null

  const filter = stateName ? `(filter: { state: { name: { eq: "${stateName.replace(/"/g, '\\"')}" } } })` : ''
  const data = await gql<{ issues: { nodes: Array<{
    id: string; identifier: string; title: string;
    state: { name: string };
    priority: number; createdAt: string; updatedAt: string; url: string;
  }> } }>(
    token,
    `query ListIssues($first: Int!) {
      issues(first: $first${filter ? ', ' + filter.slice(1, -1) : ''}) {
        nodes { id identifier title state { name } priority createdAt updatedAt url }
      }
    }`,
    { first },
  )
  return data.issues.nodes.map(n => ({
    id: n.id, identifier: n.identifier, title: n.title,
    state: n.state.name, priority: n.priority,
    createdAt: n.createdAt, updatedAt: n.updatedAt, url: n.url,
  }))
}

export const readIssue: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const id = String(params['id'] ?? params['identifier'] ?? '').trim()
  if (!id) throw new Error('params.id or params.identifier required')
  const data = await gql<{ issue: {
    id: string; identifier: string; title: string; description: string | null;
    state: { name: string }; priority: number; url: string;
    createdAt: string; updatedAt: string;
  } | null }>(
    token,
    `query ReadIssue($id: String!) {
      issue(id: $id) { id identifier title description state { name } priority url createdAt updatedAt }
    }`,
    { id },
  )
  if (!data.issue) throw new Error(`issue ${id} not found`)
  return data.issue
}

export const createIssue: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const title = String(params['title'] ?? '').trim()
  if (title.length < 3) throw new Error('params.title required (≥3 chars)')
  const teamId = String(params['teamId'] ?? '').trim()
  if (!teamId) throw new Error('params.teamId required (Linear team UUID)')
  const description = typeof params['description'] === 'string' ? params['description'] : null
  const priority = typeof params['priority'] === 'number' ? params['priority'] : null

  const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
    token,
    `mutation Create($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url } }
    }`,
    { input: {
      title, teamId,
      ...(description ? { description } : {}),
      ...(priority    !== null ? { priority } : {}),
    } },
  )
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error('Linear refused issueCreate')
  return data.issueCreate.issue
}

export const updateIssue: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const id = String(params['id'] ?? '').trim()
  if (!id) throw new Error('params.id required')
  const input: Record<string, unknown> = {}
  if (typeof params['title']       === 'string') input['title']       = params['title']
  if (typeof params['description'] === 'string') input['description'] = params['description']
  if (typeof params['stateId']     === 'string') input['stateId']     = params['stateId']
  if (typeof params['priority']    === 'number') input['priority']    = params['priority']
  if (Object.keys(input).length === 0) throw new Error('at least one of title/description/stateId/priority required')

  const data = await gql<{ issueUpdate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
    token,
    `mutation Upd($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
    }`,
    { id, input },
  )
  if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error('Linear refused issueUpdate')
  return data.issueUpdate.issue
}

// ── Dry-run previews ──────────────────────────────────────────────────

export const createIssueDryRun: DryRunFn = async (_ctx, params) => {
  const title = String(params['title'] ?? '(no title)')
  const teamId = String(params['teamId'] ?? '(no team)')
  return { summary: `would create Linear issue "${title}" in team ${teamId}`, affected: { teamId, title } }
}

export const updateIssueDryRun: DryRunFn = async (_ctx, params) => {
  const id = String(params['id'] ?? '?')
  const fields = ['title','description','stateId','priority'].filter(f => params[f] !== undefined)
  return { summary: `would update Linear issue ${id} (fields: ${fields.join(', ') || 'none'})`, affected: { id, fields } }
}
