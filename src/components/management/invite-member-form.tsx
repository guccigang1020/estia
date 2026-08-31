'use client'

/**
 * The invitation form — and, above all, what the invitation will actually do.
 *
 * ── Why this is interactive at all ────────────────────────────────────────
 *
 * Everything else in this section is a server component, because everything
 * else only reads. This one has a genuine reason: choosing a role has to
 * change what the screen says about that role *before* the invitation is sent,
 * and the whole failure mode this form exists to prevent is somebody picking
 * "מנהל כללי" from a dropdown because it sounded about right and handing a new
 * employee the agent network, the commission rules and the export of every
 * guest record.
 *
 * So the preview is not decoration. It is the same derivation the roles screen
 * makes — `grantsForSystemRole` through `roleProfile` — computed on the server
 * and handed here as data, so that what this form promises is what `can()`
 * will answer. The sensitive actions are called out separately because those
 * are the ones `SENSITIVE_ACTIONS` says need a second factor, a reason or an
 * approval, and an owner should see them before rather than after.
 *
 * ── Why the submit is disabled ────────────────────────────────────────────
 *
 * There is no operation behind it, and this component does not pretend there
 * is. `public.invitations` requires a `token_hash` and an expiry — an
 * invitation is a capability URL, so creating one means minting a token,
 * hashing it, and delivering it — and no module in `src/lib` defines that
 * operation. Writing the row from a server action would skip the whole
 * `defineOperation` pipeline: authorization, validation, the transaction, the
 * audit event and idempotency, in that order. A screen that created a
 * membership with no audit row would contradict the audit screen shipped
 * beside it.
 *
 * The honest render is a form that is complete, that says exactly what it
 * would create, and that states what is missing. See the report accompanying
 * this work.
 */

import { useState } from 'react'

import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

import { Notice } from './notice'

/** One assignable role, with the consequence of choosing it. */
export type InvitableRole = {
  code: string
  name: string
  description: string | null
  grantCount: number
  /** Hebrew names of the grant families the role touches. */
  groupLabels: readonly string[]
  /** The grants `SENSITIVE_ACTIONS` marks, as their catalogue strings. */
  sensitive: readonly string[]
}

export type ScopeChoice = {
  id: string
  name: string
}

export type InviteMemberFormProps = {
  roles: readonly InvitableRole[]
  properties: readonly ScopeChoice[]
  teams: readonly ScopeChoice[]
}

const SCOPE_KINDS = [
  { value: 'all_organization', label: 'כל הארגון' },
  { value: 'properties', label: 'נכסים מסוימים' },
  { value: 'team', label: 'צוות מסוים' },
  { value: 'own_records', label: 'רק הרשומות שלו' },
] as const

export function InviteMemberForm({
  roles,
  properties,
  teams,
}: InviteMemberFormProps) {
  const [roleCode, setRoleCode] = useState(roles[0]?.code ?? '')
  const [scopeKind, setScopeKind] =
    useState<(typeof SCOPE_KINDS)[number]['value']>('all_organization')

  const role = roles.find((candidate) => candidate.code === roleCode) ?? null

  return (
    <form className="flex flex-col gap-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="כתובת דוא״ל"
          description="ההזמנה נשלחת לכתובת הזאת, והיא גם מה שיזהה את האדם כשייכנס."
          required
        >
          <TextInput
            name="email"
            type="email"
            dir="ltr"
            autoComplete="off"
            placeholder="name@example.co.il"
          />
        </Field>

        <Field
          label="תפקיד"
          description="תפקיד הוא שם על אוסף הרשאות. מה שהוא מקנה מוצג מתחת, לפני השליחה."
          required
        >
          <Select
            name="role"
            value={roleCode}
            onChange={(event) => setRoleCode(event.target.value)}
          >
            {roles.map((candidate) => (
              <option key={candidate.code} value={candidate.code}>
                {candidate.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="טווח"
          description="תפקיד אומר מה מותר; טווח אומר איפה. ״מנהל נכס״ חסר משמעות עד שנאמר באילו נכסים."
          required
        >
          <Select
            name="scopeKind"
            value={scopeKind}
            onChange={(event) =>
              setScopeKind(
                event.target.value as (typeof SCOPE_KINDS)[number]['value'],
              )
            }
          >
            {SCOPE_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </Select>
        </Field>

        {scopeKind === 'properties' && (
          <Field
            label="נכסים"
            description="בחירה מרובה. נכס שאינו נבחר פשוט אינו קיים מבחינת האדם הזה."
            required
          >
            <Select name="propertyIds" multiple className="h-auto min-h-24">
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {scopeKind === 'team' && (
          <Field
            label="צוות"
            description="משאב שאינו נושא צוות — נכס, הזמנה — יישאר מחוץ להישג ידו."
            required
          >
            <Select name="teamIds">
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <Field
        label="הודעה אישית"
        description="נשלחת עם ההזמנה. אינה משפיעה על ההרשאות."
      >
        <Textarea name="message" rows={3} />
      </Field>

      {role && <RolePreview role={role} scopeKind={scopeKind} />}

      <Notice title="הפעולה הזאת אינה קיימת עדיין במוצר" tone="strong">
        הטופס שלם, והכתיבה חסרה. הזמנה היא כתובת־יכולת:{' '}
        <code dir="ltr">public.invitations</code> דורשת{' '}
        <code dir="ltr">token_hash</code> ותאריך תפוגה, כלומר יצירת אסימון,
        גיבובו ומשלוחו — ואין ב-<code dir="ltr">src/lib</code> מודול שמגדיר את
        הפעולה הזאת. כתיבת השורה ישירות מכאן הייתה עוקפת את כל מה שעובר דרך{' '}
        <code dir="ltr">defineOperation</code>: הרשאה, ולידציה, טרנזקציה, רישום
        ביומן הביקורת ומניעת כפילות. חברות שנוצרת בלי שורה ביומן סותרת את מסך
        יומן הביקורת שנבנה לצידה, ולכן הכפתור מושבת ולא מסתיר את החוסר.
      </Notice>

      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled
          aria-describedby="invite-disabled-reason"
        >
          שליחת ההזמנה
        </Button>
        <p
          id="invite-disabled-reason"
          className="text-sm text-muted-foreground"
        >
          מושבת עד שתיווצר פעולת הזמנה בשכבת השירות.
        </p>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------- fragments -- */

/**
 * What the chosen role will actually grant, before it is granted.
 *
 * The count and the families come from the catalogue, so this is not a summary
 * somebody wrote about the role — it is the role. The scope line beside it is
 * the other half: an owner who reads "34 הרשאות" and misses "בכל הארגון" has
 * read half the decision.
 */
function RolePreview({
  role,
  scopeKind,
}: {
  role: InvitableRole
  scopeKind: string
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">
          מה ״{role.name}״ מקנה
        </h3>
        {role.description && (
          <p className="text-sm text-muted-foreground">{role.description}</p>
        )}
      </div>

      <p className="text-sm text-foreground">
        <span className="font-semibold tabular-nums">{role.grantCount}</span>{' '}
        הרשאות, בתחומים: {role.groupLabels.join(' · ')}.{' '}
        {scopeKind === 'all_organization'
          ? 'הן יחולו על כל הנכסים והיחידות בארגון.'
          : scopeKind === 'own_records'
            ? 'הן יחולו רק על רשומות שהאדם יצר או שהוקצו לו.'
            : 'הן יחולו רק בתוך הטווח שנבחר למעלה.'}
      </p>

      {role.sensitive.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold text-foreground">
            כולל {role.sensitive.length} פעולות רגישות
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {role.sensitive.map((grant) => (
              <li key={grant}>
                <Badge tone="accent">
                  <span dir="ltr" className="font-mono text-[0.6875rem]">
                    {grant}
                  </span>
                </Badge>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            אלה אינן ניתנות לביצוע על סמך ההרשאה בלבד — שכבת השירות דורשת אימות
            מחדש, נימוק או אישור.
          </p>
        </div>
      )}
    </section>
  )
}
