/**
 * `public.team_kind`, and nothing else.
 *
 * Its own file rather than a constant in `administration.ts`, and the reason
 * is the one `scripts/client-bundle.mjs` was written about: the crews panel is
 * a Client Component and needs this list to render a dropdown, while
 * `administration.ts` is server-only and pulls in the whole service pipeline —
 * `defineOperation`, the schema validator, the error taxonomy — none of which
 * belongs in a browser bundle to draw six options.
 *
 * The lesson that script records is "import the leaf module", so this is the
 * leaf. It imports nothing, and it is the single source for the enum's values
 * and their order: `administration.ts` validates against it, the store maps
 * through it, and the panel renders it, so the three cannot disagree.
 *
 * The order is the enum's own, from `0008_accommodation.sql`.
 */

export const TEAM_KINDS = [
  'housekeeping',
  'maintenance',
  'front_desk',
  'management',
  'sales',
  'other',
] as const

export type TeamKind = (typeof TEAM_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(TEAM_KINDS)

/**
 * A stored `kind` this build does not recognise reads as `other`.
 *
 * Checked rather than cast. `teams.kind` is a Postgres enum, so a value
 * outside this list means the database has grown one that the deployed build
 * has not — and rendering `other` is a truthful "unclassified" rather than a
 * crash on a screen whose whole job is to be readable.
 */
export function toTeamKind(value: string | null | undefined): TeamKind {
  return value !== null && value !== undefined && KIND_SET.has(value)
    ? (value as TeamKind)
    : 'other'
}
