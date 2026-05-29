import type { ConnectorDef } from '../connectors.js'

export const replicateDef: ConnectorDef = {
  id:          'replicate',
  name:        'Replicate',
  category:    'ai-provider',
  description: 'Run open-source ML models (image, video, audio, language) via hosted endpoints. Per-second billing.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['replicate.delete_account', 'replicate.modify_billing'],
  actions: [
    { name: 'replicate.run_prediction', minPermission: 'draft', risk: 'medium' },
    { name: 'replicate.list_models',    minPermission: 'read',  risk: 'low' },
    { name: 'replicate.get_prediction', minPermission: 'read',  risk: 'low' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://replicate.com',
  signupUrl:             'https://replicate.com/signin',
  loginUrl:              'https://replicate.com/signin',
  apiKeyCreationUrl:     'https://replicate.com/account/api-tokens',
  docsUrl:               'https://replicate.com/docs',
  pricingUrl:            'https://replicate.com/pricing',
  permissionExplanation: 'Run hosted ML models using your token. Each prediction is billed by Replicate; we do not modify billing.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'replicate',
}
