/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Any other published page.
 *
 * `pageOf` returns `null` for a slug the snapshot does not carry and this
 * renders a 404 rather than falling back to the home page. A fallback would
 * mean a mistyped or stale link silently served somebody a different page than
 * the one it promised, which is worse than a missing page: they would not know
 * they were looking at the wrong thing.
 *
 * ── `indexable` ──────────────────────────────────────────────────────────
 *
 * Honoured here, per page, from `site_seo`. A business that marked its terms
 * page as not-for-search gets `noindex` on that page and nowhere else — which
 * is why the metadata is generated per page rather than inherited from the
 * layout.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { SitePageBody } from '@/components/website/public-site'
import { pageOf } from '@/lib/website'

import { loadPublicSite } from '../_lib/load'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; pageSlug: string }>
}): Promise<Metadata> {
  const { slug, pageSlug } = await params

  try {
    const site = await loadPublicSite(slug)
    const page = pageOf(site.snapshot, pageSlug)
    if (!page) {
      return { title: 'לא נמצא', robots: { index: false, follow: false } }
    }

    return {
      title: page.seo?.metaTitle ?? `${page.title} · ${site.snapshot.name}`,
      description: page.seo?.metaDescription ?? undefined,
      alternates: page.seo?.canonicalUrl
        ? { canonical: page.seo.canonicalUrl }
        : undefined,
      robots: {
        index: page.seo?.indexable !== false,
        follow: page.seo?.indexable !== false,
      },
    }
  } catch {
    return { title: 'לא נמצא', robots: { index: false, follow: false } }
  }
}

export default async function PublicSitePage({
  params,
}: {
  params: Promise<{ slug: string; pageSlug: string }>
}) {
  const { slug, pageSlug } = await params

  let site: Awaited<ReturnType<typeof loadPublicSite>>
  try {
    site = await loadPublicSite(slug)
  } catch {
    notFound()
  }

  const page = pageOf(site.snapshot, pageSlug)
  if (!page) notFound()

  return (
    <SitePageBody
      snapshot={site.snapshot}
      page={page}
      basePath={`/s/${encodeURIComponent(site.snapshot.slug)}`}
    />
  )
}
