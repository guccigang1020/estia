import type { Metadata } from 'next'
import { Frank_Ruhl_Libre, Heebo } from 'next/font/google'
import { ToastProvider } from '@/components/ui/toast'
import './globals.css'

/**
 * Product typography. Both families are self-hosted by next/font at build time.
 *
 * Heebo — body face. Hebrew + Latin, variable weight 100-900.
 * Frank Ruhl Libre — display face for headings. Hebrew + Latin, 300-900.
 *
 * Only the CSS variables are exported into the tree; the actual font tokens
 * (`--font-sans`, `--font-display`) are assembled in globals.css so that
 * typography stays swappable from the same place as the rest of the style.
 */
const heebo = Heebo({
  variable: '--font-heebo',
  subsets: ['hebrew', 'latin'],
  display: 'swap',
})

const frankRuhlLibre = Frank_Ruhl_Libre({
  variable: '--font-frank-ruhl-libre',
  subsets: ['hebrew', 'latin'],
  weight: ['500', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'ESTIA',
    template: '%s · ESTIA',
  },
  description:
    'מערכת ניהול אירוח לצימרים, וילות ובתי אירוח בישראל — הזמנות, יומן, אורחים וגבייה במקום אחד, עם אתר שמקבל הזמנות ישירות.',
  applicationName: 'ESTIA',
  openGraph: {
    type: 'website',
    locale: 'he_IL',
    siteName: 'ESTIA',
    title: 'ESTIA',
    description:
      'מערכת ניהול אירוח לצימרים, וילות ובתי אירוח בישראל — הזמנות, יומן, אורחים וגבייה במקום אחד, עם אתר שמקבל הזמנות ישירות.',
  },
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="he"
      dir="rtl"
      className={`${heebo.variable} ${frankRuhlLibre.variable} h-full antialiased`}
    >
      {/*
        ToastProvider wraps the whole tree because a toast is a property of the
        window, not of a screen: it must survive navigation and it must render
        above whatever is on top. Its live region is mounted here from the
        first paint, so a message announced a moment after load is not missed
        by a screen reader that had nothing to observe yet.
      */}
      <body className="flex min-h-full flex-col font-sans">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
