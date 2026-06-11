/**
 * R662 — GitHub repo intel (no auth required).
 *
 * Public read-only ops that work without a GH token. Used by novan.agent
 * when answering "what's the latest version of X" / "is repo Y active" /
 * "what does the README of Z say". Hits the public api.github.com (rate
 * limit 60/hr without auth; uses GITHUB_TOKEN if present for 5000/hr).
 */

interface GhRepo {
  full_name:    string
  description?: string
  homepage?:    string
  language?:    string
  stargazers_count: number
  forks_count:  number
  open_issues_count: number
  default_branch: string
  pushed_at:    string
  topics?:      string[]
  archived?:    boolean
  license?:     { spdx_id?: string } | null
}

interface GhRelease {
  tag_name:   string
  name?:      string
  body?:      string
  published_at: string
  html_url:   string
  prerelease: boolean
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Novan-R662',
  }
  const tok = process.env['GITHUB_TOKEN']
  if (tok) h['Authorization'] = `Bearer ${tok}`
  return h
}

export async function repoInfo(repo: string): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: 'repo must be "owner/name"' }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders() })
    if (!res.ok) return { ok: false, error: `gh ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` }
    const r = await res.json() as GhRepo
    return {
      ok: true,
      data: {
        full_name:        r.full_name,
        description:      r.description,
        homepage:         r.homepage,
        language:         r.language,
        stars:            r.stargazers_count,
        forks:            r.forks_count,
        open_issues:      r.open_issues_count,
        default_branch:   r.default_branch,
        last_push:        r.pushed_at,
        topics:           r.topics ?? [],
        archived:         !!r.archived,
        license:          r.license?.spdx_id ?? null,
      },
    }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function latestRelease(repo: string): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: 'repo must be "owner/name"' }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: ghHeaders() })
    if (res.status === 404) return { ok: true, data: { tag_name: null, note: 'no releases published' } }
    if (!res.ok) return { ok: false, error: `gh ${res.status}` }
    const r = await res.json() as GhRelease
    return {
      ok: true,
      data: {
        tag_name:     r.tag_name,
        name:         r.name,
        published_at: r.published_at,
        html_url:     r.html_url,
        prerelease:   r.prerelease,
        body_preview: (r.body ?? '').slice(0, 800),
      },
    }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function readme(repo: string): Promise<{ ok: boolean; data?: { content: string; html_url: string }; error?: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: 'repo must be "owner/name"' }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: { ...ghHeaders(), 'Accept': 'application/vnd.github.raw' } })
    if (!res.ok) return { ok: false, error: `gh ${res.status}` }
    const text = await res.text()
    return { ok: true, data: { content: text.slice(0, 8000), html_url: `https://github.com/${repo}#readme` } }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}
