/**
 * commerce-policy.ts — Permission + intent enforcement for the
 * browser-control + commerce + creative + governance layers.
 *
 * Pure functions. No I/O. Composable with safety-policy.ts.
 *
 * Three categories of blocks:
 *   PURCHASE   — anything involving payment, subscription, ad-spend
 *   SECURITY   — captcha bypass, account creation deceit, scraping abuse
 *   IP/CONTENT — copying trademarked, copyrighted, impersonation, spam
 *
 * Plus a platform-policy heuristic for spam detection.
 */

// ─── PURCHASE/PAYMENT BLOCK ──────────────────────────────────────────────
// HARD BLOCK regardless of operator approval. The platform never spends.

const PURCHASE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(buy|purchase|checkout|pay\s+for|spend|charge|subscribe|subscription|renew\s+subscription)\b/i, reason: 'purchase intent' },
  { pattern: /\b(credit[-\s]?card|cc[-\s]?number|cvv|cvc|card[-\s]?expir|card\s+number|debit[-\s]?card)\b/i, reason: 'payment credential entry' },
  { pattern: /\b(billing[-\s]?address|bank[-\s]?account|routing[-\s]?number|iban|swift[-\s]?code)\b/i, reason: 'financial-account entry' },
  { pattern: /\b(ad\s+spend|ad[-\s]?budget|run\s+ads?|boost\s+post|promote\s+(post|listing)\s+with\s+\$)\b/i, reason: 'ad-spend intent' },
  { pattern: /\b(wire\s+transfer|venmo|paypal\s+send|cashapp|zelle\s+send|stripe\s+charge|process\s+payment)\b/i, reason: 'money-movement intent' },
  { pattern: /\b(crypto\s+(transfer|send)|bitcoin\s+send|eth\s+transfer)\b/i, reason: 'crypto-movement intent' },
]

// ─── SECURITY/DECEIT BLOCK ──────────────────────────────────────────────
const SECURITY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Allow up to 4 words between verb and target
  { pattern: /\b(bypass|circumvent|defeat|solve)\b(?:\W+\w+){0,4}\W+(captcha|recaptcha|hcaptcha|cloudflare)\b/i, reason: 'captcha bypass' },
  { pattern: /\b(fake|burner|throwaway|deceptive|fraudulent)\s+(account|email|phone|identity)\b/i, reason: 'deceptive account creation' },
  { pattern: /\b(scrape|crawl)\s+(aggressively|all\s+pages|every\s+listing|the\s+entire)\b/i, reason: 'aggressive scraping' },
  { pattern: /\b(impersonat(e|ion|ing))\b(?:\W+\w+){0,4}\W+(person|brand|company|celebrity|influencer)\b/i, reason: 'impersonation' },
  { pattern: /\b(rate[-\s]?limit\s+(bypass|evade|avoid)|stealth\s+(scrape|crawl))\b/i, reason: 'rate-limit evasion' },
  { pattern: /\b(disable|turn\s+off)\s+(2fa|mfa|multi[-\s]?factor)\b/i, reason: '2FA disable intent' },
]

// ─── IP/COPYRIGHT/CONTENT BLOCK ─────────────────────────────────────────
const IP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(copy|clone|replicate|mimic|knock[-\s]?off)\b(?:\W+\w+){0,4}\W+(competitor|brand|design|listing|logo|trademark)/i, reason: 'design copying intent' },
  { pattern: /\b(disney|marvel|nintendo|pokemon|harry\s+potter|star\s+wars|nike|adidas|supreme|apple\s+logo|chanel|gucci|louis\s+vuitton|rolex)\b/i, reason: 'protected brand reference (needs licensing check)' },
  { pattern: /\b(steal|reuse\s+without\s+permission|rip[-\s]?off)\b/i, reason: 'IP theft intent' },
  { pattern: /\b(deepfake|face[-\s]?swap|undress|nsfw\s+generation)\b/i, reason: 'harmful media' },
]

// ─── SPAM PATTERNS (for social posts) ───────────────────────────────────
const SPAM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(follow\s+for\s+follow|f4f|like\s+for\s+like|like\s+4\s+like|l4l|sub4sub|engagement\s+pod|spam\s+pod)\b/i, reason: 'engagement manipulation' },
  { pattern: /(?:check\s+out\s+my\s+(?:profile|page|link)\s*){2,}/i, reason: 'spam repetition' },
  { pattern: /^\s*[#@]\w+(\s+[#@]\w+){15,}/m,  reason: 'hashtag/mention spam (16+ tags)' },
  { pattern: /\b(click\s+(?:here|now|link\s+in\s+bio)\s+(?:to\s+)?(?:win|earn|make\s+\$|get\s+rich))\b/i, reason: 'scam/get-rich-quick' },
  { pattern: /\b(buy\s+followers?|fake\s+(?:likes|followers|engagement))\b/i, reason: 'fake-growth intent' },
  { pattern: /(.)\1{8,}/, reason: 'character/word repetition (9+ in a row)' },
]

export interface PolicyCheckResult {
  ok: boolean
  category: 'purchase' | 'security' | 'ip' | 'spam' | 'ok'
  reasons: string[]
}

export function checkPurchaseIntent(text: string): PolicyCheckResult {
  const reasons: string[] = []
  for (const { pattern, reason } of PURCHASE_PATTERNS) {
    if (pattern.test(text)) reasons.push(reason)
  }
  return { ok: reasons.length === 0, category: reasons.length > 0 ? 'purchase' : 'ok', reasons }
}

export function checkSecurityIntent(text: string): PolicyCheckResult {
  const reasons: string[] = []
  for (const { pattern, reason } of SECURITY_PATTERNS) {
    if (pattern.test(text)) reasons.push(reason)
  }
  return { ok: reasons.length === 0, category: reasons.length > 0 ? 'security' : 'ok', reasons }
}

export function checkIpRisk(text: string): PolicyCheckResult {
  const reasons: string[] = []
  for (const { pattern, reason } of IP_PATTERNS) {
    if (pattern.test(text)) reasons.push(reason)
  }
  return { ok: reasons.length === 0, category: reasons.length > 0 ? 'ip' : 'ok', reasons }
}

export function checkSpam(text: string): PolicyCheckResult {
  const reasons: string[] = []
  for (const { pattern, reason } of SPAM_PATTERNS) {
    if (pattern.test(text)) reasons.push(reason)
  }
  return { ok: reasons.length === 0, category: reasons.length > 0 ? 'spam' : 'ok', reasons }
}

/** Composite check used by social/post/listing publication. */
export function checkPublishContent(content: string): PolicyCheckResult {
  const ip   = checkIpRisk(content)
  const spam = checkSpam(content)
  const reasons = [...ip.reasons.map(r => `ip:${r}`), ...spam.reasons.map(r => `spam:${r}`)]
  return {
    ok: ip.ok && spam.ok,
    category: !ip.ok ? 'ip' : !spam.ok ? 'spam' : 'ok',
    reasons,
  }
}

/** Composite check used by browser sessions / actions. */
export function checkBrowserAction(intent: string, url?: string): PolicyCheckResult {
  const purchase = checkPurchaseIntent(intent)
  if (!purchase.ok) return purchase
  const security = checkSecurityIntent(intent)
  if (!security.ok) return security
  // Defensive: reject obvious payment URLs
  if (url && /\/(checkout|pay|billing|cart\/checkout|stripe|paypal\.com\/checkout)/i.test(url)) {
    return { ok: false, category: 'purchase', reasons: [`url contains payment path: ${url.slice(0, 80)}`] }
  }
  return { ok: true, category: 'ok', reasons: [] }
}

// ─── Anti-slop heuristics ───────────────────────────────────────────────
// Score 0..1 where HIGHER = MORE slop. Generic AI-design phrasing,
// trivial composition, overused trends.

const SLOP_INDICATORS: Array<{ pattern: RegExp; weight: number; reason: string }> = [
  { pattern: /\b(highly\s+detailed|ultra\s+realistic|8k\s+resolution|trending\s+on\s+artstation|masterpiece|award[-\s]?winning)\b/i, weight: 0.15, reason: 'generic AI-prompt cliche' },
  { pattern: /\b(cute|funny|cool|awesome|amazing)\s+(t-?shirt|design|graphic)\b/i, weight: 0.10, reason: 'low-effort adjective' },
  { pattern: /\b(live\s+laugh\s+love|good\s+vibes\s+only|but\s+first\s+coffee|wine\s+o'?clock|namaste)\b/i, weight: 0.20, reason: 'overused trend phrase' },
  { pattern: /^.{0,30}$/,  weight: 0.10, reason: 'too-short copy (<30 chars)' },
  { pattern: /(\w+\s+){0,3}\w+\s+\1/i, weight: 0.15, reason: 'phrase repetition' },
  { pattern: /\b(meme|trending|viral)\b/i, weight: 0.05, reason: 'meta-trend lazy descriptor' },
]

export interface SlopScore {
  score:    number           // 0..1, higher = more slop
  signals:  Array<{ reason: string; weight: number }>
}

export function scoreSlop(text: string): SlopScore {
  let score = 0
  const signals: Array<{ reason: string; weight: number }> = []
  for (const { pattern, weight, reason } of SLOP_INDICATORS) {
    if (pattern.test(text)) {
      score += weight
      signals.push({ reason, weight })
    }
  }
  return { score: Math.min(1, Number(score.toFixed(3))), signals }
}

// ─── Originality scoring (uses hash-bag from semantic-search) ───────────
// Higher = more unique vs the reference corpus.

export function scoreOriginality(targetVec: number[], cohort: number[][]): { score: number; closestDot: number } {
  if (cohort.length === 0) return { score: 1, closestDot: 0 }
  let closestDot = 0
  for (const c of cohort) {
    let dot = 0
    for (let i = 0; i < targetVec.length; i++) dot += (targetVec[i] ?? 0) * (c[i] ?? 0)
    if (dot > closestDot) closestDot = dot
  }
  return { score: Number((1 - closestDot).toFixed(3)), closestDot: Number(closestDot.toFixed(3)) }
}

// ─── Composite quality score ────────────────────────────────────────────
export function compositeQuality(opts: { originality: number; slop: number; ipRisk: number }): number {
  // originality high good; slop high bad; ipRisk high bad
  const raw = (opts.originality * 0.5) + ((1 - opts.slop) * 0.3) + ((1 - opts.ipRisk) * 0.2)
  return Math.max(0, Math.min(1, Number(raw.toFixed(3))))
}
