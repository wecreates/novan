import type { ConnectorDef } from '../connectors.js'
import * as sl from '../connector-slack.js'

export const slackDef: ConnectorDef = {
  id:          'slack',
  name:        'Slack',
  category:    'communication',
  description: 'Draft messages for operator review. Posting requires explicit approval.',
  authType:    'oauth',
  defaultScopes: ['chat:write', 'channels:read'],
  optionalScopes: ['groups:read', 'im:read', 'users:read'],
  blockedActions: ['slack.message_all_users', 'slack.admin_remove_user'],
  actions: [
    { name: 'slack.list_channels',  minPermission: 'read',    risk: 'low',
      handler: sl.listChannels },
    { name: 'slack.draft_message',  minPermission: 'draft',   risk: 'low',
      handler: sl.draftMessage },
    { name: 'slack.post_message',   minPermission: 'publish', risk: 'medium',
      handler: sl.postMessage, dryRun: sl.postMessageDryRun },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://slack.com',
  signupUrl:             'https://slack.com/get-started',
  loginUrl:              'https://slack.com/signin',
  developerAppSetupUrl:  'https://api.slack.com/apps',
  docsUrl:               'https://api.slack.com/methods',
  pricingUrl:            'https://slack.com/pricing',
  statusPageUrl:         'https://status.slack.com',
  permissionExplanation: 'List channels you grant us access to, and prepare draft messages. Posting any message requires your per-action approval.',
  accountRequired:       true,
  supportsOauth:         true,
  freeTierAvailable:     true,
  iconKey:               'slack',
}
