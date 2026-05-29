import type { ConnectorDef } from '../connectors.js'

export const netlifyDef: ConnectorDef = {
  id:          'netlify',
  name:        'Netlify',
  category:    'cloud',
  description: 'Sites, deploys, forms. Read-only by default; deploys require approval.',
  authType:    'api_key',          // personal access tokens
  defaultScopes: [],
  blockedActions: ['netlify.delete_site', 'netlify.modify_billing'],
  actions: [
    { name: 'netlify.list_sites',       minPermission: 'read',    risk: 'low' },
    { name: 'netlify.list_deploys',     minPermission: 'read',    risk: 'low' },
    { name: 'netlify.trigger_deploy',   minPermission: 'publish', risk: 'high' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://www.netlify.com',
  signupUrl:             'https://app.netlify.com/signup',
  loginUrl:              'https://app.netlify.com',
  apiKeyCreationUrl:     'https://app.netlify.com/user/applications#personal-access-tokens',
  docsUrl:               'https://docs.netlify.com/api/get-started',
  pricingUrl:            'https://www.netlify.com/pricing',
  statusPageUrl:         'https://www.netlifystatus.com',
  permissionExplanation: 'Read your Netlify sites and deploys. Triggering deploys requires per-action approval. We never modify billing or delete sites.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'netlify',
}
