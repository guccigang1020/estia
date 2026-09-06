import { describe, expect, it } from 'vitest'

import {
  SIGNATURE_TOLERANCE_SECONDS,
  generateSigningSecret,
  signPayload,
  verifySignature,
} from './signature'

const NOW = new Date('2026-09-06T12:00:00.000Z')
const SECRET = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const BODY = '{"name":"booking.created","payload":{"id":"b-1"}}'

const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000)

describe('signing', () => {
  it('round-trips', () => {
    const header = signPayload(BODY, [SECRET], NOW)
    expect(verifySignature(BODY, header, [SECRET], NOW)).toEqual({ ok: true })
  })

  it('emits a timestamp and a versioned signature', () => {
    const header = signPayload(BODY, [SECRET], NOW)
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })

  it('refuses to sign with no secret', () => {
    // Silently sending unsigned would be worse than failing loudly: the
    // receiver's verification would fail and nobody would know why.
    expect(() => signPayload(BODY, [], NOW)).toThrow(/no secret/)
  })

  it('gives different secrets different signatures', () => {
    expect(signPayload(BODY, [SECRET], NOW)).not.toBe(
      signPayload(BODY, [OTHER], NOW),
    )
  })
})

describe('what the signature actually protects', () => {
  it('rejects a changed body', () => {
    const header = signPayload(BODY, [SECRET], NOW)
    const tampered = BODY.replace('b-1', 'b-2')
    expect(verifySignature(tampered, header, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('rejects a foreign secret', () => {
    const header = signPayload(BODY, [SECRET], NOW)
    expect(verifySignature(BODY, header, [OTHER], NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('rejects a replay once the window has passed', () => {
    const header = signPayload(BODY, [SECRET], NOW)
    const late = at(SIGNATURE_TOLERANCE_SECONDS + 1)
    expect(verifySignature(BODY, header, [SECRET], late)).toEqual({
      ok: false,
      reason: 'stale',
    })
  })

  it('rejects a timestamp from the future just as firmly', () => {
    // A check that only looks backwards accepts a signature minted for
    // tomorrow and replayed until then.
    const header = signPayload(
      BODY,
      [SECRET],
      at(SIGNATURE_TOLERANCE_SECONDS + 60),
    )
    expect(verifySignature(BODY, header, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'stale',
    })
  })

  it('accepts inside the window, at both edges', () => {
    const header = signPayload(BODY, [SECRET], NOW)
    for (const clock of [
      at(SIGNATURE_TOLERANCE_SECONDS),
      at(-SIGNATURE_TOLERANCE_SECONDS),
    ]) {
      expect(verifySignature(BODY, header, [SECRET], clock).ok).toBe(true)
    }
  })

  it('cannot be fooled by moving the timestamp', () => {
    // The timestamp is inside the MAC. Re-stamping a captured body with a
    // fresh `t` must not produce a valid delivery — if it did, the freshness
    // check would be protecting nothing.
    const header = signPayload(BODY, [SECRET], NOW)
    const signature = header.split(',')[1]
    const fresh = Math.floor(
      at(SIGNATURE_TOLERANCE_SECONDS * 2).getTime() / 1000,
    )
    const forged = `t=${fresh},${signature}`
    expect(
      verifySignature(
        BODY,
        forged,
        [SECRET],
        at(SIGNATURE_TOLERANCE_SECONDS * 2),
      ),
    ).toEqual({ ok: false, reason: 'mismatch' })
  })
})

describe('rotation', () => {
  it('signs with every live secret so both receivers verify', () => {
    const header = signPayload(BODY, [OTHER, SECRET], NOW)
    // The receiver that has updated:
    expect(verifySignature(BODY, header, [OTHER], NOW).ok).toBe(true)
    // and the one that has not, in the same delivery:
    expect(verifySignature(BODY, header, [SECRET], NOW).ok).toBe(true)
  })

  it('is why a rotation does not mean a window of total failure', () => {
    const during = signPayload(BODY, [OTHER, SECRET], NOW)
    expect(during.match(/v1=/g)).toHaveLength(2)
    const after = signPayload(BODY, [OTHER], NOW)
    expect(verifySignature(BODY, after, [SECRET], NOW).ok).toBe(false)
  })
})

describe('malformed headers', () => {
  it('names what was wrong', () => {
    expect(verifySignature(BODY, null, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'no_signature',
    })
    expect(verifySignature(BODY, '   ', [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'no_signature',
    })
    expect(verifySignature(BODY, 'v1=abc', [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(verifySignature(BODY, 't=1757155200', [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'no_signature',
    })
  })

  it('ignores a signature that is not 64 hex characters', () => {
    // Length is checked before the compare, so a short value can never reach
    // timingSafeEqual — which throws on unequal buffers.
    expect(verifySignature(BODY, 't=1757155200,v1=zz', [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'no_signature',
    })
  })

  it('tolerates spacing and unknown parts a future version may add', () => {
    const header = signPayload(BODY, [SECRET], NOW)
    const [t, v1] = header.split(',')
    const padded = `${t}, v2=whatever, ${v1}`
    expect(verifySignature(BODY, padded, [SECRET], NOW).ok).toBe(true)
  })
})

describe('the generated secret', () => {
  it('is 32 bytes of hex, and never the same twice', () => {
    const first = generateSigningSecret()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(generateSigningSecret())
  })
})
