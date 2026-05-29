import type { ConnectorDef } from '../connectors.js'

export const supabaseDef: ConnectorDef = {
  id:          'supabase',
  name:        'Supabase',
  category:    'database',
  description: 'Postgres + Auth + Storage as a service. Read-only schema/data inspection by default.',
  authType:    'api_key',          // service role key OR personal access token
  defaultScopes: [],
  blockedActions: ['supabase.delete_project', 'supabase.modify_billing'],
  actions: [
    { name: 'supabase.list_projects',  minPermission: 'read',    risk: 'low' },
    { name: 'supabase.list_tables',    minPermission: 'read',    risk: 'low' },
    { name: 'supabase.run_select',     minPermission: 'read',    risk: 'low' },
    { name: 'supabase.run_migration',  minPermission: 'publish', risk: 'high' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://supabase.com',
  signupUrl:             'https://supabase.com/dashboard/sign-up',
  loginUrl:              'https://supabase.com/dashboard/sign-in',
  apiKeyCreationUrl:     'https://supabase.com/dashboard/account/tokens',
  developerAppSetupUrl:  'https://supabase.com/dashboard',
  docsUrl:               'https://supabase.com/docs/reference/api',
  pricingUrl:            'https://supabase.com/pricing',
  statusPageUrl:         'https://status.supabase.com',
  permissionExplanation: 'Inspect your Supabase projects, schemas, and read data via SELECT queries. Migrations + destructive mutations require per-action approval.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'supabase',
}
