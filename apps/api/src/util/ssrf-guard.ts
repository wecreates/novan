/**
 * R146.312 — SSRF guard for outbound URLs derived from user / LLM input.
 *
 * Block:
 *   - non-http(s) schemes (file:, gopher:, ftp:, dict:, ...)
 *   - localhost / 127.0.0.0/8
 *   - 169.254.0.0/16  (link-local, AWS/Azure IMDS, GCP)
 *   - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC1918)
 *   - 100.64.0.0/10 (CGNAT — Tailscale uses this range)
 *   - ::1, fc00::/7, fe80::/10 (IPv6 link-local + private)
 *   - .internal / .local / .lan TLDs
 *   - explicit IMDS host metadata.google.internal
 *
 * Returns null on safe, an error reason string on block.
 */
export function ssrfReject(rawUrl: string): string | null {
  let u: URL
  try { u = new URL(rawUrl) } catch { return 'invalid URL' }
  const proto = u.protocol.toLowerCase()
  if (proto !== 'http:' && proto !== 'https:') return `disallowed scheme ${proto}`
  const host = u.hostname.toLowerCase()
  if (!host) return 'empty host'

  // Block IMDS-style hostnames anywhere
  if (host === 'metadata.google.internal' || host === 'metadata') return 'cloud metadata host'

  // .internal / .local / .lan
  if (/\.(internal|local|lan|intranet|home|corp)$/i.test(host)) return `disallowed TLD ${host}`

  // localhost literal
  if (host === 'localhost' || host === 'ip6-localhost') return 'localhost'

  // IPv4 literal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const oct = v4.slice(1, 5).map(n => Number(n))
    if (oct.some(n => n < 0 || n > 255)) return 'malformed ipv4'
    const [a, b] = oct as [number, number, number, number]
    // 0.0.0.0/8 — "this network" / wildcard
    if (a === 0)   return 'private 0.0.0.0/8'
    // 127.0.0.0/8 — loopback
    if (a === 127) return 'loopback 127/8'
    // 10.0.0.0/8 RFC1918
    if (a === 10)  return 'rfc1918 10/8'
    // 172.16.0.0/12 RFC1918
    if (a === 172 && b >= 16 && b <= 31) return 'rfc1918 172.16/12'
    // 192.168.0.0/16 RFC1918
    if (a === 192 && b === 168)          return 'rfc1918 192.168/16'
    // 169.254.0.0/16 link-local (IMDS)
    if (a === 169 && b === 254)          return 'link-local 169.254/16 (IMDS)'
    // 100.64.0.0/10 CGNAT (Tailscale 100.64-100.127)
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat 100.64/10 (tailscale)'
    // 224/4 multicast, 240/4 reserved
    if (a >= 224) return 'multicast/reserved'
  }

  // IPv6 literal — bracket-stripped by URL
  if (host.includes(':')) {
    const v6 = host.toLowerCase()
    if (v6 === '::' || v6 === '::1') return 'ipv6 loopback'
    if (v6.startsWith('fe80:') || v6.startsWith('fe80::')) return 'ipv6 link-local'
    if (v6.startsWith('fc') || v6.startsWith('fd')) return 'ipv6 ula fc00::/7'
    if (v6.startsWith('::ffff:')) {
      // IPv4-mapped — extract and re-check
      const mapped = v6.slice(7)
      return ssrfReject(`${proto}//${mapped}${u.port ? ':' + u.port : ''}${u.pathname}`)
    }
  }
  return null
}
