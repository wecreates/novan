/**
 * R146.217 — Starter skill pack. Seeds the operator's workspace with 8
 * skills that exercise the R206-R216 capability layer. Without seeded
 * skills the Thompson bandit picker has nothing to converge on.
 *
 * Each skill encodes a real Novan workflow: when the operator's chat
 * matches the whenToUse pattern, the brain loop activates it and the
 * model follows the instructions to call the right brain ops.
 */
import { skillCreate } from './r206-skills.js'

interface StarterSkill {
  name:         string
  description:  string
  whenToUse:    string
  instructions: string
}

export const STARTER_SKILLS: StarterSkill[] = [
  {
    name: 'platform-status-check',
    description: 'Check Novan platform health and surface anything broken',
    whenToUse: 'when the operator asks about platform status, health, errors, self-dev findings, or system state',
    instructions: `Call \`platform.status\` then summarize in 1-2 sentences. Highlight in this order:
1. recentErrors > 0 → mention them
2. openSelfDevFindings > 0 → list the count
3. radarOpen > 0 → call \`radar.ticker\` and read line
4. openPentestCrit > 0 → escalate
5. cronFiresLast6h < 20 → say crons look quiet
If everything is 0, say "Platform is clean and idle, no action needed."`,
  },
  {
    name: 'cron-health-triage',
    description: 'Diagnose which crons are missing heartbeats and why',
    whenToUse: 'when the operator asks about cron health, missing crons, scheduler status, or background jobs',
    instructions: `Call \`cron.health\` if available, else GET /healthz/cron via web.fetch. List crons that have NOT fired in the last hour by checking events table via \`db.query\` on the events table filtered by type LIKE 'cron.%'. For any cron missing > 1h, recommend: (1) check if it's flag-disabled via \`flag.list\`, (2) check container uptime, (3) look for cron.error events.`,
  },
  {
    name: 'cost-investigation',
    description: 'Investigate AI cost spikes and identify the biggest spenders',
    whenToUse: 'when the operator asks about AI cost, token usage, who is spending, or budget',
    instructions: `Call \`db.query\` on ai_usage table filtered to last 24h. Group by (provider, task_type, model). Report: total cost, calls, avg prompt+output tokens. Top 3 task types by cost. If gemini chat avg_in=0, mention the metrics gap (now fixed in R198 — old rows have 0). Recommend a budget cap if any provider crossed 50¢/day.`,
  },
  {
    name: 'self-dev-review',
    description: 'Review pending self-dev findings and decide what to act on',
    whenToUse: 'when the operator asks about self-dev, autonomous improvements, proposals, or what Novan found',
    instructions: `Call \`selfdev.findings\` for open findings then \`selfdev.proposals\` for draft proposals. Group findings by severity. For each high/medium proposal, summarize the title + rationale + risk_level + confidence. Flag any with confidence > 0.7 AND risk_level=low as candidates for approval. Never auto-approve — just recommend.`,
  },
  {
    name: 'memory-search',
    description: 'Recall things the workspace has remembered across sessions',
    whenToUse: 'when the operator asks "what do you remember", "what do you know about X", or references past decisions',
    instructions: `Call \`memory.kv.recall\` (no params) to load top-50 memories sorted by importance. If the operator's question contains specific keywords, scan the memory values for matches. Quote the most relevant memory key + value. If nothing matches, say so honestly — don't fabricate.`,
  },
  {
    name: 'capability-discovery',
    description: 'Find which brain op or skill applies to a task the operator describes',
    whenToUse: 'when the operator asks "can you / can Novan / how do I" do something and you are unsure which op to use',
    instructions: `Call \`op.search\` with relevant keywords from the operator's question. Also call \`skill.list\` to see registered skills. Return: top 3 matching ops with description + risk, and any matching skill names. Recommend whether to use a single op directly or invoke a skill that wraps multiple ops.`,
  },
  {
    name: 'event-pattern-analysis',
    description: 'Detect anomalies in the events stream over the last few hours',
    whenToUse: 'when the operator asks about recent activity, anomalies, what is happening, or wants a pulse',
    instructions: `Call \`db.query\` on events table for last 60 minutes grouped by source + type. Compare each type's count to its 24h-baseline using a second query (24h count / 24 = expected hourly rate). Flag any type whose recent rate is > 3× or < 1/3× baseline. Report top 5 anomalies with the (type, expected, actual) tuple.`,
  },
  {
    name: 'workflow-author',
    description: 'Draft a new R210 workflow script for a multi-step automation the operator describes',
    whenToUse: 'when the operator describes a multi-step recurring task and wants to automate it',
    instructions: `Parse the operator's described steps into a sequence of brain op calls. Output a workflow script using these primitives:
- \`await agent(prompt, {schema?})\` — sub-agent reasoning
- \`await parallel([thunk, thunk, ...])\` — fan out
- \`log(message)\` — record progress
- \`args\` — input parameters
Then call \`wf.create\` with {name, description, script}. The operator runs it via \`wf.run\` afterward. Don't auto-run — the operator confirms.`,
  },
]

export async function seedStarterPack(workspaceId: string): Promise<{ created: number; existed: number }> {
  let created = 0, existed = 0
  for (const s of STARTER_SKILLS) {
    const r = await skillCreate(workspaceId, s).catch(() => null)
    if (r?.created) created++
    else if (r) existed++
  }
  return { created, existed }
}
