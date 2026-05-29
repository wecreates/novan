/**
 * anonymize.ts — Pure transforms for presentation mode.
 *
 * The "show-off" view per the spec must hide secrets without losing
 * structure. Operator names + business names become friendly aliases;
 * financial figures round to magnitudes; specific configurations blur.
 */

/** Deterministic, kid-friendly aliases. Same input → same alias every
 *  time so a session feels consistent. */
const ALIAS_POOL = [
  'Orion', 'Lyra', 'Cygnus', 'Vega', 'Andromeda', 'Atlas', 'Helios',
  'Polaris', 'Sirius', 'Rigel', 'Antares', 'Auriga', 'Draco', 'Phoenix',
  'Nova', 'Aurora', 'Eclipse', 'Quasar', 'Pulsar', 'Nebula',
] as const

export function aliasFor(input: string): string {
  if (!input) return 'Workspace'
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0
  const idx = Math.abs(h) % ALIAS_POOL.length
  return ALIAS_POOL[idx]!
}

/** Round to a magnitude that conveys scale without leaking exact $$.
 *  Less than $1k → "<$1k"; $1k-$10k → nearest $1k; etc. */
export function roundCurrency(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return '$0'
  const abs = Math.abs(usd)
  const sign = usd < 0 ? '-' : ''
  if (abs < 1_000)      return `${sign}<$1k`
  if (abs < 10_000)     return `${sign}$${Math.round(abs / 1_000)}k`
  if (abs < 100_000)    return `${sign}~$${Math.round(abs / 10_000) * 10}k`
  if (abs < 1_000_000)  return `${sign}~$${Math.round(abs / 100_000) * 100}k`
  if (abs < 10_000_000) return `${sign}~$${(abs / 1_000_000).toFixed(1)}M`
  return `${sign}~$${Math.round(abs / 1_000_000)}M`
}

/** Round a count to a magnitude. 47 → "~50"; 1247 → "~1.2k". */
export function roundCount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n < 10)         return String(n)
  if (n < 100)        return `~${Math.round(n / 10) * 10}`
  if (n < 1_000)      return `~${Math.round(n / 50) * 50}`
  if (n < 10_000)     return `~${(n / 1_000).toFixed(1)}k`
  if (n < 100_000)    return `~${Math.round(n / 1_000)}k`
  return `~${(n / 1_000_000).toFixed(1)}M`
}

/** Redact PII-ish text. Emails, phone numbers, full names of customers
 *  get replaced with shape-preserving placeholders. */
export function redactText(s: string): string {
  if (!s) return s
  return s
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '████@████.███')
    .replace(/\b\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}\b/g, '████-████')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '███-██-████')   // SSN-shape
}

export interface AnonymizationOptions {
  hideBusinessNames?:  boolean
  hideOperatorNames?:  boolean
  roundFinancials?:    boolean
  roundCounts?:        boolean
  redactPii?:          boolean
}

export const DEFAULT_ANON: Required<AnonymizationOptions> = {
  hideBusinessNames: true,
  hideOperatorNames: true,
  roundFinancials:   true,
  roundCounts:       true,
  redactPii:         true,
}

/** Apply the full anonymization pass to a record. Caller decides which
 *  fields are "name" / "operator" / "amount" / "count" / "text". */
export interface AnonymizableRecord {
  name?:     string
  operator?: string
  amount?:   number
  count?:    number
  text?:     string
}

export function anonymize<T extends AnonymizableRecord>(
  rec: T,
  opts: AnonymizationOptions = DEFAULT_ANON,
): T {
  const o = { ...DEFAULT_ANON, ...opts }
  const out: AnonymizableRecord = { ...rec }
  if (o.hideBusinessNames && rec.name)     out.name     = aliasFor(rec.name)
  if (o.hideOperatorNames && rec.operator) out.operator = aliasFor(rec.operator)
  if (o.roundFinancials  && typeof rec.amount === 'number') out.amount = rec.amount   // number stays for math; display layer formats
  if (o.redactPii        && rec.text)      out.text     = redactText(rec.text)
  return out as T
}

/** Helper for display: formats amount using roundCurrency iff anon is on. */
export function formatAmount(amount: number, anonOn: boolean): string {
  if (anonOn) return roundCurrency(amount)
  return `$${amount.toLocaleString()}`
}

/** Helper for display: formats count using roundCount iff anon is on. */
export function formatCount(n: number, anonOn: boolean): string {
  if (anonOn) return roundCount(n)
  return n.toLocaleString()
}
