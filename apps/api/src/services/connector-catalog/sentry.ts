import type { ConnectorDef } from '../connectors.js'

export const sentryDef: ConnectorDef = {
  id:          'sentry',
  name:        'Sentry',
  category:    'monitoring',
  description: 'Errors, performance, releases. Read issues + draft resolutions; mutations approval-gated.',
  authType:    'api_key',          // user auth tokens
  defaultScopes: ['event:read', 'project:read', 'org:read'],
  optionalScopes: ['event:admin', 'project:write'],
  blockedActions: ['sentry.delete_project', 'sentry.modify_billing'],
  actions: [
    { name: 'sentry.list_issues',   minPermission: 'read',  risk: 'low' },
    { name: 'sentry.read_issue',    minPermission: 'read',  risk: 'low' },
    { name: 'sentry.resolve_issue', minPermission: 'draft', risk: 'medium', requiredScopes: ['event:admin'] },
    { name: 'sentry.list_releases', minPermission: 'read',  risk: 'low' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://sentry.io',
  signupUrl:             'https://sentry.io/signup',
  loginUrl:              'https://sentry.io/auth/login',
  apiKeyCreationUrl:     'https://sentry.io/settings/account/api/auth-tokens',
  docsUrl:               'https://docs.sentry.io/api',
  pricingUrl:            'https://sentry.io/pricing',
  statusPageUrl:         'https://status.sentry.io',
  permissionExplanation: 'Read your Sentry issues, projects, and releases. Mutations (resolve, ignore) require per-action approval.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'sentry',
}
