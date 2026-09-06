'use client'

/**
 * The crews, and the controls that finally create one.
 *
 * `"use client"` because every control here is in-flight state: a draft name
 * somebody is typing, which card is open for editing, and the pending flag
 * that stops a double submit. None of it exists on the server.
 *
 * ── What this component does NOT decide ───────────────────────────────────
 *
 * Whether the reader may do any of it. `canManage` is computed on the server
 * from `holdsGrant(actor, 'team.manage')` and passed in; the actions assert
 * the same grant again, the operations assert it a third time, and
 * `teams_insert` / `teams_update` refuse independently. Hiding a button is a
 * courtesy to somebody who cannot use it, never a gate.
 *
 * ── Archived crews are shown, not dropped ─────────────────────────────────
 *
 * Archiving is a soft delete, the roster can still name an archived team
 * against an old membership, and a panel that made them vanish would present
 * "it disappeared" as the product's answer. They sit at the foot, muted, with
 * no controls — there is deliberately no un-archive: the name is still unique
 * among live teams, so the way back is to create the crew again, which leaves
 * the old one's history intact.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Notice } from '@/components/management/notice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import { TEAM_KINDS, type TeamKind } from '@/lib/authz/team-kind'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import {
  archiveTeamAction,
  createTeamAction,
  renameTeamAction,
} from '../_lib/actions'
import type { TeamListItem } from '../_lib/teams'

/** `public.team_kind`, in Hebrew. The enum's own order. */
export const TEAM_KIND_LABEL: Record<TeamKind, string> = {
  housekeeping: 'משק בית',
  maintenance: 'אחזקה',
  front_desk: 'קבלה',
  management: 'הנהלה',
  sales: 'מכירות',
  other: 'אחר',
}

export type PropertyChoice = { id: string; name: string | null }

export function TeamsPanel({
  teams,
  properties,
  canManage,
}: {
  teams: readonly TeamListItem[]
  /** Properties this reader may reach. A crew may be attached to one, or none. */
  properties: readonly PropertyChoice[]
  canManage: boolean
}) {
  const live = teams.filter((team) => team.archivedAt === null)
  const archived = teams.filter((team) => team.archivedAt !== null)

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
          צוותים
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          צוות הוא קבוצת אנשים שעובדים יחד — צוות ניקיון של וילה, מוקד קבלה,
          אחזקה. הוא גם היעד של טווח מסוג ״צוות״: אפשר להגדיר שאדם רואה בדיוק את
          מה שהצוות שלו רואה.
        </p>
      </div>

      {canManage && <CreateTeam properties={properties} />}

      {live.length === 0 ? (
        <Notice title="עוד אין צוותים בארגון">
          עד שיוגדר צוות אחד, טווח מסוג ״צוות״ אינו יכול להצביע על דבר — ולכן
          הוא לא מוצע במסך ההזמנה.{' '}
          {canManage
            ? 'הטופס למעלה יוצר את הראשון.'
            : 'יצירת צוות דורשת הרשאת ניהול צוותים.'}
        </Notice>
      ) : (
        <ul className="flex flex-col gap-3">
          {live.map((team) => (
            <li key={team.id}>
              <TeamCard team={team} canManage={canManage} />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none rounded-lg px-2 py-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <span className="group-open:hidden">
              הצגת {archived.length} צוותים בארכיון
            </span>
            <span className="hidden group-open:inline">הסתרת הארכיון</span>
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {archived.map((team) => (
              <li
                key={team.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground"
              >
                <span className="font-medium">{team.name}</span>
                <Badge tone="neutral">בארכיון</Badge>
                <span className="text-xs">
                  {TEAM_KIND_LABEL[team.kind]}
                  {team.propertyName ? ` · ${team.propertyName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/* ---------------------------------------------------------------- create -- */

function CreateTeam({ properties }: { properties: readonly PropertyChoice[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TeamKind>('housekeeping')
  const [propertyId, setPropertyId] = useState('')
  const [description, setDescription] = useState('')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const create = useAsyncAction<void>()

  if (!open) {
    return (
      <div>
        <Button size="sm" onClick={() => setOpen(true)}>
          צוות חדש
        </Button>
      </div>
    )
  }

  return (
    <Card className="gap-4">
      <CardTitle as="h3">צוות חדש</CardTitle>

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          setFailure(null)
          if (create.pending) return

          void create.run(async () => {
            const result = await createTeamAction({
              name,
              kind,
              // Absent rather than empty. An empty string is a value and the
              // schema would refuse it as a malformed uuid, which is a
              // confusing way to say "organization-wide".
              ...(propertyId === '' ? {} : { propertyId }),
              ...(description.trim() === '' ? {} : { description }),
              // Two submissions eight milliseconds apart must create one crew.
              idempotencyKey: crypto.randomUUID(),
            })

            if (!result.ok) {
              setFailure(result.error)
              return
            }

            setName('')
            setDescription('')
            setPropertyId('')
            setOpen(false)
            router.refresh()
          })
        }}
      >
        {failure && <ActionError error={failure} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="שם הצוות" required>
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              disabled={create.pending}
            />
          </Field>

          <Field label="סוג" required>
            <Select
              value={kind}
              onChange={(event) => setKind(event.target.value as TeamKind)}
              disabled={create.pending}
            >
              {TEAM_KINDS.map((value) => (
                <option key={value} value={value}>
                  {TEAM_KIND_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="נכס"
          description="צוות יכול להיות של נכס אחד — צוות הניקיון של וילה מסוימת — או של כל הארגון. זו ברירת המחדל."
        >
          <Select
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
            disabled={create.pending}
          >
            <option value="">כל הארגון</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name ?? property.id}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="תיאור">
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={280}
            rows={2}
            disabled={create.pending}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={create.pending}>
            {create.pending ? 'יוצר…' : 'יצירת הצוות'}
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

function TeamCard({
  team,
  canManage,
}: {
  team: TeamListItem
  canManage: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description ?? '')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const save = useAsyncAction<void>()
  const archive = useAsyncAction<void>()

  const busy = save.pending || archive.pending

  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle as="h3">
            {team.color && (
              <span
                aria-hidden="true"
                className="ms-0 me-2 inline-block size-2.5 rounded-full align-middle"
                style={{ backgroundColor: team.color }}
              />
            )}
            {team.name}
          </CardTitle>
          <CardDescription>
            {TEAM_KIND_LABEL[team.kind]}
            {team.propertyName ? ` · ${team.propertyName}` : ' · כל הארגון'}
            {team.description ? ` · ${team.description}` : ''}
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={team.memberCount > 0 ? 'accent' : 'neutral'}>
            {team.memberCount === 0
              ? 'אין חברים'
              : team.memberCount === 1
                ? 'אדם אחד'
                : `${team.memberCount} אנשים`}
          </Badge>
          {/* Not decoration. A membership whose SCOPE is this team sees what
              the team sees, and that is the number that makes archiving
              consequential. */}
          {team.scopedCount > 0 && (
            <Badge tone="brand">
              {team.scopedCount === 1
                ? 'טווח של אדם אחד'
                : `טווח של ${team.scopedCount} אנשים`}
            </Badge>
          )}
        </div>
      </div>

      {failure && <ActionError error={failure} />}

      {canManage && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setEditing(true)
              setFailure(null)
            }}
          >
            עריכה
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setFailure(null)
              if (archive.pending) return

              void archive.run(async () => {
                const result = await archiveTeamAction({ teamId: team.id })
                if (!result.ok) {
                  setFailure(result.error)
                  return
                }
                router.refresh()
              })
            }}
          >
            {archive.pending ? 'מוציא לארכיון…' : 'הוצאה לארכיון'}
          </Button>
          {(team.memberCount > 0 || team.scopedCount > 0) && (
            <span className="self-center text-xs text-muted-foreground">
              הוצאה לארכיון תידחה כל עוד יש אנשים בצוות או טווח שמוגדר לפיו.
            </span>
          )}
        </div>
      )}

      {editing && (
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            setFailure(null)
            if (save.pending) return

            void save.run(async () => {
              const result = await renameTeamAction({
                teamId: team.id,
                name,
                ...(description.trim() === '' ? {} : { description }),
                ...(team.color === null ? {} : { color: team.color }),
                // The version this card was rendered from. Two supervisors on
                // the same crew get a refusal rather than a lost change.
                version: team.version,
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
          <Field label="שם הצוות" required>
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              disabled={save.pending}
            />
          </Field>

          <Field label="תיאור">
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={280}
              rows={2}
              disabled={save.pending}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.pending}>
              {save.pending ? 'שומר…' : 'שמירה'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={save.pending}
              onClick={() => {
                setEditing(false)
                setName(team.name)
                setDescription(team.description ?? '')
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
