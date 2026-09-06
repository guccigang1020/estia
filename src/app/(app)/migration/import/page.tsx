import type { Metadata } from 'next'

import { ImportStep } from '@/components/migration/steps/import-step'

export const metadata: Metadata = { title: 'ייבוא — ביצוע' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Step seven, the only one that writes.
 *
 * The route gate in `../layout.tsx` asks for `migration.view`. The write asks
 * for `migration.apply`, and that is asserted by `applyMigrationAction` itself
 * — a Server Action is reachable by a crafted POST whatever this page rendered.
 * What the page does with the same fact is show it: a person without the grant
 * sees who has to press the button, not a button that fails.
 */
export default function MigrationImportPage() {
  return <ImportStep />
}
