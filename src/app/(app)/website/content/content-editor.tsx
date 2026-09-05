'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. Adding a page, and adding a block.
 *
 * ── The form cannot express a fabricated fact ────────────────────────────
 *
 * A section form has two halves: a BINDING (which property or unit this block
 * shows) and AUTHORED text (what a person wants to say). There is no third
 * field where somebody types a sentence and picks "source: property" for it,
 * because that field is the shape a fabricated fact arrives in.
 *
 * When the section is saved, `saveSection` reads the bound row and produces
 * the canonical claims from its actual columns. So binding a `property_intro`
 * to a villa with no description produces a section with no description — and
 * that is correct, and the content quality pass reports it.
 *
 * ── Generation, with the generator this codebase ships ───────────────────
 *
 * The button is here and it works: it records the request, offers the model
 * the closed set of facts, and reports what came back. What comes back today
 * is a refusal, and the panel says so in one honest sentence rather than
 * spinning or showing a network error. Everything else on this screen works
 * with generation switched off — which is the whole design.
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
import { Select, TextInput, Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'
// Leaf modules only. The `@/lib/website` barrel reaches the repository and
// from there the postgres driver, which a client bundle cannot have.
import {
  SITE_PAGE_KIND_LABEL,
  SITE_SECTION_KIND_LABEL,
} from '@/lib/website/labels'
import { SITE_PAGE_KINDS, SITE_SECTION_KINDS } from '@/lib/website/types'

import { savePageAction, saveSectionAction } from '../_lib/actions'

type Option = { id: string; name: string }

export function ContentEditor({
  siteId,
  pages,
  properties,
  units,
}: {
  siteId: string
  pages: readonly { id: string; title: string; slug: string }[]
  properties: readonly Option[]
  units: readonly Option[]
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <NewPage
        siteId={siteId}
        hasHome={pages.some((page) => page.slug === '')}
      />
      {pages.length > 0 ? (
        <NewSection
          siteId={siteId}
          pages={pages}
          properties={properties}
          units={units}
        />
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- a page -- */

function NewPage({ siteId, hasHome }: { siteId: string; hasHome: boolean }) {
  const router = useRouter()

  const [title, setTitle] = useState('')
  // The home page is the empty slug, and a site without one shows nothing at
  // its root. So the first page defaults to being it.
  const [slug, setSlug] = useState(hasHome ? '' : '')
  const [kind, setKind] = useState<string>(hasHome ? 'custom' : 'home')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const result = await savePageAction({
      siteId,
      slug: slug.trim().toLowerCase(),
      kind: kind as (typeof SITE_PAGE_KINDS)[number],
      title: title.trim(),
      navLabel: null,
      showInNav: true,
      sortOrder: hasHome ? 10 : 0,
    })

    setPending(false)
    if (result.ok) {
      setTitle('')
      setSlug('')
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">עמוד חדש</CardTitle>
        <CardDescription>
          {hasHome
            ? 'עמוד נוסף באתר, למשל ״היחידות״ או ״צרו קשר״.'
            : 'התחילו בעמוד הבית. בלעדיו מבקר שיגיע לכתובת הראשית לא יראה דבר.'}
        </CardDescription>
      </CardHeader>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
        <Field label="כותרת">
          <TextInput
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            minLength={2}
          />
        </Field>

        <Field label="סוג העמוד">
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            {SITE_PAGE_KINDS.map((option) => (
              <option key={option} value={option}>
                {SITE_PAGE_KIND_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="כתובת בתוך האתר"
          description={
            hasHome
              ? 'למשל units. הכתובת book שמורה לטופס ההזמנה.'
              : 'השאירו ריק כדי שזה יהיה עמוד הבית.'
          }
        >
          <TextInput
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            dir="ltr"
            maxLength={64}
          />
        </Field>

        {error ? <ActionError error={error} /> : null}

        <Button type="submit" disabled={pending} className="self-start">
          {pending ? 'שומר…' : 'הוספת עמוד'}
        </Button>
      </form>
    </Card>
  )
}

/* -------------------------------------------------------------- a section -- */

function NewSection({
  siteId,
  pages,
  properties,
  units,
}: {
  siteId: string
  pages: readonly { id: string; title: string }[]
  properties: readonly Option[]
  units: readonly Option[]
}) {
  const router = useRouter()

  const [pageId, setPageId] = useState(pages[0]?.id ?? '')
  const [kind, setKind] = useState<string>('hero')
  const [boundSource, setBoundSource] = useState<'' | 'property' | 'unit'>('')
  const [boundId, setBoundId] = useState('')
  const [heading, setHeading] = useState('')
  const [body, setBody] = useState('')

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  const rows = boundSource === 'property' ? properties : units

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)

    // Only what a person typed travels as a claim. The facts come from the
    // bound row, server-side, when the section is saved.
    const authoredClaims: { key: string; text: string }[] = []
    if (heading.trim())
      authoredClaims.push({ key: 'heading', text: heading.trim() })
    if (body.trim()) authoredClaims.push({ key: 'body', text: body.trim() })

    const result = await saveSectionAction({
      siteId,
      pageId,
      kind: kind as (typeof SITE_SECTION_KINDS)[number],
      sortOrder: 0,
      boundSource: boundSource === '' ? null : boundSource,
      boundId: boundSource === '' ? null : boundId || null,
      authoredClaims,
    })

    setPending(false)
    if (result.ok) {
      setHeading('')
      setBody('')
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">מקטע חדש</CardTitle>
        <CardDescription>
          מקטע ששייכתם לנכס או ליחידה יתמלא מהנתונים שלכם. מה שתכתבו כאן יירשם
          על שמכם.
        </CardDescription>
      </CardHeader>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
        <Field label="באיזה עמוד">
          <Select
            value={pageId}
            onChange={(event) => setPageId(event.target.value)}
          >
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.title}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="סוג המקטע">
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            {SITE_SECTION_KINDS.map((option) => (
              <option key={option} value={option}>
                {SITE_SECTION_KIND_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="משויך ל"
          description="המקטע יציג את מה שכתוב בשורה הזו במערכת. אין דרך להזין כאן עובדה שלא מופיעה שם."
        >
          <Select
            value={boundSource}
            onChange={(event) => {
              setBoundSource(event.target.value as '' | 'property' | 'unit')
              setBoundId('')
            }}
          >
            <option value="">ללא שיוך — טקסט חופשי בלבד</option>
            <option value="property">נכס</option>
            <option value="unit">יחידה</option>
          </Select>
        </Field>

        {boundSource !== '' ? (
          <Field label={boundSource === 'property' ? 'איזה נכס' : 'איזו יחידה'}>
            <Select
              value={boundId}
              onChange={(event) => setBoundId(event.target.value)}
              required
            >
              <option value="">בחרו</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field label="כותרת (לא חובה)">
          <TextInput
            value={heading}
            onChange={(event) => setHeading(event.target.value)}
            maxLength={200}
          />
        </Field>

        <Field
          label="טקסט (לא חובה)"
          description="מה שתכתבו כאן יופיע כטקסט שלכם, עם שמכם כמקור."
        >
          <Textarea
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={5000}
          />
        </Field>

        {error ? <ActionError error={error} /> : null}

        <Button type="submit" disabled={pending} className="self-start">
          {pending ? 'שומר…' : 'הוספת מקטע'}
        </Button>
      </form>
    </Card>
  )
}
