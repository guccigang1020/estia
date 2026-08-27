import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT.
 *
 * The frame shared by every screen in the auth route group. Direction and
 * language are already set on `<html>` by the root layout (`lang="he"`,
 * `dir="rtl"`), so nothing here restates them — one source for document
 * direction, not two that can drift apart.
 *
 * Purely presentational. The access decisions live one level down, in the
 * `(guest)` and `(protected)` layouts, because the two groups want opposite
 * answers to the same question.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 bg-background px-5 py-12">
      <Link
        href="/"
        className="font-display text-2xl font-bold tracking-tight text-primary"
      >
        ESTIA
      </Link>

      {children}

      <p className="max-w-prose text-center text-xs text-muted-foreground">
        מערכת ניהול אירוח לצימרים, וילות ובתי אירוח.
      </p>
    </main>
  )
}
