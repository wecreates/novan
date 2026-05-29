/**
 * connector-intent.ts — natural-language intent → connector action.
 *
 * Heuristic mapper. Operator types or speaks "Create a GitHub issue
 * called 'fix login' in ops/web" → we return:
 *   { connectorId: 'github', action: 'github.create_issue',
 *     params: { repo: 'ops/web', title: 'fix login' }, confidence: 0.85 }
 *
 * Honest scope:
 *   - Pure pattern matching. No LLM. Returns null when nothing matches.
 *   - Does NOT call dispatchAction. Caller decides whether to run.
 *   - Confidence reflects how many fields were extracted with certainty;
 *     under 0.5 means "you should probably edit before approving."
 *
 * The mapper supports the 4 first-wave connectors. Adding patterns for
 * a new connector is one block per action.
 */

export interface IntentMatch {
  connectorId: string
  action:      string
  params:      Record<string, unknown>
  confidence:  number          // 0..1; under 0.5 ≈ "needs operator edit"
  reasoning:   string          // why we picked this — shown in UI
}

// ── GitHub ────────────────────────────────────────────────────────────

function matchGitHub(text: string): IntentMatch | null {
  const t = text.toLowerCase()

  // "create [an] issue [titled X] [in REPO]"
  if (/\bcreate (an? )?(github )?issue\b/.test(t) || /\bopen (an? )?issue\b/.test(t)) {
    const title = text.match(/(?:title[d]?|called|named|:)\s+["']?([^"'\n]{4,160})["']?/i)?.[1]?.trim()
    const repo  = text.match(/\bin\s+([a-z0-9_\-.]+\/[a-z0-9_\-.]+)/i)?.[1]
    return {
      connectorId: 'github',
      action:      'github.create_issue',
      params: {
        ...(title ? { title } : {}),
        ...(repo  ? { repo  } : {}),
      },
      confidence: 0.4 + (title ? 0.3 : 0) + (repo ? 0.3 : 0),
      reasoning:  'matched "create issue" pattern',
    }
  }
  // "list issues [in REPO]"
  if (/\blist (github )?issues\b/.test(t) || /\bshow (open )?issues\b/.test(t)) {
    const repo  = text.match(/\bin\s+([a-z0-9_\-.]+\/[a-z0-9_\-.]+)/i)?.[1]
    return {
      connectorId: 'github',
      action:      'github.list_issues',
      params:      { ...(repo ? { repo } : {}) },
      confidence:  0.6 + (repo ? 0.3 : 0),
      reasoning:   'matched "list issues" pattern',
    }
  }
  // "comment on issue N [in REPO]: ..."
  const commentM = text.match(/\bcomment on (?:github )?issue #?(\d+)(?:\s+in\s+([a-z0-9_\-.]+\/[a-z0-9_\-.]+))?[:\s]+([^]+)/i)
  if (commentM) {
    return {
      connectorId: 'github',
      action:      'github.comment_issue',
      params: {
        issue_number: Number(commentM[1]),
        ...(commentM[2] ? { repo: commentM[2] } : {}),
        body: commentM[3]!.trim(),
      },
      confidence: 0.8,
      reasoning:  'matched "comment on issue N" pattern',
    }
  }
  return null
}

// ── Google Calendar ──────────────────────────────────────────────────

function matchGCal(text: string): IntentMatch | null {
  const t = text.toLowerCase()
  // "schedule [a] meeting/event [titled X] [at TIME] [on DATE]"
  if (/\b(schedule|create|add) (a |an )?(meeting|event|calendar)\b/.test(t) ||
      /\bbook (a |an )?(meeting|call|event)\b/.test(t)) {
    const title = text.match(/(?:title[d]?|called|named|:)\s+["']?([^"'\n]{4,160})["']?/i)?.[1]?.trim()
    const time  = text.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i)?.[1]
    const date  = text.match(/\bon\s+([a-z]+day|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/i)?.[1]
    return {
      connectorId: 'gcal',
      action:      'gcal.create_event',
      params: {
        ...(title ? { summary: title } : {}),
        ...(time  ? { time }            : {}),
        ...(date  ? { date }            : {}),
      },
      confidence: 0.4 + (title ? 0.2 : 0) + (time ? 0.2 : 0) + (date ? 0.2 : 0),
      reasoning:  'matched "schedule event" pattern',
    }
  }
  if (/\blist (upcoming |today'?s? )?(events|meetings|calendar)\b/.test(t) ||
      /\bwhat(?:'?s| is) (on|in) (my )?calendar\b/.test(t)) {
    return {
      connectorId: 'gcal',
      action:      'gcal.list_events',
      params:      {},
      confidence:  0.85,
      reasoning:   'matched "list events" pattern',
    }
  }
  return null
}

// ── Slack ────────────────────────────────────────────────────────────

function matchSlack(text: string): IntentMatch | null {
  const t = text.toLowerCase()
  // "draft slack message to #channel: ..."  OR  "draft slack: ..."
  const draftM = text.match(/\bdraft (?:a )?slack (?:message )?(?:to )?(#[a-z0-9_-]+)?(?:\s*:)?\s+([^]+)/i)
  if (draftM) {
    return {
      connectorId: 'slack',
      action:      'slack.draft_message',
      params: {
        ...(draftM[1] ? { channel: draftM[1] } : {}),
        text: (draftM[2] ?? '').trim(),
      },
      confidence: 0.6 + (draftM[1] ? 0.3 : 0),
      reasoning:  'matched "draft slack" pattern',
    }
  }
  // "post to slack #channel: ..."  (high-risk; pipeline gates with approval)
  const postM = text.match(/\bpost to slack (#[a-z0-9_-]+)(?:\s*:)?\s+([^]+)/i)
  if (postM) {
    return {
      connectorId: 'slack',
      action:      'slack.post_message',
      params:      { channel: postM[1], text: (postM[2] ?? '').trim() },
      confidence:  0.85,
      reasoning:   'matched "post to slack" pattern (approval required)',
    }
  }
  if (/\blist slack channels\b/.test(t) || /\bshow (my )?slack channels\b/.test(t)) {
    return {
      connectorId: 'slack',
      action:      'slack.list_channels',
      params:      {},
      confidence:  0.9,
      reasoning:   'matched "list channels" pattern',
    }
  }
  return null
}

// ── Gmail ────────────────────────────────────────────────────────────

function matchGmail(text: string): IntentMatch | null {
  const t = text.toLowerCase()
  // "draft email to EMAIL [subject X]: ..."
  const draftM = text.match(/\bdraft (?:an? )?(?:email|gmail) to ([\w.\-]+@[\w.\-]+)(?:[,\s]+subject\s+["']?([^"'\n]{1,160})["']?)?(?:\s*:)?\s+([^]+)/i)
  if (draftM) {
    return {
      connectorId: 'gmail',
      action:      'gmail.create_draft',
      params: {
        to: draftM[1],
        ...(draftM[2] ? { subject: draftM[2] } : {}),
        body: (draftM[3] ?? '').trim(),
      },
      confidence: 0.75 + (draftM[2] ? 0.2 : 0),
      reasoning:  'matched "draft email to X" pattern',
    }
  }
  if (/\blist (?:my )?(?:gmail )?drafts\b/.test(t)) {
    return {
      connectorId: 'gmail',
      action:      'gmail.list_drafts',
      params:      {},
      confidence:  0.9,
      reasoning:   'matched "list drafts" pattern',
    }
  }
  return null
}

// ── Public API ────────────────────────────────────────────────────────

const MATCHERS: Array<(t: string) => IntentMatch | null> = [
  matchGitHub, matchGCal, matchSlack, matchGmail,
]

/**
 * Try every matcher; return the highest-confidence hit, or null.
 * Matchers are intentionally independent + order-insensitive.
 */
export function parseIntent(text: string): IntentMatch | null {
  if (!text || text.trim().length < 4) return null
  let best: IntentMatch | null = null
  for (const m of MATCHERS) {
    const hit = m(text)
    if (hit && (!best || hit.confidence > best.confidence)) best = hit
  }
  return best
}
