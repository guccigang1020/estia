'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. Claiming a hostname.
 *
 * One field, and it is deliberately strict: a bare hostname, no scheme and no
 * path. `https://Www.Villa.co.il/` is refused rather than normalised, because
 * a business that typed a URL should be told what the field wants — silently
 * turning their input into something else is how somebody ends up with a
 * domain record they did not intend and cannot explain.
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
import { TextInput } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'

import { addDomainAction } from '../_lib/actions'

export function DomainForm({ siteId }: { siteId: string }) {
  const router = useRouter()

  const [hostname, setHostname] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const result = await addDomainAction({
      siteId,
      hostname: hostname.trim().toLowerCase(),
    })

    setPending(false)
    if (result.ok) {
      setHostname('')
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">חיבור דומיין</CardTitle>
        <CardDescription>
          אחרי ההוספה תקבלו ערך לרשומת TXT שיש להוסיף אצל ספק הדומיין שלכם.
        </CardDescription>
      </CardHeader>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
        <Field
          label="שם הדומיין"
          description="שם בלבד, למשל villa.co.il — בלי https:// ובלי נתיב אחריו."
        >
          <TextInput
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            dir="ltr"
            required
            minLength={4}
            maxLength={253}
            placeholder="villa.co.il"
          />
        </Field>

        {error ? <ActionError error={error} /> : null}

        <Button type="submit" disabled={pending} className="self-start">
          {pending ? 'מוסיף…' : 'הוספת דומיין'}
        </Button>
      </form>
    </Card>
  )
}
