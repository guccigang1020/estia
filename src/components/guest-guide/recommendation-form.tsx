'use client'

/**
 * ADDING A LOCAL RECOMMENDATION. §44 AT THE FORM.
 *
 * ══ THERE IS NO "SUGGEST FOR ME" BUTTON, AND THERE WILL NOT BE ═════════════
 *
 * §44 says a recommendation must never be produced by a model without a
 * verified source. So the source is not an optional extra field at the bottom
 * — it is the first decision the form asks for, and the submit button is
 * disabled until it has an answer.
 *
 * Two answers, and no third:
 *
 *   · בית האירוח ממליץ — this business is vouching. The person's user id is
 *     stamped by the Server Action, not by this form, so nobody can claim a
 *     colleague vouched for a restaurant they have never eaten at.
 *   · לפי גורם חיצוני — somebody else said it, and their name is required
 *     and travels with the recommendation to the guest.
 *
 * `RecommendationSource` has exactly these two members, so a third could not
 * be posted even by a crafted request: `readSource` refuses anything it does
 * not recognise, and the CHECK the schema proposal asks for refuses it again.
 *
 * ── The distance field says "as you walked it" ────────────────────────────
 *
 * On purpose. Nothing computes this number, and a form that implied otherwise
 * would be inviting somebody to guess.
 */

import { useState } from 'react'

import { addGuideRecommendationAction } from '@/app/(app)/settings/guest-guide/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { CATEGORY_LABEL } from '@/lib/guest-guide/labels'
import {
  RECOMMENDATION_CATEGORIES,
  type RecommendationCategory,
} from '@/lib/guest-guide/types'

type SourceChoice = '' | 'business' | 'named'

export function RecommendationForm({
  propertyId,
  onAdded,
}: {
  propertyId: string
  onAdded?: () => void
}) {
  const [category, setCategory] = useState<RecommendationCategory>('restaurant')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [url, setUrl] = useState('')
  const [minutesAway, setMinutesAway] = useState('')
  const [sourceKind, setSourceKind] = useState<SourceChoice>('')
  const [sourceName, setSourceName] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [added, setAdded] = useState(false)
  const add = useAsyncAction<void>()

  // The source gates the button. See the header: this is §44, not a nicety.
  const sourceMissing =
    sourceKind === '' ||
    (sourceKind === 'named' && sourceName.trim().length === 0)
  const blocked = name.trim().length === 0 || sourceMissing

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        // `blocked` already covers an unchosen source, and the compiler knows
        // it — narrowing `sourceKind` to the two real members past this line.
        if (blocked || add.pending) return

        setFailure(null)
        setAdded(false)

        void add.run(async () => {
          const result = await addGuideRecommendationAction({
            propertyId,
            category,
            name: { he: name.trim() },
            description:
              description.trim().length === 0
                ? null
                : { he: description.trim() },
            address:
              address.trim().length === 0 ? null : { he: address.trim() },
            phone: phone.trim().length === 0 ? null : phone.trim(),
            url: url.trim().length === 0 ? null : url.trim(),
            minutesAway:
              minutesAway.trim().length === 0 ? null : Number(minutesAway),
            sourceKind,
            sourceName: sourceKind === 'named' ? sourceName.trim() : null,
            sourceUrl:
              sourceKind === 'named' && sourceUrl.trim().length > 0
                ? sourceUrl.trim()
                : null,
            sortOrder: 0,
            idempotencyKey: crypto.randomUUID(),
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          setName('')
          setDescription('')
          setAddress('')
          setPhone('')
          setUrl('')
          setMinutesAway('')
          setAdded(true)
          onAdded?.()
        })
      }}
    >
      {failure && <ActionError error={failure} />}

      {/* First, not last. The source is the decision, not the footnote. */}
      <Field
        label="מי ממליץ"
        required
        description="כל המלצה נושאת מקור. אין דרך להוסיף המלצה בלי אחד מהשניים."
        error={sourceKind === '' ? 'בחר מקור' : undefined}
      >
        <Select
          value={sourceKind}
          onChange={(event) =>
            setSourceKind(event.target.value as SourceChoice)
          }
        >
          <option value="">בחר…</option>
          <option value="business">בית האירוח ממליץ</option>
          <option value="named">לפי גורם חיצוני ששמו יופיע</option>
        </Select>
      </Field>

      {sourceKind === 'named' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="שם הגורם"
            required
            description="יוצג לאורח לצד ההמלצה."
            error={sourceName.trim().length === 0 ? 'שדה חובה' : undefined}
          >
            <TextInput
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
              maxLength={200}
            />
          </Field>

          <Field label="קישור למקור" description="https:// בלבד. אופציונלי.">
            <TextInput
              dir="ltr"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              maxLength={2000}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="קטגוריה" required>
          <Select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as RecommendationCategory)
            }
          >
            {RECOMMENDATION_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="שם המקום" required>
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
          />
        </Field>
      </div>

      <Field label="למה כדאי">
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          maxLength={2000}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="כתובת">
          <TextInput
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            maxLength={300}
          />
        </Field>

        <Field label="טלפון">
          <TextInput
            dir="ltr"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            maxLength={40}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="קישור" description="https:// או נתיב פנימי בלבד.">
          <TextInput
            dir="ltr"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            maxLength={2000}
          />
        </Field>

        <Field
          label="דקות נסיעה"
          description="כפי שאתם מכירים את הדרך. שום דבר לא מחשב את זה."
        >
          <TextInput
            type="number"
            min={0}
            max={600}
            value={minutesAway}
            onChange={(event) => setMinutesAway(event.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={blocked || add.pending}>
          {add.pending ? 'מוסיף…' : 'הוסף המלצה'}
        </Button>
        {added && (
          <span className="text-sm text-muted-foreground">
            נוספה. תופיע לאורחים אחרי פרסום.
          </span>
        )}
      </div>
    </form>
  )
}
