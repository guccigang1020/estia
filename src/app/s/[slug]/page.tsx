/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The published home page.
 *
 * Server-rendered, no client bundle, and it reads the snapshot the layout
 * already resolved — `loadPublicSite` is `cache`d, so this costs nothing and,
 * more importantly, is guaranteed to be the same version the header came from.
 *
 * ── The 404 ──────────────────────────────────────────────────────────────
 *
 * A site that has never been published is NOT FOUND, deliberately. Not "coming
 * soon", not an empty page, and not an error: from a visitor's side there is no
 * difference between a slug nobody claimed and a slug somebody is still
 * building, and telling a stranger that a business is preparing a website is
 * disclosing something the business did not choose to disclose.
 */

import { notFound } from 'next/navigation'

import { SitePageBody } from '@/components/website/public-site'
import { pageOf } from '@/lib/website'

import { loadPublicSite } from './_lib/load'

export default async function PublicSiteHomePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  let site: Awaited<ReturnType<typeof loadPublicSite>>
  try {
    site = await loadPublicSite(slug)
  } catch {
    notFound()
  }

  const page = pageOf(site.snapshot, '')
  if (!page) notFound()

  return (
    <SitePageBody
      snapshot={site.snapshot}
      page={page}
      basePath={`/s/${encodeURIComponent(site.snapshot.slug)}`}
    />
  )
}
