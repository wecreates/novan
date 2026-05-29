import type { ConnectorDef } from '../connectors.js'

export const posthogDef: ConnectorDef = {
  id:          'posthog',
  name:        'PostHog',
  category:    'analytics',
  description: 'Product analytics, session replays, feature flags. Read-only metrics + draft feature flags.',
  authType:    'api_key',          // personal API keys
  defaultScopes: [],
  blockedActions: ['posthog.delete_project', 'posthog.modify_billing'],
  actions: [
    { name: 'posthog.list_events',      minPermission: 'read',  risk: 'low' },
    { name: 'posthog.query_insight',    minPermission: 'read',  risk: 'low' },
    { name: 'posthog.list_feature_flags', minPermission: 'read', risk: 'low' },
    { name: 'posthog.create_feature_flag', minPermission: 'draft', risk: 'medium' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://posthog.com',
  signupUrl:             'https://us.posthog.com/signup',
  loginUrl:              'https://us.posthog.com/login',
  apiKeyCreationUrl:     'https://us.posthog.com/settings/user-api-keys',
  docsUrl:               'https://posthog.com/docs/api',
  pricingUrl:            'https://posthog.com/pricing',
  statusPageUrl:         'https://status.posthog.com',
  permissionExplanation: 'Read events + insights from your PostHog projects. Mutations (feature flag creation) require per-action approval. Use us.posthog.com or eu.posthog.com depending on your region.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'posthog',
}
