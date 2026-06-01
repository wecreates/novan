import type { ConnectorDef } from '../connectors.js'

/**
 * Reddit — niche community organic growth + audience intel.
 *
 * Reddit is the highest-signal organic surface for niche topics. Subreddits
 * are pre-segmented audiences. Earn karma + reputation before posting in
 * commercial subs — anti-spam moderation is aggressive. Self-promotion
 * generally limited to 1-in-10 posts (the "9:1 rule" in most subs).
 *
 * Auth: OAuth 2.0. Free read tier (100 req/min for OAuth, 60 for unauth).
 * Write rate limits are subreddit-dependent and account-age-gated.
 *
 * Brain plays this surface by: monitoring niche subreddits for audience
 * pain points (read endpoints), posting genuine contributions long before
 * commercial posts, and responding to mentions of operator's brand/products.
 */
export const redditDef: ConnectorDef = {
  id:          'reddit',
  name:        'Reddit',
  category:    'social',
  description: 'Niche community engagement: read subreddit signal, post + comment with karma-aware throttling. Spammy self-promotion gets shadowbanned — playbook enforces 9:1 ratio.',
  authType:    'oauth',
  defaultScopes: ['identity', 'read', 'submit', 'edit', 'history', 'mysubreddits', 'vote'],
  blockedActions: [
    'reddit.delete_account', 'reddit.update_user_settings',
    'reddit.buy_premium', 'reddit.buy_coins',
  ],
  actions: [
    { name: 'reddit.read_user_me',        minPermission: 'read',  risk: 'low' },
    { name: 'reddit.search_subreddits',   minPermission: 'read',  risk: 'low' },
    { name: 'reddit.read_subreddit',      minPermission: 'read',  risk: 'low' },
    { name: 'reddit.read_post',           minPermission: 'read',  risk: 'low' },
    { name: 'reddit.read_comments',       minPermission: 'read',  risk: 'low' },
    { name: 'reddit.read_inbox',          minPermission: 'read',  risk: 'low' },
    { name: 'reddit.search_mentions',     minPermission: 'read',  risk: 'low' },
    { name: 'reddit.submit_post',         minPermission: 'publish', risk: 'high' },
    { name: 'reddit.submit_comment',      minPermission: 'publish', risk: 'high' },
    { name: 'reddit.edit_post',           minPermission: 'publish', risk: 'medium' },
    { name: 'reddit.delete_post',         minPermission: 'publish', risk: 'medium' },
    { name: 'reddit.vote',                minPermission: 'publish', risk: 'low' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://www.reddit.com',
  signupUrl:             'https://www.reddit.com/register',
  loginUrl:              'https://www.reddit.com/login',
  oauthAuthorizationUrl:     'https://www.reddit.com/api/v1/authorize',
  apiKeyCreationUrl:     'https://www.reddit.com/prefs/apps',
  docsUrl:               'https://www.reddit.com/dev/api',
  pricingUrl:            'https://support.reddithelp.com/hc/en-us/articles/16160319875092',
  statusPageUrl:         'https://www.redditstatus.com',
  permissionExplanation: 'Read your subscriptions + inbox, submit posts + comments, vote. Heavy karma-aware throttling in playbook; account-age-gated. Self-promotion limited to 1:9 ratio per subreddit guidelines.',
  accountRequired:       true,
  supportsApiKey:        false,
  freeTierAvailable:     true,
  iconKey:               'reddit',
}
