# R146.331 — 100 brain ops shipped

Money-focused. POD pipeline + content engine + audience + monetization +
productivity + autonomy + scaling + trust + quality + productization.

**100 new brain ops registered.** Cumulative count: ~1148+.

## What's WORKING vs what NEEDS CREDS

### Working today (no operator setup required)
- All planning ops (return structured plans + costs + blockers)
- All scoring ops (niche feasibility, hook prediction, content quality)
- Calculation ops (auto-pricing, tax estimates, currency conversion, ROI)
- Configuration ops (set budget, brand overlay, red lines, OKRs)
- Aggregation ops (revenue dashboard, attribution, audience health)
- Self-reflection ops (about_me, drift, mistakes)

### Needs operator credential to monetize
- All `content.upload_*` ops: TikTok, YouTube, Instagram, X, Reddit, Pinterest
- `pod.first_listing`: needs Printful + Etsy creds
- `monetize.stripe_setup`, `monetize.gumroad_upload`: Stripe / Gumroad creds
- `audience.affiliate_finder` (actionable form): platform creds

## The honest path to first dollar
1. `brain.health` to confirm system alive
2. Wire ONE OAuth: `POST /api/v1/oauth/etsy/start` (or printful, slack, gmail)
3. Run `pod.niche_picker` → pick highest-feasibility niche
4. Run `pod.design_library` → pick a template
5. Run `image.generate` to make the design
6. Run `pod.first_listing { niche }` — returns listingId or honest blocker list
7. Wait 7-14 days, run `pod.daily_revenue_digest`
8. If first sale lands: `pod.record_first_sale` fires push notification

## Larger items deferred to R332+
- Live posting integrations (TikTok upload API, YouTube Data API auth flow,
  Instagram Graph API permissions — each is its own session)
- Stripe Connect onboarding UI
- Multi-tenant schema partitioning
- Voice WebRTC
- Inbox triage with actual Gmail reads
