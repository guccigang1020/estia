'use client'

/**
 * PUTTING THE DRAFT IN FRONT OF GUESTS.
 *
 * ── It says what will be published before it publishes it ─────────────────
 *
 * The count of entries and the count of essential gaps, both from the same
 * report the panel above already rendered. A publish button that only said
 * "פרסם" would let somebody put a guide live with no wi-fi entry and no idea
 * they had.
 *
 * ── It does not refuse ───────────────────────────────────────────────────
 *
 * A guide with gaps is still better than no guide, and a business publishing
 * at 23:00 before tomorrow's arrivals must not be stopped by a checklist. This
 * is the same line `src/lib/website/quality.ts` draws: only three checks there
 * can block a publish and all three are about a claim that cannot be sourced.
 * Nothing about a guide's completeness is in that class.
 *
 * ── The version is carried ────────────────────────────────────────────────
 *
 * `expectedVersion` goes with the request, so two people publishing the same
 * guide from two tabs get a conflict somebody is told about rather than a
 * silent last-write-wins over the other one's afternoon.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { publishGuideAction } from '@/app/(app)/settings/guest-guide/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import type { GuideLanguage } from '@/lib/guest-guide/types'

export function PublishButton({
  propertyId,
  expectedVersion,
  languages,
  entryCount,
  essentialGaps,
}: {
  propertyId: string
  expectedVersion: number
  languages: readonly GuideLanguage[]
  entryCount: number
  essentialGaps: number
}) {
  const router = useRouter()
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [published, setPublished] = useState<number | null>(null)
  const publish = useAsyncAction<void>()

  return (
    <div className="flex flex-col gap-3">
      {failure && <ActionError error={failure} />}

      <p className="text-sm text-muted-foreground">
        יפורסמו {entryCount} ערכים פעילים.
        {essentialGaps > 0
          ? ` ${essentialGaps} נושאים שאורחים בוודאות ישאלו עליהם עדיין חסרים — אפשר לפרסם בכל זאת, ומדריך חלקי עדיף על אין מדריך.`
          : ' אין נושא חובה שחסר.'}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={publish.pending}
          onClick={() => {
            if (publish.pending) return
            setFailure(null)
            setPublished(null)

            void publish.run(async () => {
              const result = await publishGuideAction({
                propertyId,
                label: null,
                languages: [...languages],
                expectedVersion,
                idempotencyKey: crypto.randomUUID(),
              })

              if (!result.ok) {
                setFailure(result.error)
                return
              }
              setPublished(result.data.versionNumber)
              router.refresh()
            })
          }}
        >
          {publish.pending ? 'מפרסם…' : 'פרסם את המדריך'}
        </Button>

        {published !== null && (
          <span className="text-sm text-muted-foreground">
            פורסם כגרסה {published}.
          </span>
        )}
      </div>
    </div>
  )
}
