import type { ConnectorDef } from '../connectors.js'

export const cloudflareDef: ConnectorDef = {
  id:          'cloudflare',
  name:        'Cloudflare',
  category:    'cloud',
  description: 'DNS, Workers, R2, Pages. Read-only by default; mutations require approval.',
  authType:    'token',
  defaultScopes: [],  // Cloudflare API tokens are scoped per-token
  blockedActions: ['cloudflare.delete_account', 'cloudflare.modify_billing'],
  actions: [
    { name: 'cloudflare.list_zones',       minPermission: 'read',  risk: 'low' },
    { name: 'cloudflare.list_dns_records', minPermission: 'read',  risk: 'low' },
    { name: 'cloudflare.create_dns_record', minPermission: 'draft', risk: 'high' },
    { name: 'cloudflare.purge_cache',      minPermission: 'publish', risk: 'medium' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://www.cloudflare.com',
  signupUrl:             'https://dash.cloudflare.com/sign-up',
  loginUrl:              'https://dash.cloudflare.com/login',
  apiKeyCreationUrl:     'https://dash.cloudflare.com/profile/api-tokens',
  docsUrl:               'https://developers.cloudflare.com/api',
  pricingUrl:            'https://www.cloudflare.com/plans',
  statusPageUrl:         'https://www.cloudflarestatus.com',
  permissionExplanation: 'Read your Cloudflare zones, DNS, and cache. Any mutation (DNS change, cache purge) requires your per-action approval.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'cloudflare',
}
