'use client'

/**
 * The roles a customer composed, and the controls that compose one.
 *
 * ══ THE CHECKBOX GRID ONLY EVER OFFERS WHAT THE READER HOLDS ═══════════════
 *
 * `grantable` is computed on the server as the actor's own grants — the same
 * set `holdsGrant()` answers from, so it is permission AND plan — and nothing
 * outside it is rendered. That is not the enforcement; the operation refuses
 * with `assertGrantable` and `tg_role_permission_within_reach` (0069) refuses
 * at the database. It is the *interface* telling the truth about the rule
 * instead of offering a hundred checkboxes and refusing eleven of them after
 * the click.
 *
 * The rule is stated on screen as well, because a manager who cannot find
 * `payment.refund` in the list needs to know it is absent by design and not
 * missing by accident.
 *
 * ── The reason field is not decoration ────────────────────────────────────
 *
 * `permission.edit` is in `SENSITIVE_ACTIONS`, so the pipeline refuses an
 * edit that carries no stated reason, and deleting a role is declared the
 * same way. The form collects one rather than the code inventing "עדכון" —
 * a fabricated reason makes the audit trail's most useful column worthless.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Notice } from '@/components/management/notice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Checkbox, TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { Grant } from '@/lib/authz/permissions'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import {
  createCustomRoleAction,
  deleteCustomRoleAction,
  setRolePermissionsAction,
} from '../_lib/actions'
import type { CustomRoleRecord } from '../_lib/custom-roles'

/** A family of grants with its Hebrew name, grouped on the server. */
export type GrantChoiceGroup = {
  id: string
  label: string
  grants: readonly Grant[]
}

export function CustomRolesPanel({
  roles,
  grantable,
  mayCreate,
  mayEditPermissions,
}: {
  roles: readonly CustomRoleRecord[]
  /** Exactly what this reader holds, grouped. Nothing else is offered. */
  grantable: readonly GrantChoiceGroup[]
  mayCreate: boolean
  mayEditPermissions: boolean
}) {
  const grantableCount = grantable.reduce(
    (total, group) => total + group.grants.length,
    0,
  )

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
          תפקידים מותאמים
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          תפקיד שהעסק הרכיב לעצמו. המנוע אינו מבחין בינו לבין תפקיד שהמערכת
          הביאה — שניהם אוסף הרשאות עם שם.
        </p>
      </div>

      <Notice
        title="תפקיד אינו יכול להקנות יותר ממה שיש למי שיצר אותו"
        tone="strong"
      >
        הרשימה למטה מציעה בדיוק את {grantableCount} ההרשאות שאתה מחזיק, ולא
        הרשאה אחת מעבר להן. זה אינו סינון של תצוגה: הפעולה דוחה כל הרשאה שאינך
        מחזיק, ו-<code dir="ltr">tg_role_permission_within_reach</code> במיגרציה
        0069 דוחה אותה שוב במסד הנתונים — גם עבור קריאה שאינה עוברת במסך הזה.
        אחרת, מי שמחזיק ב-<code dir="ltr">permission.edit</code> בלבד היה יכול
        להרכיב לעצמו תפקיד עם <code dir="ltr">organization.settings.edit</code>{' '}
        ולקבל אותו.
      </Notice>

      {mayCreate && (
        <CreateRole
          grantable={grantable}
          mayEditPermissions={mayEditPermissions}
        />
      )}

      {roles.length === 0 ? (
        <Notice title="עוד לא הורכב תפקיד מותאם">
          עשרים התפקידים שהמערכת מגיעה איתם מכסים את רוב העסקים. תפקיד מותאם
          נחוץ כשמבנה העסק אינו מתאים לאף אחד מהם — ״אחראי משמרת״ שרואה משימות
          ותקלות ולא כסף, למשל.
        </Notice>
      ) : (
        <ul className="flex flex-col gap-4">
          {roles.map((role) => (
            <li key={role.id}>
              <CustomRoleCard
                role={role}
                grantable={grantable}
                mayEditPermissions={mayEditPermissions}
                mayDelete={mayCreate}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ------------------------------------------------------------ grant grid -- */

function GrantGrid({
  groups,
  selected,
  disabled,
  onToggle,
}: {
  groups: readonly GrantChoiceGroup[]
  selected: ReadonlySet<string>
  disabled: boolean
  onToggle: (grant: Grant, checked: boolean) => void
}) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        אינך מחזיק באף הרשאה שניתן להעביר הלאה, ולכן אין כאן מה לבחור.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <fieldset key={group.id} className="flex flex-col gap-2">
          <legend className="text-xs font-semibold text-foreground">
            {group.label}
          </legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {group.grants.map((grant) => (
              <Checkbox
                key={grant}
                checked={selected.has(grant)}
                disabled={disabled}
                onChange={(event) => onToggle(grant, event.target.checked)}
                // The grant string itself, not a Hebrew paraphrase. A friendly
                // rendering of `booking.amend_dates` would stop being the
                // thing a reviewer can grep for — the same argument the
                // system-role list makes. It needs no `dir`: every character
                // in a grant code is left-to-right or neutral between two
                // left-to-right ones, so the bidi algorithm already lays it
                // out correctly inside this right-to-left page.
                label={grant}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- create -- */

function CreateRole({
  grantable,
  mayEditPermissions,
}: {
  grantable: readonly GrantChoiceGroup[]
  mayEditPermissions: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [grants, setGrants] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const create = useAsyncAction<void>()

  if (!open) {
    return (
      <div>
        <Button size="sm" onClick={() => setOpen(true)}>
          תפקיד מותאם חדש
        </Button>
      </div>
    )
  }

  return (
    <Card className="gap-4">
      <CardTitle as="h3">תפקיד מותאם חדש</CardTitle>

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          setFailure(null)
          if (create.pending) return

          void create.run(async () => {
            const result = await createCustomRoleAction({
              code,
              name,
              ...(description.trim() === '' ? {} : { description }),
              grants: [...grants],
              idempotencyKey: crypto.randomUUID(),
            })

            if (!result.ok) {
              setFailure(result.error)
              return
            }

            setCode('')
            setName('')
            setDescription('')
            setGrants(new Set())
            setOpen(false)
            router.refresh()
          })
        }}
      >
        {failure && <ActionError error={failure} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="שם התפקיד" required>
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              disabled={create.pending}
            />
          </Field>

          <Field
            label="מזהה"
            required
            description="אותיות לטיניות קטנות, ספרות וקו תחתון. זה המזהה שמופיע ביומן הביקורת ובבדיקות, ולכן הוא אינו בעברית."
          >
            <TextInput
              value={code}
              dir="ltr"
              onChange={(event) => setCode(event.target.value)}
              maxLength={40}
              disabled={create.pending}
            />
          </Field>
        </div>

        <Field label="תיאור">
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={280}
            rows={2}
            disabled={create.pending}
          />
        </Field>

        {mayEditPermissions ? (
          <Field
            label="הרשאות"
            description="אפשר גם ליצור תפקיד ריק עכשיו ולהוסיף לו הרשאות בהמשך."
          >
            <GrantGrid
              groups={grantable}
              selected={grants}
              disabled={create.pending}
              onToggle={(grant, checked) => {
                const next = new Set(grants)
                if (checked) next.add(grant)
                else next.delete(grant)
                setGrants(next)
              }}
            />
          </Field>
        ) : (
          // `role.create` creates the row; `role_permissions_insert` demands
          // `permission.edit` for its grants. The two are separable and the
          // screen says which half is missing rather than refusing both.
          <Notice title="התפקיד ייווצר ללא הרשאות">
            הוספת הרשאות לתפקיד דורשת את ההרשאה{' '}
            <code dir="ltr">permission.edit</code>, שאינה בידיך. אפשר ליצור את
            התפקיד עכשיו, ומי שמחזיק בה ישלים את ההרשאות.
          </Notice>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={create.pending}>
            {create.pending ? 'יוצר…' : 'יצירת התפקיד'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={create.pending}
            onClick={() => {
              setOpen(false)
              setFailure(null)
            }}
          >
            ביטול
          </Button>
        </div>
      </form>
    </Card>
  )
}

/* ------------------------------------------------------------------ card -- */

function CustomRoleCard({
  role,
  grantable,
  mayEditPermissions,
  mayDelete,
}: {
  role: CustomRoleRecord
  grantable: readonly GrantChoiceGroup[]
  mayEditPermissions: boolean
  mayDelete: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [grants, setGrants] = useState<ReadonlySet<string>>(
    new Set(role.grants),
  )
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const save = useAsyncAction<void>()
  const remove = useAsyncAction<void>()

  const busy = save.pending || remove.pending

  /**
   * Grants on the role that this reader does not hold.
   *
   * They exist legitimately: somebody more senior composed the role. They are
   * shown, because hiding them would present the role as granting less than it
   * does — and they are marked, because saving from this screen replaces the
   * whole set and would silently strip them. That is the one place where "the
   * grid only offers what you hold" could quietly remove authority, so it is
   * said out loud rather than left to be discovered.
   */
  const offered = new Set(grantable.flatMap((group) => [...group.grants]))
  const beyondReader = role.grants.filter((grant) => !offered.has(grant))

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle as="h3">{role.name}</CardTitle>
          <CardDescription>
            <span dir="ltr" className="font-mono text-xs">
              {role.code}
            </span>
            {role.description ? ` · ${role.description}` : ''}
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">תפקיד של הארגון</Badge>
          <Badge tone={role.memberCount > 0 ? 'accent' : 'neutral'}>
            {role.memberCount === 0
              ? 'אף אחד בארגון'
              : role.memberCount === 1
                ? 'אדם אחד'
                : `${role.memberCount} אנשים`}
          </Badge>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          {role.grants.length === 0
            ? 'התפקיד אינו מקנה הרשאות. מי שמחזיק בו לבדו אינו יכול דבר.'
            : `${role.grants.length} הרשאות.`}
          {role.unknownGrantCount > 0 && (
            <>
              {' '}
              <span className="font-medium text-foreground">
                {role.unknownGrantCount} הרשאות נוספות שמורות על התפקיד ואינן
                מוכרות לגרסה הזאת של המוצר.
              </span>
            </>
          )}
        </p>

        {role.grants.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {role.grants.map((grant) => (
              <li key={grant}>
                <Badge tone={offered.has(grant) ? 'neutral' : 'accent'}>
                  <span dir="ltr" className="font-mono text-[0.6875rem]">
                    {grant}
                  </span>
                </Badge>
              </li>
            ))}
          </ul>
        )}

        {beyondReader.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {beyondReader.length === 1
              ? 'הרשאה אחת בתפקיד הזה אינה בידיך'
              : `${beyondReader.length} הרשאות בתפקיד הזה אינן בידיך`}
            , ולכן שמירה מהמסך הזה תסיר אותן. מי שמחזיק בהן הוא שיכול לערוך את
            התפקיד בלי לאבד אותן.
          </p>
        )}
      </div>

      {failure && <ActionError error={failure} />}

      {!editing && !confirming && (
        <div className="flex flex-wrap gap-2">
          {mayEditPermissions && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(true)
                setGrants(new Set(role.grants))
                setReason('')
                setFailure(null)
              }}
            >
              עריכת הרשאות
            </Button>
          )}
          {mayDelete && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirming(true)
                setReason('')
                setFailure(null)
              }}
            >
              מחיקת התפקיד
            </Button>
          )}
        </div>
      )}

      {editing && (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            setFailure(null)
            if (save.pending) return

            void save.run(async () => {
              const result = await setRolePermissionsAction({
                roleId: role.id,
                grants: [...grants],
                reason,
              })

              if (!result.ok) {
                setFailure(result.error)
                return
              }

              setEditing(false)
              router.refresh()
            })
          }}
        >
          <Field label="הרשאות">
            <GrantGrid
              groups={grantable}
              selected={grants}
              disabled={save.pending}
              onToggle={(grant, checked) => {
                const next = new Set(grants)
                if (checked) next.add(grant)
                else next.delete(grant)
                setGrants(next)
              }}
            />
          </Field>

          <Field
            label="נימוק"
            required
            description="שינוי הרשאות הוא פעולה רגישה, והנימוק נשמר ביומן הביקורת לצד השינוי עצמו."
          >
            <TextInput
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={280}
              disabled={save.pending}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.pending}>
              {save.pending ? 'שומר…' : 'שמירת ההרשאות'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={save.pending}
              onClick={() => {
                setEditing(false)
                setGrants(new Set(role.grants))
                setFailure(null)
              }}
            >
              ביטול
            </Button>
          </div>
        </form>
      )}

      {confirming && (
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            setFailure(null)
            if (remove.pending) return

            void remove.run(async () => {
              const result = await deleteCustomRoleAction({
                roleId: role.id,
                reason,
              })

              if (!result.ok) {
                setFailure(result.error)
                return
              }

              setConfirming(false)
              router.refresh()
            })
          }}
        >
          <Notice title="מחיקת תפקיד שוללת הרשאות" tone="strong">
            הפעולה נדחית כל עוד מישהו מחזיק בתפקיד או שקיימת הזמנה פתוחה שמעניקה
            אותו — כדי שאיש לא יאבד הרשאות בלי שמישהו יבחר בכך.
          </Notice>

          <Field label="נימוק" required>
            <TextInput
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={280}
              disabled={remove.pending}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={remove.pending}
            >
              {remove.pending ? 'מוחק…' : 'מחיקת התפקיד'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={remove.pending}
              onClick={() => {
                setConfirming(false)
                setFailure(null)
              }}
            >
              ביטול
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}
