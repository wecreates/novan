import type { ConnectorDef } from '../connectors.js'

/**
 * Mailchimp — email list management + campaign automation.
 *
 * Email is the highest-LTV channel for most commerce niches (POD, courses,
 * subscriptions). Owned audience — no algorithm risk, no platform takedown
 * risk. The brain treats the email list as the durable backbone of any
 * business, with social/youtube as top-of-funnel feeders.
 *
 * Auth: API key (Mailchimp's classic key format: `<key>-us<N>` where the
 * suffix is the datacenter). Free tier supports up to 500 contacts; paid
 * tiers scale by list size + send volume.
 *
 * Brain workflows: list-segmentation rules from purchase signal, automated
 * welcome sequences for new subscribers, win-back flows for dormant accounts,
 * abandonment recovery hooked into Shopify/Printful order events.
 */
export const mailchimpDef: ConnectorDef = {
  id:          'mailchimp',
  name:        'Mailchimp',
  category:    'marketing',
  description: 'Email list management + automation flows. Owned-audience channel — no algorithm risk. Pairs with Shopify/Printful for abandonment + post-purchase sequences.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: [
    'mailchimp.delete_account', 'mailchimp.update_billing',
    'mailchimp.send_campaign_now',   // send is gated through approval; this raw immediate-send is blocked
  ],
  actions: [
    { name: 'mailchimp.list_audiences',         minPermission: 'read',  risk: 'low' },
    { name: 'mailchimp.read_audience',          minPermission: 'read',  risk: 'low' },
    { name: 'mailchimp.list_members',           minPermission: 'read',  risk: 'low' },
    { name: 'mailchimp.read_member',            minPermission: 'read',  risk: 'low' },
    { name: 'mailchimp.list_campaigns',         minPermission: 'read',  risk: 'low' },
    { name: 'mailchimp.read_campaign_report',   minPermission: 'read',  risk: 'low' },
    { name: 'mailchimp.list_automations',       minPermission: 'read',  risk: 'low' },
    { name: 'mailchimp.add_member',             minPermission: 'publish', risk: 'medium' },
    { name: 'mailchimp.update_member_tags',     minPermission: 'publish', risk: 'medium' },
    { name: 'mailchimp.unsubscribe_member',     minPermission: 'publish', risk: 'medium' },
    { name: 'mailchimp.create_campaign',        minPermission: 'publish', risk: 'medium' },
    { name: 'mailchimp.update_campaign',        minPermission: 'publish', risk: 'medium' },
    { name: 'mailchimp.schedule_campaign',      minPermission: 'publish', risk: 'high' },
    { name: 'mailchimp.pause_automation',       minPermission: 'publish', risk: 'medium' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://mailchimp.com',
  signupUrl:             'https://login.mailchimp.com/signup',
  loginUrl:              'https://login.mailchimp.com',
  apiKeyCreationUrl:     'https://us1.admin.mailchimp.com/account/api',
  docsUrl:               'https://mailchimp.com/developer/marketing/api',
  pricingUrl:            'https://mailchimp.com/pricing/marketing',
  statusPageUrl:         'https://status.mailchimp.com',
  permissionExplanation: 'Read your lists + members + campaigns + reports. Add / tag / unsubscribe members. Create + schedule campaigns. Cannot send immediately (queued through approval). Cannot delete account or change billing.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,     // 500 contacts free
  iconKey:               'mailchimp',
}
