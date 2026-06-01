# Multi-language strategy — expanding beyond English

English content has a ceiling. There are ~1.5 billion English speakers globally; ~6 billion speakers of other languages. Most operators leave that 6 billion untouched because the marginal cost of translation, localization, and cultural adaptation feels high. With AI-assisted translation in 2026, that cost has collapsed by 10-50x. The constraint now is strategic judgment about WHICH markets to enter, in what ORDER, with what DEPTH of localization.

## What the operator should remember

- Translation ≠ localization. A literal translation of US copy fails in most markets. Cultural adaptation matters.
- The cheapest international markets to enter are not always the most profitable.
- Some markets have catastrophic local-platform requirements (WeChat in China, VK in Russia, KakaoTalk in Korea) that don't appear in US-centric playbooks.
- AI translation has crossed the "good enough for most B2C marketing" threshold. It has NOT crossed the "good enough for legal docs, support, or B2B sales" threshold.
- Multi-language strategy is a 12-24 month commitment per market. Do not enter 5 simultaneously.

## Picking your first non-English market — the decision tree

### Question 1: What's your TAM in each candidate market?
- Use language-population × per-capita-GDP × digital-adoption as proxy
- Top candidates by raw TAM: Spanish (500M speakers, growing economies), Portuguese (260M, Brazil-led), German (95M, high purchasing power), French (300M speakers globally), Japanese (125M, high purchasing power), Mandarin (1.1B but China-platform-required), Hindi (600M but lower per-capita spend)

### Question 2: How similar is the market culturally to your existing market?
- English-speaking → US/UK/Canada/Australia/Ireland (mostly cultural similarity)
- US/EU-aligned cultural markets: Germany, France, Netherlands, Scandinavia (relatively easy)
- US-distant but accessible: Brazil, Mexico, Japan (cultural adaptation needed but markets are open)
- US-distant and complex: China, Russia, Saudi Arabia (heavy local-platform/regulatory)

### Question 3: Do you have a customer/audience already there?
- Check existing analytics — what % of your traffic is non-English-language?
- If 5-10%+ from a single market: prioritize that market
- If <2% from any: you're entering cold; pick by TAM × accessibility

### Question 4: Does your product require local infrastructure?
- Physical products: shipping, returns, customer service in language
- Payments: support local payment methods (iDEAL in Netherlands, Pix in Brazil, Konbini in Japan)
- Compliance: GDPR, local data residency, tax registration
- Customer support: must be in language for paid customers

The brain's `business.feasibility` analyzer should be run separately for each candidate market. Don't average.

## The four expansion depths

### Level 1: Translated marketing (lightest touch)
- Translate top blog posts and landing pages
- Add language toggle to site
- Update OG/meta tags per language
- Effort: 20-50 hours per language; ~$200-1000 in AI translation + human review
- Suitable for: validating market interest before deeper investment

### Level 2: Localized content + paid acquisition
- Native-language content cadence (1-2 pieces per week)
- Paid advertising in target language with local creative
- Local language customer support (email, response time within 24h)
- Effort: 40-100 hours per month per language; $2-10k per month
- Suitable for: confirmed market interest, validating product-market fit

### Level 3: Native team and infrastructure
- Hire native-speaker content/marketing lead
- Local social media presence (each platform separately)
- Localized payment methods and contract terms
- Native-language live support
- Effort: $50-150k per year per market in headcount + infrastructure
- Suitable for: confirmed product-market fit, ready to scale

### Level 4: Full local entity
- Local subsidiary or business entity
- Native sales team (B2B markets especially)
- Local data residency and compliance
- Cultural product adaptation (not just language)
- Effort: $250k+ per year per market
- Suitable for: market is 20%+ of total revenue, scale economics justify

Don't skip levels. Going from L1 to L3 without learning at L2 wastes the L3 investment.

## Translation tooling — what's good enough in 2026

### For marketing copy:
- GPT-4 / Claude / Gemini at temperature 0 with proper prompting
- Quality: 90-95% of human-translator level for major languages
- Cost: $0.01-0.10 per page
- Caveat: HUMAN review by native speaker still required for brand-critical content

### For documentation / help center:
- DeepL or Google Cloud Translation API
- Quality: 85-95% depending on language pair
- Cost: $20 per million chars (DeepL), $20 per million chars (GCT)
- Caveat: technical terminology often needs glossary input

### For UI strings / product copy:
- Crowdin, Lokalise, Phrase (TMS platforms)
- Combine AI translation + human review + version control
- Quality: highest for product copy when properly managed
- Cost: $50-500/mo platform fee + per-string translation cost

### For legal / contracts / compliance:
- Human translator with legal specialization
- Quality: must be 100%
- Cost: $0.15-0.40 per word
- Do not skip for: MSA, ToS, Privacy Policy, contracts

### For customer support:
- AI-assisted with human-in-the-loop for paid customers
- Quality threshold: tone and cultural fit matter as much as accuracy
- Risk: poor support translation damages retention rapidly

The brain has `tts.synthesize` for voice + `captions.transcribe` for video — both support multiple languages but quality varies by language pair.

## Cultural localization — beyond translation

Things that don't translate via text alone:

### Visual:
- Color meanings differ (white = mourning in parts of Asia; red = lucky in China but danger in West)
- Photography (Western stock photos with Western models can feel alienating)
- Date/number formats (MM/DD/YYYY vs DD/MM/YYYY; comma/period decimal)

### Humor:
- Most humor doesn't translate
- Sarcasm often misreads or seems hostile
- Self-deprecating Western style ≠ Japanese formality

### Pricing:
- "$9.99" vs "9,99 €" vs "¥1,000" (round numbers matter in Japan)
- Free shipping expectations differ
- Subscription comfort differs (lower in Japan, higher in Northern Europe)

### Sales messaging:
- Direct US-style pitches feel pushy in Japan, normal in Germany
- Discount-heavy promotion is normal in Brazil/Mexico, signals low-quality in Germany/Japan
- Testimonials work universally but case-study formality varies

### Customer service:
- Response time expectations differ
- Email vs. chat vs. phone preferences differ
- Apology conventions differ massively (Japan vs. US)

The brain's `social-media-playbook` patterns apply but with platform-specific overlays per market.

## Per-market platform mix (high-leverage)

| Market | Top organic | Top paid | Key constraint |
|---|---|---|---|
| US | YouTube, TikTok, IG | Meta, Google | Saturation; expensive |
| UK/AU/CA | YouTube, TikTok, IG | Meta, Google | English-language overlap |
| Germany | YouTube, LinkedIn | Google, LinkedIn | Privacy-strict; GDPR |
| France | YouTube, IG | Google, Meta | Language purity matters |
| Brazil | TikTok, IG, WhatsApp | Meta, Google | Pix payment; mobile-first |
| Mexico | Facebook, IG, WhatsApp | Meta, Google | WhatsApp dominant comms |
| Japan | Twitter, LINE, YouTube | Google, Yahoo!, LINE | Web design conventions differ |
| South Korea | KakaoTalk, Naver, YouTube | Naver, KakaoMoment | Naver search ≠ Google |
| China | WeChat, Douyin, RED | Tencent ads, ByteDance | Requires ICP license, hosting in China |
| India | YouTube, IG, WhatsApp | Meta, Google | English + Hindi mix |
| Indonesia | Instagram, TikTok | Meta, TikTok | Mobile-first; price-sensitive |
| Spain (es-ES) | YouTube, TikTok, IG | Meta, Google | Distinct from LATAM Spanish |
| Latin America | TikTok, IG, WhatsApp | Meta, Google | Pan-LATAM Spanish; payment fragmentation |

The brain's connector catalog (R146.84) covers the major Western platforms; Asian markets often require additional integrations (LINE, WeChat, Naver).

## SEO localization — non-obvious gotchas

- **Don't use auto-translated content for ranking** — Google penalizes; native-quality required
- **hreflang tags are non-negotiable** — proper implementation prevents duplicate-content issues across language variants
- **ccTLDs vs. subdirectories** — .de domain ranks better in Germany than /de/ subdirectory but creates more overhead
- **Local keywords differ** — "best laptop" in US ≠ literal translation in DE; conduct fresh keyword research per market
- **Backlink profile differs** — links from .de domains matter for ranking in Germany
- **Local search engines** — Baidu (China), Yandex (Russia), Naver (Korea) have different ranking algorithms

The brain's `seo-blog-content` patterns apply but multiply per market with separate keyword research and ranking tracking.

## Revenue economics across markets

Rough orders of magnitude for a typical B2C SaaS product:

| Market | Avg WTP vs US | Acquisition cost vs US |
|---|---|---|
| US | 1.0x | 1.0x |
| UK | 0.9x | 0.9x |
| Germany | 0.95x | 0.7x |
| France | 0.8x | 0.7x |
| Japan | 0.9x | 1.2x |
| Brazil | 0.3x | 0.2x |
| India | 0.15x | 0.1x |
| Indonesia | 0.2x | 0.15x |

This means: for the same effort, India + Indonesia + Brazil + Mexico together may produce more total revenue than expanding from US into UK + Germany. The math changes by product though — SaaS economics differ from physical goods which differ from courses.

The brain's `paid-ads-fundamentals` patterns apply but with per-market CPM/CAC inputs.

## What the brain MUST NOT do

- Auto-translate marketing materials without human native review for brand-critical content
- Promise "available in X markets" before infrastructure is ready
- Use AI translation for legal documents (contracts, ToS, privacy policies)
- Skip cultural review steps for new market entries
- Assume one Spanish/Portuguese/etc. works for all regional variants (es-MX ≠ es-ES, pt-BR ≠ pt-PT)
- Use Google Translate for live customer support of paid customers

## What "good" looks like

For an operator who's expanded into one non-English market at month 12:
- That market produces 10-25% of total business revenue
- Local-language content cadence matches main market (1+ piece per week)
- Customer satisfaction in target language matches main market
- Local payment methods supported
- At least one native-speaker team member or contractor
- Specific case study / testimonial from target market
- Clear data showing market is growing, not flat

The expansion that fails: translates the existing US site, runs the same ads with translated copy, gets 0.3% conversion (vs US 2.5%), concludes "the market doesn't work" and exits. The expansion that succeeds: spends 6 months at L1-L2, learns what's different, invests in proper localization, hits product-market fit in market 12-18 months in.
