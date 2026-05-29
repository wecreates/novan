import type { ConnectorDef } from '../connectors.js'
import { mistralChat, mistralListModels } from '../connector-openai-compat.js'

export const mistralDef: ConnectorDef = {
  id:          'mistral',
  name:        'Mistral AI',
  category:    'ai-provider',
  description: 'Mistral + Mixtral models via La Plateforme API. Per-token billing.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['mistral.modify_billing'],
  actions: [
    { name: 'mistral.chat_completion', minPermission: 'draft', risk: 'low', handler: mistralChat },
    { name: 'mistral.embeddings',      minPermission: 'draft', risk: 'low' },  // not wired — embeddings request shape differs
    { name: 'mistral.list_models',     minPermission: 'read',  risk: 'low', handler: mistralListModels },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://mistral.ai',
  signupUrl:             'https://console.mistral.ai',
  loginUrl:              'https://console.mistral.ai',
  apiKeyCreationUrl:     'https://console.mistral.ai/api-keys',
  docsUrl:               'https://docs.mistral.ai',
  pricingUrl:            'https://mistral.ai/pricing',
  permissionExplanation: 'Call Mistral inference + embedding endpoints using your API key. No account or billing modification.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'mistral',
}
