import type { ConnectorDef } from '../connectors.js'

export const figmaDef: ConnectorDef = {
  id:          'figma',
  name:        'Figma',
  category:    'design',
  description: 'Files, comments, components. Read-only by default; comments require approval.',
  authType:    'api_key',          // personal access tokens
  defaultScopes: [],
  blockedActions: ['figma.delete_file', 'figma.modify_billing'],
  actions: [
    { name: 'figma.read_file',      minPermission: 'read',  risk: 'low' },
    { name: 'figma.list_comments',  minPermission: 'read',  risk: 'low' },
    { name: 'figma.post_comment',   minPermission: 'draft', risk: 'medium' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://www.figma.com',
  signupUrl:             'https://www.figma.com/signup',
  loginUrl:              'https://www.figma.com/login',
  apiKeyCreationUrl:     'https://www.figma.com/settings',         // Settings → Personal access tokens
  docsUrl:               'https://www.figma.com/developers/api',   // 301s to developers.figma.com/docs/rest-api
  pricingUrl:            'https://www.figma.com/pricing',
  permissionExplanation: 'Read your Figma files + comments. Posting comments requires per-action approval. We never delete files or change billing.',
  accountRequired:       true,
  supportsApiKey:        true,
  supportsOauth:         true,
  freeTierAvailable:     true,
  iconKey:               'figma',
}
