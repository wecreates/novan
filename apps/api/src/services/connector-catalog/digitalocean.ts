import type { ConnectorDef } from '../connectors.js'

export const digitaloceanDef: ConnectorDef = {
  id:          'digitalocean',
  name:        'DigitalOcean',
  category:    'cloud',
  description: 'Droplets, App Platform, Spaces, K8s. Read-only by default; mutations require approval.',
  authType:    'api_key',          // personal access tokens
  defaultScopes: ['read'],
  optionalScopes: ['write'],
  blockedActions: ['digitalocean.modify_billing', 'digitalocean.destroy_account'],
  actions: [
    { name: 'digitalocean.list_droplets',  minPermission: 'read',    risk: 'low' },
    { name: 'digitalocean.list_apps',      minPermission: 'read',    risk: 'low' },
    { name: 'digitalocean.power_action',   minPermission: 'publish', risk: 'high' },
    { name: 'digitalocean.create_droplet', minPermission: 'admin',   risk: 'high' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://www.digitalocean.com',
  signupUrl:             'https://cloud.digitalocean.com/registrations/new',
  loginUrl:              'https://cloud.digitalocean.com/login',
  apiKeyCreationUrl:     'https://cloud.digitalocean.com/account/api/tokens',
  docsUrl:               'https://docs.digitalocean.com/reference/api',
  pricingUrl:            'https://www.digitalocean.com/pricing',
  statusPageUrl:         'https://status.digitalocean.com',
  permissionExplanation: 'Read your DigitalOcean droplets, apps, and resources. Any infrastructure mutation (create, destroy, power) requires per-action approval.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     false,
  iconKey:               'digitalocean',
}
