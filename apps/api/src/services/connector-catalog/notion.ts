import type { ConnectorDef } from '../connectors.js'
import * as nt from '../connector-notion.js'

export const notionDef: ConnectorDef = {
  id:          'notion',
  name:        'Notion',
  category:    'documents',
  description: 'Pages, databases, blocks. Read + draft within shared workspace scope.',
  authType:    'oauth',
  defaultScopes: ['read_content'],
  optionalScopes: ['insert_content', 'update_content'],
  blockedActions: ['notion.delete_workspace', 'notion.archive_workspace'],
  actions: [
    { name: 'notion.search',         minPermission: 'read',  risk: 'low',
      handler: nt.search },
    { name: 'notion.read_page',      minPermission: 'read',  risk: 'low',
      handler: nt.readPage },
    { name: 'notion.create_page',    minPermission: 'draft', risk: 'medium',
      handler: nt.createPage, dryRun: nt.createPageDryRun },
    // notion.update_page REMOVED — was declared without handler, causing
    // silent "not implemented" failures from connectors.dispatchAction.
    // Re-add only when nt.updatePage exists in connector-notion.ts.
    { name: 'notion.query_database', minPermission: 'read',  risk: 'low',
      handler: nt.queryDatabase },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://www.notion.so',
  signupUrl:             'https://www.notion.so/signup',
  loginUrl:              'https://www.notion.so/login',
  developerAppSetupUrl:  'https://www.notion.so/my-integrations',
  apiKeyCreationUrl:     'https://www.notion.so/my-integrations',
  docsUrl:               'https://developers.notion.com',
  pricingUrl:            'https://www.notion.so/pricing',
  permissionExplanation: 'Read and update Notion pages within the workspace you connect. We can only see pages you explicitly share with the integration.',
  accountRequired:       true,
  supportsOauth:         true,
  supportsApiKey:        true,    // internal integrations use tokens
  freeTierAvailable:     true,
  iconKey:               'notion',
}
