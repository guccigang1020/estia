/**
 * Where ESTIA is allowed to send a request.
 *
 * ══ THIS FILE IS THE MODULE'S REASON TO BE CAREFUL ══════════════════════════
 *
 * Every other feature in this product sends requests to places ESTIA chose. A
 * webhook endpoint is the first URL a CUSTOMER chooses, and ESTIA fetches it
 * from inside its own network with its own credentials attached to nothing but
 * still from its own IP. That is Server Side Request Forgery, and the payload
 * is not the danger — the destination is.
 *
 * A tenant who registers `http://169.254.169.254/latest/meta-data/iam/` has
 * not attacked anything yet. They have asked ESTIA to attack itself, and
 * ESTIA will comply politely, on schedule, with retries.
 *
 * ══ WHAT IS REFUSED, AND WHY EACH ONE ═══════════════════════════════════════
 *
 *   · **Anything but https.** Not "http is discouraged" — refused. A webhook
 *     carries a guest's name and a booking's money over somebody else's
 *     network. `http` also makes the signature pointless: an attacker who can
 *     read the body can replay it, and the whole point of signing is that they
 *     cannot forge one.
 *   · **Credentials in the URL.** `https://user:pass@host` puts a secret in
 *     every log line that ever records the endpoint, including this product's.
 *   · **Loopback, private, link-local, CGNAT, and every reserved range**, as
 *     literals AND as the target of a hostname. `127.0.0.1`, `10.x`, `192.168.x`,
 *     `169.254.169.254` (the cloud metadata address, which is the single most
 *     valuable destination on this list), `::1`, `fc00::/7`, `fe80::/10`.
 *   · **IPv4 written to look like something else.** `2130706433`,
 *     `0x7f000001` and `0177.0.0.1` are all `127.0.0.1`. A check that only
 *     understands dotted quads is a check that has been bypassed.
 *   · **IPv4 smuggled inside IPv6.** `::ffff:127.0.0.1`, `2002:7f00:1::` and
 *     `64:ff9b::127.0.0.1` all reach loopback through a v6-shaped literal.
 *   · **`localhost` and the internal suffixes** — `.local`, `.internal`,
 *     `.localdomain`, and a bare hostname with no dot at all, which on many
 *     networks resolves through a search domain to something inside.
 *
 * ══ WHAT THIS FILE CANNOT DO, AND WHO DOES IT ═══════════════════════════════
 *
 * It reads a string. It does not resolve DNS, and it therefore cannot stop
 * `evil.example.com` from having an A record pointing at `10.0.0.5`, nor from
 * changing that record between validation and delivery — DNS rebinding.
 *
 * **That is not a gap here; it is a second check that belongs at send time**,
 * against the address actually connected to. This function is the gate at
 * registration, where a human sees the refusal and fixes their URL. The sender
 * enforces the same rule against the resolved address, where a violation is an
 * attack rather than a typo. `isBlockedAddress` is exported for exactly that
 * second call, so both gates share one list and cannot drift apart.
 *
 * Nothing here throws and nothing here is async, so the refusal can be shown
 * beside the input field as the user types.
 */

/** Why a URL was refused. Stable codes; the Hebrew lives in `labels.ts`. */
export const URL_REFUSAL_CODES = [
  'not_a_url',
  'not_https',
  'has_credentials',
  'blocked_address',
  'internal_hostname',
  'too_long',
] as const

export type UrlRefusalCode = (typeof URL_REFUSAL_CODES)[number]

export type UrlVerdict =
  | { readonly ok: true; readonly url: string; readonly hostname: string }
  | { readonly ok: false; readonly reason: UrlRefusalCode }

/**
 * Long enough for any real endpoint, short enough that the URL cannot become
 * a storage channel. `webhook_endpoints.url` is capped at the same number.
 */
export const MAX_URL_LENGTH = 2048

/* --------------------------------------------------------------- IPv4 ---- */

/**
 * Every form of IPv4 a resolver accepts, reduced to four octets.
 *
 * `inet_aton` semantics, which is what most stacks actually implement: one
 * part is a 32-bit integer, two parts are `a.b` with b as 24 bits, three are
 * `a.b.c` with c as 16, four are the familiar quad. Each part may be decimal,
 * octal with a leading zero, or hex with `0x`.
 *
 * Returns null when the string is not IPv4 in any of those forms — which
 * includes ordinary hostnames, and is why the caller must not treat null as
 * "safe" on its own.
 */
export function parseIpv4(host: string): readonly number[] | null {
  if (host.length === 0 || host.length > 45) return null

  const parts = host.split('.')
  if (parts.length > 4) return null

  const values: number[] = []
  for (const part of parts) {
    if (part.length === 0) return null

    let value: number
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part, 16)
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part, 8)
    else if (/^(0|[1-9][0-9]*)$/.test(part)) value = Number.parseInt(part, 10)
    else return null

    if (!Number.isSafeInteger(value) || value < 0) return null
    values.push(value)
  }

  // The last part absorbs every octet the earlier parts did not name.
  const spread = 4 - values.length
  const last = values[values.length - 1]
  if (last >= 256 ** (spread + 1)) return null
  for (const value of values.slice(0, -1)) if (value > 255) return null

  const octets = values.slice(0, -1)
  for (let i = spread; i >= 0; i -= 1) octets.push((last >>> (i * 8)) & 0xff)
  return octets
}

/** The ranges nothing outside this datacentre should be asked to reach. */
function ipv4IsBlocked(octets: readonly number[]): boolean {
  const [a, b] = octets
  if (a === 0) return true // 0.0.0.0/8 — "this network"
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && octets[1] === 0 && octets[2] === 0) return true // IETF
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

/* --------------------------------------------------------------- IPv6 ---- */

/**
 * IPv6 to sixteen bytes, including the `::ffff:1.2.3.4` tail form.
 *
 * Deliberately permissive about what it accepts: this is a REFUSAL check, and
 * a parser that rejects an odd-but-valid literal as "not an address" would
 * hand it to the hostname path and let it through. When in doubt it parses.
 */
export function parseIpv6(host: string): readonly number[] | null {
  let text = host
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  if (!text.includes(':')) return null

  // A trailing dotted quad contributes the last four bytes.
  let tailBytes: readonly number[] = []
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const quad = parseIpv4(tail)
    if (quad === null) return null
    tailBytes = quad
    text = text.slice(0, lastColon + 1) + '0:0'
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const toWords = (part: string): number[] | null => {
    if (part === '') return []
    const words: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      words.push(Number.parseInt(group, 16))
    }
    return words
  }

  const head = toWords(halves[0])
  const rest = halves.length === 2 ? toWords(halves[1]) : []
  if (head === null || rest === null) return null

  const wordCount = 8 - tailBytes.length / 2
  let words: number[]
  if (halves.length === 2) {
    const gap = wordCount - head.length - rest.length
    if (gap < 0) return null
    words = [...head, ...Array<number>(gap).fill(0), ...rest]
  } else {
    if (head.length !== wordCount) return null
    words = head
  }

  const bytes: number[] = []
  for (const word of words) bytes.push((word >>> 8) & 0xff, word & 0xff)
  return [...bytes, ...tailBytes]
}

function ipv6IsBlocked(bytes: readonly number[]): boolean {
  const allZero = bytes.every((byte) => byte === 0)
  if (allZero) return true // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true // fc00::/7, unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true // fe80::/10

  // Every way a v4 address hides inside a v6 one. Each is checked against the
  // v4 list rather than being blanket-refused, so a legitimate 6to4 endpoint
  // on a public address still works.
  const embedded = (offset: number) => bytes.slice(offset, offset + 4)

  const v4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  if (v4Mapped) return ipv4IsBlocked(embedded(12))

  // ::a.b.c.d — the deprecated compatible form, and ::ffff:0:a.b.c.d
  if (bytes.slice(0, 12).every((b) => b === 0))
    return ipv4IsBlocked(embedded(12))

  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4IsBlocked(embedded(2)) // 6to4

  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b
  if (nat64) return ipv4IsBlocked(embedded(12))

  return false
}

/* ------------------------------------------------------------- the gate -- */

const INTERNAL_SUFFIXES = [
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
] as const

/**
 * True when this host must never be connected to.
 *
 * Exported because the SENDER calls it a second time, against the IP it
 * actually resolved. One list, two gates: registration and delivery. If they
 * were separate lists they would drift, and the one that drifted would be the
 * one nobody was watching.
 */
export function isBlockedAddress(host: string): boolean {
  const lower = host.toLowerCase()

  if (lower === 'localhost' || lower.endsWith('.localhost')) return true
  if (INTERNAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true

  const v6 = parseIpv6(lower)
  if (v6 !== null) return ipv6IsBlocked(v6)

  const v4 = parseIpv4(lower)
  if (v4 !== null) return ipv4IsBlocked(v4)

  return false
}

/**
 * The registration gate.
 *
 * Returns the URL as the platform normalised it rather than as typed, so what
 * gets stored is what would actually be requested — a check that passes one
 * string and stores a different one has checked nothing.
 */
export function checkWebhookUrl(raw: string): UrlVerdict {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'not_a_url' }
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'not_a_url' }
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'has_credentials' }
  }

  const host = url.hostname
  if (host.length === 0) return { ok: false, reason: 'not_a_url' }

  // Worked out once, because the dot rule below depends on it: an IPv6
  // literal has no dot at all, and a rule that reads "no dot means internal"
  // refuses every public v6 endpoint in existence.
  const isLiteral = parseIpv4(host) !== null || parseIpv6(host) !== null

  if (isBlockedAddress(host)) {
    // An IP literal is a different mistake from a name, and the person fixing
    // it needs to know which one they made.
    return {
      ok: false,
      reason: isLiteral ? 'blocked_address' : 'internal_hostname',
    }
  }

  // A name with no dot resolves through the search domain on most networks,
  // which is how `db` becomes `db.internal.example.com` without anybody
  // typing anything internal. Literals are exempt: they resolve to nothing.
  if (!isLiteral && !host.includes('.')) {
    return { ok: false, reason: 'internal_hostname' }
  }

  // The fragment is never sent, so storing one records an intent the product
  // cannot honour.
  url.hash = ''

  return { ok: true, url: url.toString(), hostname: host }
}
