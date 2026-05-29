import type { ConnectorDef } from '../connectors.js'
import { groqChat, groqListModels } from '../connector-openai-compat.js'

export const groqDef: ConnectorDef = {
  id:          'groq',
  name:        'Groq',
  category:    'ai-provider',
  description: 'Ultra-low-latency LPU inference. OpenAI-compatible chat completions API.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['groq.modify_billing'],
  actions: [
    { name: 'groq.chat_completion', minPermission: 'draft', risk: 'low', handler: groqChat },
    { name: 'groq.list_models',     minPermission: 'read',  risk: 'low', handler: groqListModels },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://groq.com',
  signupUrl:             'https://console.groq.com/login',
  loginUrl:              'https://console.groq.com/login',
  apiKeyCreationUrl:     'https://console.groq.com/keys',
  docsUrl:               'https://console.groq.com/docs',
  pricingUrl:            'https://groq.com/pricing',
  permissionExplanation: 'Call Groq chat-completion endpoints via your API key. No billing or org modification.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'groq',
}
