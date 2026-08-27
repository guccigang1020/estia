/**
 * Minimal class-name joiner.
 *
 * Deliberately not `clsx` + `tailwind-merge`: this project has no such
 * dependency yet, and adding one is a package.json decision. The consequence
 * is that a `className` passed by a caller is APPENDED, not merged — so a
 * caller cannot reliably override a variant's own colour or padding utility.
 * Use `className` for additive concerns (layout, margin, order); change the
 * look through a variant instead.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
