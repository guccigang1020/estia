'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. One page's search metadata.
 *
 * ── The character counters are advice, not gates ─────────────────────────
 *
 * A 64-character title is not invalid; it is truncated by Google, which is a
 * different thing. So the counter says how long it is and what usually fits,
 * and the form saves it either way. A product that refuses to save somebody's
 * own title because of a rule it read on a blog is a product they stop using.
 *
 * ── `indexable` is a checkbox with a consequence, spelled out ────────────
 *
 * Turning it off is `noindex` on the live page, which the public route sets
 * from this exact column. Somebody switching it off should know that is what
 * happens, so the label says so.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Checkbox, TextInput, Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'
import type { SiteSeo } from '@/lib/website/types'

import { saveSeoAction } from '../_lib/actions'

export function SeoForm({
  siteId,
  pageId,
  pageTitle,
  pageSlug,
  seo,
}: {
  siteId: string
  pageId: string
  pageTitle: string
  pageSlug: string
  seo: SiteSeo | null
}) {
  const router = useRouter()

  const [metaTitle, setMetaTitle] = useState(seo?.metaTitle ?? '')
  const [metaDescription, setMetaDescription] = useState(
    seo?.metaDescription ?? '',
  )
  const [canonicalUrl, setCanonicalUrl] = useState(seo?.canonicalUrl ?? '')
  const [indexable, setIndexable] = useState(seo?.indexable !== false)

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    setSaved(false)

    const result = await saveSeoAction({
      siteId,
      pageId,
      metaTitle: metaTitle.trim() || null,
      metaDescription: metaDescription.trim() || null,
      canonicalUrl: canonicalUrl.trim() || null,
      indexable,
    })

    setPending(false)
    if (result.ok) {
      setSaved(true)
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          {pageTitle}
          <span className="ms-2 text-sm font-normal text-muted-foreground">
            /{pageSlug}
          </span>
        </CardTitle>
      </CardHeader>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
        <Field
          label="כותרת חיפוש"
          description={
            metaTitle.length > 0
              ? `${metaTitle.length} תווים. גוגל מציג בערך 60.`
              : 'בלי זה גוגל יבחר טקסט בעצמו.'
          }
        >
          <TextInput
            value={metaTitle}
            onChange={(event) => setMetaTitle(event.target.value)}
            maxLength={200}
          />
        </Field>

        <Field
          label="תיאור חיפוש"
          description={
            metaDescription.length > 0
              ? `${metaDescription.length} תווים. גוגל מציג בערך 155.`
              : 'המשפט שמופיע מתחת לכותרת בתוצאות.'
          }
        >
          <Textarea
            rows={2}
            value={metaDescription}
            onChange={(event) => setMetaDescription(event.target.value)}
            maxLength={500}
          />
        </Field>

        <Field
          label="כתובת קנונית"
          description="רק כתובת מלאה שמתחילה ב־https://. השאירו ריק אם אין כפילות."
        >
          <TextInput
            value={canonicalUrl}
            onChange={(event) => setCanonicalUrl(event.target.value)}
            dir="ltr"
            maxLength={500}
          />
        </Field>

        <Checkbox
          checked={indexable}
          onChange={(event) => setIndexable(event.target.checked)}
          label="לאפשר למנועי חיפוש להציג את העמוד"
          description="כיבוי מוסיף noindex לעמוד החי, והוא ייעלם מתוצאות החיפוש."
        />

        {error ? <ActionError error={error} /> : null}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending} className="self-start">
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
  )
}
