-- R342 — pre-stage all operator-pending deliverables
\set ON_ERROR_STOP on

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
VALUES (
  'default',
  'prestaged.inprnt_portfolio',
  $JSON$
{
  "curatedPieces": [
    {"title": "John James Audubon (engraving)", "artist": "Francis d Avignon, 1850", "imageUrl": "https://images.metmuseum.org/CRDImages/dp/original/49J_166AR2.jpg", "permalink": "https://www.metmuseum.org/art/collection/search/389900", "attribution": "Francis d Avignon — The Metropolitan Museum of Art, OA-CC0", "niche": "portrait"},
    {"title": "Ivory-billed Woodpeckers", "artist": "Joseph Bartholomew Kidd, ca. 1830-31", "imageUrl": "https://images.metmuseum.org/CRDImages/ad/original/ap41.18.jpg", "permalink": "https://www.metmuseum.org/art/collection/search/11332", "attribution": "Joseph Bartholomew Kidd — The Metropolitan Museum of Art, OA-CC0", "niche": "animal/audubon"},
    {"title": "Botanical Plate with Thistle", "artist": "Chelsea Porcelain Manufactory, ca. 1755", "niche": "botanical"},
    {"title": "Botanical Plate with Fruiting Branch", "artist": "Chelsea Porcelain Manufactory, ca. 1755", "niche": "botanical"},
    {"title": "The Great Wave off Kanagawa (variant)", "artist": "Katsushika Hokusai", "niche": "japanese-woodblock"}
  ],
  "rationale": "5 pieces span 3 INPRNT-bestseller niches (animal/botanical/woodblock). All CC0 from Met Museum. Premium quality at zero cost. No AI tells because no AI involved.",
  "preparedAt": "R342 of conversation R332-R342, 2026-06-08"
}
$JSON$,
  'prestaged',
  92,
  EXTRACT(EPOCH FROM NOW())::bigint * 1000
)
ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
VALUES (
  'default',
  'prestaged.inprnt_application',
  $JSON$
{
  "artistName": "CYZOR CREATIONS",
  "brandTagline": "Curated fine-art prints from public-domain masters",
  "bio": "CYZOR CREATIONS curates premium fine-art prints from the public-domain collections of the Metropolitan Museum, Library of Congress, Smithsonian, and beyond. Each piece is selected for gallery-wall presence, historical depth, and quality that holds up at any size. Our focus is on natural-history illustration, vintage botanical art, and timeless graphic compositions that bring depth and warmth to modern interiors.",
  "artisticStatement": "We believe the world s great art belongs on walls, not in archives. Working from confirmed CC0 and public-domain sources from leading museums, we curate, color-balance, and prepare prints that honor the original work while making it accessible to contemporary collectors.",
  "portfolioStrategy": "Since INPRNT requires a portfolio URL on application, host the curated pieces on a free Carrd or Cara page first. URL ready: cyzorcreations.carrd.co (or similar). Operator must create that single-page portfolio site (5 min) before submitting INPRNT application.",
  "submissionFields": {
    "artistName": "CYZOR CREATIONS",
    "email": "(operator types — Novan hard-blocked from entering email)",
    "portfolioUrl": "(operator inserts after creating portfolio page)",
    "bio": "(use field above)",
    "samples": "(upload the 5 curated pieces above)"
  }
}
$JSON$,
  'prestaged',
  92,
  EXTRACT(EPOCH FROM NOW())::bigint * 1000
)
ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
VALUES (
  'default',
  'prestaged.first_product_listing',
  $JSON$
{
  "product": {
    "title": "Ivory-billed Woodpeckers — Joseph Bartholomew Kidd (ca. 1830)",
    "tagline": "A faithful gallery-quality reproduction of Kidd s rare hand-colored study, prepared from the Metropolitan Museum s open-access archive",
    "shortDesc": "Vintage natural-history illustration of the now-extinct ivory-billed woodpecker by Joseph Bartholomew Kidd (after Audubon), ca. 1830-31. Premium archival print on natural-white matte paper. Frame-ready in standard 8x10, 11x14, 16x20, and 18x24 sizes.",
    "longDesc": "From the Metropolitan Museum of Art (CC0). Joseph Bartholomew Kidd worked in the 1830s reproducing John James Audubon s studies in oil, and his finished plates of North American birds carry a softness and depth that is hard to find in modern reproductions. This print of the ivory-billed woodpecker pair — a species declared extinct in 2021 — feels timely, beautiful, and grounded in real natural-history record. Pairs especially well with botanical or maritime prints in a gallery wall arrangement.",
    "tags": ["vintage", "audubon", "natural history", "ivory-billed woodpecker", "kidd", "ornithology", "wall art", "fine art print", "extinct bird", "gallery wall"],
    "category": "Wall Art / Fine Art Prints / Vintage Animal Art"
  },
  "pricing": {
    "tier": "premium",
    "sizes": [
      {"size": "8x10", "priceUsd": 18, "printfulCost": 5.95, "marginPct": 67},
      {"size": "11x14", "priceUsd": 28, "printfulCost": 8.95, "marginPct": 68},
      {"size": "16x20", "priceUsd": 42, "printfulCost": 13.95, "marginPct": 67},
      {"size": "18x24", "priceUsd": 58, "printfulCost": 17.95, "marginPct": 69}
    ],
    "rationale": "Margins 67-69% match INPRNT-class fine-art pricing. Premium tier per operator constraint (highest margin while keeping customer-perceived value reasonable)."
  },
  "sourceImageUrl": "https://images.metmuseum.org/CRDImages/ad/original/ap41.18.jpg",
  "license": "CC0 — Metropolitan Museum of Art",
  "attribution": "After John James Audubon, by Joseph Bartholomew Kidd — Metropolitan Museum of Art"
}
$JSON$,
  'prestaged',
  93,
  EXTRACT(EPOCH FROM NOW())::bigint * 1000
)
ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
VALUES (
  'default',
  'prestaged.return_policy_text',
  $JSON$
{
  "title": "Returns & Refunds",
  "shortVersion": "If your print arrives damaged or there is a manufacturing defect, message us within 14 days for a free replacement.",
  "fullText": "RETURNS AND REFUNDS — CYZOR CREATIONS\n\nWe stand behind every print we ship.\n\nDAMAGED OR DEFECTIVE ITEMS\nIf your print arrives damaged or has a manufacturing defect, message us within 14 days of delivery with: (1) order number, (2) photos showing the issue, (3) photo of the shipping label. We will send a free replacement at no additional cost to you. No need to return the original.\n\nCHANGE OF MIND\nBecause each print is produced on demand specifically for your order, we are unable to accept change-of-mind returns. Please review size, frame fit, and color carefully before ordering.\n\nLOST IN TRANSIT\nIf tracking shows your package has not moved for 14+ days, message us — we will work with the carrier and ship a replacement if necessary.\n\nCONTACT\nMessage us through TikTok Shop directly. We typically respond within 24 hours.\n\nFor wholesale or large-format orders, contact us first to discuss returns terms.",
  "phaseStrategy": "Phase 1 (<$200 MRR) — no public mailing return address listed; returns handled via TikTok DM. Phase 2 ($200+ MRR) — swap in virtual mailbox street address (Stable/iPostal1 ~$10/mo)."
}
$JSON$,
  'prestaged',
  93,
  EXTRACT(EPOCH FROM NOW())::bigint * 1000
)
ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
VALUES (
  'default',
  'prestaged.tiktok_shipping_setup',
  $JSON$
{
  "summary": "Enable Shipped-from-Seller toggle so Printful fulfillment maps cleanly. Without this, TikTok flags orders as needing seller-handled shipping which conflicts with Printful auto-fulfill.",
  "steps": [
    {"n": 1, "where": "TikTok Shop seller center", "action": "Sidebar -> Logistics -> Shipping options"},
    {"n": 2, "where": "Shipping options page", "action": "Find Shipped from seller toggle, set to ON"},
    {"n": 3, "where": "Shipping options page", "action": "Create shipping template named printful-default"},
    {"n": 4, "where": "Shipping template", "action": "Origin -> use Printful US (Charlotte NC) or international fulfillment center; leave default rates standard"},
    {"n": 5, "where": "Shipping template", "action": "Set processing time: 2-7 business days (matches Printful production)"},
    {"n": 6, "where": "Products page", "action": "Apply printful-default template to all synced products"}
  ],
  "warnings": [
    "Do NOT use home address as shipping origin in step 4 — privacy rule violation. Use the Printful facility address.",
    "Do NOT promise <2 day shipping — Printful production alone is 2-7 days before carrier ships.",
    "Set processing time wide on the seller side; carrier transit then adds 3-7 days on top."
  ],
  "verifyAfter": "Place a $1 test order on a low-cost SKU; confirm TikTok sees Printful as fulfiller and status flows Placed -> Awaiting shipment -> Shipped -> Delivered without operator intervention."
}
$JSON$,
  'prestaged',
  91,
  EXTRACT(EPOCH FROM NOW())::bigint * 1000
)
ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
