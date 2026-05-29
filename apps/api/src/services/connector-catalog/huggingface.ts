import type { ConnectorDef } from '../connectors.js'
import { hfChat, hfListModels } from '../connector-openai-compat.js'

export const huggingfaceDef: ConnectorDef = {
  id:          'huggingface',
  name:        'Hugging Face',
  category:    'ai-provider',
  description: 'Inference API across hundreds of open models. Billed per-token via HF Inference Providers.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: ['huggingface.delete_repo', 'huggingface.modify_billing'],
  actions: [
    { name: 'huggingface.chat_completion', minPermission: 'draft', risk: 'low', handler: hfChat },
    { name: 'huggingface.list_models',     minPermission: 'read',  risk: 'low', handler: hfListModels },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://huggingface.co',
  signupUrl:             'https://huggingface.co/join',
  loginUrl:              'https://huggingface.co/login',
  apiKeyCreationUrl:     'https://huggingface.co/settings/tokens',
  docsUrl:               'https://huggingface.co/docs/api-inference',
  pricingUrl:            'https://huggingface.co/pricing',
  statusPageUrl:         'https://status.huggingface.co',
  permissionExplanation: 'Call inference endpoints across HF-hosted models using your API token. We never modify your account or billing.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,
  iconKey:               'huggingface',
}
