import type { ConnectorDef } from '../connectors.js'

export const airtableDef: ConnectorDef = {
  id:          'airtable',
  name:        'Airtable',
  category:    'productivity',
  description: 'Bases as spreadsheet-databases. Read + write records within granted base scopes.',
  authType:    'api_key',          // personal access tokens
  defaultScopes: ['data.records:read'],
  optionalScopes: ['data.records:write', 'schema.bases:read'],
  blockedActions: ['airtable.delete_base', 'airtable.delete_workspace'],
  actions: [
    { name: 'airtable.list_records',  minPermission: 'read',  risk: 'low' },
    { name: 'airtable.read_record',   minPermission: 'read',  risk: 'low' },
    { name: 'airtable.create_record', minPermission: 'draft', risk: 'medium', requiredScopes: ['data.records:write'] },
    { name: 'airtable.update_record', minPermission: 'draft', risk: 'medium', requiredScopes: ['data.records:write'] },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://airtable.com',
  signupUrl:             'https://airtable.com/signup',
  loginUrl:              'https://airtable.com/login',
  apiKeyCreationUrl:     'https://airtable.com/create/tokens',
  developerAppSetupUrl:  'https://airtable.com/create/tokens',
  docsUrl:               'https://airtable.com/developers/web/api/introduction',
  pricingUrl:            'https://airtable.com/pricing',
  permissionExplanation: 'Read and write records in bases your token has explicit access to. Token scopes limit what we can touch.',
  accountRequired:       true,
  supportsApiKey:        true,
  supportsOauth:         true,
  freeTierAvailable:     true,
  iconKey:               'airtable',
}
