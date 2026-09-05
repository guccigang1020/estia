/**
 * DESIGN AS TOKENS, NEVER AS CSS.
 *
 * ── Why a fixed vocabulary and not a colour picker ────────────────────────
 *
 * Because the stored value ends up on a public page, and a public page that
 * interpolates a stored string into a `style` attribute is one stored string
 * away from being somebody else's script. `#a3b18a` looks harmless until the
 * value is `red;} body{display:none` or a `url(javascript:...)`.
 *
 * So `SiteDesign` carries five closed choices, `readDesign` refuses anything
 * outside them and falls back to the default rather than throwing, and
 * `cssVariables` maps them to a record of custom properties whose VALUES this
 * file wrote. Nothing a user typed reaches a stylesheet.
 *
 * The cost is that a business cannot have an arbitrary brand colour. That is a
 * real limitation and the honest trade: five palettes chosen for Israeli
 * hospitality, or an XSS surface on every published site in the product.
 *
 * ── RTL ───────────────────────────────────────────────────────────────────
 *
 * Nothing here has a `left` or a `right`. The public renderer is `dir="rtl"`
 * and uses logical properties throughout, so a future left-to-right locale is
 * a `dir` attribute rather than a second stylesheet.
 */

import { DEFAULT_SITE_DESIGN, type SiteDesign } from './types'

const PALETTES = ['sand', 'olive', 'sea', 'stone', 'night'] as const
const FONTS = ['system', 'serif', 'display'] as const
const RADII = ['sharp', 'soft', 'round'] as const
const DENSITIES = ['comfortable', 'compact'] as const

export const SITE_PALETTES = PALETTES
export const SITE_HEADING_FONTS = FONTS
export const SITE_RADII = RADII
export const SITE_DENSITIES = DENSITIES

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * Read a stored `design` jsonb into the bounded type.
 *
 * Never throws. A design row written by an older version of the product, or by
 * hand, or half-migrated, produces the default rather than a broken page — a
 * website that will not render because a colour name changed is a worse
 * outcome than a website in the default palette.
 */
export function readDesign(value: unknown): SiteDesign {
  if (typeof value !== 'object' || value === null) return DEFAULT_SITE_DESIGN

  const row = value as Record<string, unknown>
  const logo = row.logoMediaId

  return {
    palette: pick(row.palette, PALETTES, DEFAULT_SITE_DESIGN.palette),
    headingFont: pick(row.headingFont, FONTS, DEFAULT_SITE_DESIGN.headingFont),
    radius: pick(row.radius, RADII, DEFAULT_SITE_DESIGN.radius),
    density: pick(row.density, DENSITIES, DEFAULT_SITE_DESIGN.density),
    logoMediaId: typeof logo === 'string' && logo.length > 0 ? logo : null,
  }
}

/**
 * The five palettes, as values this file wrote.
 *
 * Every string below is a literal in source. There is no path from a stored
 * value to a colour: `readDesign` narrows to one of five keys and this record
 * is looked up by that key, so the worst a corrupted row can do is choose the
 * wrong palette.
 */
const PALETTE_TOKENS: Readonly<
  Record<SiteDesign['palette'], Readonly<Record<string, string>>>
> = Object.freeze({
  sand: {
    '--site-bg': '#faf7f2',
    '--site-surface': '#ffffff',
    '--site-ink': '#2b2620',
    '--site-muted': '#6f665a',
    '--site-accent': '#a8763e',
    '--site-accent-ink': '#ffffff',
    '--site-line': '#e7ded1',
  },
  olive: {
    '--site-bg': '#f6f7f1',
    '--site-surface': '#ffffff',
    '--site-ink': '#262b20',
    '--site-muted': '#5f6a53',
    '--site-accent': '#5a7247',
    '--site-accent-ink': '#ffffff',
    '--site-line': '#dde3d2',
  },
  sea: {
    '--site-bg': '#f2f7f9',
    '--site-surface': '#ffffff',
    '--site-ink': '#1d2b31',
    '--site-muted': '#54686f',
    '--site-accent': '#2f6f83',
    '--site-accent-ink': '#ffffff',
    '--site-line': '#d3e2e7',
  },
  stone: {
    '--site-bg': '#f5f5f4',
    '--site-surface': '#ffffff',
    '--site-ink': '#26262a',
    '--site-muted': '#63636b',
    '--site-accent': '#4a4a52',
    '--site-accent-ink': '#ffffff',
    '--site-line': '#e0e0de',
  },
  night: {
    '--site-bg': '#15171b',
    '--site-surface': '#1e2127',
    '--site-ink': '#f2f3f5',
    '--site-muted': '#a3a8b3',
    '--site-accent': '#c9a227',
    '--site-accent-ink': '#15171b',
    '--site-line': '#2c3037',
  },
})

const FONT_TOKENS: Readonly<Record<SiteDesign['headingFont'], string>> =
  Object.freeze({
    system:
      'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", Arial, sans-serif',
    serif: '"Frank Ruhl Libre", "Noto Serif Hebrew", Georgia, serif',
    display: '"Heebo", "Noto Sans Hebrew", system-ui, sans-serif',
  })

const RADIUS_TOKENS: Readonly<Record<SiteDesign['radius'], string>> =
  Object.freeze({ sharp: '0px', soft: '10px', round: '22px' })

const DENSITY_TOKENS: Readonly<Record<SiteDesign['density'], string>> =
  Object.freeze({ comfortable: '4.5rem', compact: '2.75rem' })

/**
 * The custom properties a published page is rendered with.
 *
 * Returned as a record rather than as a string so the caller passes it to
 * React's `style` prop, which escapes. A function returning a `<style>` body
 * would be a function somebody eventually dangerously-sets.
 */
export function cssVariables(design: SiteDesign): Record<string, string> {
  return {
    ...PALETTE_TOKENS[design.palette],
    '--site-heading-font': FONT_TOKENS[design.headingFont],
    '--site-radius': RADIUS_TOKENS[design.radius],
    '--site-section-gap': DENSITY_TOKENS[design.density],
  }
}

/** Is this dark? The public layout needs to know for its `color-scheme`. */
export function isDarkPalette(design: SiteDesign): boolean {
  return design.palette === 'night'
}
