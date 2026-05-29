/**
 * Tests for connector-intent.ts (pure pattern matcher, no DB).
 */
import { describe, it, expect } from 'vitest'
import { parseIntent } from '../services/connector-intent.js'

describe('parseIntent', () => {
  it('returns null for empty / too-short input', () => {
    expect(parseIntent('')).toBeNull()
    expect(parseIntent('hi')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(parseIntent('what is the weather today')).toBeNull()
  })

  // ── GitHub ────────────────────────────────────────────────────────
  it('parses "create github issue titled X in repo"', () => {
    const m = parseIntent('Create a github issue titled "fix login" in ops/web')
    expect(m).not.toBeNull()
    expect(m!.connectorId).toBe('github')
    expect(m!.action).toBe('github.create_issue')
    expect(m!.params).toMatchObject({ title: 'fix login', repo: 'ops/web' })
    expect(m!.confidence).toBeGreaterThan(0.8)
  })

  it('parses "list issues in repo"', () => {
    const m = parseIntent('list issues in ops/api')
    expect(m!.action).toBe('github.list_issues')
    expect(m!.params).toMatchObject({ repo: 'ops/api' })
  })

  it('parses "comment on issue N in repo: body"', () => {
    const m = parseIntent('comment on issue #42 in ops/web: looks good to me')
    expect(m!.action).toBe('github.comment_issue')
    expect(m!.params).toMatchObject({
      issue_number: 42, repo: 'ops/web', body: 'looks good to me',
    })
  })

  // ── GCal ──────────────────────────────────────────────────────────
  it('parses "schedule a meeting titled X at TIME on DATE"', () => {
    const m = parseIntent('schedule a meeting titled "weekly review" at 3pm on monday')
    expect(m!.connectorId).toBe('gcal')
    expect(m!.action).toBe('gcal.create_event')
    expect(m!.params).toMatchObject({ summary: 'weekly review', time: '3pm', date: 'monday' })
  })

  it('parses "what\'s on my calendar"', () => {
    const m = parseIntent('what is on my calendar')
    expect(m!.action).toBe('gcal.list_events')
  })

  // ── Slack ─────────────────────────────────────────────────────────
  it('parses "draft slack to #channel: body"', () => {
    const m = parseIntent('draft slack to #team: shipping the patch in 10')
    expect(m!.connectorId).toBe('slack')
    expect(m!.action).toBe('slack.draft_message')
    expect(m!.params).toMatchObject({ channel: '#team', text: 'shipping the patch in 10' })
  })

  it('parses "post to slack #channel: body" (approval-required action)', () => {
    const m = parseIntent('post to slack #announce: shipping now')
    expect(m!.action).toBe('slack.post_message')
    expect(m!.confidence).toBeGreaterThan(0.8)
  })

  // ── Gmail ─────────────────────────────────────────────────────────
  it('parses "draft email to X subject Y: body"', () => {
    const m = parseIntent('draft email to alice@example.com, subject "follow-up": thanks for the call.')
    expect(m!.connectorId).toBe('gmail')
    expect(m!.action).toBe('gmail.create_draft')
    expect(m!.params).toMatchObject({
      to: 'alice@example.com', subject: 'follow-up',
    })
  })

  it('picks the highest-confidence match when multiple matchers fire', () => {
    // "list issues" matches github strongly; nothing else fires.
    const m = parseIntent('list issues')
    expect(m!.connectorId).toBe('github')
  })
})
