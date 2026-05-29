/**
 * connector-catalog/ — one file per connector definition.
 *
 * RULES (enforced via type system + test suite):
 *   1. Every entry MUST set metadataVerified: true OR will be flagged
 *      in the UI with an "unverified URLs" warning.
 *   2. Every entry MUST include officialWebsiteUrl + docsUrl. Other
 *      URLs (signup/login/oauth/etc.) populated as applicable.
 *   3. Handlers are imported separately (see connector-defs.ts). This
 *      folder is metadata-only — adding a connector is just a new file.
 *
 * To add a connector:
 *   1. Create `<slug>.ts` exporting a `ConnectorDef`.
 *   2. Verify every URL by navigating to it in a browser.
 *   3. Add to CATALOG array below.
 *   4. (Optional) wire real handlers in a separate `connector-<slug>.ts`.
 */
import type { ConnectorDef } from '../connectors.js'
import { githubDef } from './github.js'
import { gcalDef }   from './gcal.js'
import { gmailDef }  from './gmail.js'
import { slackDef }  from './slack.js'
import { openaiDef } from './openai.js'
import { anthropicDef } from './anthropic.js'
import { linearDef } from './linear.js'
import { notionDef } from './notion.js'
import { vercelDef } from './vercel.js'
import { cloudflareDef } from './cloudflare.js'
import { discordDef } from './discord.js'
import { stripeReadonlyDef } from './stripe-readonly.js'
import { gitlabDef } from './gitlab.js'
import { huggingfaceDef } from './huggingface.js'
import { openrouterDef } from './openrouter.js'
import { groqDef } from './groq.js'
import { replicateDef } from './replicate.js'
import { airtableDef } from './airtable.js'
import { posthogDef } from './posthog.js'
import { netlifyDef } from './netlify.js'
import { mistralDef } from './mistral.js'
import { digitaloceanDef } from './digitalocean.js'
import { sentryDef } from './sentry.js'
import { supabaseDef } from './supabase.js'
import { resendDef } from './resend.js'
import { sendgridDef } from './sendgrid.js'
import { dropboxDef } from './dropbox.js'
import { figmaDef } from './figma.js'
import { calcomDef } from './calcom.js'
import { neonDef } from './neon.js'
import { asanaDef } from './asana.js'

export const CATALOG: ConnectorDef[] = [
  // Original 12 (verified prior turns)
  githubDef, gcalDef, gmailDef, slackDef,
  openaiDef, anthropicDef,
  linearDef, notionDef,
  vercelDef, cloudflareDef, discordDef,
  stripeReadonlyDef,
  // Batch 2 (verified via WebFetch — round 1)
  gitlabDef, huggingfaceDef, openrouterDef, groqDef, replicateDef,
  airtableDef, posthogDef, netlifyDef, mistralDef, digitaloceanDef,
  sentryDef, supabaseDef,
  // Batch 3 (verified via WebFetch — round 2)
  resendDef, sendgridDef, dropboxDef, figmaDef, calcomDef, neonDef, asanaDef,
]
