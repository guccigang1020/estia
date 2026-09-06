/**
 * EXECUTION CONTEXT — ROUTE HANDLER, SERVER ONLY. The register as a file.
 *
 * ══ AN EXPORT IS A DISCLOSURE, AND IT IS AUDITED ═══════════════════════════
 *
 * This handler hands a person a file of named guests, their dates and — where
 * the operator turned the field on — their addresses. `guest.export` is in
 * `SENSITIVE_ACTIONS` for exactly that reason, and `security.bulk_export` is
 * on `ALERT_EVENTS`. So the download is not a read that happens to produce a
 * file: an audit row is written **before** the bytes leave, and if the audit
 * write fails the export does not happen.
 *
 * That ordering is the whole point. An audit written afterwards is an audit
 * that a crash, a timeout or a cancelled request silently omits — and the one
 * export nobody can account for is the one that mattered.
 *
 * ══ THE FILE CONTAINS WHAT THE SCREEN WOULD SHOW, AND NOT MORE ═════════════
 *
 * The same `loadGuestBook` the page calls, with the same filter, under the
 * same scope narrowing and the same `redact()`. A reader without
 * `guest.view_name` gets a file with no names in it. There is deliberately no
 * "export everything" path that bypasses the filter: a file that contained
 * rows the screen would not have shown is a privilege escalation with a
 * filename.
 *
 * ══ TWO GRANTS, BOTH REQUIRED ═════════════════════════════════════════════
 *
 * `guest.view` opens the register and `guest.export` allows taking it away.
 * They are separate rights and this handler demands both — reading a register
 * at a desk and walking out with a copy of it are different acts.
 */

import { holdsGrant } from '@/lib/authz/can'
import { recordAuditEvent } from '@/lib/audit/pipeline'
import { SupabaseAuditWriter } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import {
  guestBookCsv,
  loadGuestBook,
  parseGuestBookFilter,
} from '../_lib/queries'

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export async function GET(request: Request): Promise<Response> {
  const context = await shellContext()

  if (!context) return refuse(401, 'נדרשת התחברות.')
  if (context.status !== 'ready') return refuse(403, 'אין הרשאה לייצוא.')

  const { actor } = context

  if (!holdsGrant(actor, 'guest.view') || !holdsGrant(actor, 'guest.export')) {
    return refuse(403, 'אין הרשאה לייצא את ספר האורחים.')
  }

  const url = new URL(request.url)
  const filter = parseGuestBookFilter(
    Object.fromEntries(url.searchParams.entries()),
  )

  const db = await createClient()
  const screen = await loadGuestBook(db, actor, actor.organizationId, filter)

  if (screen.state === 'not_provisioned') {
    return refuse(409, 'אחסון ספר האורחים עדיין לא קיים במסד הנתונים.')
  }
  if (!screen.data.config.enabled) {
    return refuse(409, 'ניהול ספר אורחים אינו פעיל בחשבון הזה.')
  }

  const requestId = crypto.randomUUID()
  const rows = screen.data.entries

  // Before the bytes, never after. See the header.
  await recordAuditEvent(
    {
      actor: {
        type: 'user',
        userId: actor.userId,
        label: context.user.email ?? actor.userId,
      },
      context: {
        organizationId: actor.organizationId,
        propertyId: filter.propertyId,
        requestId,
        userAgent: request.headers.get('user-agent'),
      },
      action: 'guest.export',
      resourceType: 'guest_book',
      resourceId: null,
      summary:
        `ייצוא ספר האורחים: ${rows.length} רישומים` +
        `${filter.from === null && filter.to === null ? '' : ` בטווח ${filter.from ?? 'תחילת הרישום'}–${filter.to ?? 'היום'}`}.`,
      // The register is not a record with a version, so there is no before or
      // after to diff. What is audited is the disclosure itself: who, when,
      // how many rows, and under which filter.
      after: {
        rowCount: rows.length,
        propertyId: filter.propertyId,
        status: filter.status,
        from: filter.from,
        to: filter.to,
      },
    },
    new SupabaseAuditWriter(db),
  )

  const filename = `guest-book-${new Date().toISOString().slice(0, 10)}.csv`

  return new Response(guestBookCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // A register is not something a proxy should keep a copy of.
      'cache-control': 'no-store',
    },
  })
}
