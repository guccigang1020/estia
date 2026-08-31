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
 * ── The submit was disabled, and now is not ───────────────────────────────
 *
 * It shipped switched off with the reason on screen: `public.invitations`
 * needs a minted, hashed token and an expiry, and nothing in `src/lib` minted
 * one. Both halves exist now — `defineInvitationOperations` creates the row
 * through the full pipeline, and `/invite/[token]` with migration 0027 lets
 * somebody redeem it. Enabling the button before the second half existed would
 * have made every invitation a dead letter.
 *
 * ── The link is shown once, here, and sent by a person ────────────────────
 *
 * There is no mail transport in this codebase. The token leaves the operation
 * sideways through the delivery port — never in the result, because a result
 * is persisted into `idempotency_keys` and a token there is a credential in
 * plain text — and this screen displays it exactly once for the inviter to
 * copy. That is a real product pattern, not a placeholder, and it is why the
 * panel says plainly that closing the page without copying means cancelling
 * and starting again.
 */

import { useState } from 'react'

import {
  createInvitationAction,
  type CreatedInvitationResult,
} from '@/app/(app)/team/invite/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { useAsyncAction } from '@/components/ui/async-action'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { SafeErrorBody } from '@/lib/errors'

import { Notice } from './notice'

/** One assignable role, with the consequence of choosing it. */
export type InvitableRole = {
  /** `public.roles.id`, which is what the invitation stores. */
  id: string
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

  const send = useAsyncAction<void>()
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [created, setCreated] = useState<CreatedInvitationResult | null>(null)

  /**
   * One key for this form, kept across retries.
   *
   * The retry after a dropped connection is the case that matters: the person
   * cannot know whether the first attempt reached the database, and pressing
   * again must not create a second invitation to the same address — which
   * `invitations_one_live_per_email_idx` would refuse anyway, with a
   * constraint name instead of a sentence.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  const role = roles.find((candidate) => candidate.code === roleCode) ?? null

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (send.pending || created) return

        const data = new FormData(event.currentTarget)
        const text = (field: string) => String(data.get(field) ?? '')
        const many = (field: string) =>
          data.getAll(field).map((value) => String(value))

        if (!role) {
          setFailure({
            code: 'no_role_selected',
            message: 'לא נבחר תפקיד. בחר תפקיד מהרשימה.',
            dataMessage: 'ההזמנה לא נוצרה.',
            retryMessage: 'בחר תפקיד ונסה שוב.',
            dataOutcome: 'not_saved',
            retryable: false,
            // Its own id even though nothing reached the server: a person
            // reading a support ticket should not find one failure without
            // one.
            correlationId: crypto.randomUUID(),
          })
          return
        }

        setFailure(null)
        void send.run(async () => {
          const result = await createInvitationAction({
            email: text('email'),
            roleId: role.id,
            scopeKind,
            // Only the list the chosen scope actually uses is sent. The
            // database's `invitations_scope_shape` refuses a row that carries
            // ids the kind does not want, and sending them anyway would make
            // a stale choice from a previous selection part of the request.
            propertyIds: scopeKind === 'properties' ? many('propertyIds') : [],
            unitIds: [],
            teamIds: scopeKind === 'team' ? many('teamIds') : [],
            message: text('message'),
            idempotencyKey,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          setCreated(result.data)
        })
      }}
    >
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

      {created ? (
        <InvitationHandoffPanel created={created} />
      ) : (
        <Notice title="הקישור מוצג פעם אחת, ואתה ששולח אותו" tone="strong">
          אין במערכת שירות דואר, ולכן ההזמנה לא נשלחת מכאן. אחרי היצירה יוצג כאן
          קישור אישי — העתק אותו ושלח לאדם בעצמך. הקישור אינו נשמר בשום מקום:
          במסד הנתונים יש רק גיבוב שלו, וזאת הסיבה שדליפה של גיבוי לא מחלקת גישה
          לארגון. אם תסגור את הדף בלי להעתיק, בטל את ההזמנה וצור חדשה.
        </Notice>
      )}

      {failure ? <ActionError error={failure} /> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={send.pending || created !== null}>
          {send.pending ? 'יוצר…' : 'יצירת ההזמנה'}
        </Button>
        <span aria-live="polite" className="sr-only">
          {send.pending ? 'יוצר את ההזמנה' : ''}
        </span>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------- fragments -- */

/**
 * The link, once.
 *
 * `readOnly` and selected on focus rather than a copy button alone, because a
 * clipboard write can fail silently in a browser that has not granted the
 * permission and the person would send nothing at all. The value is also the
 * one thing on this screen that must never be logged, so there is no
 * `onChange` and nothing reads it back.
 *
 * A replay returns no link and says so. Minting a replacement would leave two
 * live credentials for one invitation.
 */
function InvitationHandoffPanel({
  created,
}: {
  created: CreatedInvitationResult
}) {
  const expires = new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Jerusalem',
  }).format(new Date(created.expiresAt))

  if (!created.link) {
    return (
      <Notice title="ההזמנה כבר קיימת" tone="strong">
        השליחה הזאת חזרה על שליחה קודמת, ולכן לא נוצרה הזמנה שנייה ואין קישור
        חדש. הקישור המקורי הוא זה שתקף. אם אבד — בטל את ההזמנה הקיימת וצור אחת
        חדשה.
      </Notice>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary bg-surface-raised p-4">
      <p className="text-sm font-semibold text-foreground">
        ההזמנה נוצרה. שלח את הקישור ל־
        <span dir="ltr">{created.email}</span>
      </p>

      <input
        readOnly
        dir="ltr"
        value={created.link}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="קישור ההזמנה"
        className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground"
      />

      <p className="text-xs text-muted-foreground">
        בתוקף עד {expires}. תקף לשימוש אחד בלבד, ורק מהכתובת שאליה נועד.
      </p>
    </div>
  )
}

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
