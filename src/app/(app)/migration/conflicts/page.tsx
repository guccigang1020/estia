import type { Metadata } from 'next'

import { ConflictsStep } from '@/components/migration/steps/conflicts-step'

export const metadata: Metadata = { title: 'ייבוא — התנגשויות' }

/** EXECUTION CONTEXT — SERVER COMPONENT. Step six. See `../layout.tsx`. */
export default function MigrationConflictsPage() {
  return <ConflictsStep />
}
