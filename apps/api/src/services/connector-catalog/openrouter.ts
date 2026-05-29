import type { ConnectorDef } from '../connectors.js'
import { openrouterChat, openrouterListModels } from '../connector-openai-compat.js'

export const openrouterDef: ConnectorDef = {
  id:          'openrouter',
  name:        'OpenRouter',
  category:    'ai-provider',
  description: 'Unified API gateway across 100+ LLM providers. OpenAI-compatible. Billed per-token by OpenRouter.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['openrouter.modify_billing', 'openrouter.delete_account'],
  actions: [
    { name: 'openrouter.chat_completion', minPermission: 'draft', risk: 'low', handler: openrouterChat },
    { name: 'openrouter.list_models',     minPermission: 'read',  risk: 'low', handler: openrouterListModels },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://openrouter.ai',
  signupUrl:             'https://openrouter.ai/sign-in',
  loginUrl:              'https://openrouter.ai/sign-in',
  apiKeyCreationUrl:     'https://openrouter.ai/keys',
  docsUrl:               'https://openrouter.ai/docs',
  pricingUrl:            'https://openrouter.ai/models',
  permissionExplanation: 'Call any model in the OpenRouter catalog via your API key. We never alter your billing or organization settings.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,    // free credits at signup
  iconKey:               'openrouter',
}
