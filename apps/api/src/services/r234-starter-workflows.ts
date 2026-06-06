/**
 * R146.234 — Starter workflow pack. Three example R210 workflows that
 * exercise the capability layer end-to-end. Operator can run them
 * immediately and see results in /brain.html Metrics tab.
 *
 *   health-sweep         — calls platform.status + radar.ticker, summarizes
 *   skill-audit          — lists all skills + recent outcomes, scores them
 *   memory-condense      — pulls top 20 memories, asks LLM to merge dupes
 */
import { workflowCreate } from './r210-workflow.js'

interface StarterWorkflow {
  name:        string
  description: string
  script:      string
}

export const STARTER_WORKFLOWS: StarterWorkflow[] = [
  {
    name:        'health-sweep',
    description: 'Quick platform-health sweep. Reports anything that needs attention.',
    script: `
log('starting health sweep')
const status = await agent('Call platform.status via brain ops and return the JSON. Then summarize: any open issues, recent errors, or open self-dev findings? Keep it under 3 sentences.')
log('status: ' + JSON.stringify(status).slice(0, 200))
const radar = await agent('Call radar.ticker and return the line.')
log('radar: ' + JSON.stringify(radar))
return { status, radar }
`.trim(),
  },
  {
    name:        'skill-audit',
    description: 'Audit registered skills + recent outcomes. Flags skills with low win rates.',
    script: `
log('auditing skills')
const skills = await agent('Call skill.list and return the array as JSON.')
const outcomes = await agent('Call brain.metrics, extract recentOutcomes, return as JSON.')
const lowPerformers = (Array.isArray(skills) ? skills : []).filter(s => s.uses >= 5 && (s.wins / s.uses) < 0.4)
log('low performers: ' + lowPerformers.length)
return { totalSkills: Array.isArray(skills) ? skills.length : 0, recentOutcomes: outcomes, lowPerformers }
`.trim(),
  },
  {
    name:        'memory-condense',
    description: 'Pull workspace memories and ask the LLM to spot duplicates worth merging.',
    script: `
log('loading memories')
const mems = await agent('Call memory.kv.recall (no params) and return the array.')
log('memories: ' + (Array.isArray(mems) ? mems.length : 0))
if (!Array.isArray(mems) || mems.length < 3) return { dedupes: [], reason: 'not enough memories to dedupe' }
const dupes = await agent(
  'Here are memories: ' + JSON.stringify(mems.slice(0, 30)) +
  ' — return {dedupes:[{keeperKey, mergeKeys:[], reason}]} where mergeKeys are keys whose value overlaps keeperKey. Empty array if none overlap.',
  { schema: { type: 'object', properties: { dedupes: { type: 'array' } }, required: ['dedupes'] } }
)
return { totalMemories: mems.length, suggestions: dupes }
`.trim(),
  },
]

export async function seedStarterWorkflows(workspaceId: string): Promise<{ created: number; existed: number }> {
  let created = 0, existed = 0
  for (const w of STARTER_WORKFLOWS) {
    const r = await workflowCreate(workspaceId, {
      name: w.name, description: w.description, script: w.script,
    }).catch(() => null)
    if (r?.created) created++
    else if (r) existed++
  }
  return { created, existed }
}
