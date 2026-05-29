import type { ConnectorDef } from '../connectors.js'
import * as ln from '../connector-linear.js'

export const linearDef: ConnectorDef = {
  id:          'linear',
  name:        'Linear',
  category:    'project-management',
  description: 'Issues, projects, cycles. Read + create within team scopes.',
  authType:    'api_key',
  defaultScopes: ['read'],
  optionalScopes: ['write', 'admin'],
  blockedActions: ['linear.delete_team', 'linear.delete_workspace'],
  actions: [
    { name: 'linear.list_issues',  minPermission: 'read',  risk: 'low',
      handler: ln.listIssues },
    { name: 'linear.read_issue',   minPermission: 'read',  risk: 'low',
      handler: ln.readIssue },
    { name: 'linear.create_issue', minPermission: 'draft', risk: 'medium',
      handler: ln.createIssue, dryRun: ln.createIssueDryRun },
    { name: 'linear.update_issue', minPermission: 'draft', risk: 'medium',
      handler: ln.updateIssue, dryRun: ln.updateIssueDryRun },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://linear.app',
  signupUrl:             'https://linear.app/signup',
  loginUrl:              'https://linear.app/login',
  apiKeyCreationUrl:     'https://linear.app/settings/api',
  docsUrl:               'https://developers.linear.app',
  pricingUrl:            'https://linear.app/pricing',
  permissionExplanation: 'Read your Linear issues and create or update them only when you approve each action. We never delete teams or workspaces.',
  accountRequired:       true,
  supportsApiKey:        true,
  supportsOauth:         true,    // Linear supports OAuth too
  freeTierAvailable:     true,
  iconKey:               'linear',
}
