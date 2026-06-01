import type { ConnectorDef } from '../connectors.js'

/**
 * Pinterest — visual-discovery distribution layer.
 *
 * Pinterest is a search engine that LOOKS like social. Users search with
 * intent; pins compound (a pin from 18 months ago can still drive sales today).
 * Perfect complement to POD (Printful/Shopify) and lifestyle/aesthetic
 * commerce. Conversion-to-purchase rates often beat Instagram's by 2-3x for
 * commerce niches.
 *
 * Auth: OAuth 2.0 (Pinterest API v5). Free tier; rate limits per business
 * account. Personal accounts have lower limits; business is free to upgrade.
 *
 * High-value use: auto-pin every POD product to themed boards, monitor
 * trending pins in operator's niche, schedule pin drops at peak-engagement
 * times. Idea pins (video) get the most current Pinterest reach.
 */
export const pinterestDef: ConnectorDef = {
  id:          'pinterest',
  name:        'Pinterest',
  category:    'social',
  description: 'Visual-discovery pinning + board management. Long-tail commerce surface — pins compound over months. Best paired with Printful/Shopify product feeds.',
  authType:    'oauth',
  defaultScopes: [
    'boards:read', 'boards:write',
    'pins:read', 'pins:write',
    'user_accounts:read',
  ],
  blockedActions: [
    'pinterest.delete_account', 'pinterest.update_billing',
    'pinterest.promote_pin',     // paid promotion managed at ads.pinterest.com
  ],
  actions: [
    { name: 'pinterest.read_user_me',     minPermission: 'read',  risk: 'low' },
    { name: 'pinterest.list_boards',      minPermission: 'read',  risk: 'low' },
    { name: 'pinterest.read_board',       minPermission: 'read',  risk: 'low' },
    { name: 'pinterest.list_pins',        minPermission: 'read',  risk: 'low' },
    { name: 'pinterest.read_pin',         minPermission: 'read',  risk: 'low' },
    { name: 'pinterest.search_pins',      minPermission: 'read',  risk: 'low' },
    { name: 'pinterest.read_analytics',   minPermission: 'read',  risk: 'low' },
    { name: 'pinterest.create_board',     minPermission: 'publish', risk: 'medium' },
    { name: 'pinterest.create_pin',       minPermission: 'publish', risk: 'high' },
    { name: 'pinterest.update_pin',       minPermission: 'publish', risk: 'medium' },
    { name: 'pinterest.delete_pin',       minPermission: 'publish', risk: 'medium' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://www.pinterest.com',
  signupUrl:             'https://www.pinterest.com/business/create',
  loginUrl:              'https://www.pinterest.com/login',
  oauthAuthorizationUrl:     'https://www.pinterest.com/oauth',
  apiKeyCreationUrl:     'https://developers.pinterest.com/apps',
  docsUrl:               'https://developers.pinterest.com/docs/api/v5',
  pricingUrl:            'https://business.pinterest.com',
  statusPageUrl:         'https://www.pinterestcareers.com',
  permissionExplanation: 'Read your boards + pins + analytics, create new boards + pins, update / delete pins you own. Paid pin promotion is NOT controlled here — manage at ads.pinterest.com.',
  accountRequired:       true,
  supportsApiKey:        false,
  freeTierAvailable:     true,
  iconKey:               'pinterest',
}
