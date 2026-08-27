import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/components/ui/cn'

/* The one layout measure the page repeats. The width itself is a theme token
   (`max-w-shell`), so only the gutter rhythm lives here. */
const SHELL = 'mx-auto w-full max-w-shell px-5 sm:px-8 lg:px-10'

/* -------------------------------------------------------------- content -- */

type Capability = {
  title: string
  body: string
  icon: keyof typeof ICON_PATHS
}

const CAPABILITIES: Capability[] = [
  {
    icon: 'calendar',
    title: 'יומן והזמנות',
    body: 'לוח שנה עברי עם חגים ומועדים, הזמנות שלא מתנגשות, וצ׳ק-אין שלא תלוי בזיכרון של אף אחד.',
  },
  {
    icon: 'globe',
    title: 'אתר שמייצר הכנסה',
    body: 'אתר עסקי עם הזמנה ישירה. כל הזמנה שלא עוברת דרך ערוץ חיצוני היא עמלה שנשארת אצלך.',
  },
  {
    icon: 'payment',
    title: 'כסף וניירת',
    body: 'סליקה, פיקדון והחזרים, חוזה חתום דיגיטלית, וחשבונית אוטומטית לכל תשלום.',
  },
  {
    icon: 'team',
    title: 'צוות ותפעול',
    body: 'שיבוצי ניקיון, משימות ותחזוקה, ותפקידים שנאכפים בשרת — לא בהסתרת כפתור.',
  },
]

type PackageCard = {
  id: string
  name: string
  tagline: string
  price: string
  capacity: string
  inherits: string | null
  features: string[]
  featured?: boolean
  note?: string
}

const PACKAGES: PackageCard[] = [
  {
    id: 'basic',
    name: 'Basic',
    tagline: 'ניהול בלבד',
    price: '149',
    capacity: 'נכס אחד · 2 יחידות · 2 משתמשים',
    inherits: null,
    features: [
      'הזמנות, אורחים ויומן עברי',
      'עמוד אורח, חוזה וחתימה דיגיטלית',
      'סליקה, פיקדון והחזרים',
      'חשבוניות אוטומטיות ותבניות WhatsApp',
    ],
  },
  {
    id: 'direct',
    name: 'Direct',
    tagline: 'ניהול + אתר',
    price: '299',
    capacity: 'נכס אחד · 4 יחידות · 3 משתמשים',
    inherits: 'Basic',
    featured: true,
    features: [
      'אתר עסקי עם SEO',
      'הזמנה ישירה באתר, בלי עמלת ערוץ',
      'תוכן שיווקי שנכתב ב-AI',
      'תת-דומיין משלך',
    ],
    note: 'הזמנה ישירה אחת של ₪2,000 חוסכת כ-₪300 עמלה. החבילה מחזירה את עצמה בהזמנה אחת בחודש.',
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'מתחמים',
    price: '649',
    capacity: '5 נכסים · 15 יחידות · 10 משתמשים',
    inherits: 'Direct',
    features: [
      'יומן רב-יחידתי',
      'צוות, תפקידים ושיבוצים',
      'ניקיון, משימות ותחזוקה',
      'ערוצי הפצה ותמחור דינמי',
    ],
  },
  {
    id: 'management',
    name: 'Management',
    tagline: 'חברות ניהול',
    price: '1,490',
    capacity: '25 נכסים · 60 יחידות · משתמשים ללא הגבלה',
    inherits: 'Pro',
    features: [
      'פורטל בעלי נכסים',
      'דוחות בעלים ועמלות',
      'אישורים, תקלות ומלאי',
      'תפקידים מותאמים וריבוי מותגים',
    ],
  },
]

const STEPS = [
  {
    title: '14 יום ניסיון',
    body: 'בלי כרטיס אשראי. מקימים נכס, מזינים הזמנה אמיתית, ורואים אם זה מתאים.',
  },
  {
    title: 'אשף הקמת אתר',
    body: 'חינם בכל חבילה שכוללת אתר. האתר עולה לאוויר עם תוכן ותמונות — לא כשלד ריק.',
  },
  {
    title: 'מחיר נעול',
    body: 'לקוחות מוקדמים נועלים את המחיר שלהם לתמיד, גם כשהמחירון יעלה.',
  },
]

/* ---------------------------------------------------------------- icons -- */

const ICON_PATHS = {
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
  payment: [
    'M3 7.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z',
    'M3 10.5h18M6.5 15h4',
  ],
  team: [
    'M15.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H7a3.5 3.5 0 0 0-3.5 3.5V20',
    'M9.5 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
    'M20.5 20v-1.5a3.5 3.5 0 0 0-2.7-3.4',
    'M15.5 4.7a3.5 3.5 0 0 1 0 6.6',
  ],
} as const

function Icon({
  name,
  className,
}: {
  name: keyof typeof ICON_PATHS
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
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="mt-1 size-4 shrink-0 text-success"
    >
      <path d="m4 10.5 4 4 8-9" />
    </svg>
  )
}

/* ----------------------------------------------------------------- page -- */

export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:right-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-5 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        דילוג לתוכן הראשי
      </a>

      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
        <div className={cn(SHELL, 'flex h-16 items-center justify-between')}>
          <span className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full bg-accent"
            />
            <span
              dir="ltr"
              className="font-display text-lg font-bold tracking-[0.22em] text-foreground"
            >
              ESTIA
            </span>
          </span>
          <Button href="#packages" variant="ghost">
            חבילות ומחירים
          </Button>
        </div>
      </header>

      <main id="main" className="flex-1">
        {/* ---------------------------------------------------------- hero */}
        <section
          aria-labelledby="hero-title"
          className="relative overflow-hidden border-b border-border"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(75%_60%_at_70%_0%,var(--color-primary-soft),transparent_70%)]"
          />
          <div className={cn(SHELL, 'relative py-16 sm:py-24 lg:py-32')}>
            <Badge tone="accent">14 יום ניסיון · בלי כרטיס אשראי</Badge>

            <h1 id="hero-title" className="mt-6">
              <span
                dir="ltr"
                className="block font-display text-5xl leading-none font-bold tracking-[0.18em] text-foreground sm:text-7xl"
              >
                ESTIA
              </span>
              {/* Explicit separator: without it the accessible name of the
                  heading reads as one run-together word. */}
              <span className="sr-only"> — </span>
              <span className="mt-5 block max-w-prose font-display text-[1.6rem] leading-snug font-medium text-foreground sm:text-4xl lg:text-[2.75rem]">
                ניהול אירוח שמחזיר לך את ההזמנה הישירה
              </span>
            </h1>

            <p className="mt-6 max-w-prose text-base text-muted-foreground sm:text-lg">
              מערכת אחת לצימרים, וילות ובתי אירוח בישראל: הזמנות, יומן עברי,
              אורחים וגבייה — ואתר עסקי שמקבל הזמנות ישירות, בלי עמלת ערוץ.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href="#packages" size="lg">
                לצפייה בחבילות
              </Button>
              <Button href="#capabilities" variant="secondary" size="lg">
                מה יש במערכת
              </Button>
            </div>

            <p className="mt-8 max-w-prose text-sm text-muted-foreground">
              <span className="font-semibold text-accent-strong">
                אין עמלה על תשלומים.
              </span>{' '}
              כל עסק מחבר את חשבון הסליקה שלו, והכסף עובר ישירות אליו.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------- capabilities */}
        <section
          id="capabilities"
          aria-labelledby="capabilities-title"
          className="scroll-mt-20 border-b border-border bg-muted/40"
        >
          <div className={cn(SHELL, 'py-16 sm:py-20 lg:py-24')}>
            <h2
              id="capabilities-title"
              className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
            >
              מערכת אחת, מההזמנה ועד החשבונית
            </h2>
            <p className="mt-3 max-w-prose text-muted-foreground">
              אבטחה, בידוד בין לקוחות, גיבויים ותיעוד פעולות אינם נמכרים בנפרד.
              הם הרצפה של המוצר — בכל חבילה, גם הזולה ביותר.
            </p>

            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {CAPABILITIES.map((item) => (
                <li key={item.icon} className="flex">
                  <Card className="w-full gap-4">
                    <span className="inline-flex size-11 items-center justify-center rounded-lg bg-primary-soft text-primary">
                      <Icon name={item.icon} className="size-6" />
                    </span>
                    <CardHeader>
                      <CardTitle className="text-lg">{item.title}</CardTitle>
                      <CardDescription>{item.body}</CardDescription>
                    </CardHeader>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------ packages */}
        <section
          id="packages"
          aria-labelledby="packages-title"
          className="scroll-mt-20 border-b border-border"
        >
          <div className={cn(SHELL, 'py-16 sm:py-20 lg:py-24')}>
            <h2
              id="packages-title"
              className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
            >
              חבילות ומחירים
            </h2>
            <p className="mt-3 max-w-prose text-muted-foreground">
              מחירים לחודש, לפני מע״מ. בתשלום שנתי — חודשיים מתנה. שדרוג מיידי
              בחיוב יחסי, הורדה בסוף מחזור החיוב.
            </p>

            <ul className="mt-10 grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-4">
              {PACKAGES.map((pkg) => (
                <li key={pkg.id} className="flex">
                  <Card
                    tone={pkg.featured ? 'featured' : 'default'}
                    className={cn('w-full', pkg.featured && 'xl:-mt-4')}
                  >
                    <CardHeader>
                      <span className="flex flex-wrap items-center gap-2">
                        <CardTitle
                          as="h3"
                          dir="ltr"
                          className="text-lg tracking-wide"
                        >
                          {pkg.name}
                        </CardTitle>
                        {pkg.featured ? (
                          <Badge tone="accent">הכי נבחרת</Badge>
                        ) : null}
                      </span>
                      <CardDescription>{pkg.tagline}</CardDescription>
                    </CardHeader>

                    <p className="mt-5 flex items-baseline gap-2">
                      <span className="font-display text-4xl font-bold text-foreground">
                        ₪{pkg.price}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        לחודש
                      </span>
                    </p>

                    <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs font-medium text-muted-foreground">
                      {pkg.capacity}
                    </p>

                    <CardContent className="mt-5">
                      <p className="text-xs font-semibold text-foreground">
                        {pkg.inherits
                          ? `כל מה שבחבילת ${pkg.inherits}, ובנוסף:`
                          : 'כל מה שצריך כדי לנהל צימר בודד:'}
                      </p>
                      <ul className="mt-3 flex flex-col gap-2.5">
                        {pkg.features.map((feature) => (
                          <li
                            key={feature}
                            className="flex items-start gap-2.5 text-sm text-muted-foreground"
                          >
                            <CheckIcon />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>
                    </CardContent>

                    {pkg.note ? (
                      <CardFooter>
                        <p className="text-xs leading-relaxed text-accent-strong">
                          {pkg.note}
                        </p>
                      </CardFooter>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>

            <p className="mt-8 max-w-prose text-sm text-muted-foreground">
              מעל 60 יחידות, או צורך ב-SSO, API ו-SLA — חבילת Enterprise, מחיר
              בהתאמה. יחידה נוספת ₪29 לחודש, משתמש נוסף ₪39 לחודש.
            </p>
          </div>
        </section>

        {/* --------------------------------------------------------- start */}
        <section
          id="start"
          aria-labelledby="start-title"
          className="scroll-mt-20"
        >
          <div className={cn(SHELL, 'py-16 sm:py-20 lg:py-24')}>
            <h2
              id="start-title"
              className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
            >
              איך מתחילים
            </h2>

            <ol className="mt-10 grid gap-6 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border-strong font-display text-sm font-bold text-accent-strong"
                  >
                    {index + 1}
                  </span>
                  <span className="flex flex-col gap-1.5">
                    <span className="font-display text-lg font-bold text-foreground">
                      {step.title}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {step.body}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-10">
              <Button href="#packages" variant="secondary">
                חזרה להשוואת החבילות
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-muted/40">
        <div
          className={cn(
            SHELL,
            'flex flex-col gap-3 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
          )}
        >
          <span dir="ltr" className="font-display font-bold tracking-[0.22em]">
            ESTIA
          </span>
          <span>כל המחירים לחודש ואינם כוללים מע״מ.</span>
        </div>
      </footer>
    </>
  )
}
