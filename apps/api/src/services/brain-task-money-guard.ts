/**
 * brain-task-money-guard.ts — Reject any operation that touches money.
 *
 * Runs BEFORE every brain-task operation. If any parameter, URL, file
 * path, command, or selector matches a financial pattern, the
 * operation is hard-blocked and audit-logged.
 *
 * This is a *prevention* layer, not a *detection* layer. We err on
 * the side of false positives — if the operator wants something
 * money-adjacent, they have to explicitly tag it as `non_financial: true`
 * after reviewing the params (escape hatch for legitimate use like
 * "read the price column from this CSV").
 */

const FINANCIAL_PATTERNS: RegExp[] = [
  // Payment methods
  /\b(?:credit|debit)\s*card|cc[\s-]?(?:num(?:ber)?|#)|cvv|cvc|card\s*number/i,
  /\b(?:routing|account)\s*number|aba\s*number|swift\s*code|iban\b/i,
  /\bbank\s*(?:account|transfer|deposit|withdraw|wire)/i,

  // Actions
  /\b(?:pay|paying|payment|paid|charge|purchase|buy|sell|trade|transfer|withdraw|deposit|invest|invoice|refund|chargeback)\b/i,
  /\b(?:ach|wire\s*transfer|venmo|paypal|zelle|cashapp|stripe|braintree|plaid)\b/i,

  // Currencies + amounts
  /\$\s*\d|\b\d+\s*(?:USD|EUR|GBP|JPY|CNY|CAD|AUD|CHF|INR|MXN|BTC|ETH)\b/i,
  /\b(?:dollars?|euros?|pounds?|yen|yuan|rupees?|pesos?|bitcoin|ethereum|crypto(?:currency)?)\b/i,

  // Financial services / hosts
  /\b(?:bank|banking|brokerage|exchange|wallet|treasury|payroll|stripe|paypal|venmo|cashapp|robinhood|coinbase|binance|kraken|fidelity|vanguard|schwab|etrade)\b/i,
]

// URL host blocklist — exact matches against domain segments
const FINANCIAL_HOSTS: RegExp[] = [
  /\b(?:stripe|paypal|venmo|cashapp|zelle|wise|revolut|coinbase|binance|kraken|gemini|bitstamp|robinhood|fidelity|vanguard|schwab|etrade|ameritrade)\.com\b/i,
  /\b(?:bank|banking|chase|wellsfargo|bofa|bankofamerica|citi|capitalone|usbank|ally|discover)\.com\b/i,
  /\bplaid\.com\b/i,
]

export interface GuardResult {
  ok:      boolean
  matched?: string
  source?:  string   // which field tripped it
}

// Field names whose values are opaque binary blobs (PNG/JPEG base64,
// screenshots, audio, raw bytes). Skip scanning them — random binary
// will hit a 3-letter pattern like "Cvv" by chance.
const BINARY_FIELDS = new Set([
  'pngBase64', 'jpgBase64', 'imageBase64', 'audioBase64', 'screenshotBase64',
  'screenshot', 'image', 'audio', 'video', 'bytes', 'buffer', 'raw',
  'html',   // HTML content from scraped pages — too noisy; gets checked via `text` instead
])

// Looks like base64 binary (long, only a-zA-Z0-9+/= chars, mostly mixed case)
function looksBinary(s: string): boolean {
  if (s.length < 200) return false
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) return false
  // Real base64 is ~75% alphanumeric mix; English prose has more spaces + punctuation.
  // If less than 1% of chars are spaces, it's almost certainly binary.
  const spaces = (s.match(/\s/g) ?? []).length
  return spaces / s.length < 0.01
}

/**
 * Inspect operation params for financial content. Recursively walks
 * strings, arrays, and objects. Returns the first match or ok=true.
 */
export function checkMoneyContent(value: unknown, source = 'root'): GuardResult {
  if (value === null || value === undefined) return { ok: true }
  if (typeof value === 'string') {
    // Skip likely-binary strings — they trip on random 3-letter matches
    if (looksBinary(value)) return { ok: true }
    for (const re of FINANCIAL_PATTERNS) {
      const m = value.match(re)
      if (m) return { ok: false, matched: m[0], source }
    }
    for (const re of FINANCIAL_HOSTS) {
      const m = value.match(re)
      if (m) return { ok: false, matched: m[0], source }
    }
    return { ok: true }
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { ok: true }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = checkMoneyContent(value[i], `${source}[${i}]`)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Skip binary-data fields entirely
      if (BINARY_FIELDS.has(k)) continue
      // Field-name check first — "payment_amount" would catch even if value is 0
      for (const re of FINANCIAL_PATTERNS) {
        if (re.test(k)) return { ok: false, matched: k, source: `${source}.${k}` }
      }
      const r = checkMoneyContent(v, `${source}.${k}`)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  return { ok: true }
}

/**
 * Guard wrapper for an entire operation invocation.
 * Skipped if params.non_financial === true (escape hatch — operator
 * has reviewed the params and confirmed they aren't money).
 */
export function guardOperation(op: string, params: Record<string, unknown>): GuardResult {
  if (params['non_financial'] === true) return { ok: true }
  return checkMoneyContent({ op, params }, 'op')
}
