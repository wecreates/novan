import type { ConnectorDef } from '../connectors.js'
import * as an from '../connector-anthropic.js'

export const anthropicDef: ConnectorDef = {
  id:          'anthropic',
  name:        'Anthropic',
  category:    'ai-provider',
  description: 'Claude messages API. Billed per-use by Anthropic.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['anthropic.delete_org', 'anthropic.modify_billing'],
  actions: [
    { name: 'anthropic.messages',    minPermission: 'draft', risk: 'low',
      handler: an.messages },
    { name: 'anthropic.list_models', minPermission: 'read',  risk: 'low',
      handler: an.listModels },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://anthropic.com',
  signupUrl:             'https://console.anthropic.com',
  loginUrl:              'https://console.anthropic.com/login',
  apiKeyCreationUrl:     'https://console.anthropic.com/settings/keys',
  docsUrl:               'https://docs.anthropic.com',
  pricingUrl:            'https://anthropic.com/pricing',
  statusPageUrl:         'https://status.anthropic.com',
  permissionExplanation: 'Call the Anthropic Messages API using your API key. We never modify your console settings or billing.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     false,
  iconKey:               'anthropic',
}
