import type { ConnectorDef } from '../connectors.js'

export const asanaDef: ConnectorDef = {
  id:          'asana',
  name:        'Asana',
  category:    'project-management',
  description: 'Tasks, projects, workspaces. Read + create within granted token scope.',
  authType:    'api_key',          // personal access tokens
  defaultScopes: [],
  blockedActions: ['asana.delete_workspace', 'asana.modify_billing'],
  actions: [
    { name: 'asana.list_tasks',    minPermission: 'read',  risk: 'low' },
    { name: 'asana.read_task',     minPermission: 'read',  risk: 'low' },
    { name: 'asana.create_task',   minPermission: 'draft', risk: 'medium' },
    { name: 'asana.update_task',   minPermission: 'draft', risk: 'medium' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://asana.com',
  signupUrl:             'https://asana.com/create-account',
  loginUrl:              'https://app.asana.com/-/login',
  apiKeyCreationUrl:     'https://app.asana.com/0/my-apps',
  developerAppSetupUrl:  'https://app.asana.com/0/my-apps',
  docsUrl:               'https://developers.asana.com/docs',
  pricingUrl:            'https://asana.com/pricing',
  permissionExplanation: 'Read your tasks + projects. Creating + updating tasks requires per-action approval. We never delete workspaces or modify billing.',
  accountRequired:       true,
  supportsApiKey:        true,
  supportsOauth:         true,
  freeTierAvailable:     true,
  iconKey:               'asana',
}
