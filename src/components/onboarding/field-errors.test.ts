import { describe, expect, it } from 'vitest'

import {
  NO_FIELD_ERRORS,
  fieldErrorsFrom,
  fieldErrorsFromIssues,
} from './field-errors'

import type { SafeErrorBody } from '@/lib/errors/safe-response'

const body = (fields?: SafeErrorBody['fields']): SafeErrorBody => ({
  code: 'validation_failed',
  message: 'שדה אחד אינו תקין. תקן אותו ונסה שוב.',
  dataMessage: 'השינוי שלך לא נשמר.',
  retryMessage: 'תקן את השדה ונסה שוב.',
  dataOutcome: 'not_saved',
  retryable: false,
  correlationId: 'test',
  fields,
})

describe('fieldErrorsFrom', () => {
  it('indexes each issue by the control it belongs to', () => {
    expect(
      fieldErrorsFrom(
        body([
          { field: 'name', code: 'required', message: 'יש להזין שם עסק.' },
          { field: 'slug', code: 'format', message: 'הכתובת אינה תקינה.' },
        ]),
      ),
    ).toEqual({
      name: 'יש להזין שם עסק.',
      slug: 'הכתובת אינה תקינה.',
    })
  })

  it('keeps the first issue for a field and drops the rest', () => {
    // Two complaints about one input have one root cause; stacking both under
    // a single control reads as noise.
    expect(
      fieldErrorsFrom(
        body([
          { field: 'slug', code: 'length', message: 'קצר מדי.' },
          { field: 'slug', code: 'format', message: 'תווים לא חוקיים.' },
        ]),
      ),
    ).toEqual({ slug: 'קצר מדי.' })
  })

  it('answers with nothing for an error that carries no fields', () => {
    expect(fieldErrorsFrom(body())).toBe(NO_FIELD_ERRORS)
    expect(fieldErrorsFrom(body([]))).toBe(NO_FIELD_ERRORS)
    expect(fieldErrorsFrom(null)).toBe(NO_FIELD_ERRORS)
    expect(fieldErrorsFrom(undefined)).toBe(NO_FIELD_ERRORS)
  })

  it('keeps a field named like an Object prototype member', () => {
    // `'constructor' in {}` is TRUE — the operator walks the prototype chain —
    // so a presence check written with `in` would drop this message entirely
    // and leave the control with no explanation at all.
    expect(
      fieldErrorsFrom(
        body([
          { field: 'constructor', code: 'invalid', message: 'לא תקין.' },
          { field: 'toString', code: 'required', message: 'חסר.' },
        ]),
      ),
    ).toEqual({ constructor: 'לא תקין.', toString: 'חסר.' })
  })
})

describe('fieldErrorsFromIssues', () => {
  it('produces the same shape from the client-side validators', () => {
    expect(
      fieldErrorsFromIssues([
        { field: 'capacity', message: 'תפוסה מרבית חייבת להיות מספר שלם.' },
      ]),
    ).toEqual({ capacity: 'תפוסה מרבית חייבת להיות מספר שלם.' })
  })

  it('answers with nothing for an empty list', () => {
    expect(fieldErrorsFromIssues([])).toBe(NO_FIELD_ERRORS)
  })
})
