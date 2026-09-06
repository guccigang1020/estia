/**
 * "The owner portal's storage is not built here", said precisely and once.
 *
 * `DomainGap` already argues why this is not an empty state: a module with no
 * rows and a module with no *table* look identical on screen and are opposite
 * situations. Rendering "אין בעלי נכסים" over a database that could not hold
 * one tells a buyer the product works and this business simply has no owners,
 * and the first person to add one and watch nothing appear concludes ESTIA is
 * broken.
 *
 * This wraps it so the three owner screens say the same sentence and name the
 * same five tables. Three copies of a list of table names is three chances for
 * one of them to be stale after the migration lands.
 *
 * No `"use client"`: it renders text.
 */

import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'

import { OWNER_TABLES } from '../_lib/queries'

export function OwnersGap({ context }: { context: string }) {
  return (
    <DomainGap
      title="אחסון פורטל הבעלים עדיין לא קיים במסד"
      body={
        <>
          {context} ההרשאות, החבילה והתפקיד ״בעל נכס״ כבר קיימים ונמכרים,
          והלוגיקה — הדוח, ההפרדה בין בעלים לבעלים, והאישורים — כתובה ונבדקת. מה
          שחסר הוא המיגרציה שיוצרת את הטבלאות. ברגע שהיא תרוץ המסך הזה יתמלא
          מעצמו, בלי שינוי קוד.
        </>
      }
      missingTables={[...OWNER_TABLES]}
      alreadyBuilt={[
        <>
          ההרשאות <GrantCode>owner.view</GrantCode>,{' '}
          <GrantCode>owner.manage</GrantCode>,{' '}
          <GrantCode>owner_statement.view</GrantCode>,{' '}
          <GrantCode>owner_statement.issue</GrantCode> ו-
          <GrantCode>owner.view_commission</GrantCode>
        </>,
        <>
          היכולת <GrantCode>owner_portal</GrantCode> בחבילות pro ו-management
        </>,
        <>התפקיד ״בעל נכס״ עם ארבע הרשאות בלבד, כפי שהוא מורכב היום</>,
        <>
          טבלת <GrantCode>approvals</GrantCode> הקיימת, שבקשות בעלים נכתבות אליה
          כ-<GrantCode>owner_request</GrantCode> ולא לטבלה חדשה
        </>,
        <>
          האירועים <GrantCode>owner_statement.issued</GrantCode> ו-
          <GrantCode>owner_payout.paid</GrantCode> בקטלוג האירועים
        </>,
      ]}
    />
  )
}
