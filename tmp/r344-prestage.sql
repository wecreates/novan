-- R344 — Pre-stage application content for parallel-safe POD signups

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'prestaged.society6_application',
  $JSON$
{
  "platform": "Society6",
  "signupUrl": "https://society6.com/become-an-artist",
  "displayName": "CYZOR CREATIONS",
  "shopHandle": "cyzorcreations",
  "bio": "CYZOR CREATIONS curates premium fine-art prints from public-domain masterworks. Vintage botanical illustration, natural-history studies, and timeless graphic compositions sourced from the Metropolitan Museum, Library of Congress, and other open-access collections. Each piece is selected for gallery-wall presence and quality that holds at any size.",
  "categories": ["Vintage", "Natural History", "Botanical", "Animal", "Landscape"],
  "markup": {
    "art_prints": 35,
    "framed_prints": 25,
    "canvas_prints": 30,
    "tapestries": 20,
    "tote_bags": 15,
    "phone_cases": 20,
    "comment": "Set higher markup on art prints (target audience) and lower on incidental products."
  },
  "firstUploadList": [
    "Ivory-billed Woodpeckers — Joseph Bartholomew Kidd (Met CC0)",
    "Vintage Botanical Iris — AI gen R343 019ea871",
    "Ivory-billed Woodpeckers on Magnolia — AI gen R343 019ea872"
  ],
  "operatorAction": "Sign up at signupUrl with email + new password. Paste bio. Upload images. Set markup per category. Activate shop. NOTE: do not reuse TikTok Shop or Printful password."
}
$JSON$, 'prestaged', 90, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'prestaged.redbubble_application',
  $JSON$
{
  "platform": "Redbubble",
  "signupUrl": "https://www.redbubble.com/account/sell",
  "displayName": "CYZOR CREATIONS",
  "shopHandle": "cyzorcreations",
  "bio": "Premium fine-art prints curated from public-domain masterworks. Vintage botanical, natural-history, and gallery-quality compositions from the Metropolitan Museum and partner archives.",
  "tags_per_design_starter_list": ["vintage", "botanical", "audubon", "natural history", "fine art print", "wall art", "gallery wall", "victorian", "museum", "antique illustration"],
  "markup": {
    "default_artist_margin": 25,
    "stickers": 40,
    "art_prints": 35,
    "framed_prints": 30,
    "comment": "Redbubble lets artists set markup per product type. Higher on small items (stickers); moderate on large prints."
  },
  "firstUploadList": [
    "Ivory-billed Woodpeckers (Met CC0)",
    "Vintage Botanical Iris (AI R343 019ea871)",
    "Ivory-billed Woodpeckers on Magnolia (AI R343 019ea872)"
  ],
  "operatorAction": "Sign up with email + new password. Verify email. Complete artist profile. Upload first 3 images. Tag aggressively (Redbubble SEO is keyword-heavy)."
}
$JSON$, 'prestaged', 90, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'prestaged.zazzle_application',
  $JSON$
{
  "platform": "Zazzle",
  "signupUrl": "https://www.zazzle.com/sell",
  "displayName": "CYZOR CREATIONS",
  "shopHandle": "cyzorcreations",
  "bio": "Vintage natural-history and botanical fine-art prints. Public-domain masterworks curated and prepared for modern walls.",
  "categories": ["Art & Wall Decor", "Stationery", "Custom Gifts"],
  "royalty": {
    "default_pct": 15,
    "wall_art_pct": 25,
    "stationery_pct": 20,
    "comment": "Zazzle royalty is your cut on top of their base price. Keep wall art highest."
  },
  "firstUploadList": [
    "Ivory-billed Woodpeckers (Met CC0)",
    "Vintage Botanical Iris (AI R343 019ea871)"
  ],
  "operatorAction": "Sign up. Email verify. Create store. Configure royalty %. Upload images. Zazzle is best for stationery/cards/invitations — consider adding wedding invitation templates with the botanicals."
}
$JSON$, 'prestaged', 88, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'prestaged.gumroad_application',
  $JSON$
{
  "platform": "Gumroad",
  "signupUrl": "https://gumroad.com/signup",
  "displayName": "CYZOR CREATIONS",
  "shopHandle": "cyzorcreations",
  "bio": "Premium fine-art prints — digital downloads + printable PDFs of public-domain masterworks. Curated, color-balanced, ready to print at home or send to a local print shop.",
  "productStrategy": {
    "format": "digital_download",
    "fileTypes": ["High-res PNG (300 DPI)", "Print-ready PDF with bleed", "JPEG preview"],
    "priceRange": {"low": 4, "mid": 9, "high": 19},
    "bundleStrategy": "Single piece: $4-9. Curated 5-pack: $19. Subscription tier $5/mo for new pieces weekly.",
    "comment": "90% margin (10% Gumroad fee). Customer downloads + prints themselves. Zero fulfillment overhead. Pure passive revenue once listed."
  },
  "firstUploadList": [
    "Ivory-billed Woodpeckers digital download (Met CC0, sized for 8x10 + 11x14 + 16x20)",
    "Vintage Botanical Iris digital download (AI gen R343)"
  ],
  "operatorAction": "Sign up. Connect Stripe (operator action — bank-level KYC). Upload PDFs. Set price. Publish."
}
$JSON$, 'prestaged', 90, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Lock the operator-decision around staggering
INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (
  'default',
  'strategy.pod_account_staggering',
  'R344 OPERATOR STAGGERING RULE (importance 96): Standalone marketplaces (Redbubble, Society6, Zazzle, Gumroad, INPRNT, Fine Art America, Spreadshirt, TeePublic) can be opened in parallel any day — they do NOT share fraud signals. Free Printful-sync storefronts (Storenvy, Big Cartel free, Ecwid free) require 5-day age gap between signups. Tax-ID storefronts (TikTok Shop, Square, eBay) require 14-day age gap — these are the highest ban-risk surface. Never open more than 1 tax-ID seller account per week. Never open more than 2 free-storefront accounts per week.',
  'strategies', 96, EXTRACT(EPOCH FROM NOW())::bigint * 1000
) ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
