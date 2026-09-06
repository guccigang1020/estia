import { describe, expect, it } from 'vitest'

import {
  checkWebhookUrl,
  isBlockedAddress,
  parseIpv4,
  parseIpv6,
} from './url-safety'

const refusal = (raw: string) => {
  const verdict = checkWebhookUrl(raw)
  return verdict.ok ? null : verdict.reason
}

describe('the scheme', () => {
  it('accepts an ordinary https endpoint', () => {
    const verdict = checkWebhookUrl('https://hooks.example.com/estia')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.hostname).toBe('hooks.example.com')
  })

  it('refuses http, and not as a warning', () => {
    // A webhook carries a guest's name and a booking's money. http also makes
    // the signature pointless: whoever can read the body can replay it.
    expect(refusal('http://hooks.example.com/estia')).toBe('not_https')
  })

  it('refuses every other scheme somebody might reach for', () => {
    for (const raw of [
      'ftp://hooks.example.com/x',
      'file:///etc/passwd',
      'gopher://hooks.example.com/x',
      'javascript:fetch("/")',
      'data:text/plain,hello',
    ]) {
      expect(refusal(raw), raw).not.toBeNull()
    }
  })

  it('refuses credentials in the URL', () => {
    // They end up in every log line that ever records the endpoint.
    expect(refusal('https://user:pass@hooks.example.com/x')).toBe(
      'has_credentials',
    )
    expect(refusal('https://user@hooks.example.com/x')).toBe('has_credentials')
  })
})

describe('the addresses nothing may be asked to reach', () => {
  it('refuses loopback and the private ranges as dotted quads', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '0.0.0.0',
      '100.64.0.1',
      '255.255.255.255',
      '224.0.0.1',
    ]) {
      expect(refusal(`https://${host}/hook`), host).toBe('blocked_address')
    }
  })

  it('refuses the cloud metadata address', () => {
    // The single most valuable destination on the list: it hands out the
    // machine's own role credentials to anybody who can make it fetch a URL.
    expect(refusal('https://169.254.169.254/latest/meta-data/')).toBe(
      'blocked_address',
    )
  })

  it('lets a public address through', () => {
    expect(checkWebhookUrl('https://93.184.216.34/hook').ok).toBe(true)
    expect(checkWebhookUrl('https://172.32.0.1/hook').ok).toBe(true)
    expect(checkWebhookUrl('https://172.15.255.255/hook').ok).toBe(true)
  })

  it('refuses IPv4 written to look like something else', () => {
    // All four of these are 127.0.0.1. A check that only understands dotted
    // quads is a check that has already been bypassed.
    for (const host of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1']) {
      expect(refusal(`https://${host}/hook`), host).toBe('blocked_address')
    }
  })

  it('refuses IPv4 smuggled inside IPv6', () => {
    for (const host of [
      '[::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:10.0.0.1]',
      '[2002:7f00:1::]',
      '[64:ff9b::127.0.0.1]',
      '[fc00::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      '[::]',
    ]) {
      expect(refusal(`https://${host}/hook`), host).toBe('blocked_address')
    }
  })

  it('lets a public IPv6 address through', () => {
    expect(checkWebhookUrl('https://[2606:4700::1111]/hook').ok).toBe(true)
    expect(checkWebhookUrl('https://[2002:5db8:1::]/hook').ok).toBe(true)
  })
})

describe('hostnames that mean "inside"', () => {
  it('refuses localhost and the internal suffixes', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'db.local',
      'vault.internal',
      'files.lan',
      'gateway.home',
      'wiki.corp',
    ]) {
      expect(refusal(`https://${host}/hook`), host).toBe('internal_hostname')
    }
  })

  it('refuses a bare hostname with no dot', () => {
    // `db` becomes `db.internal.example.com` through the search domain,
    // without anybody typing anything internal.
    expect(refusal('https://db/hook')).toBe('internal_hostname')
  })

  it('separates a bad name from a bad literal', () => {
    // The person fixing it needs to know which mistake they made.
    expect(refusal('https://10.0.0.1/x')).toBe('blocked_address')
    expect(refusal('https://vault.internal/x')).toBe('internal_hostname')
  })
})

describe('what is stored is what would be requested', () => {
  it('returns the normalised URL, not the typed one', () => {
    const verdict = checkWebhookUrl('  https://Hooks.Example.COM/estia  ')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.url).toBe('https://hooks.example.com/estia')
  })

  it('drops the fragment, which is never sent', () => {
    const verdict = checkWebhookUrl('https://hooks.example.com/x#section')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.url).toBe('https://hooks.example.com/x')
  })

  it('keeps the query string, which is', () => {
    const verdict = checkWebhookUrl('https://hooks.example.com/x?tenant=7')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.url).toBe('https://hooks.example.com/x?tenant=7')
    }
  })

  it('refuses nonsense and refuses length', () => {
    expect(refusal('')).toBe('not_a_url')
    expect(refusal('   ')).toBe('not_a_url')
    expect(refusal('hooks.example.com/x')).toBe('not_a_url')
    expect(refusal(`https://hooks.example.com/${'a'.repeat(2100)}`)).toBe(
      'too_long',
    )
  })
})

describe('the second gate', () => {
  it('exports the same rule the sender re-checks against', () => {
    // Registration cannot stop DNS rebinding — evil.example.com passes here
    // and points at 10.0.0.5 by the time anything connects. The sender calls
    // THIS function against the resolved address. One list, two gates.
    expect(isBlockedAddress('evil.example.com')).toBe(false)
    expect(isBlockedAddress('10.0.0.5')).toBe(true)
    expect(isBlockedAddress('169.254.169.254')).toBe(true)
    expect(isBlockedAddress('::1')).toBe(true)
  })
})

describe('the parsers, on their own', () => {
  it('reads every inet_aton form', () => {
    expect(parseIpv4('127.0.0.1')).toEqual([127, 0, 0, 1])
    expect(parseIpv4('2130706433')).toEqual([127, 0, 0, 1])
    expect(parseIpv4('0x7f000001')).toEqual([127, 0, 0, 1])
    expect(parseIpv4('127.1')).toEqual([127, 0, 0, 1])
    expect(parseIpv4('192.168.1')).toEqual([192, 168, 0, 1])
  })

  it('says null for things that are not IPv4', () => {
    expect(parseIpv4('example.com')).toBeNull()
    expect(parseIpv4('999.1.1.1')).toBeNull()
    expect(parseIpv4('1.2.3.4.5')).toBeNull()
    expect(parseIpv4('')).toBeNull()
  })

  it('reads compressed and mapped IPv6', () => {
    expect(parseIpv6('::1')?.slice(-1)).toEqual([1])
    expect(parseIpv6('::ffff:127.0.0.1')?.slice(-4)).toEqual([127, 0, 0, 1])
    expect(parseIpv6('2606:4700::1111')?.slice(0, 2)).toEqual([0x26, 0x06])
    expect(parseIpv6('not:an:address:at:all:x:y:z')).toBeNull()
    expect(parseIpv6('127.0.0.1')).toBeNull()
  })
})
