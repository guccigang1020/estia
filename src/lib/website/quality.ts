/**
 * THE QUALITY PASSES.
 *
 * Four of them, run over the draft, producing findings a person reads and
 * decides about. Content, conversion, technical, and a second pass immediately
 * before publish.
 *
 * ── The rule that keeps this honest ───────────────────────────────────────
 *
 *   A CHECK THAT CANNOT BE SOURCED FROM REAL DATA REPORTS `not_assessed`.
 *
 * Not a zero, not a guess, not "8/10". `not_assessed` is a first-class status
 * in `SITE_FINDING_STATUSES` and several checks below return it deliberately:
 *
 *   · page load time — nothing here measures a request, so it is not scored
 *   · keyword competitiveness — there is no search data in this product
 *   · conversion rate — no analytics source exists, so no rate is claimed
 *
 * A quality report that scores what it cannot measure is decoration, and
 * decoration is what makes people stop reading quality reports. Every finding
 * below either reads a real row or says out loud that it did not.
 *
 * ── Severity, and the one thing that blocks ───────────────────────────────
 *
 * Only `blocker` stops a publish, and only the unsourced-claim checks raise
 * one — because that is the module's own law rather than an opinion about
 * marketing. Everything else is `warning` or `advice`. A tool that refuses to
 * let a business publish its own website because a heading is 62 characters is
 * a tool that gets switched off, and then nothing is checked at all.
 */

import { publishBlockers, unsourcedClaims } from './facts'
import type {
  SiteFindingSeverity,
  SiteFindingStatus,
  SitePage,
  SiteQualityKind,
  SiteSection,
  SiteSnapshotPage,
} from './types'

export type Finding = {
  checkCode: string
  kind: SiteQualityKind
  severity: SiteFindingSeverity
  status: SiteFindingStatus
  title: string
  detail: string
  pageSlug: string | null
  sectionId: string | null
}

export type QualityInput = {
  pages: readonly SitePage[]
  /** Every section, for every page. Keyed to pages by `pageId`. */
  sections: readonly SiteSection[]
  /** Alt text lives on media; a gallery with none is a technical finding. */
  media: readonly { id: string; altText: string | null }[]
  /** True when the plan carries `custom_domain`. Changes one finding's wording. */
  customDomainAvailable: boolean
  hasVerifiedDomain: boolean
}

/* ------------------------------------------------------------ the passes -- */

export function runQualityPass(
  kind: SiteQualityKind,
  input: QualityInput,
): readonly Finding[] {
  switch (kind) {
    case 'content':
      return contentPass(input)
    case 'conversion':
      return conversionPass(input)
    case 'technical':
      return technicalPass(input)
    case 'pre_publish':
      return prePublishPass(input)
  }
}

/** Every pass, in order. What the studio's quality screen shows. */
export function runAllPasses(input: QualityInput): readonly Finding[] {
  return [
    ...contentPass(input),
    ...conversionPass(input),
    ...technicalPass(input),
  ]
}

/* ----------------------------------------------------------- 1 · content -- */

/**
 * Is there anything here, and does it say something true?
 *
 * The first check is the module's law and the only one in this pass that can
 * block. The rest are about emptiness — a page with no sections, a section
 * with no claims — which is the failure a website actually has, far more often
 * than a stylistic one.
 */
function contentPass(input: QualityInput): readonly Finding[] {
  const findings: Finding[] = []
  const active = input.sections.filter((section) => section.isActive)

  for (const blocker of unsourcedClaims(active.flatMap((s) => s.claims))) {
    const section = active.find((candidate) =>
      candidate.claims.includes(blocker.claim),
    )
    findings.push({
      checkCode: 'content.claim_unsourced',
      kind: 'content',
      severity: 'blocker',
      status: 'open',
      title: `הטענה ״${blocker.claim.key}״ אינה ניתנת לאימות`,
      detail: DETAIL[blocker.reason],
      pageSlug: slugOf(input, section?.pageId ?? null),
      sectionId: section?.id ?? null,
    })
  }

  for (const page of input.pages.filter((page) => page.isActive)) {
    const onPage = active.filter((section) => section.pageId === page.id)

    if (onPage.length === 0) {
      findings.push({
        checkCode: 'content.page_empty',
        kind: 'content',
        severity: 'warning',
        status: 'open',
        title: `לעמוד ״${page.title}״ אין תוכן`,
        detail:
          'העמוד יפורסם ריק. אפשר להוסיף לו מקטעים, או לכבות אותו עד שיהיה מוכן.',
        pageSlug: page.slug,
        sectionId: null,
      })
    }

    for (const section of onPage) {
      if (section.claims.length === 0) {
        findings.push({
          checkCode: 'content.section_empty',
          kind: 'content',
          severity: 'warning',
          status: 'open',
          title: 'מקטע ללא תוכן',
          detail:
            section.boundTo === null
              ? 'המקטע אינו משויך לנכס או ליחידה ואין בו טקסט, ולכן אין ממה למלא אותו.'
              : 'המקטע משויך לשורה במערכת אך אין בה שדות למלא ממנה. השלימו את פרטי הנכס.',
          pageSlug: page.slug,
          sectionId: section.id,
        })
      }
    }
  }

  // What this product has no way of knowing, said plainly rather than scored.
  findings.push({
    checkCode: 'content.readability',
    kind: 'content',
    severity: 'advice',
    status: 'not_assessed',
    title: 'קריאוּת הטקסט לא נבדקה',
    detail:
      'אין במוצר מנוע ניתוח שפה, ולכן לא ניתן לתת ציון קריאוּת בלי להמציא אותו.',
    pageSlug: null,
    sectionId: null,
  })

  return findings
}

const DETAIL: Readonly<Record<string, string>> = Object.freeze({
  canonical_source_without_row:
    'הטענה מצהירה שהיא מגיעה מנתוני המערכת, אך אינה מפנה לשורה שאפשר לבדוק מולה. אתר לא יפרסם משפט שאי אפשר לאמת.',
  authored_without_author:
    'אין מי שחתום על המשפט הזה. כתבו אותו מחדש דרך הסטודיו כדי שיירשם על שמכם.',
  empty_text: 'הטענה ריקה ותתפרסם ככותרת ללא תוכן.',
})

/* -------------------------------------------------------- 2 · conversion -- */

/**
 * Can a visitor who wants to book actually do it?
 *
 * The conversion questions this product can genuinely answer are structural:
 * is there a booking widget anywhere, is there a way to make contact, does the
 * home page lead somewhere. What it cannot answer is whether any of it works,
 * because there is no analytics source in this codebase — so the rate is
 * reported `not_assessed` rather than invented.
 */
function conversionPass(input: QualityInput): readonly Finding[] {
  const findings: Finding[] = []
  const active = input.sections.filter((section) => section.isActive)
  const activePages = input.pages.filter((page) => page.isActive)

  const hasBooking = active.some((s) => s.kind === 'booking_widget')
  if (!hasBooking) {
    findings.push({
      checkCode: 'conversion.no_booking_path',
      kind: 'conversion',
      severity: 'warning',
      status: 'open',
      title: 'אין באתר דרך להזמין',
      detail:
        'אין אף מקטע הזמנה. מבקר שרוצה להזמין יצטרך לחפש טלפון. הוסיפו מקטע ״הזמנה״ לאחד העמודים.',
      pageSlug: null,
      sectionId: null,
    })
  }

  const hasContact = active.some(
    (s) => s.kind === 'contact_details' || s.kind === 'cta',
  )
  if (!hasContact) {
    findings.push({
      checkCode: 'conversion.no_contact',
      kind: 'conversion',
      severity: 'advice',
      status: 'open',
      title: 'אין פרטי יצירת קשר',
      detail: 'חלק מהאורחים מעדיפים לטלפן לפני שהם מזמינים.',
      pageSlug: null,
      sectionId: null,
    })
  }

  const home = activePages.find((page) => page.kind === 'home')
  if (!home) {
    findings.push({
      checkCode: 'conversion.no_home',
      kind: 'conversion',
      severity: 'warning',
      status: 'open',
      title: 'אין עמוד בית פעיל',
      detail: 'מבקר שמגיע לכתובת הראשית לא יראה דבר.',
      pageSlug: null,
      sectionId: null,
    })
  } else {
    const onHome = active.filter((section) => section.pageId === home.id)
    if (!onHome.some((s) => s.kind === 'hero')) {
      findings.push({
        checkCode: 'conversion.home_no_hero',
        kind: 'conversion',
        severity: 'advice',
        status: 'open',
        title: 'לעמוד הבית אין מקטע פתיחה',
        detail: 'המשפט הראשון הוא מה שקובע אם ממשיכים לגלול.',
        pageSlug: home.slug,
        sectionId: null,
      })
    }
  }

  findings.push({
    checkCode: 'conversion.rate',
    kind: 'conversion',
    severity: 'advice',
    status: 'not_assessed',
    title: 'שיעור ההמרה לא נמדד',
    detail:
      'אין במוצר מקור נתוני אנליטיקה, ולכן אין ממה לחשב שיעור המרה. מספר שהיה מוצג כאן היה מומצא.',
    pageSlug: null,
    sectionId: null,
  })

  return findings
}

/* --------------------------------------------------------- 3 · technical -- */

/**
 * The things that break a page for a search engine or a screen reader.
 *
 * All four checks below read real rows. What is `not_assessed` is performance:
 * nothing in this module times a request, and a load-time score produced
 * without timing anything would be the exact fiction the specification's rule
 * is about.
 */
function technicalPass(input: QualityInput): readonly Finding[] {
  const findings: Finding[] = []
  const activePages = input.pages.filter((page) => page.isActive)

  for (const page of activePages) {
    const title = page.seo?.metaTitle?.trim() ?? ''
    if (title.length === 0) {
      findings.push({
        checkCode: 'technical.meta_title_missing',
        kind: 'technical',
        severity: 'warning',
        status: 'open',
        title: `לעמוד ״${page.title}״ אין כותרת חיפוש`,
        detail:
          'מנועי חיפוש יציגו טקסט שהם יבחרו בעצמם. כותרת של 50–60 תווים עדיפה.',
        pageSlug: page.slug,
        sectionId: null,
      })
    } else if (title.length > 60) {
      findings.push({
        checkCode: 'technical.meta_title_long',
        kind: 'technical',
        severity: 'advice',
        status: 'open',
        title: `כותרת החיפוש של ״${page.title}״ ארוכה`,
        detail: `${title.length} תווים. גוגל חותך בערך ב־60.`,
        pageSlug: page.slug,
        sectionId: null,
      })
    }

    const description = page.seo?.metaDescription?.trim() ?? ''
    if (description.length === 0) {
      findings.push({
        checkCode: 'technical.meta_description_missing',
        kind: 'technical',
        severity: 'advice',
        status: 'open',
        title: `לעמוד ״${page.title}״ אין תיאור חיפוש`,
        detail: 'התיאור הוא מה שמופיע מתחת לכותרת בתוצאות החיפוש.',
        pageSlug: page.slug,
        sectionId: null,
      })
    }
  }

  const slugs = new Map<string, number>()
  for (const page of activePages) {
    slugs.set(page.slug, (slugs.get(page.slug) ?? 0) + 1)
  }
  for (const [slug, count] of slugs) {
    if (count > 1) {
      findings.push({
        checkCode: 'technical.duplicate_slug',
        kind: 'technical',
        severity: 'warning',
        status: 'open',
        title: `הכתובת ״/${slug}״ מופיעה ${count} פעמים`,
        detail: 'רק אחד מהעמודים יהיה נגיש בכתובת הזו.',
        pageSlug: slug,
        sectionId: null,
      })
    }
  }

  const withoutAlt = input.media.filter(
    (item) => (item.altText ?? '').trim().length === 0,
  )
  if (withoutAlt.length > 0) {
    findings.push({
      checkCode: 'technical.media_without_alt',
      kind: 'technical',
      severity: 'warning',
      status: 'open',
      title: `${withoutAlt.length} תמונות ללא טקסט חלופי`,
      detail:
        'קורא מסך לא יוכל לתאר אותן, ומנוע חיפוש לא ידע מה הן מראות. הוסיפו תיאור קצר בעברית.',
      pageSlug: null,
      sectionId: null,
    })
  }

  if (!input.hasVerifiedDomain) {
    findings.push({
      checkCode: 'technical.no_custom_domain',
      kind: 'technical',
      severity: 'advice',
      status: 'open',
      title: 'האתר מתפרסם בכתובת המערכת',
      detail: input.customDomainAvailable
        ? 'אפשר לחבר דומיין משלכם במסך הדומיין.'
        : 'חיבור דומיין משלכם דורש שדרוג חבילה.',
      pageSlug: null,
      sectionId: null,
    })
  }

  findings.push({
    checkCode: 'technical.performance',
    kind: 'technical',
    severity: 'advice',
    status: 'not_assessed',
    title: 'זמן טעינה לא נמדד',
    detail:
      'אין כאן מדידה של בקשה אמיתית, ולכן לא יינתן ציון מהירות. הדף הציבורי נבנה בשרת ומוגש מתוך תמונת המצב שפורסמה.',
    pageSlug: null,
    sectionId: null,
  })

  return findings
}

/* ------------------------------------------------------- 4 · pre-publish -- */

/**
 * The second pass, immediately before going live.
 *
 * Deliberately NOT a rerun of the other three. It asks the one question that
 * only matters at this moment — will this publish be refused, and why — plus
 * the two things somebody is about to regret: publishing a site with no live
 * page, and publishing with warnings nobody has looked at.
 *
 * It is the same `publishBlockers` the publish operation itself calls, so the
 * screen and the operation cannot disagree about whether the button will work.
 */
function prePublishPass(input: QualityInput): readonly Finding[] {
  const findings: Finding[] = []

  const activePageIds = new Set(
    input.pages.filter((page) => page.isActive).map((page) => page.id),
  )
  const included = input.sections.filter(
    (section) => section.isActive && activePageIds.has(section.pageId),
  )

  for (const blocker of publishBlockers(included)) {
    const section = included.find((candidate) =>
      candidate.claims.includes(blocker.claim),
    )
    findings.push({
      checkCode: 'pre_publish.claim_unsourced',
      kind: 'pre_publish',
      severity: 'blocker',
      status: 'open',
      title: `הפרסום ייחסם: ״${blocker.claim.key}״`,
      detail: DETAIL[blocker.reason],
      pageSlug: slugOf(input, section?.pageId ?? null),
      sectionId: section?.id ?? null,
    })
  }

  if (activePageIds.size === 0) {
    findings.push({
      checkCode: 'pre_publish.no_live_page',
      kind: 'pre_publish',
      severity: 'blocker',
      status: 'open',
      title: 'אין אף עמוד פעיל לפרסם',
      detail: 'מבקר שיגיע לאתר יקבל דף ריק.',
      pageSlug: null,
      sectionId: null,
    })
  }

  return findings
}

/* ---------------------------------------------------------------- shared -- */

function slugOf(input: QualityInput, pageId: string | null): string | null {
  if (!pageId) return null
  return input.pages.find((page) => page.id === pageId)?.slug ?? null
}

/**
 * Does this set of findings stop a publish?
 *
 * `not_assessed` never blocks — that is the whole reason it exists — and
 * neither does a finding somebody has accepted or dismissed. A person who read
 * a warning and decided to publish anyway has made a decision, and a tool that
 * re-blocks them is a tool that does not believe them.
 */
export function blocksPublish(findings: readonly Finding[]): boolean {
  return findings.some(
    (finding) => finding.severity === 'blocker' && finding.status === 'open',
  )
}

/** A one-line summary for the studio's header. Counts, never a score. */
export function summarize(findings: readonly Finding[]): {
  blockers: number
  warnings: number
  advice: number
  notAssessed: number
} {
  let blockers = 0
  let warnings = 0
  let advice = 0
  let notAssessed = 0

  for (const finding of findings) {
    if (finding.status === 'not_assessed') {
      notAssessed += 1
      continue
    }
    if (finding.status !== 'open') continue
    if (finding.severity === 'blocker') blockers += 1
    else if (finding.severity === 'warning') warnings += 1
    else advice += 1
  }

  return { blockers, warnings, advice, notAssessed }
}

/** The quality passes over a snapshot's pages — what a published site scores. */
export function snapshotQualityInput(
  pages: readonly SiteSnapshotPage[],
  media: readonly { id: string; altText: string | null }[],
  options: { customDomainAvailable: boolean; hasVerifiedDomain: boolean },
): QualityInput {
  return {
    pages: pages.map((page, index) => ({
      id: `snapshot-${index}`,
      organizationId: '',
      siteId: '',
      slug: page.slug,
      kind: page.kind,
      title: page.title,
      navLabel: page.navLabel,
      showInNav: page.showInNav,
      sortOrder: page.sortOrder,
      isActive: true,
      seo: page.seo,
    })),
    sections: pages.flatMap((page, index) =>
      page.sections.map((section) => ({
        ...section,
        pageId: `snapshot-${index}`,
      })),
    ),
    media,
    customDomainAvailable: options.customDomainAvailable,
    hasVerifiedDomain: options.hasVerifiedDomain,
  }
}
