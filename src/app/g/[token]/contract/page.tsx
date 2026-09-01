/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The contract.
 *
 * ── When the contract is disabled, this route does not exist ──────────────
 *
 * `notFound()`, not a page saying "no contract is required". The specification
 * is explicit that a disabled contract means no contract UI anywhere, and a
 * page explaining its own absence is still contract UI — it is a screen a
 * guest can reach, read and be confused by, about a feature their host never
 * switched on. The database agrees: `guest_portal_sign_contract` refuses
 * outright when the mode is `disabled`, so there is no way to produce a
 * signature row against such a booking even by calling the RPC directly.
 *
 * ── After signing, the frozen text is the only contract there is ──────────
 *
 * The projection stops returning the template once a signature exists, and
 * this page renders `signature.body` — the copy taken at the moment of
 * signing. That is the whole reason §4 of migration 0034 has two tables: a
 * guest who comes back in March to check what they agreed to sees what they
 * agreed to, not whatever the template says today.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ContractForm } from '@/components/guest/contract-form'
import { GuestLinkRefusedError } from '@/lib/guest-portal'

import { portalContext } from '../_lib/portal'

function BackLink({ token }: { token: string }) {
  return (
    <Link
      href={`/g/${token}`}
      className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      ← חזרה להזמנה
    </Link>
  )
}

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Jerusalem',
  }).format(date)
}

export default async function GuestContractPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let context
  try {
    context = await portalContext(token)
  } catch (cause) {
    if (cause instanceof GuestLinkRefusedError) notFound()
    throw cause
  }

  const { journey } = context
  const { contract } = journey

  // No contract in this business. The route is simply not there.
  if (journey.settings.contractMode === 'disabled') notFound()

  const signed = contract.signature

  return (
    <main className="flex flex-col gap-5">
      <BackLink token={token} />

      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold text-foreground">
          {signed ? signed.title : (contract.template?.title ?? 'תנאי השהות')}
        </h1>
        {signed ? (
          <p className="text-sm text-success">
            נחתם על ידי {signed.signerName} · {when(signed.signedAt)}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {journey.settings.contractMode === 'mandatory'
              ? 'יש לחתום על התנאים כדי להשלים את ההזמנה.'
              : 'החתימה אינה חובה, אך היא מסייעת לשמור את התנאים בכתב.'}
          </p>
        )}
      </header>

      {/* The terms. `whitespace-pre-line` rather than a markdown renderer: the
          text is written by the business and rendering it as markup would let
          a pasted paragraph become a heading, or worse. */}
      <article className="max-h-[60svh] overflow-y-auto rounded-xl border border-border bg-surface px-4 py-4 text-sm leading-relaxed whitespace-pre-line text-foreground">
        {signed
          ? signed.body
          : (contract.template?.body ??
            'נוסח החוזה אינו זמין כרגע. פנה לבית האירוח.')}
      </article>

      {signed ? (
        <p className="rounded-xl border border-success bg-success/10 px-4 py-3 text-sm text-foreground">
          זהו הנוסח שעליו חתמת, כפי שהיה במועד החתימה. עדכונים מאוחרים יותר של
          בית האירוח אינם חלים עליו.
        </p>
      ) : contract.template ? (
        <ContractForm
          token={token}
          contractTitle={contract.template.title}
          requireIdNumber={journey.settings.requiredDetailFields.includes(
            'id_number',
          )}
        />
      ) : (
        // Configured to require a contract with no active template behind it.
        // Named rather than left as a form that cannot submit.
        <p
          role="status"
          className="rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
        >
          בית האירוח טרם פרסם נוסח לחתימה. הוא ייצור איתך קשר.
        </p>
      )}
    </main>
  )
}
