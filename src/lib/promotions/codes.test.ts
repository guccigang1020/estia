import { describe, expect, it } from 'vitest'

import {
  COUPON_CODE_PATTERN,
  PROMOTION_CODE_PATTERN,
  codesMatch,
  foldCode,
  isCouponCode,
  isPromotionCode,
} from './codes'

describe('a guest typing a code in the wrong case still finds the coupon', () => {
  it('matches summer25 to SUMMER25', () => {
    expect(codesMatch('summer25', 'SUMMER25')).toBe(true)
  })

  it('matches a code the guest typed with the space a phone added', () => {
    expect(codesMatch(' summer25 ', 'SUMMER25')).toBe(true)
  })

  it('does not match two codes that genuinely differ', () => {
    expect(codesMatch('summer25', 'summer26')).toBe(false)
  })

  it('folds to exactly what upper(btrim(code)) produces in 0073', () => {
    // If these two ever disagree, a lookup on code_folded misses rows the
    // database considers duplicates — the one failure this fold exists to
    // prevent, and the one nothing else in the suite would catch.
    expect(foldCode('  summer25  ')).toBe('SUMMER25')
    expect(foldCode('SUMMER25')).toBe('SUMMER25')
    expect(foldCode('Summer-25')).toBe('SUMMER-25')
  })

  it('leaves a code that is already folded untouched', () => {
    expect(foldCode(foldCode('summer25'))).toBe(foldCode('summer25'))
  })
})

describe('a promotion code is a machine identifier and a coupon code is typed', () => {
  it('accepts a lower-case promotion code', () => {
    expect(isPromotionCode('direct-booking_5')).toBe(true)
  })

  it('refuses an upper-case promotion code, which no guest ever types', () => {
    expect(isPromotionCode('DIRECT')).toBe(false)
  })

  it('refuses a promotion code that starts with punctuation', () => {
    expect(isPromotionCode('-direct')).toBe(false)
  })

  it('refuses a single-character promotion code', () => {
    expect(isPromotionCode('a')).toBe(false)
  })

  it('refuses a promotion code past forty characters', () => {
    expect(isPromotionCode('a'.repeat(41))).toBe(false)
    expect(isPromotionCode('a'.repeat(40))).toBe(true)
  })

  it('accepts a coupon code in either case, because the fold is what compares', () => {
    expect(isCouponCode('SUMMER25')).toBe(true)
    expect(isCouponCode('summer25')).toBe(true)
    expect(isCouponCode('Summer-25')).toBe(true)
  })

  it('refuses a coupon code short enough to be guessed', () => {
    expect(isCouponCode('A1B')).toBe(false)
    expect(isCouponCode('A1B2')).toBe(true)
  })

  it('refuses a coupon code with characters a keypad cannot produce', () => {
    expect(isCouponCode('קיץ25')).toBe(false)
    expect(isCouponCode('SUMMER 25')).toBe(false)
    expect(isCouponCode('SUMMER_25')).toBe(false)
  })

  it('matches the patterns the CHECK constraints in 0073 enforce', () => {
    // Transcribed deliberately: the constraint and the regex are one rule in
    // two languages, and a divergence shows as a row the product accepts and
    // the database refuses.
    expect(PROMOTION_CODE_PATTERN.source).toBe('^[a-z0-9][a-z0-9_-]{1,39}$')
    expect(COUPON_CODE_PATTERN.source).toBe('^[A-Za-z0-9-]{4,24}$')
  })
})
