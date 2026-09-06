import type { Metadata } from 'next'

import { DetectStep } from '@/components/migration/steps/detect-step'

export const metadata: Metadata = { title: 'ייבוא — זיהוי הקובץ' }

/** EXECUTION CONTEXT — SERVER COMPONENT. Step two. See `../layout.tsx`. */
export default function MigrationDetectPage() {
  return <DetectStep />
}
