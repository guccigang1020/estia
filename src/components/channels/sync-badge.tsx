import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import {
  SYNC_STATE_LABEL,
  type ExceptionSeverity,
  type SyncState,
} from '@/lib/channels/types'

/**
 * The state of one channel, as a word and a colour.
 *
 * ── Why the word is never dropped ─────────────────────────────────────────
 *
 * A colour alone fails three ways at once: it is invisible to a colour-blind
 * reader, it is meaningless to a screen reader, and — the one that matters
 * most here — it is ambiguous. Amber against a channel could mean "syncing",
 * "behind" or "paused", and those are three completely different mornings.
 * `SYNC_STATE_LABEL` is the frozen vocabulary and the badge always says it.
 *
 * ── `stopped` is deliberately not red ─────────────────────────────────────
 *
 * A paused connector is off because somebody turned it off. Painting it the
 * same colour as a failing one teaches people that red means nothing, which is
 * exactly the habit that makes the real failure invisible.
 */
// No `success-soft` / `warning-soft` / `danger-soft` tokens exist, so each
// tint is an opacity of the colour itself rather than a new palette entry
// invented here — `src/app/globals.css` belongs to the coordinator. The same
// decision `components/guest/reconfirm-notice.tsx` records.
const STATE_CLASS: Record<SyncState, string> = {
  healthy: 'bg-success/10 text-success',
  degraded: 'bg-warning/15 text-warning',
  failing: 'bg-danger/10 text-danger',
  // Off, not broken.
  stopped: 'bg-muted text-muted-foreground',
  never_synced: 'bg-muted text-muted-foreground',
}

export function SyncBadge({
  state,
  className,
}: {
  state: SyncState
  className?: string
}) {
  return (
    <Badge className={cn(STATE_CLASS[state], className)}>
      {SYNC_STATE_LABEL[state]}
    </Badge>
  )
}

const SEVERITY_CLASS: Record<ExceptionSeverity, string> = {
  critical: 'bg-danger/10 text-danger',
  urgent: 'bg-warning/15 text-warning',
  warning: 'bg-muted text-muted-foreground',
}

const SEVERITY_LABEL: Record<ExceptionSeverity, string> = {
  critical: 'קריטי',
  urgent: 'דחוף',
  warning: 'לתשומת לב',
}

export function SeverityBadge({
  severity,
  className,
}: {
  severity: ExceptionSeverity
  className?: string
}) {
  return (
    <Badge className={cn(SEVERITY_CLASS[severity], className)}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  )
}
