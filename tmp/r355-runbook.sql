INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'storefront.signup_runbook',
  $TXT$R355 STOREFRONT SIGNUP RUNBOOK (importance 97) - Updated for Society6 closure (Oct 2025).

GLOBAL DEFAULTS:
- Brand: CYZOR CREATIONS
- Display name: Chris Spangler
- Email: same brand inbox used for Gumroad + FAA + INPRNT (consistency = trust signal)
- Bio (paste-ready, 240 chars): Original artwork by Chris Spangler / CYZOR CREATIONS. Botanical, natural-history, vintage-scientific, and cottagecore illustrations. Each print is hand-finished. Made for collectors who like books, gardens, and quiet rooms.
- Avatar + banner: same image set across every platform (cross-platform consistency = trust)
- NO home address public (R332 doctrine, importance 99)
- Tax info (SSN/W-9/W-8): operator enters personally; Anthropic block prohibits agent entry
- Day 1-7 ramp: 1 upload/day max regardless of cap (R350 anti-flag rule 9)
- Day 8-30: 50% of SAFE_DAILY_VELOCITY
- Day 30+: full cap
- Like/follow 3-5 other artists/day per platform for first 30 days (organic signal)

ACTIVE STOREFRONTS (11 build + 1 inherited):

ALREADY BUILT (operator-driven):
1) GUMROAD - live, profile in flight
2) FINE ART AMERICA (FAA) - live, profile in flight
3) INPRNT - waiting for portfolio app review
4) REDBUBBLE - account chrome done R353 (avatar/social/payment pending operator)
5) TIKTOK SHOP - approved, awaiting Shipped-from-seller shipping template toggle

UNBUILT SIGNUP ORDER (highest-throughput first):

6) ETSY (etsy.com/sell) - 8 min
   - 96M active buyers, highest first-sale velocity of all POD platforms
   - Username: cyzorcreations | Shop name: CYZOR CREATIONS
   - Sells: digital downloads (printable wall art) - no shipping needed
   - $0.20 listing fee per item, 6.5% transaction fee
   - Cap: 10/day strict (Etsy throttles new sellers aggressively)
   - First upload: day 1 = ONE proven design as digital download
   - Tax interview at first sale - operator action

7) REDBUBBLE (redbubble.com/signup) - DONE
   - Profile chrome filled per R353
   - Cap 20/day | account in 5-day classification window

8) TEEPUBLIC (teepublic.com) - 5 min
   - Apparel-only POD; Redbubble-owned but separate account
   - Username: cyzorcreations | Cap 20/day
   - Royalty: $4 base / $2 sale (fixed)

9) SPREADSHIRT (spreadshirt.com - Partner Program) - 7 min
   - Apparel + accessories; cap 15/day
   - Use Partner Area signup (NOT customer signup)
   - Username: cyzorcreations | Payouts at $25

10) ZAZZLE (zazzle.com/sell) - 10 min
   - Custom products (mugs, cards, invitations); cap 15/day
   - Designer royalty 5-99% (default 15%)
   - Username: cyzorcreations | Payouts at $50

11) THREADLESS (threadless.com/artist-shops) - 5 min
   - Apparel + art-board + tote/mug; cap 10/day
   - Artist Shops model (you set markup, they handle production)
   - Username: cyzorcreations | Designer markup ~$6/unit

12) DISPLATE (displate.com/artists) - 10 min
   - Metal print only - PREMIUM niche, higher AOV ($30-$60)
   - Cap 5/day (curated, slow upload looks natural)
   - Application review 3-7 days; portfolio required
   - Vertical 3:2 PNG format only
   - Username: cyzorcreations | $5 designer markup baseline

INHERITED (no action needed):
13) PIXELS.COM - FAA's sister site, auto-syncs from FAA account.
    Zero separate uploads. Every FAA listing appears on Pixels.

REMOVED:
X) SOCIETY6 - curated invitation-only since Oct 2025. Mass-shut existing artist
   accounts in March 2025. New artists may submit portfolio via support contact
   form (https://contact.gorgias.help/en-US/forms/t17q9ux1) but approval rate
   <5%. Operator decision: skip until S6 reopens public applications.

VELOCITY CAPS (R349 SAFE_DAILY_VELOCITY):
gumroad 20 | inprnt 10 | FAA 15 | redbubble 20 | zazzle 15 | spreadshirt 15
teepublic 20 | tiktok_shop 8 | etsy 10 | displate 5 | threadless 10
New account day 1-7: cap 1 | day 8-30: 50% cap | day 30+: full cap
$TXT$,
  'storefront_ops', 97, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

SELECT 'runbook_updated' AS status, key, importance, length(value) AS bytes
FROM workspace_memory WHERE workspace_id='default' AND key='storefront.signup_runbook';
