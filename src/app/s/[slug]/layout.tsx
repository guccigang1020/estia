/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The public website's frame.
 *
 * ── What makes this safe ─────────────────────────────────────────────────
 *
 * It resolves the published snapshot and passes it down. It reads no draft
 * table — it CANNOT: `src/lib/website/public.ts` has one function for this and
 * that function calls `site_public_snapshot`, which reads `site_versions` by
 * `sites.published_version_id`. `anon` holds no privilege on any table 0042
 * creates, so there is no second path even for a caller who wanted one.
 *
 * ── No business chrome ───────────────────────────────────────────────────
 *
 * Nothing from `(app)` is imported here. No shell, no nav, no actor, no
 * `shellContext`. A visitor is not a user of ESTIA and the page they see must
 * not look like one — this is the customer's website, and the product's job is
 * to be invisible on it.
 *
 * ── The design tokens ────────────────────────────────────────────────────
 *
 * `cssVariables` returns a record whose VALUES are literals in `design.ts`,
 * passed to React's `style` prop, which escapes. Nothing the customer typed
 * reaches a stylesheet and there is no `dangerouslySetInnerHTML` on this path.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { SiteNavigation } from '@/components/website/public-site'
import { cssVariables, isDarkPalette } from '@/lib/website'

import { loadPublicSite } from './_lib/load'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params

  try {
    const site = await loadPublicSite(slug)
    return {
      title: site.snapshot.name,
      // The customer's site is meant to be found. Individual pages may opt
      // out through `site_seo.indexable`, which the page below honours.
      robots: { index: true, follow: true },
    }
  } catch {
    // A site that is not published has no name to put in a tab, and the
    // metadata pass must not be the thing that throws — the page below renders
    // the 404 and owns the message.
    return { title: 'האתר לא נמצא', robots: { index: false, follow: false } }
  }
}

export default async function PublicSiteLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  let snapshot: Awaited<ReturnType<typeof loadPublicSite>> | null = null
  try {
    snapshot = await loadPublicSite(slug)
  } catch {
    // ── WHY `notFound()` HERE AND NOT A FALLBACK FRAME ────────────────────
    //
    // The first version of this file caught the failure and rendered a neutral
    // wrapper, leaving the page below to call `notFound()`. That meant the
    // capability was resolved twice per request for the one case where it had
    // already failed, and it put the refusal after the frame rather than
    // before it. Refusing here means nothing is rendered for a site that does
    // not exist, and the segments below never run.
    //
    // ── A KNOWN GAP, MEASURED AND NOT FIXED HERE ──────────────────────────
    //
    // This does NOT currently produce an HTTP 404. `curl -D -` on a missing
    // slug answers `200 OK` with the not-found page in the body — and so does
    // `/bookings/<unknown-id>`, which this worker did not write. The dev
    // server begins streaming before the not-found boundary resolves, and a
    // status already sent cannot be changed. It is an application-wide
    // behaviour, not a property of this route, and fixing it means touching
    // the shell rather than the website module. It is reported rather than
    // worked around, because a "not found" page served as 200 is indexed by a
    // search engine as content and read by an uptime check as healthy.
    //
    // ── And it is a 404 rather than "coming soon" ─────────────────────────
    //
    // A site nobody claimed and a site somebody is still building are the same
    // answer to a stranger. Saying "this business is preparing a website"
    // discloses something the business did not choose to disclose.
    notFound()
  }

  const design = snapshot.snapshot.design
  const basePath = `/s/${encodeURIComponent(snapshot.snapshot.slug)}`

  return (
    <div
      dir="rtl"
      lang={snapshot.snapshot.locale}
      style={{
        ...cssVariables(design),
        background: 'var(--site-bg)',
        color: 'var(--site-ink)',
        colorScheme: isDarkPalette(design) ? 'dark' : 'light',
      }}
      className="min-h-svh"
    >
      <header style={{ borderColor: 'var(--site-line)' }} className="border-b">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6 sm:px-6">
          <p
            style={{ fontFamily: 'var(--site-heading-font)' }}
            className="text-xl font-bold"
          >
            {snapshot.snapshot.name}
          </p>
          <SiteNavigation
            snapshot={snapshot.snapshot}
            basePath={basePath}
            current=""
          />
        </div>
      </header>

      <main
        className="mx-auto flex w-full max-w-3xl flex-col px-4 py-8 sm:px-6"
        style={{ gap: 'var(--site-section-gap)' }}
      >
        {children}
      </main>

      <footer
        style={{ borderColor: 'var(--site-line)', color: 'var(--site-muted)' }}
        className="border-t"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-6 text-xs sm:px-6">
          {/* The organization's registered name, from the snapshot, which read
              it from the organizations row at publish. Not a guess and not the
              site's own display name. */}
          <p>© {snapshot.snapshot.organizationName}</p>
        </div>
      </footer>
    </div>
  )
}
