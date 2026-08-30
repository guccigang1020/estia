/**
 * Is this process running the demo?
 *
 * The single source of truth for the switch. Everything that changes shape in
 * demo mode — the client, the session, the persona switcher — asks this and
 * nothing else, so that "is the demo on?" has exactly one answer and there is
 * no second variable to set out of step with the first.
 *
 * ── Why the literal `process.env.NEXT_PUBLIC_ESTIA_DEMO` ──────────────────
 *
 * Next.js replaces `process.env.NEXT_PUBLIC_*` textually at build time, and
 * only when it is written as a full member expression. Destructuring it
 * (`const { NEXT_PUBLIC_ESTIA_DEMO } = process.env`) or reading it through a
 * computed key defeats the substitution and the value silently becomes
 * `undefined` in every client bundle. So it is written out, once, here.
 *
 * ── Why `'1'` and not a truthiness check ──────────────────────────────────
 *
 * `NEXT_PUBLIC_ESTIA_DEMO=0` and `=false` are things a person writes when they
 * mean "off", and both are truthy strings. An exact match against `'1'` makes
 * every value that is not deliberately the demo mean production, which is the
 * safe direction for a switch that replaces the database and the identity.
 *
 * ── Why production needs a second, differently-named variable ─────────────
 *
 * The demo does not merely swap a data source. `proxy.ts` returns early when
 * it is on, which takes down the authentication wall for the whole
 * application — that is correct for a laptop and catastrophic for a
 * deployment. And `NEXT_PUBLIC_ESTIA_DEMO` is baked into the bundle at build
 * time, so a stray value in a hosting provider's environment is enough: there
 * is no runtime moment at which somebody notices and turns it off.
 *
 * One variable is too easy to set by accident. Two are not, when the second
 * says out loud what it permits. In a production build the demo therefore
 * stays off unless `NEXT_PUBLIC_ESTIA_DEMO_ALLOW_PRODUCTION` is also exactly
 * `'1'` — which is how a deliberately hosted showroom is still possible.
 *
 * It refuses by returning `false` rather than by throwing. A throw here would
 * run inside the client bundle and replace the product with an error page; a
 * `false` leaves the real application standing with its sign-in wall intact,
 * which is the outcome worth defaulting to when the two variables disagree.
 *
 * Both are `NEXT_PUBLIC_` deliberately. A server-only second variable would
 * make the server think the demo is on while every client bundle thought it
 * was off — one switch with two answers, which is the thing this module
 * exists to prevent.
 */
export function isDemoMode(): boolean {
  if (process.env.NEXT_PUBLIC_ESTIA_DEMO !== '1') return false

  if (process.env.NODE_ENV === 'production') {
    return process.env.NEXT_PUBLIC_ESTIA_DEMO_ALLOW_PRODUCTION === '1'
  }

  return true
}
