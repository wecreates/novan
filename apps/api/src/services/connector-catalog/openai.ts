import type { ConnectorDef } from '../connectors.js'
import * as oa from '../connector-openai.js'

export const openaiDef: ConnectorDef = {
  id:          'openai',
  name:        'OpenAI',
  category:    'ai-provider',
  description: 'Chat completions, embeddings, image generation, voice. Billed per-use by OpenAI.',
  authType:    'api_key',
  defaultScopes: [],         // OpenAI API keys are scoped per key, not per request
  blockedActions: ['openai.delete_org', 'openai.modify_billing'],
  actions: [
    { name: 'openai.chat_completion',  minPermission: 'draft',  risk: 'low',
      handler: oa.chatCompletion },
    { name: 'openai.embeddings',       minPermission: 'draft',  risk: 'low',
      handler: oa.embeddings },
    { name: 'openai.image_generate',   minPermission: 'draft',  risk: 'medium' },
    { name: 'openai.list_models',      minPermission: 'read',   risk: 'low',
      handler: oa.listModels },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://openai.com',
  signupUrl:             'https://platform.openai.com/signup',
  loginUrl:              'https://platform.openai.com/login',
  apiKeyCreationUrl:     'https://platform.openai.com/api-keys',
  docsUrl:               'https://platform.openai.com/docs',
  pricingUrl:            'https://openai.com/api/pricing',
  statusPageUrl:         'https://status.openai.com',
  permissionExplanation: 'Call OpenAI APIs using your API key. We never modify your billing, organization settings, or delete account resources.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     false,    // pay-per-use; no perpetual free tier
  iconKey:               'openai',
}
