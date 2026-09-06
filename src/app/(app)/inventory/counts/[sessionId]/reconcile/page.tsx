import type { Metadata } from 'next'

import { Td, Th } from '@/components/operations/table-parts'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import {
  COUNT_SESSION_STATUS_LABEL,
  classificationsForVariance,
  explainVariance,
} from '@/lib/inventory/counts'
import { LOSS_CLASS_LABEL } from '@/lib/inventory/loss'
import { formatAgorot } from '@/lib/plans/plan'

import { shellContext } from '../../../../_lib/context'
import { requireGrant } from '../../../../_lib/guard'
import { ModuleOff } from '../../../_components/module-state'
import { ClassifyForm } from '../../_components/classify-form'
import {
  NotProvisioned,
  SessionNotFound,
  SessionNotReadable,
} from '../../_components/notices'
import { SessionActions } from '../../_components/session-actions'
import { reconciliationState } from '../../_lib/queries'

export const metadata: Metadata = { title: 'התאמת ספירה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the count found, and what it
 * means.
 *
 * EVERY ROW SHOWS ITS ARITHMETIC. ״ציפינו ל-18 על המדף, נספרו 15, חסרים 3״.
 * A screen that printed only the three is a number a person either believes
 * or ignores, and after the first wrong one they ignore all of them. The same
 * rule the shortage screen follows.
 *
 * THE CIRCULATION FIGURE SITS BESIDE THE VARIANCE, AND THAT IS THE POINT.
 * Linen is not soap. A missing towel is first of all a towel in the wash, and
 * a reconciler who cannot see that forty-two units are recorded as
 * circulating will classify laundry as loss. Consumables show nothing there,
 * and ״בכביסה״ is not offered for them at all.
 *
 * THE MONEY IS AN ESTIMATE AND CANNOT BE RENDERED WITHOUT SAYING SO. The
 * figure comes out of `ReplacementExposure`, which has no bare amount on it —
 * the number lives inside `method`, beside the table it was built from, the
 * basis of the per-unit cost, and the sentence saying what it is not. It is
 * printed here with all four.
 *
 * AN UNEXPLAINED DIFFERENCE IS UNEXPLAINED. That is the whole of what this
 * screen says about it: a quantity, a cost estimate, and no attribution to
 * anyone. There is a test that greps this file to keep it that way.
 */
export default async function ReconcileCountPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = await params

  const [actor, context] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const state = await reconciliationState({ actor, context, sessionId })

  if (state.kind === 'module_off') {
    return (
      <ModuleOff
        provisioned={state.provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  const shell = (body: React.ReactNode) => (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {body}
    </div>
  )

  if (state.kind === 'not_provisioned') return shell(<NotProvisioned />)
  if (state.kind === 'not_found') return shell(<SessionNotFound />)
  if (state.kind === 'not_readable') return shell(<SessionNotReadable />)

  const { session, variances, exposure } = state
  const method = exposure.method
  const unexplained = variances.filter(
    (one) => one.classification === null || one.classification === 'unknown',
  ).length

  return shell(
    <>
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          התאמת ספירה
        </h1>
        <p className="text-sm text-muted-foreground">
          {session.label ?? 'ספירת מלאי'} ·{' '}
          {state.propertyName ?? session.propertyId} ·{' '}
          {COUNT_SESSION_STATUS_LABEL[session.status]}
        </p>
        <p className="max-w-prose text-muted-foreground">
          {state.matched} פריטים תאמו במדויק, {variances.length} בהפרש,{' '}
          {state.uncounted} לא נספרו כלל. פריט שלא נספר אינו חסר — איש לא הביט
          בו, וזו תשובה אחרת לגמרי.
        </p>
      </header>

      {state.mayClassify && (
        <SessionActions
          sessionId={session.id}
          status={session.status}
          blind={session.blind}
          unexplained={unexplained}
        />
      )}

      {/* The estimate, with its method attached. Never the number alone. */}
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-4 shadow-soft">
        <h2 className="font-display text-lg font-bold text-foreground">
          {exposure.formatted}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {method.disclaimer}
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          {method.basis}
        </p>

        {method.table.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-foreground">
            {method.table.map((row) => (
              <li key={row.itemId}>
                {row.label}: {row.units} ×{' '}
                {formatAgorot(row.replacementCostAgorot)} ={' '}
                {formatAgorot(row.agorot)}
              </li>
            ))}
          </ul>
        )}

        {method.unpricedUnits > 0 && (
          <p className="text-sm text-muted-foreground">
            {method.unpricedUnits} יחידות מ־{method.unpricedItems} פריטים אינן
            נכללות בסכום, כי לא נרשמה להן עלות ליחידה. אפס היה קורא ״אלה לא
            עולים כלום״, וזה בדיוק מה שאינו נכון.
          </p>
        )}
      </section>

      {variances.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          לא נמצאו הפרשים. אם הספירה עדיין לא הושוותה, לחצו ״סיים ספירה והשווה״
          למעלה.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-soft">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <Th>פריט</Th>
                <Th>צפוי על המדף</Th>
                <Th>נספר</Th>
                <Th>הפרש</Th>
                <Th>רשום מחוץ למדף</Th>
                <Th>סיווג</Th>
              </tr>
            </thead>
            <tbody>
              {variances.map((one) => (
                <tr
                  key={one.id}
                  className="border-b border-border align-top last:border-b-0"
                >
                  <Td>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-foreground">
                        {one.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {explainVariance({
                          itemId: one.itemId,
                          label: one.label,
                          expected: one.expected,
                          counted: one.counted,
                          variance: one.variance,
                          elsewhere: {},
                          circulating: one.circulating,
                          replacementCostAgorot: one.replacementCostAgorot,
                        })}
                      </span>
                    </div>
                  </Td>
                  <Td>{one.expected}</Td>
                  <Td>{one.counted}</Td>
                  <Td>
                    <span className="font-semibold text-foreground">
                      {one.variance > 0
                        ? `חסרים ${one.variance}`
                        : `עודף ${Math.abs(one.variance)}`}
                    </span>
                  </Td>
                  <Td>{one.circulating > 0 ? one.circulating : '–'}</Td>
                  <Td>
                    {state.mayClassify ? (
                      <ClassifyForm
                        sessionId={session.id}
                        varianceId={one.id}
                        options={classificationsForVariance(one)}
                        current={one.classification}
                      />
                    ) : one.classification === null ? (
                      <span className="text-muted-foreground">טרם סווג</span>
                    ) : (
                      LOSS_CLASS_LABEL[one.classification]
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <Button href={`/inventory/counts/${session.id}`} variant="secondary">
          חזרה לגיליון
        </Button>
      </div>
    </>,
  )
}
