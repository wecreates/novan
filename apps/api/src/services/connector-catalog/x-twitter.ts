import type { ConnectorDef } from '../connectors.js'

/**
 * X (Twitter) — organic posting + read analytics.
 *
 * Biggest missing distribution surface for organic growth + paid amplification.
 * Useful for: announcement threads, real-time engagement, community building,
 * cross-posting from YouTube/blog drops. Read endpoints feed signal back to
 * the brain for trend detection + audience intel.
 *
 * Auth: OAuth 2.0 with PKCE. X v2 API requires paid tier for write endpoints
 * ($100/mo Basic at minimum as of 2025); read endpoints have a free tier with
 * heavy rate limits (1500 tweets / month read). Operator should provision a
 * Basic-tier app before connecting.
 *
 * Money-related guarantee: no write action publishes paid content; ads are
 * managed via X Ads Manager (separate connector if added later). All organic
 * writes require OPERATOR_APPROVED per SPEC §11.6.
 */
export const xTwitterDef: ConnectorDef = {
  id:          'x-twitter',
  name:        'X (Twitter)',
  category:    'social',
  description: 'Organic posting, thread building, mention monitoring, and audience analytics on X. Paid ads are NOT controlled here.',
  authType:    'oauth',
  defaultScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  blockedActions: [
    'x.delete_account', 'x.update_profile_payment',
    'x.promote_tweet',          // paid ads handled out-of-scope
  ],
  actions: [
    { name: 'x.read_user_me',         minPermission: 'read',  risk: 'low' },
    { name: 'x.read_user_tweets',     minPermission: 'read',  risk: 'low' },
    { name: 'x.read_tweet',           minPermission: 'read',  risk: 'low' },
    { name: 'x.search_recent',        minPermission: 'read',  risk: 'low' },
    { name: 'x.read_mentions',        minPermission: 'read',  risk: 'low' },
    { name: 'x.read_engagement',      minPermission: 'read',  risk: 'low' },
    { name: 'x.post_tweet',           minPermission: 'publish', risk: 'high' },
    { name: 'x.post_thread',          minPermission: 'publish', risk: 'high' },
    { name: 'x.reply_tweet',          minPermission: 'publish', risk: 'high' },
    { name: 'x.delete_tweet',         minPermission: 'publish', risk: 'high' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://x.com',
  signupUrl:             'https://x.com/i/flow/signup',
  loginUrl:              'https://x.com/i/flow/login',
  oauthAuthorizationUrl:     'https://x.com/i/oauth2/authorize',
  apiKeyCreationUrl:     'https://developer.x.com/en/portal/dashboard',
  docsUrl:               'https://docs.x.com/x-api/introduction',
  pricingUrl:            'https://developer.x.com/en/portal/products',
  statusPageUrl:         'https://api.x.com/2/status',
  permissionExplanation: 'Read your timeline + mentions, post tweets + threads, reply to mentions. All write actions require OPERATOR_APPROVED. Paid ads are NOT controlled by this connector — manage at ads.x.com.',
  accountRequired:       true,
  supportsApiKey:        false,
  freeTierAvailable:     true,    // read-only free tier; write tier paid
  iconKey:               'x',
}
