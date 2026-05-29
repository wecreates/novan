import type { ConnectorDef } from '../connectors.js'

/**
 * Stripe read-only — analytics + customer + invoice reads.
 *
 * EXPLICITLY excludes any action that moves money. This is the safe
 * subset; charge / refund / payout actions are not even *declared*
 * here, so the dispatch pipeline literally has nothing to call.
 * Hard-block patterns in the runtime act as second-line defense.
 */
export const stripeReadonlyDef: ConnectorDef = {
  id:          'stripe-readonly',
  name:        'Stripe (read-only)',
  category:    'payments',
  description: 'READ-ONLY revenue, customer, and invoice analytics. NO charges, refunds, or payouts — those actions are not declared.',
  authType:    'api_key',     // Stripe restricted keys
  defaultScopes: [],
  blockedActions: [
    // Belt-and-suspenders: these aren't declared as actions, so they
    // can't be dispatched, but listing them in blockedActions also
    // surfaces the explicit policy on the connector card.
    'stripe.create_charge', 'stripe.create_refund', 'stripe.create_payout',
    'stripe.update_payment_method', 'stripe.modify_subscription',
  ],
  actions: [
    { name: 'stripe.list_customers',    minPermission: 'read', risk: 'low' },
    { name: 'stripe.read_customer',     minPermission: 'read', risk: 'low' },
    { name: 'stripe.list_invoices',     minPermission: 'read', risk: 'low' },
    { name: 'stripe.list_subscriptions', minPermission: 'read', risk: 'low' },
    { name: 'stripe.list_charges',      minPermission: 'read', risk: 'low' },
    { name: 'stripe.balance_summary',   minPermission: 'read', risk: 'low' },
  ],
  metadataVerified:      true,
  officialWebsiteUrl:    'https://stripe.com',
  signupUrl:             'https://dashboard.stripe.com/register',
  loginUrl:              'https://dashboard.stripe.com/login',
  apiKeyCreationUrl:     'https://dashboard.stripe.com/apikeys',
  docsUrl:               'https://stripe.com/docs/api',
  pricingUrl:            'https://stripe.com/pricing',
  statusPageUrl:         'https://status.stripe.com',
  permissionExplanation: 'Read-only access to customers, invoices, subscriptions, and balance. We can never charge cards, issue refunds, or move money. Use a Stripe restricted key with read-only permissions.',
  accountRequired:       true,
  supportsApiKey:        true,
  freeTierAvailable:     true,    // Stripe account is free; only takes fees on charges
  iconKey:               'stripe',
}
