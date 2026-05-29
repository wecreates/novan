/**
 * connector-github.ts — real GitHub handlers via @octokit/rest.
 *
 * Auth: Personal Access Token stored in secrets_vault, fetched lazily
 * via ctx.getSecret() (which audits the reveal). OAuth flow can drop
 * in later without touching these handlers.
 *
 * Wired actions:
 *   - github.list_issues   (read)
 *   - github.read_issue    (read)
 *   - github.create_issue  (draft → approval required, medium risk)
 *   - github.comment_issue (draft → approval required, medium risk)
 *
 * Each handler:
 *   1. Calls ctx.getSecret() once per dispatch (cached for that call only)
 *   2. Constructs an Octokit instance with the token
 *   3. Calls the appropriate REST method
 *   4. Returns the relevant subset of the response (NOT the full PII-laden
 *      Octokit body — we strip fields that would bloat the audit row)
 *
 * Params for each action:
 *   list_issues:   { repo: "owner/name", state?: "open"|"closed"|"all" }
 *   read_issue:    { repo: "owner/name", issue_number: number }
 *   create_issue:  { repo: "owner/name", title: string, body?: string, labels?: string[] }
 *   comment_issue: { repo: "owner/name", issue_number: number, body: string }
 */
import { Octokit } from '@octokit/rest'
import type { ConnectorHandler, DryRunFn } from './connectors.js'

function parseRepo(spec: unknown): { owner: string; repo: string } {
  if (typeof spec !== 'string' || !spec.includes('/')) {
    throw new Error('params.repo must be "owner/name"')
  }
  const [owner, repo] = spec.split('/', 2)
  if (!owner || !repo) throw new Error('params.repo must be "owner/name"')
  return { owner, repo }
}

async function octokit(ctx: { getSecret: () => Promise<string> }): Promise<Octokit> {
  const token = await ctx.getSecret()
  return new Octokit({ auth: token })
}

// ── Handlers ──────────────────────────────────────────────────────────

export const listIssues: ConnectorHandler = async (ctx, params) => {
  const { owner, repo } = parseRepo(params['repo'])
  const state = (params['state'] as 'open' | 'closed' | 'all' | undefined) ?? 'open'
  const gh = await octokit(ctx)
  const { data } = await gh.issues.listForRepo({ owner, repo, state, per_page: 30 })
  // Strip to a useful subset to keep audit rows small + secret-free
  return data
    .filter(i => !i.pull_request)  // PRs come through the same endpoint
    .map(i => ({
      number:    i.number,
      title:     i.title,
      state:     i.state,
      labels:    (i.labels ?? []).map(l => typeof l === 'string' ? l : l.name).filter(Boolean),
      user:      i.user?.login ?? null,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      url:       i.html_url,
    }))
}

export const readIssue: ConnectorHandler = async (ctx, params) => {
  const { owner, repo } = parseRepo(params['repo'])
  const issue_number = Number(params['issue_number'])
  if (!Number.isFinite(issue_number) || issue_number < 1) throw new Error('params.issue_number required (positive integer)')
  const gh = await octokit(ctx)
  const { data: i } = await gh.issues.get({ owner, repo, issue_number })
  return {
    number:    i.number,
    title:     i.title,
    state:     i.state,
    body:      i.body,
    labels:    (i.labels ?? []).map(l => typeof l === 'string' ? l : l.name).filter(Boolean),
    user:      i.user?.login ?? null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    url:       i.html_url,
  }
}

export const createIssue: ConnectorHandler = async (ctx, params) => {
  const { owner, repo } = parseRepo(params['repo'])
  const title = String(params['title'] ?? '').trim()
  if (title.length < 3) throw new Error('params.title required (≥3 chars)')
  const body = typeof params['body'] === 'string' ? params['body'] : undefined
  const labels = Array.isArray(params['labels']) ? (params['labels'] as string[]) : undefined
  const gh = await octokit(ctx)
  const { data: i } = await gh.issues.create({
    owner, repo, title,
    ...(body   ? { body   } : {}),
    ...(labels ? { labels } : {}),
  })
  return { number: i.number, url: i.html_url, title: i.title, state: i.state }
}

export const commentIssue: ConnectorHandler = async (ctx, params) => {
  const { owner, repo } = parseRepo(params['repo'])
  const issue_number = Number(params['issue_number'])
  if (!Number.isFinite(issue_number) || issue_number < 1) throw new Error('params.issue_number required')
  const body = String(params['body'] ?? '').trim()
  if (body.length < 1) throw new Error('params.body required')
  const gh = await octokit(ctx)
  const { data: c } = await gh.issues.createComment({ owner, repo, issue_number, body })
  return { id: c.id, url: c.html_url, body: c.body }
}

// ── Dry-run previews (no network calls — pure summaries) ─────────────

export const createIssueDryRun: DryRunFn = async (_ctx, params) => {
  const title = String(params['title'] ?? '(no title)')
  const repo  = String(params['repo']  ?? '(no repo)')
  const labels = Array.isArray(params['labels']) ? params['labels'] : []
  return {
    summary: `would create issue "${title}" in ${repo}${labels.length ? ` with labels [${labels.join(', ')}]` : ''}`,
    affected: { repo, title, labels },
  }
}

export const commentIssueDryRun: DryRunFn = async (_ctx, params) => {
  const issue_number = params['issue_number']
  const repo = String(params['repo'] ?? '(no repo)')
  const body = String(params['body'] ?? '')
  return {
    summary: `would comment on ${repo}#${issue_number} (${body.length} chars)`,
    affected: { repo, issue_number, length: body.length },
  }
}
