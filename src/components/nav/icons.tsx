/**
 * The navigation icon set.
 *
 * Inline paths rather than an icon package, matching the approach already used
 * on the marketing page: adding a dependency is a package.json decision and
 * this file is a dozen paths. `currentColor` throughout, so an icon inherits
 * whatever token its container sets and never carries a colour of its own.
 *
 * There is one icon per menu SECTION, not per item. Forty item glyphs would be
 * forty small decisions about meaning, most of them arbitrary, and a Hebrew
 * sidebar reads perfectly well as text. The section icons carry the mobile bar
 * and the collapsed rail, where a glyph genuinely has to stand alone.
 */

const PATHS = {
  // ── Sections ──────────────────────────────────────────────────────────
  home: [
    'M3.5 10.2 12 3.5l8.5 6.7',
    'M5.8 8.9V19a1.5 1.5 0 0 0 1.5 1.5h9.4a1.5 1.5 0 0 0 1.5-1.5V8.9',
  ],
  calendar: [
    'M8 2.5v4M16 2.5v4M3.5 10.5h17',
    'M5.5 4.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z',
  ],
  globe: [
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
    'M3.6 9.2h16.8M3.6 14.8h16.8',
    'M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9',
    'M12 3c-2.4 2.6-3.6 5.6-3.6 9s1.2 6.4 3.6 9',
  ],
  operations: [
    'M14.7 6.3a3.9 3.9 0 0 0 5 5L15 16l-3.6 3.6a2.1 2.1 0 0 1-3-3L12 13Z',
    'M8.6 8.6 5.2 5.2M4 9.4 9.4 4',
  ],
  finance: [
    'M3 7.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z',
    'M3 10.5h18M6.5 15h4',
  ],
  // A shopfront awning over a counter. The store section needed an icon and
  // borrowing `finance` would have given two different sections the same
  // mark — the one thing a sidebar icon exists to prevent.
  store: [
    'M4 9.5h16l-1 9.5a1.5 1.5 0 0 1-1.5 1.3h-11A1.5 1.5 0 0 1 5 19Z',
    'M3.5 9.5 5 4.2h14l1.5 5.3M9 13.5h6',
  ],
  spark: [
    'M12 3.2 13.7 8l4.8 1.7-4.8 1.7L12 16.2 10.3 11.4 5.5 9.7l4.8-1.7Z',
    'M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z',
  ],
  building: [
    'M4.5 20.5V5.2a1.5 1.5 0 0 1 1.5-1.5h7a1.5 1.5 0 0 1 1.5 1.5v15.3',
    'M14.5 10h3.8a1.5 1.5 0 0 1 1.5 1.5v9M3 20.5h18',
    'M8 7.5h2.5M8 11.5h2.5M8 15.5h2.5',
  ],
  settings: [
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
    'M19.3 14.2a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.5 1Z',
  ],

  // ── Chrome ────────────────────────────────────────────────────────────
  search: [
    'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z',
    'm20.5 20.5-4.2-4.2',
  ],
  plus: ['M12 5.5v13M5.5 12h13'],
  bell: [
    'M18 8.8a6 6 0 1 0-12 0c0 5.2-2 6.8-2 6.8h16s-2-1.6-2-6.8Z',
    'M13.7 19.2a2 2 0 0 1-3.4 0',
  ],
  user: [
    'M19 20v-1.7a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20',
    'M12 10.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z',
  ],
  menu: ['M4 7h16M4 12h16M4 17h16'],
  close: ['m6 6 12 12M18 6 6 18'],
  chevron: ['m6 9.5 6 6 6-6'],
  lock: [
    'M6.5 10.5h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5Z',
    'M8.2 10.5V7.8a3.8 3.8 0 1 1 7.6 0v2.7',
  ],
  property: [
    'M4 20.5h16M5.5 20.5V9.8L12 5l6.5 4.8v10.7',
    'M10 20.5v-4.8h4v4.8',
  ],
  check: ['m4.5 12.5 5 5 10-11'],
} as const

export type NavIconName = keyof typeof PATHS

export function NavIcon({
  name,
  className = 'size-5',
}: {
  name: NavIconName
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
