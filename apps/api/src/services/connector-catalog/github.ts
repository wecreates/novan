import type { ConnectorDef } from '../connectors.js'
import * as gh from '../connector-github.js'

export const githubDef: ConnectorDef = {
  id:          'github',
  name:        'GitHub',
  category:    'developer',
  description: 'Issues, pull requests, repositories. Read + write within granted repo scopes.',
  authType:    'oauth',
  defaultScopes: ['repo', 'read:user'],
  optionalScopes: ['workflow', 'read:org'],
  blockedActions: ['github.delete_repo', 'github.delete_branch_protected', 'github.transfer_repo'],
  actions: [
    { name: 'github.list_issues',   minPermission: 'read',    risk: 'low',
      handler: gh.listIssues },
    { name: 'github.read_issue',    minPermission: 'read',    risk: 'low',
      handler: gh.readIssue },
    { name: 'github.create_issue',  minPermission: 'draft',   risk: 'medium', requiredScopes: ['repo'],
      handler: gh.createIssue,  dryRun: gh.createIssueDryRun },
    { name: 'github.comment_issue', minPermission: 'draft',   risk: 'medium', requiredScopes: ['repo'],
      handler: gh.commentIssue, dryRun: gh.commentIssueDryRun },
    { name: 'github.create_pr',     minPermission: 'publish', risk: 'high',   requiredScopes: ['repo'] },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://github.com',
  signupUrl:             'https://github.com/signup',
  loginUrl:              'https://github.com/login',
  apiKeyCreationUrl:     'https://github.com/settings/tokens',
  developerAppSetupUrl:  'https://github.com/settings/developers',
  docsUrl:               'https://docs.github.com/en/rest',
  pricingUrl:            'https://github.com/pricing',
  statusPageUrl:         'https://www.githubstatus.com',
  permissionExplanation: 'Read your repositories, issues, pull requests, and basic user info. Create issues and comments only when you explicitly approve each action.',
  accountRequired:       true,
  supportsOauth:         true,
  supportsApiKey:        true,    // PATs work today
  freeTierAvailable:     true,
  iconKey:               'github',
}
