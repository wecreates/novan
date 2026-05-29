import type { ConnectorDef } from '../connectors.js'

export const resendDef: ConnectorDef = {
  id:          'resend',
  name:        'Resend',
  category:    'communication',
  description: 'Transactional email API. Draft + send messages, manage audiences. Per-message billing.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['resend.delete_account', 'resend.modify_billing'],
  actions: [
    { name: 'resend.send_email',     minPermission: 'publish', risk: 'medium' },
    { name: 'resend.list_emails',    minPermission: 'read',    risk: 'low' },
    { name: 'resend.list_domains',   minPermission: 'read',    risk: 'low' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://resend.com',
  signupUrl:             'https://resend.com/signup',
  loginUrl:              'https://resend.com/login',
  apiKeyCreationUrl:     'https://resend.com/api-keys',
  docsUrl:               'https://resend.com/docs',
  pricingUrl:            'https://resend.com/pricing',
  permissionExplanation: 'Send + read transactional emails. Sending requires per-action approval. We never modify your billing or domain settings.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'resend',
}
