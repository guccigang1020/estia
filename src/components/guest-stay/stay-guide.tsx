/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The guide, during the stay.
 *
 * ── What this renders, and what it refuses to ─────────────────────────────
 *
 * `buildStaySections` returns the sections the property actually configured,
 * already ordered and already filtered. This component renders that list and
 * has no list of its own — no headings for air conditioning, the pool, the
 * jacuzzi or the barbecue waiting to be filled in. A guest reading a heading
 * with nothing under it learns the screen was generated rather than written
 * for them, and stops reading the parts that were.
 *
 * There is likewise no branch here that decides whether a password may be
 * shown. It is not in the object until the stay has begun, because SQL did not
 * return it — §9 of migration 0034 — and an `if` in this file would be a
 * second opinion about a secret.
 *
 * ── Values read character by character ────────────────────────────────────
 *
 * A network name, a password and a door code are typed one character at a
 * time into a device by somebody standing outside in the dark. They are
 * rendered `dir="ltr"` and monospaced: bidirectional reordering of a mixed
 * string loses a character, and a proportional font makes `l1I` a guess. This
 * is `verbatim` on the field, decided by the domain rather than by a class
 * name somebody remembers to add.
 */

import type { GuestStaySection } from '@/lib/guest-journey/stay'

export function StayGuide({
  sections,
  notice,
  children,
}: {
  sections: readonly GuestStaySection[]
  /** The one sentence for a guide that has not opened yet. */
  notice?: string | null
  /** The requests form and list, slotted where the domain put the section. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      {sections.map((section) =>
        section.id === 'requests' ? (
          <section key={section.id} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="font-display text-lg font-bold text-foreground">
                {section.title}
              </h2>
              {section.body && (
                <p className="text-sm text-muted-foreground">{section.body}</p>
              )}
            </div>
            {children}
          </section>
        ) : (
          <StaySection key={section.id} section={section} />
        ),
      )}
    </div>
  )
}

function StaySection({ section }: { section: GuestStaySection }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
      <h2 className="font-display text-base font-bold text-foreground">
        {section.title}
      </h2>

      {section.fields.length > 0 && (
        <dl className="flex flex-col gap-2">
          {section.fields.map((field) => (
            <div
              key={field.label}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd
                dir={field.verbatim ? 'ltr' : undefined}
                className={
                  field.verbatim
                    ? 'font-mono text-base font-semibold text-foreground'
                    : 'text-base font-semibold text-foreground'
                }
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {section.body && (
        // `whitespace-pre-line`: an operator writing a guide uses line breaks
        // to separate the pool from the barbecue, and collapsing them turns
        // nine short answers into one paragraph nobody reads.
        <p className="text-sm whitespace-pre-line text-muted-foreground">
          {section.body}
        </p>
      )}
    </section>
  )
}
