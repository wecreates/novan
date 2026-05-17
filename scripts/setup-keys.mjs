#!/usr/bin/env node
/**
 * setup-keys.mjs — One-command interactive .env bootstrap.
 *
 * Items #1-#4 ergonomics: prompts for each provider key, links to where
 * to get it, writes .env at repo root. Idempotent — preserves existing
 * values, only asks about missing ones.
 *
 * Usage:  pnpm setup-keys
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath }                            from 'node:url'
import { dirname, join }                            from 'node:path'
import { createInterface }                          from 'node:readline'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = join(ROOT, '.env')

const KEYS = [
  { env: 'GROQ_API_KEY',         url: 'https://console.groq.com/keys',                 why: 'LLM (required for brain-plan, prompt rewriter, research extract)' },
  { env: 'GEMINI_API_KEY',       url: 'https://aistudio.google.com/app/apikey',        why: 'Optional secondary LLM' },
  { env: 'REPLICATE_API_TOKEN',  url: 'https://replicate.com/account/api-tokens',      why: 'Image gen (~$0.003/img with flux-schnell — cheapest)' },
  { env: 'OPENAI_API_KEY',       url: 'https://platform.openai.com/api-keys',          why: 'Image gen + embeddings (alternative to Replicate)' },
  { env: 'STABILITY_API_KEY',    url: 'https://platform.stability.ai/',                why: 'Optional image gen provider' },
  { env: 'FAL_KEY',              url: 'https://fal.ai/dashboard/keys',                 why: 'Optional fast image gen provider' },
  { env: 'SEARCH_API_KEY',       url: 'https://tavily.com',                            why: 'Auto-discover research sources (Tavily free tier works)' },
  { env: 'SEARCH_PROVIDER',      url: '',                                              why: "Set to 'tavily' | 'serper' | 'brave'" },
  { env: 'NOTIFY_WEBHOOK_URL',   url: '',                                              why: 'Generic webhook for governance alerts (optional)' },
  { env: 'PUSHOVER_TOKEN',       url: 'https://pushover.net/api',                      why: 'Optional: phone push notifications' },
  { env: 'PUSHOVER_USER',        url: '',                                              why: 'Pushover user key (paired with token above)' },
  { env: 'SLACK_WEBHOOK_URL',    url: 'https://api.slack.com/messaging/webhooks',      why: 'Optional Slack notifications' },
  { env: 'DISCORD_WEBHOOK_URL',  url: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks', why: 'Optional Discord notifications' },
  { env: 'OLLAMA_URL',           url: 'https://ollama.com',                            why: 'Optional local embeddings (alternative to OpenAI embeddings)' },
]

function parseEnv(content) {
  const out = {}
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function serializeEnv(map) {
  const header = '# Novan — local environment overrides (gitignored)\n'
  const body = Object.entries(map)
    .filter(([_, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  return header + body + '\n'
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  const existing = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {}
  console.log('\n🔑  Novan key setup')
  console.log(`     .env at ${ENV_PATH}\n`)
  console.log('Press ENTER to skip any key. Existing values are preserved.\n')

  let asked = 0, set = 0
  for (const k of KEYS) {
    if (existing[k.env]) {
      console.log(`  ✓ ${k.env} (already set)`)
      continue
    }
    asked++
    console.log(`\n  ${k.env}`)
    console.log(`    ${k.why}`)
    if (k.url) console.log(`    get it:  ${k.url}`)
    const v = await prompt(`    value (or ENTER to skip): `)
    if (v) {
      existing[k.env] = v
      set++
    }
  }

  writeFileSync(ENV_PATH, serializeEnv(existing), { encoding: 'utf8', mode: 0o600 })
  console.log(`\n✓  Wrote ${ENV_PATH}`)
  console.log(`   ${set}/${asked} new values set; ${Object.keys(existing).length} total.\n`)
  if (set > 0) {
    console.log('   Restart the container to apply:')
    console.log('     docker compose -f docker-compose.local.yml --env-file .env up -d --build\n')
  }
}

await main()
