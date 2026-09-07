import { describe, expect, it } from 'vitest'

import {
  ALLOWED_PHOTO_TYPES,
  InvalidPhotoTarget,
  MAX_PHOTO_BYTES,
  checkPhoto,
  isPhotoType,
  objectPath,
  photoProblemMessage,
} from './photo'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROP = '22222222-2222-4222-8222-222222222222'

describe('the extension comes from the content type, never the filename', () => {
  it('names the object by type even when the filename says otherwise', () => {
    // `villa.php.jpg` is the oldest trick there is, and the filename is never
    // consulted — so it cannot reach the path at all.
    expect(
      objectPath({
        organizationId: ORG,
        propertyId: PROP,
        type: 'image/webp',
        unique: 'abc',
      }),
    ).toBe(`${ORG}/${PROP}/abc.webp`)
  })

  it('gives every allowed type its own extension', () => {
    const paths = ALLOWED_PHOTO_TYPES.map((type) =>
      objectPath({
        organizationId: ORG,
        propertyId: PROP,
        type,
        unique: 'x',
      }),
    )
    // Four types, four distinct names — a collision here would mean two
    // formats overwriting each other in the bucket.
    expect(new Set(paths).size).toBe(ALLOWED_PHOTO_TYPES.length)
  })
})

describe('the path is an authorization surface, so it refuses to be almost right', () => {
  it('throws on an organization id that is not a uuid', () => {
    // storage_object_organization returns null for this, null matches no
    // organization, and the upload dies as an unreadable permission error.
    // Failing here says what is actually wrong.
    expect(() =>
      objectPath({
        organizationId: 'not-a-uuid',
        propertyId: PROP,
        type: 'image/jpeg',
        unique: 'x',
      }),
    ).toThrow(InvalidPhotoTarget)
  })

  it('throws on a property id that is not a uuid', () => {
    expect(() =>
      objectPath({
        organizationId: ORG,
        propertyId: '../../etc',
        type: 'image/jpeg',
        unique: 'x',
      }),
    ).toThrow(InvalidPhotoTarget)
  })

  it('refuses a unique segment that would add a directory', () => {
    // `a/../b` would move the object out of its organization's folder, which
    // is the one thing the whole scheme rests on.
    expect(() =>
      objectPath({
        organizationId: ORG,
        propertyId: PROP,
        type: 'image/jpeg',
        unique: 'a/../b',
      }),
    ).toThrow(InvalidPhotoTarget)
  })

  it('refuses a blank unique segment', () => {
    expect(() =>
      objectPath({
        organizationId: ORG,
        propertyId: PROP,
        type: 'image/jpeg',
        unique: '   ',
      }),
    ).toThrow(InvalidPhotoTarget)
  })

  it('always puts the organization first, because that is what the policy reads', () => {
    const path = objectPath({
      organizationId: ORG,
      propertyId: PROP,
      type: 'image/png',
      unique: 'k',
    })
    expect(path.split('/')[0]).toBe(ORG)
  })
})

describe('what a file has to be', () => {
  it('accepts an ordinary telephone photograph', () => {
    expect(checkPhoto({ type: 'image/jpeg', size: 3_500_000 })).toEqual([])
  })

  it('refuses a type that is not an image', () => {
    expect(checkPhoto({ type: 'application/pdf', size: 1000 })).toEqual([
      { kind: 'type', given: 'application/pdf' },
    ])
  })

  it('refuses a camera original that would crawl up a rural connection', () => {
    const problems = checkPhoto({
      type: 'image/jpeg',
      size: MAX_PHOTO_BYTES + 1,
    })
    expect(problems).toEqual([
      { kind: 'too_large', bytes: MAX_PHOTO_BYTES + 1 },
    ])
  })

  it('accepts a file sitting exactly on the limit', () => {
    expect(checkPhoto({ type: 'image/png', size: MAX_PHOTO_BYTES })).toEqual([])
  })

  it('reports every problem at once, not just the first', () => {
    // Somebody who picked a 30MB TIFF has two things to fix and should not
    // discover the second only after correcting the first.
    const problems = checkPhoto({ type: 'image/tiff', size: 30_000_000 })
    expect(problems.map((p) => p.kind).sort()).toEqual(['too_large', 'type'])
  })

  it('refuses an empty file rather than storing nothing', () => {
    expect(checkPhoto({ type: 'image/jpeg', size: 0 })).toEqual([
      { kind: 'empty' },
    ])
  })

  it('knows which types it allows', () => {
    expect(isPhotoType('image/jpeg')).toBe(true)
    expect(isPhotoType('image/gif')).toBe(false)
  })
})

describe('what the person reads', () => {
  it('says the size in megabytes rather than in bytes', () => {
    const message = photoProblemMessage({
      kind: 'too_large',
      bytes: 12_582_912,
    })
    expect(message).toContain('12')
    expect(message).toContain('8')
    expect(message).not.toContain('12582912')
  })

  it('names the formats that would work', () => {
    const message = photoProblemMessage({ kind: 'type', given: 'image/gif' })
    expect(message).toContain('JPG')
    expect(message).toContain('WebP')
  })
})
