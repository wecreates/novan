import type { ConnectorDef } from '../connectors.js'

/**
 * Gumroad — digital product + info-product storefront.
 *
 * Closes the digital-goods loop: the brain can design + produce digital
 * assets (PDFs, templates, video courses, audio packs, presets) and list
 * them for sale without a self-hosted commerce stack. Gumroad handles
 * tax, fulfillment, and payouts.
 *
 * Auth: API key (Gumroad-generated, per-account). No OAuth.
 * Rate limit: 60 req/min/key.
 *
 * Brain use: rapid info-product launches, tripwire offers, bundle pricing
 * experiments, customer-list export to Mailchimp/ConvertKit for nurture.
 * Strong fit for course/template/info-product business types (SPEC §11.2);
 * complements Shopify (physical) + Printful (POD) + Etsy (handmade).
 */
export const gumroadDef: ConnectorDef = {
  id:          'gumroad',
  name:        'Gumroad',
  category:    'commerce',
  description: 'Digital-goods storefront. Tax + fulfillment + payouts handled by Gumroad. Strong fit for templates, courses, presets, audio packs, info-products.',
  authType:    'api_key',
  defaultScopes: [],
  blockedActions: [
    'gumroad.delete_account', 'gumroad.update_payout_method',
    'gumroad.issue_refund',     // refund flow lives in operator-approved path only
  ],
  actions: [
    { name: 'gumroad.read_user_me',         minPermission: 'read',  risk: 'low' },
    { name: 'gumroad.list_products',        minPermission: 'read',  risk: 'low' },
    { name: 'gumroad.read_product',         minPermission: 'read',  risk: 'low' },
    { name: 'gumroad.list_sales',           minPermission: 'read',  risk: 'low' },
    { name: 'gumroad.read_sale',            minPermission: 'read',  risk: 'low' },
    { name: 'gumroad.list_subscribers',     minPermission: 'read',  risk: 'low' },
    { name: 'gumroad.list_offer_codes',     minPermission: 'read',  risk: 'low' },
    { name: 'gumroad.create_product',       minPermission: 'publish', risk: 'high' },
    { name: 'gumroad.update_product',       minPermission: 'publish', risk: 'medium' },
    { name: 'gumroad.disable_product',      minPermission: 'publish', risk: 'medium' },
    { name: 'gumroad.create_offer_code',    minPermission: 'publish', risk: 'medium' },
    { name: 'gumroad.cancel_subscription',  minPermission: 'publish', risk: 'high' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://gumroad.com',
  signupUrl:             'https://gumroad.com/signup',
  loginUrl:              'https://gumroad.com/login',
  apiKeyCreationUrl:     'https://gumroad.com/settings/advanced',
  docsUrl:               'https://gumroad.com/api',
  pricingUrl:            'https://gumroad.com/pricing',
  statusPageUrl:         'https://gumroad.statuspage.io',
  permissionExplanation: 'Read your sales + products + subscribers, create + update products, create offer codes. Refunds + payout method changes are blocked — must be done from Gumroad UI directly.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,    // free + 10% per-sale fee model
  iconKey:               'gumroad',
}
