'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. Four closed choices.
 *
 * Every option is a member of a tuple in `src/lib/website/types.ts`, and every
 * colour behind it is a literal in `design.ts`. There is no free-text field on
 * this form, deliberately: a published site is served to strangers and a
 * stored string that reaches a stylesheet is the shape of an injection.
 *
 * The swatch previews are built from the same token names the public renderer
 * uses, so what somebody sees here is what the site will be — not an
 * approximation maintained separately, which is how a preview starts lying.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'
// Leaf modules, never the barrel — it reaches the postgres driver.
import {
  DENSITY_LABEL,
  FONT_LABEL,
  PALETTE_LABEL,
  RADIUS_LABEL,
} from '@/lib/website/labels'
import {
  SITE_DENSITIES,
  SITE_HEADING_FONTS,
  SITE_PALETTES,
  SITE_RADII,
  cssVariables,
} from '@/lib/website/design'
import type { SiteDesign } from '@/lib/website/types'

import { saveDesignAction } from '../_lib/actions'

export function DesignForm({
  siteId,
  design,
}: {
  siteId: string
  design: SiteDesign
}) {
  const router = useRouter()

  const [draft, setDraft] = useState<SiteDesign>(design)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)

  function set<K extends keyof SiteDesign>(key: K, value: SiteDesign[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const result = await saveDesignAction({
      siteId,
      palette: draft.palette,
      headingFont: draft.headingFont,
      radius: draft.radius,
      density: draft.density,
      logoMediaId: draft.logoMediaId,
    })

    setPending(false)
    if (result.ok) {
      setSaved(true)
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  const tokens = cssVariables(draft)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle as="h2">הבחירות</CardTitle>
        </CardHeader>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
          <Field
            label="ערכת צבעים"
            description="חמש ערכות סגורות. אין בורר צבע חופשי — צבע שנשמר כטקסט ומגיע לעמוד ציבורי הוא פתח לקוד זר."
          >
            <Select
              value={draft.palette}
              onChange={(event) =>
                set('palette', event.target.value as SiteDesign['palette'])
              }
            >
              {SITE_PALETTES.map((option) => (
                <option key={option} value={option}>
                  {PALETTE_LABEL[option]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="גופן כותרות">
            <Select
              value={draft.headingFont}
              onChange={(event) =>
                set(
                  'headingFont',
                  event.target.value as SiteDesign['headingFont'],
                )
              }
            >
              {SITE_HEADING_FONTS.map((option) => (
                <option key={option} value={option}>
                  {FONT_LABEL[option]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="פינות">
            <Select
              value={draft.radius}
              onChange={(event) =>
                set('radius', event.target.value as SiteDesign['radius'])
              }
            >
              {SITE_RADII.map((option) => (
                <option key={option} value={option}>
                  {RADIUS_LABEL[option]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="צפיפות">
            <Select
              value={draft.density}
              onChange={(event) =>
                set('density', event.target.value as SiteDesign['density'])
              }
            >
              {SITE_DENSITIES.map((option) => (
                <option key={option} value={option}>
                  {DENSITY_LABEL[option]}
                </option>
              ))}
            </Select>
          </Field>

          {error ? <ActionError error={error} /> : null}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'שומר…' : 'שמירה'}
            </Button>
            {saved ? (
              <span className="text-sm text-muted-foreground">
                נשמר. ייכנס לאוויר בפרסום הבא.
              </span>
            ) : null}
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">איך זה ייראה</CardTitle>
        </CardHeader>

        {/* The same tokens the public renderer uses, so this is the site and
            not an approximation kept in step by hand. */}
        <div
          dir="rtl"
          style={{
            ...tokens,
            background: 'var(--site-bg)',
            color: 'var(--site-ink)',
            borderRadius: 'var(--site-radius)',
          }}
          className="mt-4 flex flex-col gap-4 border border-border p-6"
        >
          <p
            style={{ fontFamily: 'var(--site-heading-font)' }}
            className="text-2xl font-bold"
          >
            אחוזת הגליל
          </p>
          <p style={{ color: 'var(--site-muted)' }} className="text-sm">
            כך ייראו טקסט משני, קישורים והכפתור הראשי באתר שלכם.
          </p>
          <span
            style={{
              background: 'var(--site-accent)',
              color: 'var(--site-accent-ink)',
              borderRadius: 'var(--site-radius)',
            }}
            className="self-start px-4 py-2 text-sm font-semibold"
          >
            בדיקת זמינות
          </span>
        </div>
      </Card>
    </div>
  )
}
