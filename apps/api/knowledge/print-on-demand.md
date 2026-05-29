# Print-on-Demand Playbook

Operating knowledge for the brain when launching, scaling, and optimizing print-on-demand (POD) businesses toward the $10k/mo per-business floor.

---

## 1. The math (read this first)

POD margins are slim. To hit $10k/mo net per business:

```
typical_pod_margin_per_unit = $8–$14  (on a $24–$34 retail item with $12–$18 base cost)
ad_spend_per_unit           = $3–$6   (when running paid traffic)
net_per_unit                ≈ $5–$10

units_required_per_month    = 10000 / 7   ≈ 1430 units/month
                            = ~48 units/day
```

That's the floor. Etsy organic + Pinterest organic gets you maybe 30% of that without paid traffic; the rest comes from either **scaling listings (volume strategy)** or **scaling ad spend (efficiency strategy)**. The brain should default to the **volume strategy** for first-time operators — it's lower-risk and the optimization signal (which listings stick) is cleaner.

### Channel revenue breakdown that works

| Channel | Share of revenue | Margin | Ad spend | Notes |
|---|---|---|---|---|
| Etsy organic (SEO) | 40–60% | $10/unit | $0 | The foundation. Etsy SEO is the #1 lever. |
| Etsy ads (Etsy Ads program) | 15–25% | $7/unit | $1.5/unit | Use after 20 sales for SEO signal |
| Pinterest organic | 10–20% | $10/unit | $0 | Long-tail, slow to ramp (3–6 months) |
| Pinterest Idea Pins → Etsy | 5–10% | $9/unit | $1/unit (boost) | Mid-tier lever |
| Direct via Shopify + Meta ads | 0–30% | $8/unit | $4/unit | High-skill, only after first $5k/mo proven |
| TikTok Shop | 0–25% | $6/unit | varies | Volatile; algorithm-dependent |

A first-time POD operator should aim for **70% Etsy organic + 30% Etsy ads** until $5k/mo, then diversify.

---

## 2. Platform comparison (pick one, master it)

| Platform | Approval time | First-sale time | Margin | Volume ceiling per shop | Niche fit |
|---|---|---|---|---|---|
| **Etsy + Printify** | 1 day | 7–30 days | $8–$12 | $30–$50k/mo solo | Apparel, mugs, posters, jewelry |
| Etsy + Printful | 1 day | 7–30 days | $5–$9 | $30–$50k/mo solo | Premium apparel, embroidery |
| Redbubble | Instant | 30–90 days | $2–$5 | $5–$15k/mo solo | Stickers, t-shirts, niche fandoms |
| TeePublic | Instant | 30–90 days | $3–$5 | $5–$10k/mo solo | T-shirts |
| Society6 | Instant | 60–120 days | $3–$6 | $5–$10k/mo | Art prints, home decor |
| Amazon Merch on Demand | 6–12 months invite | 7–14 days | $3–$7 | $20k+/mo (tier-dependent) | T-shirts only |
| Shopify + Printify (own store) | Instant | 60–180 days | $10–$18 | unlimited | Brand-driven niches |
| TikTok Shop + POD fulfillment | 30 days | 14–60 days | $4–$9 | volatile | Trend-driven |

**Default recommendation for the brain**: start on Etsy + Printify. Highest first-sale conversion, easiest SEO, cleanest data feedback loop.

---

## 3. Niche selection (POD-specific)

POD niches are **identity-based**, not interest-based. A "dog mom" buys a dog-mom mug because it identifies her, not because it's about dogs. Successful POD niches share three attributes:

1. **An identity claim**: "I'm a [profession]" / "I love [hobby]" / "I survived [thing]"
2. **A gift-giving occasion**: birthday, wedding, retirement, Mother's/Father's Day, graduation, new home, new job, anniversary
3. **A sub-segment that's underserved**: not just "dog mom" but "Goldendoodle mom" or "rescue mom"

### Niche scoring (0–10 on each axis; reject any sub-6)

| Axis | What to measure | Target |
|---|---|---|
| Search volume | Etsy search frequency for top 5 keywords | ≥ 5,000/mo combined |
| Competition density | Number of Etsy listings with > 100 reviews on top keyword | < 1,500 |
| Gift fit | Number of clear gift occasions per year | ≥ 3 |
| Margin headroom | Cheapest viable base cost vs realistic ask | ≥ $8 margin at retail |
| Defensibility | Can a competitor copy in 24h? | Yes (low) → 4; Needs custom illustration → 7+ |
| ToS safety | Trademark / copyright clearance | No protected words/characters |

### Niches the brain should default-prefer

- **Profession + identity**: nurse, teacher, firefighter, dental hygienist (each ~3k Etsy listings, ~50k monthly searches)
- **Pet-parent + breed-specific**: Frenchie mom, German Shepherd dad, etc.
- **Hobby + identity**: pickleball, sourdough baker, plant parent, rock climber
- **Survivor / milestone**: "survived 2020", "1 year sober", "50 years married"
- **Faith-based** (high purchase frequency, low ad cost, brain should check niche-appropriateness)
- **Astrology + birth month** (volume, low margin, ToS-safe)

### Niches the brain should refuse

- Any sports team name (trademark)
- Any band / artist name (copyright)
- Any movie / TV character (trademark + copyright)
- Any political slogan associated with a campaign (Etsy de-lists)
- Any phrase associated with the LGBTQ+ rainbow that contains protected slogans (case-by-case; conservative default)
- Any "Live Laugh Love"-style oversaturated phrases

---

## 4. Etsy SEO (the dominant lever)

### 4.1 The Etsy ranking formula (simplified)

```
score = (relevance × quality × shop_quality) × (recency_decay × paid_ads_boost)

relevance     = keyword match in title (weighted 50%) + tags (30%) + description (20%)
quality       = CTR from search × conversion rate × review rate
shop_quality  = shop's all-time review score × shop's recent sales velocity × shop's listing quality (photos, descriptions, sections)
recency_decay = boost for listings < 30 days old, then linear decay to ~60% by month 6
paid_boost    = Etsy Ads multiplier on impressions
```

The brain should optimize each axis independently, not all at once.

### 4.2 Title rules

- 140 characters max; Etsy uses every character
- **First three words matter most** — they're the primary keyword
- Front-load the keyword with the highest exact-match volume
- Format: `[primary keyword] | [variant keyword] | [identity claim] | [occasion]`
- Example: `Nurse Mug | RN Coffee Mug | Funny Nurse Gift | Nurse Graduation Gift`
- Avoid: ALL CAPS, emoji (Etsy de-ranks), unrelated keywords (Etsy detects "keyword stuffing" and de-ranks)

### 4.3 Tags rules

- 13 tags, exactly. Use all 13.
- 20 chars max per tag
- Each tag should be a phrase a buyer might search ("nurse mug" not "nurse")
- Mix exact-match + long-tail + synonym + audience descriptor
- Repeat the primary keyword in 2–3 tags (not 5; that's stuffing)
- Tools: **Erank** (the standard), **Sale Samurai**, **Marmalead** — the brain should consult these via API if the operator has a subscription, or fall back to its own keyword model

### 4.4 Description rules

- First 160 characters = Google preview snippet. Make them count.
- Mention the keyword 2–3 times, naturally
- Bullet points for features (Etsy renders them)
- Include shipping time, materials, care instructions
- Include 1–2 "gift suggestion" phrases ("perfect for Mother's Day", "great for a nurse's birthday") — these match buyer intent searches
- End with a sentence that pulls toward shop favorites: "browse more nurse gifts in my shop"

### 4.5 Photos rules

- 10 photos max; use all 10
- Photo 1 (the thumbnail): lifestyle shot with the product in use, not a flat product shot. Etsy CTR difference is 30–60%.
- Photos 2–5: product shots from different angles
- Photo 6: dimensions / sizing chart
- Photo 7: gift packaging (if any)
- Photo 8: variations (colors, sizes)
- Photo 9: testimonial / review quote overlay (5-star pull from existing buyers)
- Photo 10: shop branding / CTA

For POD apparel, **mockup quality dominates**. Use **Placeit**, **Pixelied**, or **Mockup.photos** for premium mockups. Generic Printify mockups depress CTR by 30–50% vs lifestyle mockups.

### 4.6 Variations (the secret lever)

- Always offer color variations (apparel) — even if only 2 colors. Listings with variations rank higher.
- Always offer size variations on apparel
- Mug listings: offer 11oz + 15oz at different prices
- T-shirt listings: offer S–5XL; the 2XL+ tiers carry the most margin

---

## 5. The 90-day launch sequence

The brain should plan this sequence for every new POD shop:

### Days 0–7: setup
1. Shop name: 4–13 characters, includes one keyword from primary niche
2. Banner + logo (auto-generate via image-gen, operator approves)
3. Shop policies (Etsy template + customization for production-time)
4. About page (build trust — 70% conversion-rate lift vs blank About)
5. First 10 listings (one niche, one product type — focus matters)

### Days 7–30: build to 50 listings
- 1–3 listings/day
- Same product type, vary the design across sub-niches
- Each listing tested with 3 mockup variants (Etsy shows the highest-CTR one in search)
- Etsy Ads turned on at $1/day per listing once shop has 5 reviews

### Days 30–60: identify winners
- Sort listings by views / sales / conversion
- Top 10% get more variations (color, size, gift options)
- Bottom 30% get killed (low CTR drags shop quality score)
- Cross-promote winners on Pinterest (5 pins/winner/week)

### Days 60–90: scale + diversify
- Push winners onto a second platform (Redbubble for the same designs — different SEO + different audience)
- Begin pricing experiments ($1–$2 increments, watch conversion impact)
- Open a sub-niche shop with a fresh Etsy account if the first shop is plateauing (one shop ceiling is ~$8–15k/mo solo; new sub-niche shop unlocks the next tier)

### Days 90+: optimization loop
- Monthly: prune bottom 20% of listings
- Monthly: refresh top 20% with new mockups
- Quarterly: re-audit keywords (Etsy search volume shifts seasonally)
- Holiday prep: 60-day lead for Mother's Day, Father's Day, Christmas — the operator should not wait for the brain to remind them in November

---

## 6. Pricing strategy

| Item | Base cost (Printify) | Sweet-spot retail | Margin | Notes |
|---|---|---|---|---|
| 11oz mug | $4.95 | $14.99–$19.99 | $9–$13 | Volume product; high gift conversion |
| 15oz mug | $5.95 | $17.99–$22.99 | $10–$15 | Premium; "upgrade" tier |
| T-shirt (cotton) | $8.50–$11 | $22.99–$27.99 | $11–$15 | Anchor product |
| T-shirt (premium / Bella+Canvas 3001) | $10.50–$13 | $26.99–$32.99 | $13–$17 | Use for "premium" niches |
| Hoodie | $24–$32 | $44.99–$54.99 | $18–$24 | Lower volume; higher AOV |
| Poster (12×18) | $6.50 | $19.99–$24.99 | $13–$17 | Fast shipping, low return rate |
| Tote bag | $9.50 | $21.99–$26.99 | $12–$15 | Gift-friendly |
| Sticker (3-pack) | $2.95 | $7.99–$10.99 | $4–$7 | High volume, low AOV |

**Bundle pricing** (mug + matching shirt + sticker pack at 10% discount) lifts AOV by ~35% and is the easiest path to $50+ orders.

---

## 7. Pinterest as the POD traffic engine

POD businesses that scale past $20k/mo almost always have Pinterest as a major channel. The mechanics:

1. **Every winning Etsy listing → 5 Pinterest pins** with different text overlays
2. **Each pin links to the Etsy listing** (Pinterest allows direct outbound)
3. **Pinterest's algorithm rewards fresh pins** — repinning the same image is worth ~10% of a fresh pin's reach
4. **Vertical 1000×1500**; bright single-color text overlays
5. **Title + description both keyword-loaded** — Pinterest is Etsy-adjacent search engine

The brain can auto-generate the 5 pin variants per winning listing (different angle, different overlay text, different background). Operator approves the batch in 30 seconds.

---

## 8. Ad strategy (after $2k/mo organic)

### 8.1 Etsy Ads
- Start at **$1/day per top-decile listing**
- Etsy Ads optimization is opaque; let it run for 30 days minimum before judging
- Pull ads from listings with CPC > 50% of margin (it's losing money)
- Push ads on listings with conversion rate > 4% (every impression is profitable)

### 8.2 Pinterest Ads (later)
- Start at $5/day for a single winning pin
- Goal: cost-per-outbound-click < 30¢ for POD price points
- Above that, organic Pinterest wins on unit economics

### 8.3 Meta Ads (advanced, Shopify only)
- Don't run Meta Ads to Etsy listings — Meta will not optimize toward Etsy's conversion event
- For Shopify POD: target CAC < $8 for $24 AOV products
- Use the brain to generate 5 ad creative variants per ad set; rotate winners weekly

---

## 9. Common failure modes

1. **Niche-hopping**: operator launches 20 designs across 8 niches in 30 days. Etsy can't develop shop quality signal; nothing sells.
2. **Cheap mockups**: generic Printify mockups → 30% CTR penalty → no sales → operator concludes "POD doesn't work".
3. **Pricing too low**: operator prices a t-shirt at $14.99 trying to compete with Amazon Merch. Margin is $3, can't afford ads, organic-only takes 6 months.
4. **Pricing too high**: operator prices at $34.99 with no brand. Conversion < 1%, listing dies.
5. **Tag stuffing**: operator uses synonym-spammed tags ("nurse, RN, registered nurse, nurses, nursing, nurse gift, RN gift") — Etsy de-ranks for keyword stuffing.
6. **Ignoring reviews**: any review < 5 stars at < 100-review shop tanks discoverability. The brain should flag every <5 review within 1 hour for operator response (Etsy permits one operator response per review and it's read by the algorithm).
7. **Trademark hit**: operator uses a near-brand-name phrase that gets DMCA'd → shop suspended for 30 days. ToS-checking by the brain on every new design is mandatory.

---

## 10. ToS & IP safety (mandatory checks)

Before publishing any design, the brain should check:

1. **Trademark database** (USPTO TESS, EUIPO, etc.) for the exact phrase + similar variants
2. **Reverse image search** to confirm the design isn't a copy
3. **Etsy's prohibited items list**: weapons, drugs, hate speech, COVID-misinformation, recalled products
4. **Printify's content policy**: same as Etsy + additional restrictions on celebrity faces, religious icons in certain markets
5. **The specific phrase "I [verb] [noun]" templates** — many are protected ("I Run Like a Girl" is trademarked; "Live, Laugh, Love" is, in some uses)

The brain should default-refuse any design where the trademark check returns *any* match in the same Nice classification (apparel = class 25, mugs = class 21).

---

## 11. Brain decision pattern

When asked "what should we launch this week" the brain should:

1. Pull recent shop performance from `content_analytics` and external Etsy stats (via API if connected)
2. Identify the top-decile listing by **revenue × velocity × CTR**
3. Generate 5 design concepts in the same sub-niche, same product type, varying:
   - Phrase / hook
   - Visual treatment (typography vs illustration vs photo overlay)
   - Sub-occasion (different gift target)
4. Auto-trademark-check all 5
5. Auto-generate 3 mockups per surviving concept
6. Queue all surviving designs for operator approval as a batch (so the operator can approve a week's launch in 2 minutes)
7. On approval, the brain creates listings via the Etsy/Printify API and schedules them across the week (Tuesday + Thursday + Saturday morning slots historically convert best)

The brain runs this loop weekly per shop. After 12 weeks, the brain has 60+ listings + clear winner signal + the basis for the next 12 weeks' designs.
