'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. Adding the first thing you sell.
 *
 * ── Why this is the whole form ───────────────────────────────────────────
 *
 * Six fields, and every one of them is a thing an owner already knows about
 * their own product. Options, add-ons, availability rules, property overrides
 * and the operational recipe are all real and all configurable — and none of
 * them belongs on the screen where somebody is trying to write down "שולחן
 * שוק, ₪1,500" for the first time. A form that demanded a fulfilment recipe
 * before it would accept a product is a form nobody finishes.
 *
 * ── The idempotency key is minted once per form, not per click ───────────
 *
 * `useRef` rather than a value computed in the handler: a key regenerated on
 * every render would make the pipeline's replay protection useless, which is
 * the exact failure the key exists to prevent, dressed as correctness.
 */

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { SafeErrorBody } from '@/lib/errors'
// A leaf module, never the `@/lib/store` barrel: the barrel reaches the
// repository and from there the `postgres` driver, and a client component
// importing it asks the bundler for `node:fs` in the browser. See the longer
// note in `settings/settings-form.tsx`.
import {
  STORE_ITEM_TYPE_LABEL,
  STORE_PRICING_MODEL_LABEL,
} from '@/lib/store/labels'
import { STORE_ITEM_TYPES, STORE_PRICING_MODELS } from '@/lib/contracts/states'

import { createProductAction } from '../_lib/actions'

export function NewProductForm({
  defaultItemType,
}: {
  defaultItemType: (typeof STORE_ITEM_TYPES)[number]
}) {
  const router = useRouter()
  const idempotencyKey = useRef(crypto.randomUUID())

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [itemType, setItemType] = useState<string>(defaultItemType)
  const [pricingModel, setPricingModel] = useState<string>('fixed')
  const [priceShekels, setPriceShekels] = useState('')
  const [shortDescription, setShortDescription] = useState('')
  const [leadTimeHours, setLeadTimeHours] = useState('0')

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // `quote` is a real answer and not a missing price, so the price field is
  // ABSENT for it rather than disabled — the same argument `mode.ts` makes
  // about supplier vocabulary.
  const wantsPrice = pricingModel !== 'quote'

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    setPending(true)
    setError(null)
    setSaved(null)

    const result = await createProductAction({
      name,
      slug,
      itemType,
      pricingModel,
      priceShekels: wantsPrice ? priceShekels : '',
      shortDescription,
      leadTimeHours,
      idempotencyKey: idempotencyKey.current,
    })

    setPending(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    setSaved(result.data.name)
    setName('')
    setSlug('')
    setPriceShekels('')
    setShortDescription('')
    // A fresh key for the next product. The old one now names a product that
    // exists, and reusing it would replay that creation instead of making one.
    idempotencyKey.current = crypto.randomUUID()
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">הוספת פריט</CardTitle>
      </CardHeader>

      <p className="mt-2 text-sm text-muted-foreground">
        הפריט נשמר כטיוטה. הוא יופיע לאורחים רק אחרי שתפעילו אותו.
      </p>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="שם" required>
            <TextInput
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              placeholder="שולחן שוק"
              required
              minLength={2}
            />
          </Field>

          <Field
            label="מזהה"
            description="אותיות לטיניות קטנות, ספרות ומקפים. מופיע בכתובת."
            required
          >
            <TextInput
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value)
              }}
              placeholder="market-table"
              pattern="[a-z0-9][a-z0-9_\-]*"
              required
              dir="ltr"
            />
          </Field>

          <Field label="סוג">
            <Select
              value={itemType}
              onChange={(event) => {
                setItemType(event.target.value)
              }}
            >
              {STORE_ITEM_TYPES.filter((type) => type !== 'package').map(
                (type) => (
                  <option key={type} value={type}>
                    {STORE_ITEM_TYPE_LABEL[type]}
                  </option>
                ),
              )}
            </Select>
          </Field>

          <Field label="אופן התמחור">
            <Select
              value={pricingModel}
              onChange={(event) => {
                setPricingModel(event.target.value)
              }}
            >
              {STORE_PRICING_MODELS.map((model) => (
                <option key={model} value={model}>
                  {STORE_PRICING_MODEL_LABEL[model]}
                </option>
              ))}
            </Select>
          </Field>

          {wantsPrice && (
            <Field
              label="מחיר בשקלים"
              description="1500 או 1500.50. לא אגורות."
              required
            >
              <TextInput
                value={priceShekels}
                onChange={(event) => {
                  setPriceShekels(event.target.value)
                }}
                inputMode="decimal"
                placeholder="1500"
                required
                dir="ltr"
              />
            </Field>
          )}

          <Field
            label="זמן התראה בשעות"
            description="כמה זמן מראש צריך לבקש. 0 אם אפשר מיד."
          >
            <TextInput
              value={leadTimeHours}
              onChange={(event) => {
                setLeadTimeHours(event.target.value)
              }}
              inputMode="numeric"
              dir="ltr"
            />
          </Field>
        </div>

        <Field label="תיאור קצר" description="מה האורח רואה על הכרטיס.">
          <TextInput
            value={shortDescription}
            onChange={(event) => {
              setShortDescription(event.target.value)
            }}
            placeholder="שולחן עמוס בטוב של האזור, מחכה לכם בכניסה."
            maxLength={300}
          />
        </Field>

        {error && <ActionError error={error} />}

        {saved && (
          <p role="status" className="text-sm text-foreground">
            ״{saved}״ נשמר כטיוטה. אפשר להוסיף עוד פריט.
          </p>
        )}

        {/* `Button` rather than `SubmitButton`: the latter reads
            `useFormStatus`, which only reports for a form driven by a Server
            Function `action`. This form submits through `onSubmit` so it can
            keep the created product's name on screen, so the pending state is
            this component's own. */}
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? 'שומר…' : 'שמירה'}
        </Button>
      </form>
    </Card>
  )
}
