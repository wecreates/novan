/**
 * Tests for connector-github.ts — real handlers with Octokit mocked.
 *
 * What this proves:
 *   - parseRepo input validation
 *   - listIssues filters PRs and returns the slim subset (no secrets leak)
 *   - createIssue validates title, calls Octokit.issues.create with right args
 *   - commentIssue validates both issue_number and body
 *   - dry-run previews are pure (no network)
 *   - getSecret is called exactly once per handler invocation (audit trail
 *     gets one reveal per action)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Build mock fns in hoisted scope so vi.mock can reach them.
const { mockListForRepo, mockGet, mockCreate, mockCreateComment, octokitCtorSpy } = vi.hoisted(() => ({
  mockListForRepo:   vi.fn(),
  mockGet:           vi.fn(),
  mockCreate:        vi.fn(),
  mockCreateComment: vi.fn(),
  octokitCtorSpy:    vi.fn(),
}))

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    issues = {
      listForRepo:    mockListForRepo,
      get:            mockGet,
      create:         mockCreate,
      createComment:  mockCreateComment,
    }
    constructor(opts: unknown) { octokitCtorSpy(opts) }
  },
}))

import {
  listIssues, readIssue, createIssue, commentIssue,
  createIssueDryRun, commentIssueDryRun,
} from '../services/connector-github.js'

function ctx() {
  const getSecret = vi.fn(async () => 'ghp_test_token')
  return {
    workspaceId: 'ws-1', accountId: 'a1', connectorId: 'github',
    getSecret, scopes: ['repo'], permission: 'draft' as const,
  }
}

beforeEach(() => {
  mockListForRepo.mockReset()
  mockGet.mockReset()
  mockCreate.mockReset()
  mockCreateComment.mockReset()
  octokitCtorSpy.mockReset()
})

describe('parseRepo validation', () => {
  it('listIssues rejects bad repo string', async () => {
    const c = ctx()
    await expect(listIssues(c, { repo: 'no-slash' })).rejects.toThrow(/owner\/name/)
    expect(c.getSecret).not.toHaveBeenCalled()    // failed validation before reveal
  })

  it('listIssues rejects missing repo', async () => {
    const c = ctx()
    await expect(listIssues(c, {})).rejects.toThrow(/owner\/name/)
  })
})

describe('listIssues', () => {
  it('passes token to Octokit, filters PRs, returns slim subset', async () => {
    mockListForRepo.mockResolvedValue({
      data: [
        { number: 1, title: 'real issue', state: 'open', labels: ['bug'], user: { login: 'alice' }, created_at: 'a', updated_at: 'b', html_url: 'u1', body: 'secret things' },
        { number: 2, title: 'a pull request', state: 'open', pull_request: { url: 'x' }, labels: [], user: { login: 'bob' }, created_at: 'a', updated_at: 'b', html_url: 'u2', body: '' },
      ],
    })
    const c = ctx()
    const r = await listIssues(c, { repo: 'ops/web', state: 'open' })
    expect(c.getSecret).toHaveBeenCalledOnce()
    expect(octokitCtorSpy).toHaveBeenCalledWith({ auth: 'ghp_test_token' })
    expect(mockListForRepo).toHaveBeenCalledWith({ owner: 'ops', repo: 'web', state: 'open', per_page: 30 })
    expect(Array.isArray(r)).toBe(true)
    const rows = r as Array<{ number: number; body?: unknown }>
    expect(rows.length).toBe(1)              // PR filtered out
    expect(rows[0]!.number).toBe(1)
    expect((rows[0] as Record<string, unknown>)['body']).toBeUndefined()  // body stripped from list payload
  })
})

describe('readIssue', () => {
  it('validates issue_number is positive integer', async () => {
    const c = ctx()
    await expect(readIssue(c, { repo: 'a/b' })).rejects.toThrow(/issue_number/)
    await expect(readIssue(c, { repo: 'a/b', issue_number: 0 })).rejects.toThrow(/issue_number/)
    await expect(readIssue(c, { repo: 'a/b', issue_number: -3 })).rejects.toThrow(/issue_number/)
  })

  it('returns subset including body', async () => {
    mockGet.mockResolvedValue({
      data: { number: 7, title: 't', state: 'open', body: 'b', labels: [], user: { login: 'x' }, created_at: 'a', updated_at: 'b', html_url: 'u' },
    })
    const r = await readIssue(ctx(), { repo: 'o/r', issue_number: 7 })
    expect((r as Record<string, unknown>)['number']).toBe(7)
    expect((r as Record<string, unknown>)['body']).toBe('b')
  })
})

describe('createIssue', () => {
  it('rejects too-short title', async () => {
    const c = ctx()
    await expect(createIssue(c, { repo: 'a/b', title: 'hi' })).rejects.toThrow(/title required/)
    expect(c.getSecret).not.toHaveBeenCalled()
  })

  it('creates with title + body + labels', async () => {
    mockCreate.mockResolvedValue({
      data: { number: 42, html_url: 'u/42', title: 'fix login', state: 'open' },
    })
    const r = await createIssue(ctx(), {
      repo: 'ops/web', title: 'fix login', body: 'broke on safari', labels: ['bug', 'p1'],
    })
    expect(mockCreate).toHaveBeenCalledWith({
      owner: 'ops', repo: 'web', title: 'fix login', body: 'broke on safari', labels: ['bug', 'p1'],
    })
    expect(r).toEqual({ number: 42, url: 'u/42', title: 'fix login', state: 'open' })
  })

  it('handles bare create (no body / labels)', async () => {
    mockCreate.mockResolvedValue({ data: { number: 1, html_url: 'u', title: 't', state: 'open' } })
    await createIssue(ctx(), { repo: 'a/b', title: 'short title' })
    expect(mockCreate).toHaveBeenCalledWith({ owner: 'a', repo: 'b', title: 'short title' })
  })
})

describe('commentIssue', () => {
  it('rejects empty body', async () => {
    const c = ctx()
    await expect(commentIssue(c, { repo: 'a/b', issue_number: 1, body: '' })).rejects.toThrow(/body required/)
    await expect(commentIssue(c, { repo: 'a/b', issue_number: 1, body: '   ' })).rejects.toThrow(/body required/)
  })

  it('posts the comment', async () => {
    mockCreateComment.mockResolvedValue({ data: { id: 99, html_url: 'u/99', body: 'looks good' } })
    const r = await commentIssue(ctx(), { repo: 'a/b', issue_number: 5, body: 'looks good' })
    expect(mockCreateComment).toHaveBeenCalledWith({ owner: 'a', repo: 'b', issue_number: 5, body: 'looks good' })
    expect((r as Record<string, unknown>)['id']).toBe(99)
  })
})

describe('dry-run previews (pure, no network)', () => {
  it('createIssueDryRun describes the action', async () => {
    const c = ctx()
    const p = await createIssueDryRun(c, { repo: 'a/b', title: 'fix', labels: ['bug'] })
    expect(p.summary).toMatch(/would create issue "fix" in a\/b.*bug/)
    expect(p.affected).toMatchObject({ repo: 'a/b', title: 'fix', labels: ['bug'] })
    expect(c.getSecret).not.toHaveBeenCalled()   // dry-run never reveals secret
  })

  it('commentIssueDryRun reports length without leaking body', async () => {
    const p = await commentIssueDryRun(ctx(), {
      repo: 'a/b', issue_number: 7, body: 'this is a private internal comment',
    })
    expect(p.summary).toMatch(/would comment on a\/b#7 \(\d+ chars\)/)
    expect(p.affected).toMatchObject({ repo: 'a/b', issue_number: 7 })
    // Body itself should NOT appear in the preview (only length)
    expect(JSON.stringify(p)).not.toContain('private internal comment')
  })
})
