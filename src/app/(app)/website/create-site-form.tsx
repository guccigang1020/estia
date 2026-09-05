'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. The first step, and only the first.
 *
 * Three fields. A name, a public address, and which property this site is for.
 * Everything else the module can do — pages, sections, design, SEO, a domain —
 * is configurable and none of it belongs on the screen where somebody is
 * creating their first website. A form that demanded a colour palette before
 * it would accept a name is a form nobody finishes.
 *
 * ── The property choice, and why it is here rather than later ────────────
 *
 * Because it decides which units the published site may ever quote. A site
 * bound to one property cannot sell the other one's rooms — `buildSnapshot`
 * enforces that — and moving the choice later would mean a business could
 * publish a site that sells the wrong house before anybody noticed.
 *
 * ── Leaf imports only ───────────────────────────────────────────────────
 *
 * Nothing here imports `@/lib/website`. The barrel reaches the repository and
 * from there the `postgres` driver, and a client component importing it asks
 * the bundler for `node:fs` in the browser. The action is a server action and
 * that boundary is what keeps this file small.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'

import { createSiteAction } from './_lib/actions'

export function CreateSiteForm({
  properties,
}: {
  properties: readonly { id: string; name: string }[]
}) {
  const router = useRouter()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const result = await createSiteAction({
      name: name.trim(),
      slug: slug.trim().toLowerCase(),
      propertyId: propertyId === '' ? null : propertyId,
    })

    setPending(false)
    if (result.ok) router.refresh()
    else setError(result.error)
  }

  return (
    <Card tone="featured">
      <CardHeader>
        <CardTitle as="h2">עוד אין לכם אתר</CardTitle>
        <CardDescription>
          האתר נבנה מהנתונים שכבר יש לכם — שמות הנכסים, היחידות, המתקנים
          והמחירים. שום דבר לא נכתב מחדש ושום דבר לא מומצא.
        </CardDescription>
      </CardHeader>

      <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
        <Field
          label="שם האתר"
          description="מה שיופיע בראש הדף ובלשונית הדפדפן."
        >
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
            maxLength={200}
          />
        </Field>

        <Field
          label="כתובת"
          description="הכתובת הפומבית: /s/הכתובת-שלכם. אותיות לטיניות קטנות, ספרות ומקפים, וייחודית בכל המערכת."
        >
          <TextInput
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            required
            minLength={3}
            maxLength={64}
            dir="ltr"
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          />
        </Field>

        <Field
          label="נכס"
          description="אתר שמשויך לנכס יוכל להציע להזמנה רק את היחידות שלו. השאירו ריק כדי להציג את כל העסק."
        >
          <Select
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
          >
            <option value="">כל הנכסים</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </Select>
        </Field>

        {error ? <ActionError error={error} /> : null}

        <Button type="submit" disabled={pending} className="self-start">
          {pending ? 'יוצר…' : 'יצירת האתר'}
        </Button>

        <p className="text-xs text-muted-foreground">
          האתר נוצר כטיוטה. אף אחד מחוץ לעסק לא יראה אותו עד שמישהו עם הרשאת
          פרסום יעלה אותו לאוויר.
        </p>
      </form>
    </Card>
  )
}
