INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'storefront.signup_runbook',
  $TXT$R352 STOREFRONT SIGNUP RUNBOOK (importance 97) - 5 background platforms; complete in this order.

GLOBAL DEFAULTS (use across all):
- Brand: CYZOR CREATIONS
- Display name: Chris Spangler
- Email: same brand inbox used for Gumroad + FAA + INPRNT (consistency = trust signal)
- Bio (paste-ready, 240 chars): Original artwork by Chris Spangler / CYZOR CREATIONS. Botanical, natural-history, vintage-scientific, and cottagecore illustrations. Each print is hand-finished. Made for collectors who like books, gardens, and quiet rooms.
- Avatar + banner: same image set across every platform (cross-platform consistency = trust)
- NO home address public anywhere (R332 doctrine, importance 99)
- Tax info (SSN / W-9 / W-8): operator enters personally; Anthropic block prohibits agent entry regardless of authorization
- Day 1-7 ramp: 1 upload/day max regardless of cap (R350 anti-flag rule 9)
- Day 8-30: 50% of SAFE_DAILY_VELOCITY
- Day 30+: full cap
- Like/follow 3-5 other artists/day per platform for first 30 days (organic signal)

SIGNUP ORDER (highest-throughput first):

1) REDBUBBLE (redbubble.com/signup) - 5 min
   - Mass-market platform; cap 20/day
   - Tier: free; payouts PayPal at $20 threshold
   - Username: cyzorcreations
   - Required: avatar, banner, bio, default tags
   - Tax modal appears at first sale - skip until then
   - First upload: day 1 = ONE proven design (peony or chickadee)

2) SOCIETY6 (society6.com) - 5 min
   - High-end home decor; cap 15/day
   - Username: cyzorcreations
   - Tier: free; payouts PayPal at $20
   - Categories on first upload: Art Print, Canvas, Framed Print, Wall Tapestry

3) TEEPUBLIC (teepublic.com) - 5 min
   - Apparel-only; cap 20/day; Redbubble-owned but separate account
   - Username: cyzorcreations
   - Royalty: $4 base / $2 sale (fixed)

4) SPREADSHIRT (spreadshirt.com - Partner Program) - 7 min
   - Apparel + accessories; cap 15/day
   - Use Partner Area signup (not customer signup)
   - Username: cyzorcreations
   - Payouts at $25; tax interview at first sale

5) ZAZZLE (zazzle.com/sell) - 10 min
   - Custom products (mugs, cards, invitations); cap 15/day
   - Designer royalty 5-99% (default 15%)
   - Username: cyzorcreations
   - Payouts at $50

Some payouts mention thresholds and withdrawal methods for context. Operator enters all personal payout info themselves. Novan provides info, not credentials.

VELOCITY CAPS (R349 code):
redbubble 20/day | society6 15/day | teepublic 20/day | spreadshirt 15/day | zazzle 15/day
New account day 1-7: cap 1 | day 8-30: 50% cap | day 30+: full cap
$TXT$,
  'storefront_ops', 97, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

SELECT 'runbook_saved' AS status, key, importance FROM workspace_memory WHERE workspace_id='default' AND key='storefront.signup_runbook';
