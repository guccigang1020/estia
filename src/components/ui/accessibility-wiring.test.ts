/**
 * Accessibility wiring, proven against real rendered markup.
 *
 * The failure this guards is specifically invisible: an `aria-describedby` that
 * points at an id which does not exist, or a `<label>` whose `for` misses its
 * control, looks perfect in a screenshot and type-checks cleanly. Only the
 * output shows it.
 *
 * It fits the suite's `environment: 'node'` as written — nothing here touches a
 * DOM. `renderToStaticMarkup` returns a string; no effects, layout or events
 * are involved, so neither jsdom nor a testing library is needed.
 * `createElement` rather than JSX because the include pattern is
 * `src/**\/*.test.ts`.
 */

import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { describeError, technicalDetail } from '../states/error-copy'
import { ErrorState } from '../states/error-state'
import { ModuleEmptyState } from '../states/empty-state'
import { PageSkeleton } from '../states/skeleton'
import { Field } from './field'
import { Checkbox, Select, TextInput } from './input'

function idOfAttr(html: string, attr: string): string | null {
  const match = html.match(new RegExp(`${attr}="([^"]+)"`))
  return match ? match[1] : null
}

/** The control's id, read off the label rather than off the first `id=` seen. */
function labelTarget(html: string): string | null {
  return idOfAttr(html, 'for')
}

describe('field wiring', () => {
  it('points label, description and error at the real control', () => {
    const html = renderToStaticMarkup(
      // `children` goes in the props object: `createElement`'s trailing-child
      // overload does not satisfy a props type that declares it required.
      h(Field, {
        label: 'שם האורח',
        description: 'כפי שמופיע בתעודת הזהות',
        error: 'שדה חובה',
        required: true,
        children: h(TextInput, { name: 'guest' }),
      }),
    )

    const controlId = labelTarget(html)
    expect(controlId).toBeTruthy()
    expect(html).toContain(`id="${controlId}" aria-describedby=`)
    expect(html).toContain(`for="${controlId}"`)

    const describedBy = idOfAttr(html, 'aria-describedby')
    expect(describedBy).toBe(`${controlId}-description ${controlId}-error`)
    expect(html).toContain(`id="${controlId}-description"`)
    expect(html).toContain(`id="${controlId}-error"`)

    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('required')
  })

  it('omits the error id from aria-describedby when the field is valid', () => {
    const html = renderToStaticMarkup(
      h(Field, {
        label: 'הערות',
        description: 'לא חובה',
        children: h(TextInput, { name: 'notes' }),
      }),
    )

    const controlId = labelTarget(html)
    expect(idOfAttr(html, 'aria-describedby')).toBe(`${controlId}-description`)
    expect(html).not.toContain('aria-invalid')
  })

  it('labels a select and a checkbox without a wrapper', () => {
    const select = renderToStaticMarkup(
      h(Field, {
        label: 'יחידה',
        children: h(
          Select,
          { name: 'unit' },
          h('option', { value: 'a' }, 'וילה'),
        ),
      }),
    )
    expect(select).toContain(`id="${labelTarget(select)}"`)

    const checkbox = renderToStaticMarkup(
      h(Checkbox, {
        name: 'terms',
        label: 'אני מאשר את התנאים',
        error: 'חובה לאשר',
      }),
    )
    const boxId = labelTarget(checkbox)
    expect(checkbox).toContain(`for="${boxId}"`)
    expect(checkbox).toContain(`id="${boxId}-error"`)
    expect(checkbox).toContain('aria-invalid="true"')
  })
})

describe('state components render', () => {
  it('renders an error without leaking a stack trace', () => {
    const cause = new Error('Failed to insert booking')
    cause.stack = 'Error\n    at createBooking (/app/src/lib/bookings.ts:41:11)'

    const html = renderToStaticMarkup(
      h(ErrorState, {
        presentation: describeError({ kind: 'timeout', operation: 'לשמור' }),
        detail: technicalDetail(cause, 'abc123'),
      }),
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('<details')
    expect(html).toContain('פרטים טכניים')
    expect(html).not.toContain('at createBooking')
  })

  it('renders both empty variants', () => {
    const first = renderToStaticMarkup(
      h(ModuleEmptyState, { module: 'bookings', reason: 'no_data' }),
    )
    const filtered = renderToStaticMarkup(
      h(ModuleEmptyState, { module: 'bookings', reason: 'no_results' }),
    )

    expect(first).toContain('<svg')
    expect(first).toContain('עוד אין הזמנות ביומן')
    expect(filtered).toContain('שתואמות לסינון')
  })

  it('renders the page skeleton with exactly one status region', () => {
    const html = renderToStaticMarkup(h(PageSkeleton, {}))

    expect(html.match(/role="status"/g)?.length).toBe(1)
    expect(html).toContain('aria-hidden="true"')
  })
})
