/**
 * The public site's own not-found page.
 *
 * ── Why this file exists rather than falling through to the root one ─────
 *
 * `src/app/not-found.tsx` is ESTIA's 404, and it belongs to ESTIA: it says
 * what the product is and offers a way back into it. A visitor who mistyped a
 * customer's website address is not a user of ESTIA and has no interest in it,
 * and showing them the vendor's chrome at the moment they were looking for a
 * villa in the Galilee is the product intruding on the customer's brand.
 *
 * So the boundary is claimed here, above `[slug]`, and says one plain sentence
 * with nothing to click. It is deliberately styleless beyond the base type:
 * the design tokens belong to a site, and at this point there is no site.
 *
 * ── What it does NOT say ─────────────────────────────────────────────────
 *
 * "This site has not been published yet." A slug nobody claimed and a slug
 * somebody is still building are the same answer to a stranger — telling them
 * a business is preparing a website discloses something the business did not
 * choose to disclose.
 */

export default function PublicSiteNotFound() {
  return (
    <div
      dir="rtl"
      className="mx-auto flex min-h-svh w-full max-w-lg flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <h1 className="font-display text-2xl font-bold text-foreground">
        לא מצאנו אתר בכתובת הזו
      </h1>
      <p className="text-sm text-muted-foreground">
        ייתכן שהכתובת הועתקה חלקית. בדקו אותה מול הקישור שקיבלתם.
      </p>
    </div>
  )
}
