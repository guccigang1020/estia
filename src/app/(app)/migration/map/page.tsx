import type { Metadata } from 'next'

import { MapStep } from '@/components/migration/steps/map-step'

export const metadata: Metadata = { title: 'ייבוא — מיפוי עמודות' }

/** EXECUTION CONTEXT — SERVER COMPONENT. Step three. See `../layout.tsx`. */
export default function MigrationMapPage() {
  return <MapStep />
}
