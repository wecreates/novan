import type { ConnectorDef } from '../connectors.js'

export const sendgridDef: ConnectorDef = {
  id:          'sendgrid',
  name:        'SendGrid',
  category:    'communication',
  description: 'Twilio SendGrid email API. Send + manage email campaigns. Per-volume billing.',
  authType:    'api_key',
  defaultScopes: [],     // SendGrid API keys have built-in scopes set at creation
  blockedActions: ['sendgrid.delete_account', 'sendgrid.modify_billing'],
  actions: [
    { name: 'sendgrid.send_email',   minPermission: 'publish', risk: 'medium' },
    { name: 'sendgrid.list_stats',   minPermission: 'read',    risk: 'low' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://sendgrid.com',
  signupUrl:             'https://signup.sendgrid.com',
  loginUrl:              'https://app.sendgrid.com/login',
  apiKeyCreationUrl:     'https://app.sendgrid.com/settings/api_keys',
  docsUrl:               'https://docs.sendgrid.com',
  pricingUrl:            'https://sendgrid.com/pricing',
  statusPageUrl:         'https://status.sendgrid.com',
  permissionExplanation: 'Send email + read stats with your SendGrid API key. Sending requires per-action approval.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'sendgrid',
}
