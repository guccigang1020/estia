'use client'

/**
 * The control that puts one person into one crew.
 *
 * It writes `memberships.team_id`, and it does so with `team.manage` rather
 * than `user.edit` — which is only possible because `assign_membership_to_team`
 * in 0069 is a SECURITY DEFINER function that can change exactly one column.
 * Read the argument there before reaching for `db.from('memberships')`.
 *
 * ── Why a select that saves on change, and not a form ─────────────────────
 *
 * There is one field and one decision. A save button beside a single dropdown
 * is a second click for no information, and on a roster of ninety people it is
 * ninety buttons. The refusal path is the same either way: the action returns
 * the server's own Hebrew, and the select snaps back to what it was, because
 * leaving it showing the crew the person is NOT in is the one outcome worse
 * than the refusal.
 *
 * "ללא צוות" is a real choice, not an empty state: `teamId: null` takes
 * somebody out of every team and the operation accepts it as an instruction.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { Select } from '@/components/ui/input'

import { assignMemberToTeamAction } from '../_lib/actions'

export type TeamChoice = { id: string; name: string }

export function MemberTeamPicker({
  membershipId,
  teamId,
  teams,
  label,
}: {
  membershipId: string
  teamId: string | null
  /** Live teams only. An archived one is refused by the operation anyway. */
  teams: readonly TeamChoice[]
  /** Names the person, so ninety of these are not ninety identical controls. */
  label: string
}) {
  const router = useRouter()
  const [value, setValue] = useState(teamId ?? '')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-1">
      <Select
        aria-label={`הצוות של ${label}`}
        value={value}
        disabled={pending}
        onChange={(event) => {
          const chosen = event.target.value
          const previous = value

          setValue(chosen)
          setMessage(null)
          setPending(true)

          void (async () => {
            try {
              const result = await assignMemberToTeamAction({
                membershipId,
                teamId: chosen === '' ? null : chosen,
              })

              if (!result.ok) {
                // Back to the truth. A control left showing the crew somebody
                // is not in is worse than the refusal it is reporting.
                setValue(previous)
                setMessage(result.error.message)
                return
              }

              router.refresh()
            } finally {
              setPending(false)
            }
          })()
        }}
      >
        <option value="">ללא צוות</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </Select>

      {message && (
        <p role="alert" className="text-xs font-medium text-danger">
          {message}
        </p>
      )}
    </div>
  )
}
