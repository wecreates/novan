import type { ConnectorDef } from '../connectors.js'

export const calcomDef: ConnectorDef = {
  id:          'calcom',
  name:        'Cal.com',
  category:    'productivity',
  description: 'Bookings, event types, availability. Self-hostable scheduling.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['calcom.delete_account', 'calcom.modify_billing'],
  actions: [
    { name: 'calcom.list_bookings',      minPermission: 'read',  risk: 'low' },
    { name: 'calcom.list_event_types',   minPermission: 'read',  risk: 'low' },
    { name: 'calcom.create_booking',     minPermission: 'draft', risk: 'medium' },
    { name: 'calcom.cancel_booking',     minPermission: 'admin', risk: 'high' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://cal.com',
  signupUrl:             'https://app.cal.com/signup',
  loginUrl:              'https://app.cal.com/auth/login',
  apiKeyCreationUrl:     'https://app.cal.com/settings/developer/api-keys',
  docsUrl:               'https://cal.com/docs/api-reference',
  pricingUrl:            'https://cal.com/pricing',
  permissionExplanation: 'Read your bookings + event types. Creating + cancelling bookings requires per-action approval.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'calcom',
}
