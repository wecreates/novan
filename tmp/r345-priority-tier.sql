-- R345 priority tiers — operator decision 2026-06-08
-- PRIMARY: Gumroad / INPRNT / Fine Art America — focus active effort here
-- BACKGROUND: Society6 / Redbubble / Zazzle / Spreadshirt / TeePublic — create accounts now, build over time

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'strategy.pod_priority_tiers',
  $JSON$
{
  "decidedAt": "R345 2026-06-08",
  "primary": {
    "platforms": ["gumroad", "inprnt", "fine_art_america"],
    "rationale": "Highest items-per-MRR efficiency. Digital (Gumroad 90% margin), premium curated (INPRNT 50%), and SEO-driven (Fine Art America 40%). Combined target $35k MRR is achievable with ~1000 items.",
    "weeklyOutput": "Aim for 15-30 new pieces/week across the 3 primary, focused on natural-history / botanical / vintage aesthetic that all 3 audiences share.",
    "primaryFirstSale": "Gumroad — set up digital downloads of the AI-generated + Met CC0 art today, $0 setup, first sale possible within 24 hours."
  },
  "background": {
    "platforms": ["society6", "redbubble", "zazzle", "spreadshirt", "teepublic"],
    "rationale": "Long-tail. Open accounts now so they age and build search ranking. Bulk-upload winning designs from primary platforms once a month. Don't burn weekly cycles here.",
    "monthlyOutput": "Once a month, replicate top-5 primary sellers across all 5 background accounts (~25 listings/month, batched). 6-12 months of patient accumulation."
  },
  "doNotPursueUntilMrrSignal": ["shopify", "wix_ecommerce", "squarespace", "displate", "square_online", "ebay", "storenvy", "big_cartel_free", "ecwid_free"]
}
$JSON$,
  'strategies', 97, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, importance = EXCLUDED.importance, updated_at = EXCLUDED.updated_at;

-- Pre-stage Spreadshirt application content (background tier)
INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'prestaged.spreadshirt_application',
  $JSON$
{
  "platform": "Spreadshirt",
  "tier": "background",
  "signupUrl": "https://www.spreadshirt.com/sell-online",
  "displayName": "CYZOR CREATIONS",
  "shopHandle": "cyzorcreations",
  "bio": "Premium fine-art prints curated from public-domain masterworks. Vintage botanical, natural-history, and gallery-quality compositions.",
  "categories": ["Wall Art", "Apparel — Vintage Designs", "Accessories"],
  "markup": {
    "tshirts_pct": 22,
    "hoodies_pct": 20,
    "wall_art_pct": 35,
    "accessories_pct": 25
  },
  "firstUploadList": [
    "Ivory-billed Woodpeckers (Met CC0)",
    "Vintage Botanical Iris (AI R343)",
    "Ivory-billed Woodpeckers on Magnolia (AI R343)"
  ],
  "monthlyMaintenanceCadence": "Once-monthly batch: replicate top 5 primary-tier sellers here. Don't burn weekly cycles.",
  "operatorAction": "Sign up. Email verify. Set up Marketplace shop. Upload designs. Configure markup. Activate. Then forget about it for 30 days."
}
$JSON$, 'prestaged', 85, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Pre-stage TeePublic application content (background tier)
INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'prestaged.teepublic_application',
  $JSON$
{
  "platform": "TeePublic",
  "tier": "background",
  "signupUrl": "https://www.teepublic.com/sell",
  "displayName": "CYZOR CREATIONS",
  "shopHandle": "cyzorcreations",
  "bio": "Vintage natural-history fine art for modern walls. Public-domain masterworks, curated and prepared for premium prints, apparel, and accessories.",
  "designStrategy": "TeePublic pays fixed royalty (~$2-4/shirt). Bulk-list winning Redbubble/Society6 designs here for additional channel. Don't curate — replicate.",
  "tagsBatch": ["vintage", "botanical", "audubon", "natural history", "victorian", "fine art", "wall art", "museum", "antique illustration", "extinct birds"],
  "firstUploadList": [
    "Ivory-billed Woodpeckers (Met CC0)",
    "Vintage Botanical Iris (AI R343)",
    "Ivory-billed Woodpeckers on Magnolia (AI R343)"
  ],
  "monthlyMaintenanceCadence": "Once-monthly batch upload of top primary-tier designs.",
  "operatorAction": "Sign up. Verify email. Complete artist profile. Bulk-upload first 3 designs. Apply tags aggressively. Set as background channel — don't optimize, just feed."
}
$JSON$, 'prestaged', 85, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
