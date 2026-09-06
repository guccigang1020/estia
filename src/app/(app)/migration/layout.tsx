/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The frame every step of a migration sits in.
 *
 * ── Why the gate is here and not repeated eight times ─────────────────────
 *
 * A layout runs for every route beneath it, so `migration.view` is asserted
 * once and cannot be forgotten on the ninth step somebody adds next month. It
 * is not the only gate: `dryRunMigrationAction` and `applyMigrationAction` each
 * call `assertCan` again, because a Server Action is reachable by a crafted
 * POST whatever the screen rendered, and row level security refuses regardless
 * of both.
 *
 * ── The two grants are different amounts of authority ─────────────────────
 *
 * `migration.view` opens the whole flow up to and including the dry run — which
 * writes nothing, provably. `migration.apply` is what performs the import.
 * Somebody with the first and not the second can read the preview of a
 * three-year migration and cannot execute it, and the screen says so on the
 * import step instead of showing a button that fails. `mayApply` is computed
 * here, once, and carried down.
 *
 * ── Why the provider is at this level ─────────────────────────────────────
 *
 * There is a route per step, and Next.js keeps a layout's Client Component
 * state across navigation between its children. So the parsed file survives
 * moving from the mapping screen to the dry run and does not survive a reload,
 * which is the pair of properties this feature wants — see the header on
 * `components/migration/wizard-state.tsx` for why an eighteen-hundred-row
 * customer list is not going into a URL or into storage.
 */

import Link from 'next/link'

import { MigrationNotices } from '@/components/migration/notices'
import { StepRail } from '@/components/migration/step-rail'
import { MigrationProvider } from '@/components/migration/wizard-state'
import { holdsGrant } from '@/lib/authz/can'

import {
  MIGRATION_APPLY,
  WRITE_GRANT_LABEL,
  missingWriteGrants,
  requireMigrationAccess,
} from './_lib/access'
import { applyMigrationAction, dryRunMigrationAction } from './_lib/actions'

export default async function MigrationLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const actor = await requireMigrationAccess()

  return (
    <div
      dir="rtl"
      className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8"
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          <Link href="/migration" className="hover:underline">
            ייבוא נתונים ממערכת קודמת
          </Link>
        </h1>
        <p className="max-w-prose text-muted-foreground">
          ההיסטוריה שלכם עוברת איתכם. מעלים קובץ, מסבירים איזו עמודה היא מה,
          וקוראים בדיוק מה יקרה — לפני שנכתב שום דבר. הרצה חוזרת של אותו קובץ
          אינה מכפילה כלום.
        </p>
      </header>

      <MigrationProvider
        actions={{ dryRun: dryRunMigrationAction, apply: applyMigrationAction }}
        mayApply={holdsGrant(actor, MIGRATION_APPLY)}
        missingGrants={missingWriteGrants(actor).map(
          (grant) => WRITE_GRANT_LABEL[grant] ?? grant,
        )}
      >
        <MigrationNotices />

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
          <aside>
            <StepRail />
          </aside>
          <div className="flex min-w-0 flex-col gap-6">{children}</div>
        </div>
      </MigrationProvider>
    </div>
  )
}
