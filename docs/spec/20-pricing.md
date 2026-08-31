# 20 · תמחור, תוכניות תעריפים ומבצעים

> אפיון קצה. נכתב לפי [`00-TEMPLATE.md`](00-TEMPLATE.md), עשרים הסעיפים בסדר הזה.
> מקור האמת הוא הקוד: `src/lib/booking/pricing.ts`, `src/lib/booking/types.ts`,
> `src/lib/hebrew-calendar/`, `src/lib/metrics/` (המילון והעובדות),
> `src/lib/contracts/states.ts`, `src/lib/finance/`,
> `supabase/migrations/0008_accommodation.sql`, `0009_booking_core.sql`.
> מה שהקוד כבר קובע — נלקח משם ולא מוגדר מחדש.

---

## 1. מטרת המודול

בעל צימר בישראל לא מוכר לילה אחד במחיר אחד. שישי־שבת עולה יותר מיום שלישי,
סוכות עולה יותר משישי־שבת רגיל, ינואר זול, ולסוכן שמביא לו עשר הזמנות בשנה
הוא נותן מחיר אחר מזה שבאתר. היום הוא מחזיק את כל זה בראש ובאקסל, וכשמישהו
שואל "למה יצא ₪6,400?" הוא פותח מחשבון.

המודול הזה הופך את ההחזקה־בראש למנוע. הוא לוקח נכס, יחידה, טווח תאריכים,
מספר אורחים, ערוץ, סוכן, מבצע וקופון — ומחזיר **מספר אחד, דטרמיניסטי,
שמסביר את עצמו שורה־שורה**. אותם קלטים מחזירים תמיד את אותו מספר, גם בעוד שנה,
גם אחרי שהמחירון השתנה.

שתי הבטחות שהמודול קיים בשבילן:

1. **אפשר להסביר כל מחיר.** הסכום הוא תמיד סכום השורות
   (`sumLines` ב-`src/lib/booking/pricing.ts`), אף פעם לא מספר שמישהו הקליד.
2. **מחירון שמשתנה היום לא נוגע בהזמנה מהחודש שעבר.** ההזמנה מחזיקה snapshot,
   לא הפניה למחירון.

---

## 2. משתמשים והרשאות

| תפקיד                               | מה הוא עושה כאן                                                 | הרשאות                                                                                                 | טווח                                 | מה הוא **לא** רואה                                                                            |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `organization_owner`                | קובע מחירון, רצפות ותקרות, מאשר תמחור דינמי                     | `pricing.manage` · `rate.view_public` · `rate.view_agent` · `rate.view_net` · `booking.override_price` | `all_organization`                   | —                                                                                             |
| `revenue_manager`                   | הבעלים המקצועי של המודול: לוח מחירים, עונות, מבצעים, מדיניות AI | `pricing.manage` · שלוש הרשאות ה-`rate.view_*` · `booking.override_price` · `agent_limits.manage`      | `all_organization` או `properties[]` | עלויות בפועל, רווחיות ברמת הזמנה (`booking.view_profitability`), מסמכי מס                     |
| `general_manager`                   | מאשר חריגה מתחת לרצפה, רואה הכול                                | `pricing.manage` · `rate.view_*` · `booking.override_price`                                            | `all_organization`                   | —                                                                                             |
| `property_manager`                  | מחירים של הנכסים שלו בלבד                                       | `pricing.manage` · `rate.view_public` · `rate.view_agent`                                              | `properties[]`                       | `rate.net` של נכסים שאינם שלו, וכל נכס מחוץ לטווח — נאכף ב-RLS ולא בסינון תוצאה               |
| `reservation_manager` · `reception` | מצטט מחיר, מפעיל קופון, לא משנה מחירון                          | `quote.create` · `quote.send` · `rate.view_public` · `booking.amend_price`                             | `all_organization`                   | `rate.agent`, `rate.net`, מסך עריכת המחירון                                                   |
| `sales_agent` · `senior_agent`      | מוכר לפי תוכנית תעריפים של סוכן                                 | `availability.view` · `quote.*` · הסולם `PRICE_LEVELS` (ראה `src/lib/authz/roles.ts`)                  | `properties[]` או `units[]`          | כל תעריף מעל הדרגה שהוקצתה לו. `net` בלי `agent` הוא צירוף בלתי ניתן לייצוג — הסולם מונע אותו |
| `referral_agent`                    | מפנה לקוח, לא מצטט                                              | `availability.view`                                                                                    | מוגבל                                | **כל מחיר.** `PRICE_LEVELS = 'none'`                                                          |
| `cleaner` · `maintenance`           | —                                                               | —                                                                                                      | `own_records`                        | **כל המודול.** אין לו אף `rate.view_*` ואף `booking.view_price`                               |
| `property_owner`                    | רואה את התעריף הציבורי של הנכס שלו                              | `rate.view_public` · `owner_statement.view`                                                            | `properties[]`                       | `rate.agent`, `rate.net`, מבצעים, המלצות AI, מחירים של נכסים אחרים                            |
| `accountant`                        | קורא מה נגבה, לא קובע מה ייגבה                                  | `finance.view` · `booking.view_price`                                                                  | `all_organization`                   | `pricing.manage`. חשבונאי לא משנה תאריכים ולא משנה מחירון                                     |
| `ai_agent` (מנוע ההמלצות)           | מציע מחיר, לעולם לא קובע                                        | בדיוק ההרשאות של המשתמש שהוא משרת — ראה §12                                                            | הטווח של אותו משתמש                  | כל מה שאותו משתמש לא רואה                                                                     |

**שלושה מחירים לאותו לילה, שלושה מעגלי אמון** — `rate.public` · `rate.agent` ·
`rate.net`, כפי שהם מוגדרים ב-`SENSITIVE_FIELDS`. אף אחד מהם אינו גורר את השני.
מי שמחזיק `rate.view_net` בלי `rate.view_public` הוא צירוף שהסולם ב-`roles.ts`
לא מייצר, וגם אם הוקצה ידנית — המנוע מכבד אותו כפי שהוא. Deny by default.

---

## 3. מודל הנתונים

כל טבלה נושאת `organization_id` ואת בלוק המטא-דאטה המלא
(`created_at` · `created_by` · `updated_at` · `updated_by` · `version`,
ו-`deleted_at` · `deleted_by` היכן שמחיקה רכה נכונה), לפי
[`ARCHITECTURE.md`](../ARCHITECTURE.md) §5.

### 3.1 `rate_plans` — תוכנית תעריפים

| עמודה                                   | טיפוס              | הערה                                                                                            |
| --------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `id`                                    | `uuid`             |                                                                                                 |
| `organization_id` · `property_id`       | `uuid`             | `property_id` nullable: תוכנית ברמת הארגון חלה על כל הנכסים                                     |
| `code`                                  | `text`             | מזהה מכונה יציב. לא משתנה כשהשם משתנה — אותו היגיון כמו `plans.code`                            |
| `name`                                  | `text`             | עברית, מוצג                                                                                     |
| `kind`                                  | `rate_plan_kind`   | `flexible` · `non_refundable` · `direct` · `agent` · `ota` · `corporate` · `owner_special`      |
| `channel_scope`                         | `booking_source[]` | לאילו ערוצים התוכנית זמינה. ריק = כולם                                                          |
| `requires_grant`                        | `text`             | ה-`Grant` שהמשתמש חייב להחזיק כדי לבחור אותה. `agent` דורש `rate.view_agent`                    |
| `derivation`                            | `jsonb`            | `null` = תעריף עצמאי. אחרת `{ from_rate_plan_id, adjust: { kind: 'percent'\|'fixed', value } }` |
| `min_nights` · `max_nights`             | `integer`          | דורס את `units.min_nights` כשקיים                                                               |
| `advance_days_min` · `advance_days_max` | `integer`          | חלון ההזמנה מראש. הבסיס של early bird ו-last minute                                             |
| `cancellation_policy`                   | `jsonb`            | מבנה מדרגות. נצרב ל-`bookings` — ראה §3.7                                                       |
| `floor_agorot` · `ceiling_agorot`       | `integer`          | הגבולות הדטרמיניסטיים של §6 חוק 22                                                              |
| `priority`                              | `integer`          | קובע בחירה כשכמה תוכניות כשירות                                                                 |
| `is_active`                             | `boolean`          |                                                                                                 |
| `effective_from` · `effective_to`       | `date`             | חצי־פתוח, כמו כל טווח במוצר                                                                     |

אינדקסים: `(organization_id, property_id, is_active)` לשליפת התוכניות הכשירות;
`unique (organization_id, code)` — `code` הוא מזהה, ומזהה כפול הוא באג.

### 3.2 `rate_rules` — סולם התעריף ללילה

השורה שקובעת כמה עולה לילה בודד. **טווחית**, ולכן נפרדת מ-`rate_calendar`.

| עמודה                   | טיפוס        | הערה                                                               |
| ----------------------- | ------------ | ------------------------------------------------------------------ |
| `rate_plan_id`          | `uuid`       |                                                                    |
| `scope_kind`            | `rate_scope` | `unit` · `unit_group` · `property`                                 |
| `scope_id`              | `uuid`       |                                                                    |
| `specificity`           | `smallint`   | **מחושב ונשמר**, לא מוקלד. ראה §7.2                                |
| `date_from` · `date_to` | `date`       | חצי־פתוח. העונה                                                    |
| `weekdays`              | `smallint[]` | 0=ראשון … 6=שבת. ריק = כל הימים                                    |
| `nightly_agorot`        | `integer`    | התעריף. `>= 0`                                                     |
| `min_nights`            | `integer`    | מינימום לילות שהחוק הזה כופה                                       |
| `priority`              | `integer`    | שובר שוויון בתוך אותה רמת ספציפיות                                 |
| `label`                 | `text`       | עברית — "עונת קיץ", "אמצע שבוע". מגיע ל-`resolution` של ה-snapshot |

אינדקס: `(rate_plan_id, scope_kind, scope_id, date_from, date_to)` — דפוס
השאילתה היחיד הוא "כל החוקים שנוגעים בטווח הזה", ולכן GiST על `daterange(date_from, date_to, '[)')`
בתוספת `(rate_plan_id, scope_id)`.

### 3.3 `rate_calendar` — התעריף הידני ליום בודד

| עמודה                      | טיפוס                  | הערה                                                                                            |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `unit_id` · `rate_plan_id` | `uuid`                 |                                                                                                 |
| `date`                     | `date`                 | לילה בודד                                                                                       |
| `nightly_agorot`           | `integer`              |                                                                                                 |
| `source`                   | `rate_calendar_source` | `manual` · `ai_approved` · `channel_sync`                                                       |
| `suggestion_id`            | `uuid`                 | מפנה ל-`rate_suggestions` כאשר `source = 'ai_approved'`. **המסלול היחיד שבו המלצה הופכת למחיר** |
| `approved_by`              | `uuid`                 | מי אישר. `not null` כאשר `source = 'ai_approved'`                                               |

`unique (unit_id, rate_plan_id, date)`. טבלה נפרדת מ-`rate_rules` כי דפוס
הגישה שונה לגמרי — נקודתי לפי יום, נכתב בכמויות על ידי מסך היומן ועל ידי
זרימת האישור, ונקרא לכל לילה בכל ציטוט. אינדקס `(rate_plan_id, date)` משרת את
מסך היומן; `(unit_id, date)` משרת את הציטוט.

### 3.4 `rate_modifiers` — תוספות ליליות

| עמודה                     | טיפוס                | הערה                                                                                                                                                                                                                 |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                    | `rate_modifier_kind` | `weekend` · `holiday` · `occupancy` · `guest_count` · `event_type`                                                                                                                                                   |
| `scope_kind` · `scope_id` |                      | כמו `rate_rules`                                                                                                                                                                                                     |
| `rate_plan_id`            | `uuid`               | nullable = חל על כל התוכניות                                                                                                                                                                                         |
| `trigger`                 | `jsonb`              | `weekend`: `{ weekdays: [5,6] }`. `holiday`: `{ special_day_kinds: ['yom_tov','chol_hamoed'] }`. `occupancy`: `{ from_percent, to_percent }`. `guest_count`: `{ from, to }`. `event_type`: `{ any_of: EventType[] }` |
| `adjust_kind`             | `text`               | `percent` \| `fixed`                                                                                                                                                                                                 |
| `adjust_value`            | `integer`            | נקודות אחוז ×100 (bps) עבור `percent`; אגורות עבור `fixed`. מספר שלם תמיד                                                                                                                                            |
| `priority`                | `integer`            |                                                                                                                                                                                                                      |

🔒 `adjust_value` באחוזים נשמר ב-**bps** ולא כ-`numeric`. אותו נימוק בדיוק כמו
`properties.tax_rate_bps`: אחוז שנשמר כ-`0.15` float מייצר בסוף חשבונית שלא
מסתכמת.

### 3.5 `promotions` ו-`coupons`

| `promotions`                        | טיפוס            | הערה                                                                                                          |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `code`                              | `text`           | מזהה מכונה. `unique (organization_id, code)`                                                                  |
| `kind`                              | `promotion_kind` | `early_bird` · `last_minute` · `midweek` · `long_stay` · `repeat_guest` · `direct_booking` · `agent_campaign` |
| `conditions`                        | `jsonb`          | ראה §7.6 — שפת התנאים, סגורה בכוונה                                                                           |
| `discount_kind`                     | `text`           | `percent` \| `fixed` \| `free_nights`                                                                         |
| `discount_value`                    | `integer`        | bps · אגורות · מספר לילות                                                                                     |
| `applies_to`                        | `text`           | `stay_total` \| `accommodation_only`. אף פעם לא על מע״מ ואף פעם לא על פיקדון                                  |
| `stackable`                         | `boolean`        |                                                                                                               |
| `exclusive_group`                   | `text`           | שני מבצעים באותה קבוצה לא ידורו יחד                                                                           |
| `priority`                          | `integer`        |                                                                                                               |
| `max_redemptions` · `max_per_guest` | `integer`        | `null` = ללא הגבלה                                                                                            |
| `budget_agorot`                     | `integer`        | תקרת הנחה מצטברת. `null` = ללא                                                                                |
| `effective_from` · `effective_to`   | `timestamptz`    | **instant ולא date** — מבצע מסתיים בחצות של אזור הזמן של הנכס, ו"חצות" הוא רגע                                |

`coupons` זהה במבנה, ובנוסף: `promotion_id` (הקופון הוא מופע של מבצע),
`issued_to_guest_id`, `single_use`, `expires_at`.

`discount_redemptions` — שורה אחת לכל מימוש: `promotion_id` \| `coupon_id`,
`booking_id`, `amount_agorot`, `redeemed_at`.
`unique (coupon_id) where single_use` — התקרה נאכפת באילוץ ולא בבדיקה בקוד,
כי בדיקה בקוד מפסידה למרוץ. ראה §10.

### 3.6 `rate_suggestions` ו-`dynamic_pricing_policies`

| `rate_suggestions`                              | הערה                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `unit_id` · `rate_plan_id` · `date`             | הלילה שההמלצה נוגעת בו                                              |
| `deterministic_agorot`                          | מה המנוע הדטרמיניסטי אמר. **נשמר**, כדי שאפשר יהיה למדוד את ההמלצה  |
| `suggested_agorot`                              | מה ה-AI הציע                                                        |
| `confidence_bps`                                |                                                                     |
| `rationale`                                     | עברית, מוצג למאשר. המלצה בלי הסבר לא ניתנת לאישור                   |
| `inputs_hash`                                   | טביעת אצבע של הקלטים. שתי המלצות מאותם קלטים חייבות להיות אותה שורה |
| `status`                                        | `pending` · `approved` · `rejected` · `expired` · `auto_applied`    |
| `decided_by` · `decided_at` · `decision_reason` |                                                                     |

`dynamic_pricing_policies`: `auto_apply` (boolean), `max_delta_bps` (כמה מותר
לזוז מהמחיר הדטרמיניסטי), `max_daily_changes`, `floor_agorot`, `ceiling_agorot`,
`enabled_by_user_id`. השדה האחרון הוא מה שנכתב ל-`audit_events.on_behalf_of_user_id`
בכל שינוי אוטומטי.

### 3.7 `booking_price_snapshots` — 🔒 מנגנון הצריבה

זה הסעיף שקשה מכול לתקן בדיעבד.

| עמודה                                 | טיפוס         | הערה                                                                             |
| ------------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `id`                                  | `uuid`        |                                                                                  |
| `booking_id`                          | `uuid`        | `(booking_id, organization_id, property_id)` → `bookings`, כמו כל טבלת בת ב-0009 |
| `sequence`                            | `integer`     | 1, 2, 3 … כל תמחור מחדש הוא שורה חדשה. **אף פעם לא UPDATE**                      |
| `hash`                                | `text`        | תוכן־hash של `inputs` + `resolution`. תצורות זהות חולקות אותו; שינוי מתגלה       |
| `captured_at`                         | `timestamptz` |                                                                                  |
| `effective_on`                        | `date`        | התאריך שלפיו נפתרה התיארוך־בתוקף. ברירת מחדל: יום יצירת ההזמנה                   |
| `engine_version`                      | `text`        | גרסת מנוע התמחור. שינוי בקוד המנוע לא מסביר מחיר ישן בלי זה                      |
| `rate_plan_id` · `rate_plan_version`  |               |                                                                                  |
| `inputs`                              | `jsonb`       | ה-`StayPricingRequest` המלא כפי שנמסר ל-`priceStay`                              |
| `resolution`                          | `jsonb`       | לכל לילה: איזה חוק ניצח, באיזו רמת ספציפיות, מה היה הבסיס, איזו תוספת חלה ולמה   |
| `tax_rate_bps` · `tourist_vat_exempt` |               | נצרב גם ב-`bookings` (קיים ב-0009) וגם כאן                                       |
| `cancellation_policy`                 | `jsonb`       | **המדיניות כפי שהייתה**, לא הפניה ל-`rate_plans`                                 |
| `superseded_by`                       | `uuid`        | ה-snapshot שהחליף אותו. `null` = הפעיל                                           |

Append-only, על אותם תנאים כמו `booking_status_history` ב-0009: ההרשאות
נשללות ו-trigger ברמת statement מסרב ל-UPDATE ול-DELETE. אינדקס
`(booking_id, sequence desc)` ואינדקס חלקי `(booking_id) where superseded_by is null`.

**מה שהטבלה הזאת לא עושה:** היא לא המחיר. המחיר הוא
`booking_price_lines` (0009), והוא נכתב פעם אחת. ה-snapshot הוא ה**הסבר** —
למה השורות האלה ולא אחרות. הפרדה זו היא מה שמונע פיתוי לחשב מחדש: אין שום
נתיב שקורא snapshot ומייצר ממנו מחיר.

### 3.7.1 היחס ל-`FinanceSnapshot`

`src/lib/finance/snapshot.ts` כבר מגדיר `FinanceSnapshot`, שצורב את שורות
המחיר לצד כללי העמלה, חלוקת הבעלים והוצאות. שני ה-snapshot אינם כפילות
אלא **שני שלבים של אותו קו**:

|             | `booking_price_snapshots` (כאן)                         | `FinanceSnapshot` (`finance/`)                  |
| ----------- | ------------------------------------------------------- | ----------------------------------------------- |
| מתי         | בעת התמחור                                              | בעת שההזמנה הופכת ממשית כספית                   |
| מה קופא     | **למה** יצא המחיר: החוק שניצח לכל לילה, התוספות, הצביטה | **מה** נגזר מהמחיר: עמלה, חלק בעלים, כללי הוצאה |
| מקור השורות | מייצר אותן דרך `priceStay`                              | **מעתיק** אותן, ולא מחשב                        |

`FinanceSnapshot.lines` הוא עותק ולא מצביע, מהנימוק המפורש שבקובץ ההוא:
מצביע ל-`(id, version)` שורד רק כל עוד אף אחד לא מחק ולא מיספר מחדש, ושניהם
קורים. הכפילות הזאת מכוונת ומנומקת, ואינה סתירה.

הכיוון חד-סטרי: תמחור אינו קורא `FinanceSnapshot` לעולם, ופיננסים אינו
מתמחר לעולם (`captureFinanceSnapshot` מקבל `lines` ואין לו גישה למחירון).

---

## 4. מצבים ומעברים

לתמחור אין מכונת מצבים משלו — הזמנה כן, וזו ב-`src/lib/booking/state-machine.ts`.
מה שכן יש הוא **מכונת מצבים של ה-snapshot**, ושל ההמלצה.

### 4.1 snapshot של מחיר

| ממצב     | למצב                  | מי רשאי                                                                                                 | תנאים                                                                               | תופעות לוואי                                                             | Audit                                                                    |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| —        | `active` (sequence 1) | `booking.create`                                                                                        | ההזמנה נוצרת                                                                        | כתיבת `booking_price_lines`; טריגר מעדכן `bookings.total_agorot`         | "רוני יצרה הזמנה B3F91A2C · ₪6,400 · 3 לילות"                            |
| `active` | `superseded`          | `booking.amend_price` או `booking.amend_dates` או `booking.amend_extras` או `booking.amend_guest_count` | ההזמנה אינה ב-`TERMINAL_STATUSES`; לא קיימת חשבונית פתוחה על סכום שונה (§16 שורה 8) | snapshot חדש עם `sequence+1`; שורות מחיר חדשות; אירוע `booking.repriced` | "דנה שינתה את סכום ההזמנה מ-₪5,200 ל-₪4,700 · סיבה: פיצוי על תקלה במזגן" |
| `active` | `frozen`              | — (אוטומטי)                                                                                             | ההזמנה נכנסה ל-`completed` · `cancelled` · `no_show`                                | side effect `close_financials` של המכונה הקיימת                          | "ההזמנה נסגרה. המחיר קפוא"                                               |

מעבר לא חוקי נכשל ב-`BusinessRuleError` עם הודעה בעברית שמנסחת את העובדה
ולא את החוק — "לא ניתן לשנות מחיר של הזמנה שהושלמה. לתיקון כספי יש להנפיק
חשבונית זיכוי", ולא "invalid transition".

### 4.2 המלצת תמחור

`pending` → `approved` (דורש `pricing.manage`, כותב `rate_calendar` עם
`source='ai_approved'`) · `rejected` (דורש נימוק) · `expired` (עברו `ttl`
שעות, ברירת מחדל 24 — המלצה על מחר לא רלוונטית מחרתיים) ·
`auto_applied` (רק כאשר `dynamic_pricing_policies.auto_apply` וכל התנאים ב-§6
חוק 26 מתקיימים).

`pending` → `approved` **אינו קיים** עבור לילה שכבר יש עליו הזמנה תופסת —
ראה §6 חוק 24.

---

## 5. מסכים

### 5.1 לוח המחירים

**מטרה** — לראות חודש שלם של יחידה, לילה־לילה, ולשנות מחיר במקום.
**תפקידים** — `revenue_manager`, `organization_owner`, `general_manager`,
`property_manager` (הנכסים שלו).
**הרשאות** — `pricing.manage` לעריכה, `rate.view_public` לצפייה בלבד.
**פריסה** — RTL. בורר יחידה + תוכנית תעריפים מימין, רשת חודשית מתחת, פאנל
פרטי־לילה נפתח משמאל.
**שדות בכל תא** — התאריך העברי (`formatHebrewDate`), התג הקצר של יום מיוחד
(`SpecialDay.shortName`) כאשר קיים, המחיר הפתור (`formatAgorot`), ותג "י" קטן
כאשר `rate_calendar.source = 'manual'`.
**פעולות** — עריכת לילה · בחירת טווח ועריכה קבוצתית · חסימת מכירה · פתיחת
המלצת AI · שחזור לתעריף החוק (מחיקת שורת `rate_calendar`).
**מצבים** — לילה תפוס מוצג עם המחיר שנמכר בו, אפור, ולא ניתן לעריכה: המחיר
של לילה שנמכר הוא עובדה, לא הגדרה.
**מובייל** — הרשת קורסת לרשימה אנכית של שבועות. עריכה קבוצתית מוסתרת; היא
לא פעולה שעושים בטלפון, ולדחוס אותה למסך קטן זו הזמנה לטעות שעולה כסף.
**ריק** — "עוד לא הוגדר מחירון ליחידה הזאת. המחיר שיוצג לאורח הוא ₪X —
מחיר הבסיס של היחידה." עם קישור לעריכת היחידה. אף פעם לא רשת ריקה בלי מספר.
**טעינה** — שלד רשת. אף פעם לא ספינר על מסך שלם.
**שגיאה** — `ErrorState` עם `userMessage`, `dataOutcome` ו-`retryable` מתוך
`AppError`. עריכה שנכשלה מחזירה את התא לערכו הקודם ומסמנת אותו.
**מתועד** — כל שינוי מחיר: "שי שינה את מחיר הלילה 14/04 ביחידה 'סוויטה' מ-₪1,200 ל-₪1,450".

### 5.2 עריכת תוכנית תעריפים

מטרה — להגדיר עונות, ימי שבוע, מינימום לילות, רצפה ותקרה.
פעולות — הוספת חוק · שינוי סדר עדיפות · **תצוגה מקדימה**: שלושה תאריכי דוגמה
(אמצע שבוע, סוף שבוע, חג) שמראים את המחיר שייצא, לפני שמירה.
מה מתועד — לפני/אחרי של כל חוק, ברמת השדה (`diffFields`).
מצב שגיאה מיוחד — חוקים חופפים באותה רמת ספציפיות ובאותו `priority`: המסך
מסרב לשמור ומצביע על שני החוקים בשמם. ראה §6 חוק 6.

### 5.3 מבצעים וקופונים

פעולות — יצירה · השהיה · שכפול · הפקת אצווה של קופונים.
שדות — הכול מ-§3.5, עם בונה תנאים ויזואלי מעל שפת התנאים הסגורה של §7.6.
מצב — מבצע פעיל מציג `redemptions / max_redemptions` ו-`budget` שנוצל.
מה מתועד — יצירה, השהיה, שינוי תקציב, ו**כל מימוש** (במיוחד לצורך §16 שורה 4).

### 5.4 המלצות תמחור

מטרה — לאשר או לדחות, לילה־לילה או באצווה.
כל שורה — התאריך · המחיר הדטרמיניסטי · ההצעה · הפער באחוזים · הנימוק בעברית
· רמת הביטחון · **תמיד** הרצפה והתקרה, כדי שהמאשר יראה את הגבול ולא רק את המספר.
פעולות — אישור · דחייה (חובה נימוק) · אישור אצווה (עד 60 לילות בפעולה אחת,
עם מפתח Idempotency אחד).
מה מתועד — "ESTIA הציעה ₪1,610 ללילה 03/10 (דטרמיניסטי: ₪1,400). דנה אישרה."
עם `actor.type = 'ai_agent'` על שורת ההצעה ו-`on_behalf_of_user_id = דנה`
על שורת האישור.

### 5.5 מחשבון התמחור / הצעת מחיר

מטרה — התשובה ל"כמה זה יעלה?" בטלפון, בשלוש שניות.
פריסה — קלטים משמאל, פירוק שורות מימין, מתעדכן חי.
הפירוק — בדיוק `StayQuote.lines`, בסדר שבו `priceStay` מייצר אותן, עם
`stayTotalAgorot`, `depositAgorot` ו-`taxAgorot` כשורות סיכום נפרדות.
כל שורת לינה נושאת את שם החוק שניצח (`rate_rules.label`) — זה מה שהופך
"₪1,450" ל"₪1,450 · עונת סוכות · שבת".
פעולות — שמירה כהצעת מחיר · שליחה (`quote.send`) · המרה להזמנה.
מובייל — הפירוק מעל הקלטים, כי זה מה שמסתכלים עליו.

---

## 6. חוקים עסקיים

ממוספרים וניתנים לבדיקה. כל אחד מהם הוא מקרה בדיקה ב-§19.

**קלט וטווח**

1. טווח שהות הוא חצי־פתוח `[checkIn, checkOut)`. לילה של יציאה אינו נמכר.
   נאכף ב-`nightsBetween` וב-`bookings_dates_ordered`.
2. ציטוט לטווח שבו `checkOut <= checkIn` נכשל ב-`ValidationError` על השדה
   `checkOut` עם ההודעה שב-`priceStay`, ולא מחזיר אפס.
3. `guests >= 1`, מספר שלם. אפס אורחים אינו הזמנה זולה, הוא באג.
4. `guests <= units.max_guests`, אלא אם המשתמש מחזיק `booking.override_availability`
   ומסר נימוק.
5. מינימום לילות נאכף **בעת יצירה ובעת שינוי תאריכים**, ונלקח כמקסימום של
   `units.min_nights`, `properties.min_nights`, `rate_plans.min_nights`
   ו-`rate_rules.min_nights` של כל לילה בטווח. חריגה דורשת
   `booking.override_availability` ונימוק.

**פתרון התעריף**

6. לשני חוקי `rate_rules` חופפים באותה `specificity` ובאותה `priority` על אותו
   `scope_id` — **אסור להתקיים**. נאכף באילוץ exclusion על
   `(rate_plan_id, scope_kind, scope_id, specificity, priority, daterange)`.
   אי-דטרמיניזם נמנע במסד ולא בזהירות.
7. לכל לילה נבחר **בדיוק חוק בסיס אחד**. הסולם והשוברי־שוויון ב-§7.2.
8. לילה שאין לו אף חוק מקבל את `units.base_price_agorot`. זו הרצפה האחרונה,
   והיא לעולם לא `null` ולעולם לא 0 בשקט — יחידה עם `base_price_agorot = 0`
   מוצגת במסך הגדרות עם אזהרה, כי מחיר אפס הוא כמעט תמיד שדה שלא מולא.
9. לכל לילה חלה **תוספת לוח־שנה אחת לכל היותר** — המקסימום מבין תוספת סוף
   השבוע ותוספת החג, לא הסכום. שבת שהיא גם חול המועד היא לילה יקר אחד ולא שניים.
10. סוף השבוע הישראלי הוא **שישי ושבת** (`weekdays = [5,6]`), כברירת מחדל
    הניתנת לשינוי ברמת הארגון. חמישי אינו סוף שבוע כברירת מחדל.
11. תוספת חג נגזרת מ-`src/lib/hebrew-calendar/`: לילה הוא חג אם
    `isPeakNight(date)` — כלומר שבת, יום טוב או חול המועד. `bein_hazmanim`
    **אינו** תוספת ליליה; הוא אות ביקוש, וגלגולו לתוספת היה מסמן את רוב ניסן
    כשיא. זו החלטת המודול ב-`range.ts` והיא נלקחת משם.
12. תוספת ביקוש (`occupancy`) מחושבת מתפוסה **של הנכס באותו לילה**, לא של
    היחידה. תפוסה של יחידה בודדת היא 0% או 100% ואין ממנה מדרגות.
13. תפוסה כשאין לילות זמינים היא `null` ולא 0 — `safeDivide` מ-`metrics/rounding.ts`.
    לילה כזה **לא מקבל תוספת ביקוש בכלל**. אפס תפוסה היה מפעיל את המדרגה הזולה
    ביותר על נכס שכל יחידותיו מושבתות.
14. מחיר לילה נצבט לטווח `[floor, ceiling]` של תוכנית התעריפים **אחרי** כל
    התוספות ולפני העיגול הסופי. הצביטה אינה שקטה: היא נרשמת ב-`resolution`.
15. `floor` מתחת ל-`ceiling` — אילוץ במסד. תוכנית שבה הרצפה גבוהה מהתקרה לא
    ניתנת לשמירה.

**רכיבי מחיר**

16. אורח נוסף מחויב מעבר ל-`includedGuests`, שברירת המחדל שלו היא
    `units.standard_guests`. החישוב `extraGuests × extraRate × nights`,
    כולו במספרים שלמים.
17. דמי ניקיון הם שורה אחת להזמנה, לא ללילה. מיטה נוספת, חימום בריכה, יציאה
    מאוחרת וכניסה מוקדמת הם `addon` — `unitPrice × quantity`, מספרים שלמים.
18. דמי אירוע נגזרים מ-`EventType` של ההזמנה
    (`src/lib/preparation/types.ts`) ולא ממספר האורחים. חתונה ושבת הן אותם
    עשרים וחמישה אנשים באותו בית ותמחור שונה לגמרי.
19. פיקדון ביטחון נכנס לסכום ההזמנה **ומחוץ לבסיס המס**. הוא כספו של האורח
    שמוחזק, לא אספקה של דבר. `stayTotalAgorot = totalAgorot − depositAgorot`.
    זה כבר החוק ב-`priceStay`.
20. עמלת סוכן **אינה** בסכום האורח, לעולם. `agentCommissionLine` מחזירה אותה
    בנפרד ומחשבת אותה על `stayTotalAgorot` — אף אחד לא מרוויח עמלה על כסף
    שחוזר לאורח.
21. מע״מ מחושב על הסכום **אחרי** ההנחות. מיסוי לפני הנחה גובה מע״מ על כסף
    שאיש לא שילם. זה החוק ב-`priceStay` שלב 5.

**רצפה, תקרה וחריגה**

22. מחיר מתחת ל-`floor_agorot` דורש `booking.override_price`, נימוק, ואירוע
    Audit. הוא מתבצע כשורת הנחה (`manualDiscountLine`) ולא כעריכת הסכום —
    כדי שהחריגה תישאר גלויה בפירוק לכל חיי ההזמנה.
23. הנחה מצטברת אינה יורדת מתחת לאפס. `priceStay` צובט; מחיר שלילי הוא החזר,
    והחזר אינו דבר שמחשבון מחירים ממציא.

**תמחור דינמי — הגבול בין הסתברותי לדטרמיניסטי**

24. 🔒 **המלצה לעולם אינה מחיר.** היא נכתבת ל-`rate_suggestions` בלבד. אין
    נתיב קוד שבו מנוע ההמלצות כותב ל-`rate_calendar` או ל-`rate_rules`.
25. אישור המלצה ללילה שכבר תפוס (`OCCUPYING_STATUSES`) נדחה. המחיר של לילה
    שנמכר הוא עובדה היסטורית.
26. אישור אוטומטי מותר רק כאשר **כל** אלה מתקיימים: מדיניות פעילה עם
    `auto_apply` · המחיר בתוך `[floor, ceiling]` · הפער מהמחיר הדטרמיניסטי
    `<= max_delta_bps` · לא נוצל `max_daily_changes` לאותה יחידה היום ·
    הלילה אינו תפוס. נכשל אחד — ההמלצה נשארת `pending` וממתינה לאדם.
27. 🔒 שינוי אוטומטי כותב אירוע Audit עם `actor.type = 'ai_agent'` ו-
    `on_behalf_of_user_id` = מי שהפעיל את המדיניות. "המערכת עשתה את זה"
    אינה תשובה קבילה.

**מבצעים וקופונים**

28. סדר פתרון המבצעים ב-§7.7. שני מבצעים באותה `exclusive_group` לא ידורו יחד.
29. מבצע לא־`stackable` שנבחר עוצר את הרשימה. מבצעים שנבחרו אחריו לא היו
    נבחרים, ולא מוצגים לאורח כ"פספסת".
30. קופון הוא ציר נפרד ממבצע. **קופון אחד לכל היותר** להזמנה.
31. כל ההנחות באחוזים מחושבות מול **אותו** סכום־לפני־הנחה. שתי הנחות של 10%
    מורידות 20% ולא 19%. סדר ההזנה לא משנה את המחיר שצוטט. זה החוק ב-`priceStay` שלב 4.
32. הנחה חלה על `stay_total` או על `accommodation_only` בלבד — לעולם לא על
    מע״מ ולעולם לא על פיקדון.
33. תקרת הנחה של סוכן (`agent_limits.manage`) **מסרבת** ולא צובטת בשקט.
    צביטה שקטה שולחת את הסוכן לצטט מחיר שהמערכת לא תכבד.
34. קופון חד־פעמי שנוצל נדחה באילוץ במסד, לא בבדיקה מוקדמת. ראה §10.
35. מבצע `repeat_guest` נבחן מול `guests` באותו `organization_id` בלבד. אורח
    חוזר אצל עסק אחר אינו אורח חוזר כאן.
36. `early_bird` ו-`last_minute` נבחנים מול `advance_days` = ההפרש בימים בין
    יום יצירת ההזמנה (בזמן המקומי של הנכס, `localDate`) ל-`checkIn`. לא מול
    `now()` בעת חישוב מאוחר — אחרת ההנחה תיעלם בכל תמחור מחדש.

**צריבה**

37. 🔒 שינוי `rate_rules`, `rate_calendar`, `rate_modifiers`, `promotions`,
    `rate_plans` או `properties.tax_rate_bps` **אינו** משנה אף הזמנה קיימת.
    הוכחה: אין נתיב קריאה שמחשב מחיר של הזמנה קיימת. `booking_price_lines`
    נכתבות פעם אחת.
38. תמחור מחדש הוא פעולה מפורשת של אדם עם `booking.amend_price`, עם נימוק,
    שמייצרת snapshot חדש ומשאירה את הישן.
39. עריכת חוק סוגרת את השורה הישנה (`effective_to`) ופותחת חדשה. חוק לעולם
    לא מעודכן במקום. אותו דפוס בדיוק כמו `PreparationRule` ו-`effectiveOn`.

---

## 7. חישובים

> מדד שמופיע ב-`src/lib/metrics/` נלקח משם. הפונקציות
> `roundAgorot` · `safeDivide` · `percentOf` · `agorotPer` · `allocateEvenly`
> · `allocateShares` הן מ-`src/lib/metrics/rounding.ts` ו**אינן מוגדרות מחדש כאן**.
>
> ⚠️ **כפילות** — `roundAgorot` מוגדרת פעמיים: ב-`src/lib/booking/pricing.ts`
> וב-`src/lib/metrics/rounding.ts`. שתי המימושים מסכימים היום (חצי הרחק מאפס,
> על הגודל המוחלט), אבל שתי הגדרות לאותה פונקציה יסטו. **המלצה:** להשאיר את
> ההגדרה ב-`booking/pricing.ts` — היא הוותיקה ומתועדת בהרחבה — ולייבא אותה
> ב-`metrics/rounding.ts`.

### 7.1 המבנה: המנוע מייצר קלט, `priceStay` מייצר מחיר

🔒 **הפלט של מנוע פתרון התעריף הוא `StayPricingRequest`, לא מחיר.**

```
resolvePricing(context) → StayPricingRequest → priceStay() → StayQuote
```

כל החשבון הלילי — בסיס, תוספת לוח־שנה, תוספת ביקוש, צביטה — קורס למספר שלם
אחד ללילה בתוך `nightlyOverrides`. `priceStay` הוא המקום היחיד שמייצר שורות
וסכום, ולכן הכלל "הסכום הוא סכום השורות" נכון בבנייה ולא בזהירות.

### 7.2 סולם הספציפיות — בחירת חוק הבסיס ללילה

`specificity` מחושב בעת הכתיבה, לא מוקלד:

| מקור                                                   | `specificity` |
| ------------------------------------------------------ | ------------- |
| `rate_calendar` (יום בודד, יחידה בודדת)                | 100           |
| `rate_rules` · `scope_kind='unit'` + `weekdays` לא ריק | 80            |
| `rate_rules` · `scope_kind='unit'`                     | 70            |
| `rate_rules` · `scope_kind='unit_group'` + `weekdays`  | 60            |
| `rate_rules` · `scope_kind='unit_group'`               | 50            |
| `rate_rules` · `scope_kind='property'` + `weekdays`    | 40            |
| `rate_rules` · `scope_kind='property'`                 | 30            |
| `units.base_price_agorot`                              | 0             |

```
base(n) = nightly_agorot של השורה המנצחת, כאשר המנצחת נבחרת לפי:
          specificity יורד
       →  priority יורד
       →  effective_from יורד (החדש יותר גובר)
       →  id עולה
```

ארבעת השוברים ממצים. `id` אינו אסתטי — הוא מה שהופך את התוצאה לזהה בכל ריצה
גם אם שני חוקים נכתבו באותה מילישנייה. חוק 6 אוסר על השוויון הזה מלכתחילה;
השובר קיים כי "אסור שיקרה" ו"לא יקרה" הם שני דברים שונים.

### 7.3 תוספת לוח־שנה — לילה בודד

```
weekend_add(n) = 0                                 אם dayOfWeek(n) ∉ weekdays
               = adjust_value/10000 × base(n)      אם adjust_kind = 'percent'
               = adjust_value                      אם adjust_kind = 'fixed'

holiday_add(n) = 0                                 אם ¬isPeakNight(n)
               = (אותו חישוב)

calendar_add(n) = max(weekend_add(n), holiday_add(n))     ← חוק 9. מקסימום, לא סכום
```

`isPeakNight` ו-`dayOfWeek` נלקחות מ-`src/lib/hebrew-calendar/` ואינן
מחושבות מחדש. שבת מגיעה משם כ-peak **וגם** נופלת ב-`weekdays=[5,6]`;
המקסימום הוא בדיוק מה שמונע את הכפילות.

**אין עיגול כאן.** `calendar_add` נשאר שבר עד §7.5.

### 7.4 תוספת ביקוש

```
occupancy(property, n) = percentOf(soldUnitNights(property, n),
                                   availableUnitNights(property, n))
```

מ-`metrics/rounding.ts`. **מכנה אפס → `null`**, ואז:

```
demand_add(n) = 0    אם occupancy(property, n) = null      ← חוק 13
              = התוספת של המדרגה שבה occupancy נופל, אחרת
```

המדרגות סגורות משמאל ופתוחות מימין (`[from_percent, to_percent)`), כמו כל
טווח במוצר, כדי ש-70.0% ייפול במדרגה אחת בלבד.

### 7.5 המחיר הלילי הסופי — 🔒 העיגול היחיד

```
raw(n)     = base(n) + calendar_add(n) + demand_add(n) + event_add(n) + guest_add(n)
clamped(n) = min(max(raw(n), floor_agorot), ceiling_agorot)
nightly(n) = roundAgorot(clamped(n))
```

🔒 **זה מקום העיגול הראשון מתוך שניים בכל המערכת.** כל התוספות מצטברות
כשברים ומעוגלות פעם אחת, בסוף, על הלילה. עיגול של כל תוספת בנפרד היה מייצר
סטייה שגדלה עם מספר התוספות.

המקום השני — והאחרון — הוא בתוך `priceStay`, על שורות האחוזים בלבד (הנחה,
מע״מ, עמלה). שם, גם כן, פעם אחת לשורה.

**אין מקום שלישי.** מסך שמעגל שוב לא יכול לסתור מסך אחר, כי לא נשאר מה לעגל.

### 7.6 שפת התנאים של מבצע

סגורה בכוונה. מה שארבעת הצורות לא מבטאות הוא מבצע שני, לא שפה גדולה יותר —
אותו נימוק בדיוק כמו `QuantityExpression` ב-`preparation/types.ts`.

| צורה                                               | דוגמה                             |
| -------------------------------------------------- | --------------------------------- |
| `{ kind:'compare', basis, comparator, value }`     | `nights >= 5` (long stay)         |
| `{ kind:'advance', comparator, days }`             | `advance_days >= 90` (early bird) |
| `{ kind:'weekday_set', all_of }`                   | כל הלילות באמצע השבוע (midweek)   |
| `{ kind:'source', any_of: BookingSource[] }`       | `direct_website` (direct booking) |
| `{ kind:'guest_history', min_completed_bookings }` | אורח חוזר                         |
| `{ kind:'all'\|'any'\|'not' }`                     | הרכבה                             |

`basis` הוא `FactBasis` מ-`src/lib/preparation/types.ts` — הרשימה משותפת
בכוונה, כדי ש"לכל אורח" יאמר אותו דבר לכלל המגבת ולכלל ההנחה.

### 7.7 🔒 סדר פתרון המחיר — התשובה המלאה

זה הסעיף שכל השאר משרת. **עונה + תוספת סוף שבוע + מבצע + תעריף סוכן, כולם
יחד, נותנים מספר אחד.**

| #   | שלב                                    | מה נקבע                                                                        | היכן                  |
| --- | -------------------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| 0   | **הקפאת קלטים**                        | נכס, יחידה, טווח, אורחים, סוג אירוע, ערוץ, סוכן, קופון, תוספות, `effective_on` | `resolvePricing`      |
| 1   | **בחירת תוכנית תעריפים**               | בדיוק אחת. כשירות → `priority` יורד → `code` עולה                              | §7.8                  |
| 2   | **בסיס לכל לילה**                      | חוק אחד ללילה, סולם §7.2                                                       | לולאה על `eachNight`  |
| 3   | **תוספת לוח־שנה**                      | מקסימום מבין סוף שבוע וחג                                                      | §7.3                  |
| 4   | **תוספת ביקוש · אירוע · תפוסת אורחים** | מדרגות דטרמיניסטיות                                                            | §7.4                  |
| 5   | **המלצת AI**                           | רק אם אושרה מראש ל-`rate_calendar` — כלומר היא כבר נבלעה בשלב 2                | §6 חוק 24             |
| 6   | **צביטה לרצפה/תקרה**                   | דטרמיניסטי, אחרון                                                              | §7.5                  |
| 7   | **עיגול לילי**                         | `roundAgorot`, פעם אחת                                                         | §7.5                  |
| 8   | **מינימום לילות**                      | מסרב, לא מתמחר                                                                 | §6 חוק 5              |
| 9   | **מסירה ל-`priceStay`**                | `nightlyOverrides` מוכן                                                        | `StayPricingRequest`  |
| 10  | **לינה · אורח נוסף · ניקיון · תוספות** | שורות חיוביות                                                                  | `priceStay` 1–3       |
| 11  | **מבצעים**                             | סדר §7.9, כולם מול אותו סכום־לפני־הנחה                                         | `priceStay` 4         |
| 12  | **קופון**                              | אחד לכל היותר, אחרי המבצעים                                                    | `priceStay` 4         |
| 13  | **הנחת סוכן / הנחה שאושרה ידנית**      | `manualDiscountLine`                                                           | `priceStay` 4         |
| 14  | **מע״מ**                               | על הסכום אחרי ההנחות                                                           | `priceStay` 5         |
| 15  | **פיקדון**                             | אחרון, מחוץ לבסיס המס                                                          | `priceStay` 6         |
| 16  | **עמלת סוכן**                          | בנפרד, לא בסכום האורח                                                          | `agentCommissionLine` |
| 17  | **צריבה**                              | `booking_price_snapshots` + `booking_price_lines`                              | §3.7                  |

**המפתח לתרחיש שבשאלה:** תעריף סוכן **אינו הנחה**. הוא תוכנית תעריפים —
שלב 1 — ולכן הוא משנה איזו טבלת חוקים שלב 2 בכלל קרא. הוא לא מתחרה במבצע
ולא מצטבר איתו; הוא קדם לו. תוספת סוף השבוע פועלת על הבסיס שהעונה קבעה,
כי שתיהן ברמות שונות של אותו לילה. המבצע פועל על הסכום, לא על הלילה.
ארבעה דברים, ארבע רמות, מספר אחד.

### 7.8 בחירת תוכנית תעריפים

```
eligible = { p ∈ rate_plans :
             p.is_active
           ∧ effective_on ∈ [p.effective_from, p.effective_to)
           ∧ (p.property_id = null ∨ p.property_id = booking.property_id)
           ∧ (p.channel_scope = ∅ ∨ booking.source ∈ p.channel_scope)
           ∧ (p.requires_grant = null ∨ actor.grants ∋ p.requires_grant)
           ∧ nights ∈ [p.min_nights, p.max_nights]
           ∧ advance_days ∈ [p.advance_days_min, p.advance_days_max] }

chosen = argmax over eligible by (priority desc, code asc)
```

`eligible = ∅` → `BusinessRuleError` עם קוד `pricing.no_rate_plan` ו-
"אין תוכנית תעריפים שמתאימה לתאריכים ולערוץ האלה." **לא** נפילה שקטה למחיר
הבסיס: ציטוט בלי תוכנית הוא ציטוט שאיש לא אישר.

תעריף נגזר (`derivation`) נפתר רקורסיבית עד עומק 3. מעבר לכך —
`BusinessRuleError`, כי שרשרת גזירה ארוכה היא מחירון שאיש לא יכול לקרוא.
מעגל מזוהה ונדחה בזמן **שמירה**, לא בזמן ציטוט.

### 7.9 סדר פתרון המבצעים

```
candidates = מבצעים כשירים, ממוינים לפי:
             priority יורד → ערך ההנחה באגורות יורד → code עולה

selected = []
for c in candidates:
    if c.exclusive_group ≠ null ∧ c.exclusive_group ∈ groups(selected): continue
    if ¬c.stackable ∧ selected ≠ ∅:                                     continue
    selected.append(c)
    if ¬c.stackable: break
```

המיון לפי `priority` **לפני** ערך ההנחה הוא מכוון: הכוונה המפורשת של העסק
גוברת על "מה הכי טוב לאורח". שני מבצעים בעלי אותה עדיפות ואותו ערך נבחרים
לפי `code` — שרירותי, אבל **יציב**, וזה מה שנדרש.

ערך ההנחה למיון מחושב מול הסכום־לפני־הנחה, פעם אחת, לפני הלולאה. חישוב
מחדש בתוך הלולאה היה הופך את התוצאה לתלוית סדר.

### 7.10 מקרי מכנה אפס — הרשימה המלאה

| ביטוי                   | מכנה אפס         | מה קורה                                                  |
| ----------------------- | ---------------- | -------------------------------------------------------- |
| תפוסה לתוספת ביקוש      | אין לילות זמינים | `null` → אין תוספת (חוק 13). לא 0%                       |
| מחיר ממוצע ללילה בתצוגה | `nights = 0`     | טווח לא חוקי — `ValidationError` לפני החישוב (חוק 2)     |
| הנחה באחוזים            | —                | `discountable = 0` → `applied = 0`, השורה מושמטת         |
| חלוקת הנחה ללילות בדוח  | 0 לילות          | `allocateEvenly` מחזירה `[]`                             |
| נתח מבצע מסך ההנחות     | סך ההנחות 0      | `allocateShares` מחזירה `null`. מוצג כסכומים, לא כאחוזים |

### 7.11 דוגמה מספרית מלאה

יחידה "סוויטת הגפן". שהות 02/10/2026 (שישי) → 05/10/2026 (שני), 3 לילות.
4 אורחים, `standard_guests = 2`, `extra_guest = ₪120`, ניקיון `₪250`,
מע״מ 18%, פיקדון `₪1,000`. תוכנית `direct`, רצפה `₪900`, תקרה `₪2,200`.
מבצע `direct_booking` 5%, לא בלעדי, `priority 10`.

| לילה  | יום   | לוח עברי               | בסיס (§7.2)                             | תוספת לוח (§7.3)                                      | ביקוש             | raw     | צביטה | `nightly`   |
| ----- | ----- | ---------------------- | --------------------------------------- | ----------------------------------------------------- | ----------------- | ------- | ----- | ----------- |
| 02/10 | שישי  | כ״א תשרי · חוה״מ סוכות | 140,000 (עונת סוכות, `unit`, spec 70)   | max(15% שישי = 21,000 ; 25% חג = 35,000) = **35,000** | 84% → +5% = 7,000 | 182,000 | —     | **182,000** |
| 03/10 | שבת   | כ״ב תשרי · שמח״ת       | 140,000                                 | max(15% = 21,000 ; 25% = 35,000) = **35,000**         | 84% → 7,000       | 182,000 | —     | **182,000** |
| 04/10 | ראשון | כ״ג תשרי               | 95,000 (עונת סוכות, אמצע שבוע, spec 80) | 0                                                     | 61% → 0           | 95,000  | —     | **95,000**  |

שים לב לשורה הראשונה: שישי **וגם** חול המועד. חוק 9 לוקח מקסימום — ₪350
ולא ₪560. האורח חווה לילה יקר אחד.

`priceStay` מכאן:

| #   | שורה                                | `kind`          | אגורות                    |
| --- | ----------------------------------- | --------------- | ------------------------- |
| 1   | לינה 02/10                          | `accommodation` | 182,000                   |
| 2   | לינה 03/10                          | `accommodation` | 182,000                   |
| 3   | לינה 04/10                          | `accommodation` | 95,000                    |
| 4   | אורח נוסף · 2 × 3 לילות             | `extra_guest`   | 72,000                    |
| 5   | דמי ניקיון                          | `cleaning_fee`  | 25,000                    |
|     | **סכום לפני הנחה** (`discountable`) |                 | **556,000**               |
| 6   | הזמנה ישירה 5%                      | `promotion`     | −27,800                   |
|     | **בסיס המס**                        |                 | **528,200**               |
| 7   | מע״מ 18%                            | `tax`           | 95,076                    |
| 8   | פיקדון ביטחון                       | `deposit`       | 100,000                   |
|     | **`totalAgorot`**                   |                 | **723,276** → `₪7,232.76` |
|     | `stayTotalAgorot`                   |                 | 623,276 → `₪6,232.76`     |
|     | `depositAgorot`                     |                 | 100,000                   |
|     | `taxAgorot`                         |                 | 95,076                    |

בדיקת העיגול: `528,200 × 18 / 100 = 95,076.0` — שלם, לא נדרש עיגול.
ההנחה: `556,000 × 500 / 10000 = 27,800.0` — שלם. שני המקרים נבחרו כדי
שהדוגמה תהיה ניתנת לאימות בעיפרון; בדיקת §19 מכסה גם את חצי־האגורה.

עמלת סוכן, אילו הייתה — 10% על `stayTotalAgorot`: `roundAgorot(623,276 × 10 / 100)` =
62,328 (‎62,327.6 מעוגל הרחק מאפס). **מחוץ** לסכום.

---

## 8. ולידציות

| שדה                                   | חובה      | טווח                   | פורמט                   | הודעה בעברית                                                       |
| ------------------------------------- | --------- | ---------------------- | ----------------------- | ------------------------------------------------------------------ |
| `checkIn` · `checkOut`                | כן        | `checkOut > checkIn`   | `YYYY-MM-DD`            | "תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה."                      |
| `guests`                              | כן        | `1 … units.max_guests` | שלם                     | "חייב להיות לפחות אורח אחד בהזמנה." / "היחידה מתאימה עד N אורחים." |
| `nightly_agorot`                      | כן        | `0 … 10,000,000`       | שלם                     | "מחיר ללילה חייב להיות מספר שלם של אגורות, ולא שלילי."             |
| `floor_agorot` · `ceiling_agorot`     | לא        | `floor <= ceiling`     | שלם                     | "מחיר הרצפה לא יכול להיות גבוה ממחיר התקרה."                       |
| `adjust_value` (percent)              | כן        | `−10000 … 100000`      | שלם bps                 | "אחוז התוספת חייב להיות בין ‎-100%‎ ל-‎1,000%‎."                   |
| `discount_value` (percent)            | כן        | `1 … 10000`            | שלם bps                 | "אחוז ההנחה חייב להיות בין 0.01%‎ ל-100%‎."                        |
| `promotions.code` · `rate_plans.code` | כן        | 2–40                   | `^[a-z0-9][a-z0-9_-]*$` | "הקוד יכול להכיל אותיות אנגליות קטנות, ספרות, מקף וקו תחתון."      |
| `max_redemptions` · `budget_agorot`   | לא        | `>= 1` / `>= 0`        | שלם                     | "מספר המימושים חייב להיות לפחות 1."                                |
| `effective_from` · `effective_to`     | `from` כן | `to > from`            | `YYYY-MM-DD`            | "תאריך הסיום חייב להיות אחרי תאריך ההתחלה."                        |
| `weekdays`                            | לא        | ‎0–6, ללא כפילויות     | `smallint[]`            | "בחר ימים תקינים בשבוע."                                           |
| `min_nights`                          | לא        | `1 … 365`              | שלם                     | "מינימום הלילות חייב להיות לפחות 1."                               |
| `coupon.code`                         | כן        | 4–24                   | `^[A-Z0-9-]+$`          | "קוד קופון מכיל אותיות גדולות, ספרות ומקפים בלבד."                 |
| נימוק (`reason`) בחריגת מחיר          | כן        | 3–500                  | טקסט                    | "הפעולה הזו דורשת נימוק. הסבר בקצרה מדוע היא מבוצעת."              |

כל השדות מדווחים **יחד** ולא אחד־אחד — `ValidationError` נושאת את כל
ה-`FieldIssue`. הסכימות נבנות מ-`src/lib/service/schema.ts`;
`s.agorot(...)` הוא הטיפוס לכל שדה כספי, ולא `s.number`.

---

## 9. אוטומציות והתראות

| טריגר                                           | תנאי                              | פעולה                                                                   | מי מקבל                                 | ערוץ                | כישלון משלוח                                                      |
| ----------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `pricing.suggestions_ready` (יומי, 06:00 מקומי) | יש `pending`                      | התראה עם מספר ההמלצות והפער המצטבר                                      | מחזיקי `pricing.manage`, לפי הטווח שלהם | דוא״ל + התראה במוצר | אין ניסיון חוזר. ההמלצות ממתינות במסך; התראה שאבדה אינה מחיר שאבד |
| מחיר לילה נצבט לרצפה 3 פעמים ב-7 ימים           | —                                 | "המחירון מייצר מחירים מתחת לרצפה — כדאי לבדוק"                          | `revenue_manager`                       | במוצר               | —                                                                 |
| מבצע חצה 80% מ-`budget_agorot`                  | —                                 | אזהרה                                                                   | יוצר המבצע + `revenue_manager`          | דוא״ל               | ניסיון חוזר פעם אחת                                               |
| מבצע מיצה `max_redemptions`                     | —                                 | המבצע מושבת אוטומטית + התראה                                            | כנ״ל                                    | דוא״ל               | ההשבתה **אינה** תלויה בהתראה. היא באילוץ, §10                     |
| שינוי `properties.tax_rate_bps`                 | —                                 | "שינוי מע״מ ישפיע על הזמנות חדשות בלבד. N הזמנות קיימות שומרות על 17%." | מבצע השינוי                             | חסימת דיאלוג        | —                                                                 |
| הזמנה נוצרה עם מחיר מתחת לרצפה                  | חריגה עם `booking.override_price` | דיווח יומי מרוכז                                                        | `general_manager`                       | דוא״ל               | —                                                                 |
| תעריף לא הוגדר ל-30 הימים הקרובים               | יחידה פעילה                       | "יחידה X נמכרת במחיר הבסיס בלבד"                                        | `revenue_manager`                       | במוצר               | —                                                                 |

התראה נכשלת אף פעם לא מגלגלת לאחור פעולה עסקית — זה החוק ב-`operation.ts`
שלב 10, והכישלון מדווח דרך `onEventError`.

---

## 10. מקביליות ו-Idempotency

**שני אנשים עורכים את אותו לילה.** `rate_calendar` נושאת `version`. שמירה
מוסרת `expectedVersion`; אי-התאמה → `ConflictError` (409), לא ניתן לניסיון
חוזר אוטומטי. ניסיון חוזר אוטומטי כאן הוא בדיוק העריכה האבודה שהעמודה קיימת
כדי למנוע.

**עריכה קבוצתית מול עריכה נקודתית.** עריכה קבוצתית פועלת בטרנזקציה אחת עם
`select … for update` על טווח התאריכים, ממוין לפי `date` עולה. הסדר הקבוע
הוא מה שמונע deadlock בין שתי עריכות קבוצתיות חופפות.

**מבצע שמתקרב לתקרה.** `max_redemptions` **אינו** נבדק בקוד לפני הכתיבה.
הוא נאכף על `discount_redemptions` באילוץ — `redemption_index` שנוצר
מ-`count(*)` בתוך `insert … select` עם אילוץ `check (redemption_index <= max_redemptions)`,
או, פשוט יותר, `unique (coupon_id) where single_use`. בדיקה בקוד מפסידה
למרוץ; אילוץ לא.

**קופון חד־פעמי בשני חלונות דפדפן.** האילוץ הייחודי לעיל. אחד עובר, השני
מקבל `BusinessRuleError` עם "הקופון כבר מומש".

**שני ציטוטים בו־זמנית לאותה יחידה.** מותר ובלתי מזיק: ציטוט אינו תופס
תאריכים. תפיסת תאריכים היא `hold`, ושם המנגנון הוא `unit_occupancy_no_overlap`
ב-0009 ולא כאן.

### Idempotency — 🔒 מפתחות, טווח ומחזור חיים

הטווח הוא `(organization_id, operation, key)` — מ-`src/lib/service/idempotency.ts`
ומ-`idempotency_keys_scope_key` ב-0006. אף פעם לא המפתח לבדו.

| פעולה                                 | מקור המפתח                                                                     | למה                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `booking.create` (עם תמחור)           | הלקוח מייצר UUID v4 **בעת הצגת הטופס**, ומשתמש בו בכל ניסיון חוזר של אותו טופס | מפתח שנוצר מחדש בכל ניסיון אינו מפתח                                       |
| `pricing.approve_suggestion` (יחיד)   | `suggestion:{suggestion_id}`                                                   | אישור הוא מעשה חד־פעמי לכל המלצה. נגזר בשרת                                |
| `pricing.approve_suggestions` (אצווה) | הלקוח מייצר UUID אחד לאצווה                                                    | אצווה חלקית שרצה פעמיים היא חצי מחירון כפול                                |
| `pricing.bulk_edit`                   | `bulk:{unit_id}:{plan_id}:{from}:{to}:{payload_hash}`                          | נגזר. אותה עריכה בדיוק פעמיים היא לחיצה כפולה                              |
| `promotion.redeem`                    | `redeem:{booking_id}:{promotion_id}`                                           | מבצע נפדה פעם אחת להזמנה, בהגדרה                                           |
| `booking.reprice`                     | הלקוח מייצר UUID לכל פתיחת דיאלוג התמחור מחדש                                  | תמחור מחדש **הוא** פעולה חוזרת לגיטימית; המפתח מגן על הלחיצה, לא על הכוונה |

מחזור החיים מ-0006: הזמנה מוחזקת שעה (`expires_at`); שורה שהושלמה נשמרת
24 שעות ואז ניתנת לתביעה מחדש. שחרור בכישלון הוא `abandon()` שמוחק את
השורה — בלי זה, כישלון חולף היה מרעיל את המפתח והניסיון החוזר שהמשתמש
התבקש לעשות היה נכשל לנצח.

⚠️ 24 השעות מספיקות לכל פעולת תמחור. הן **אינן** מספיקות לזרימות הכספים —
ראה [`21-finance.md`](21-finance.md) §10, שם הפער הזה הוא ממצא.

---

## 11. אינטגרציות

| ספק                                      | מה נקרא               | מה נכתב                           | תקלה                                                                  | איזון אחריה                                                                                                                                                    |
| ---------------------------------------- | --------------------- | --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ערוצי הפצה (Airbnb · Booking.com · VRBO) | —                     | `nightly` ו-`min_nights` לכל לילה | דחיפה שנכשלה נשמרת בתור עם `attempt`, `last_error`, `next_attempt_at` | סנכרון מלא לילי משווה את מה שבערוץ למה שב-`rate_calendar` ומדווח סטיות. **ESTIA היא מקור האמת**; סטייה נפתרת לטובתה                                            |
| ערוצי הפצה — קליטה                       | מחיר שההזמנה נסגרה בו | `booking_price_lines` כפי שהגיעו  | מחיר שאינו תואם את המחירון                                            | ⚠️ **המחיר של הערוץ גובר.** הזמנה מ-OTA היא עסקה שכבר נסגרה; תיקונה למחירון שלנו הוא המצאת חוב. הסטייה נרשמת ב-`resolution` כ-`channel_price_mismatch` ומדווחת |
| `src/lib/hebrew-calendar/`               | ימים מיוחדים ושבת     | —                                 | —                                                                     | מודול מקומי, ללא רשת. נתמך לכל שנה עברית (§המודול)                                                                                                             |
| ספק תמחור דינמי חיצוני                   | ❓                    | —                                 | —                                                                     | ❓                                                                                                                                                             |

❓ **האם ESTIA משתמשת בספק תמחור דינמי חיצוני** (PriceLabs, Wheelhouse, Beyond)
או במנוע פנימי — החלטה מסחרית: יש לה עלות לכל יחידה לחודש, והיא משנה את
מבנה החבילות. [`PACKAGES.md`](../PACKAGES.md) מתמחר "תמחור דינמי AI ₪149/חודש",
מה שרומז על עלות שולית אמיתית, אך אינו נוקב בספק. **המנגנון בסעיף 12 תקף
לשניהם:** הצעה נכתבת ל-`rate_suggestions` ואינה מחיר, מי שיצר אותה.

⚠️ **מיפוי `booking_source` לערוץ** — `BOOKING_SOURCES` מכיל `airbnb`,
`booking_com`, `vrbo`, `other_channel`, אבל `rate_plans.channel_scope` צריך
גם להבחין בין שני חשבונות Booking.com של אותו עסק. `bookings.source_channel`
(text) קיים בדיוק לזה. **המלצה:** `channel_scope` יתאים על הצמד
`(source, source_channel)` ולא על `source` בלבד.

---

## 12. AI

**מה ה-AI עושה כאן** — קורא ביקוש היסטורי, תפוסה, קצב הזמנות, מחירי הנכס
עצמו לאורך זמן ולוח השנה העברי, ומציע מחיר ללילה, עם נימוק בעברית ורמת ביטחון.

**על אילו נתונים** — אך ורק נתוני ה-`organization` עצמה: `bookings` שהגיעו
ל-`REALISED_STATUSES`, `unit_occupancy`, `rate_calendar`, `holds`,
ו-`hebrew-calendar`. אין נתוני שוק ואין נתוני עסקים אחרים.

🔒 **ל-AI יש בדיוק את הרשאות המשתמש שהוא משרת.** האכיפה בשאילתה: המנוע רץ
תחת אותו `Actor`, אותו `Scope` ואותו `resolveMetricScope`. מנוע שרץ על הכול
ומסנן בסוף כבר הדליף. מנהל נכס עם `properties[4,7]` מקבל המלצות לשני הנכסים
האלה בלבד, כי השאילתה מעולם לא נגעה באחרים.

**מה אסור לו — רשימה סגורה:**

1. **לכתוב מחיר.** אין נתיב קוד מ-`rate_suggestions` ל-`rate_calendar` שאינו
   עובר באישור אדם או במדיניות `auto_apply` שאדם הפעיל ושמוגבלת ב-§6 חוק 26.
2. **לעקוף רצפה ותקרה.** הצביטה של §7.5 היא דטרמיניסטית ורצה אחרי ההצעה,
   לא לפניה. הצעה של ₪3,000 בתקרה ₪2,200 נכתבת כ-₪3,000 ומיושמת כ-₪2,200,
   ושני המספרים נשמרים.
3. **לגעת בהזמנה קיימת.** מחיר של לילה שנמכר הוא עובדה.
4. **לשנות תנאי כשירות של מבצע.** מבצע הוא הבטחה מסחרית; שינוי התנאים שלו
   הוא שינוי ההבטחה.
5. **לחצות ארגון.** בידוד דיירים אינו סינון תוצאה — RLS + `MetricScopeError`.
6. **לפעול בלי שם.** כל שינוי אוטומטי נושא `actor.type='ai_agent'`,
   `label` שמזהה את המנוע, ו-`on_behalf_of_user_id` = מי שהפעיל את המדיניות.
7. **לגעת בכסף.** אין ל-AI, בשום מדיניות, גישה להנפקת מסמך, החזר, זיכוי או
   תשלום. ראה [`21-finance.md`](21-finance.md) §12.

**מה שנשמר כדי שאפשר יהיה למדוד** — `deterministic_agorot` נשמר לצד
`suggested_agorot`. בלעדיו אי אפשר לענות על "האם ההמלצות שיפרו משהו", וזו
השאלה היחידה שמצדיקה את קיום המנוע.

---

## 13. אבטחה ופרטיות

**מה רגיש כאן** — שלושת התעריפים. `rate.net` הוא **המחיר שהעסק באמת מוכן
לקבל**, ומסירתו לגורם הלא נכון מוסרת את המשא ומתן עצמו.

| שדה                     | ההרשאה                       | מי מחזיק בפועל                                          |
| ----------------------- | ---------------------------- | ------------------------------------------------------- |
| `rate.public`           | `rate.view_public`           | כמעט כולם, כולל `property_owner` וסוכן מדרגה `public`   |
| `rate.agent`            | `rate.view_agent`            | סוכנים מדרגה `agent` ומעלה, `revenue_manager`           |
| `rate.net`              | `rate.view_net`              | הנהלה ו-`revenue_manager` בלבד. **לא** `property_owner` |
| `booking.price`         | `booking.view_price`         | מי שרואה כמה שולם בפועל. שונה מ-`rate.*`, שהוא מחירון   |
| `booking.profitability` | `booking.view_profitability` | ראה [`21-finance.md`](21-finance.md) §13                |

**הסתרה ברמת השדה, לא ברמת המסך.** התעריף שאין למשתמש הרשאה עליו **אינו
נשלח בתגובה**. הוא לא מוסתר ב-CSS ולא מסונן בקליינט. הסתרת כפתור אינה אבטחה.

**מנקה** — לא מופיע במודול הזה בשום צורה. אין לו `rate.view_*`, אין לו
`booking.view_price`, ואין לו מסך. זה חוק המינימום ההכרחי מ-`CLAUDE.md`.

**`property_owner`** — רואה את התעריף הציבורי של הנכס שלו, ולא רואה: מבצעים
(הם מנגנון שיווקי של חברת הניהול), תעריפי סוכן, `rate.net`, המלצות AI,
ותעריפים של כל נכס אחר — כולל של בעלים אחר באותה חברת ניהול. הבידוד הזה
הוא בין שורות באותו ארגון, ולכן הוא **בטווח** (`properties[]`) ולא ב-RLS.

**פעולות שדורשות נימוק** — מחיר מתחת לרצפה, דחיית המלצה, השבתת מבצע פעיל,
שינוי `tax_rate_bps`. הנימוק נאכף בצינור (`requiresReason`) ולא במסך.

**פעולות שדורשות אימות מחדש** — שינוי `floor_agorot` של תוכנית תעריפים,
והפעלת `auto_apply`. שתיהן מוסיפות `pricing.manage` ל-`SENSITIVE_ACTIONS`.
⚠️ `pricing.manage` **אינו** ב-`SENSITIVE_ACTIONS` היום. **המלצה:** להוסיף
אותו — הרצפה היא המחסום היחיד בין המלצה הסתברותית לבין הפסד, ומי שמזיז אותה
צריך לומר למה.

---

## 14. Audit

כל ניסוח בעברית, בשם המבצע, עם המספרים המלאים.

| פעולה                | `action`                 | הניסוח                                                                                                                          |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| שינוי מחיר לילה      | `pricing.manage`         | "שי שינה את מחיר הלילה 14/04/2026 ביחידה 'סוויטת הגפן' מ-₪1,200 ל-₪1,450"                                                       |
| עריכה קבוצתית        | `pricing.manage`         | "רוני עדכנה 23 לילות ביחידה 'סוויטת הגפן' (01/07–23/07) ל-₪1,600 ללילה"                                                         |
| חוק תעריף חדש        | `pricing.manage`         | "דנה יצרה חוק תעריף 'עונת סוכות' · 25/09–15/10 · ₪1,400 ללילה · יחידה 'סוויטת הגפן'"                                            |
| שינוי רצפה           | `pricing.manage`         | "שי הוריד את מחיר הרצפה בתוכנית 'ישיר' מ-₪900 ל-₪750 · סיבה: תחרות מול צימר סמוך"                                               |
| מבצע נוצר            | `pricing.manage`         | "דנה יצרה מבצע 'הזמנה ישירה' · 5% · ללא הגבלת מימושים · תקציב ₪20,000"                                                          |
| מבצע הושבת           | `pricing.manage`         | "המערכת השביתה את המבצע 'הזמנה ישירה' — מוצו 200 המימושים"                                                                      |
| מימוש מבצע           | `booking.create`         | "מבצע 'הזמנה ישירה' הופעל בהזמנה B3F91A2C · הנחה ₪278"                                                                          |
| המלצה נוצרה          | `pricing.manage`         | "ESTIA הציעה ₪1,610 ללילה 03/10/2026 (דטרמיניסטי ₪1,400, ביטחון 78%): 'ביקוש גבוה מהרגיל לשמחת תורה'" · `actor.type='ai_agent'` |
| המלצה אושרה          | `pricing.manage`         | "דנה אישרה את ההמלצה ל-03/10/2026 · ₪1,610"                                                                                     |
| המלצה יושמה אוטומטית | `pricing.manage`         | "ESTIA עדכנה את מחיר הלילה 03/10/2026 מ-₪1,400 ל-₪1,610 לפי מדיניות התמחור האוטומטי שהפעיל שי" · `on_behalf_of_user_id = שי`    |
| חריגה מתחת לרצפה     | `booking.override_price` | "רוני אישרה מחיר ₪850 ללילה, מתחת לרצפה ₪900 · סיבה: אורח חוזר שהמליץ על שלושה"                                                 |
| תמחור מחדש           | `booking.amend_price`    | "דנה שינתה את סכום ההזמנה B3F91A2C מ-₪5,200 ל-₪4,700 · סיבה: פיצוי על תקלה במזגן"                                               |
| שינוי מע״מ           | `property.update`        | "שי שינה את שיעור המע״מ בנכס 'דה אוליביה' מ-17% ל-18%. 41 הזמנות קיימות שומרות על השיעור הקודם"                                 |

`before`/`after` מצומצמים ל-`diffFields`. `NEVER_LOGGED` חל; אין כאן שדה
סודי, אבל הכלל אינו מותנה בכך.

---

## 15. דיווח

מזין: **הכנסה מלינה** (`BookingFactRow.roomRevenue` — נטו ממס ומהנחות,
כפי ש-`src/lib/metrics/rows.ts` מגדיר), **הכנסה נלווית**
(`ancillaryRevenue`), **עמלה** (`commission`).

מדדים — נלקחים מ-`src/lib/metrics/` ולא מוגדרים כאן:
תפוסה · ADR · RevPAR · ערך הזמנה ממוצע · תמהיל מקורות.

⚠️ **תלות פתוחה** — `src/lib/metrics/rows.ts` ו-`scope.ts` מפנים ל-`facts.ts`,
שעדיין אינו קיים. הנוסחאות של תפוסה, ADR ו-RevPAR שייכות לשם. **המודול הזה
לא מגדיר אותן**, ולא יגדיר. מה שהוא **צריך** מ-`facts.ts`:

| מה נדרש                              | לשם מה                       |
| ------------------------------------ | ---------------------------- |
| `occupancyPercent(propertyId, date)` | תוספת הביקוש, §7.4           |
| `adr(scope, range)`                  | השוואת המלצה למציאות         |
| `revpar(scope, range)`               | מדידת השפעת המחירון          |
| `paceByLeadTime(scope, range)`       | `early_bird` / `last_minute` |

דוחות שהמודול מזין: המחירון מול המכירות בפועל · ניצול מבצעים
(`discount_redemptions` מקובץ) · דיוק ההמלצות (`suggested` מול
`deterministic` מול מה שנמכר בפועל) · לילות שנמכרו מתחת לרצפה.

---

## 16. מטריצת מקרי קצה

| #   | המקרה                                           | מה קורה היום                               | מה **צריך** לקרות                                                                                  | איך בודקים                                                                                       |
| --- | ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | המחירון משתנה אחרי שנוצרה הזמנה                 | אין מנגנון — אין `booking_price_snapshots` | 🔒 ההזמנה לא זזה. אין נתיב שמחשב מחיר קיים                                                         | יצירת הזמנה → שינוי `rate_rules` → `bookings.total_agorot` ו-`booking_price_lines` זהים ביט־בביט |
| 2   | מע״מ עולה מ-17% ל-18% ב-1 בינואר                | `properties.tax_rate_bps` יחיד, ללא תיארוך | הזמנות קיימות שומרות על `bookings.tax_rate_bps` הצרוב. חדשות מקבלות את החדש                        | שתי הזמנות משני צדי התאריך; שתי שורות `tax` שונות; שתיהן מסתכמות                                 |
| 3   | שבת שהיא גם חול המועד                           | —                                          | תוספת אחת, המקסימום (חוק 9). לא סכום                                                               | 02/10/2026: `calendar_add = 35,000` ולא 56,000                                                   |
| 4   | שני חוקי תעריף חופפים באותה ספציפיות ועדיפות    | לא ניתן לייצוג                             | אילוץ exclusion דוחה את השני בשמירה                                                                | ניסיון INSERT מחזיר 23P01; ההודעה בעברית נוקבת בשני החוקים                                       |
| 5   | קופון חד־פעמי בשני חלונות בו־זמנית              | —                                          | אחד עובר, שני מקבל "הקופון כבר מומש". **אילוץ**, לא בדיקה                                          | שתי בקשות מקבילות; בדיוק שורה אחת ב-`discount_redemptions`                                       |
| 6   | ה-AI מציע מחיר מעל התקרה                        | —                                          | ההצעה נשמרת כפי שהיא; היישום נצבט לתקרה; שני המספרים נשמרים                                        | `suggested=300000`, `ceiling=220000` → `rate_calendar = 220000`, `resolution.clamped = true`     |
| 7   | `auto_apply` מופעל ולילה נמכר באותו רגע         | —                                          | היישום נדחה (חוק 25). ההמלצה נשארת `pending`                                                       | מרוץ: אישור אוטומטי מול `booking.create` על אותו לילה                                            |
| 8   | הנחה גדולה מהסכום                               | `priceStay` צובט ל-`remaining`             | סכום 0, לא שלילי. השורה מוצגת בערכה הצבוט                                                          | הנחה 150% על ₪1,000 → שורת הנחה ‎−100,000, סכום 0                                                |
| 9   | תפוסה של נכס שכל יחידותיו מושבתות               | —                                          | `null` → אין תוספת ביקוש. **לא** המדרגה הזולה                                                      | `availableUnitNights = 0` → `demand_add = 0`, ו-`resolution` מציין `occupancy: null`             |
| 10  | מינימום לילות משתנה אחרי שנוצרה הזמנה קצרה יותר | —                                          | ההזמנה תקפה. המינימום נאכף ביצירה ובשינוי תאריכים, לא רטרואקטיבית                                  | שינוי `min_nights` ל-3; הזמנה קיימת של לילה אחת נשארת; שינוי תאריכיה נכשל                        |
| 11  | ערוץ החזיר הזמנה במחיר שאינו במחירון            | —                                          | ⚠️ **מחיר הערוץ גובר.** נרשם כ-`channel_price_mismatch` ומדווח                                     | קליטת הזמנה עם ₪900 מול מחירון ₪1,200: השורות ₪900; דוח סטיות מציג אחת                           |
| 12  | סוכן מבקש הנחה מעל התקרה שלו                    | —                                          | **סירוב** עם שמה של התקרה. לא צביטה שקטה (חוק 33)                                                  | סוכן עם תקרה 10% מבקש 15% → `BusinessRuleError` שנוקב ב-10%                                      |
| 13  | תוכנית תעריפים נגזרת יוצרת מעגל                 | —                                          | נדחה **בשמירה**, לא בציטוט                                                                         | A→B→A נדחה עם "גזירת התעריפים יוצרת מעגל"                                                        |
| 14  | טווח שהות של אפס לילות                          | `ValidationError` מ-`priceStay`            | כנ״ל. לא ₪0                                                                                        | `checkIn = checkOut` → 422 על `checkOut`                                                         |
| 15  | תמחור לילה בשנה עברית רחוקה (2035)              | עובד — הטבלה נבנית לפי שנה, memoised       | כנ״ל. הפגם הישן של הלגסי (חלון ±4 שנים) לא חזר                                                     | `isPeakNight('2035-04-24')` מזהה פסח                                                             |
| 16  | אין תוכנית תעריפים כשירה                        | —                                          | `BusinessRuleError`, **לא** נפילה למחיר הבסיס                                                      | ערוץ `airbnb` בלי תוכנית ל-OTA → `pricing.no_rate_plan`                                          |
| 17  | מבצע פג תוקף בין הציטוט להזמנה                  | —                                          | ההזמנה מתומחרת מחדש בעת היצירה, לפי `effective_on` של **היצירה**. האורח רואה את השינוי לפני האישור | ציטוט ב-23:59, יצירה ב-00:01 באזור הזמן של הנכס → הנחה נעלמת, מוצגת התראה                        |
| 18  | שני מבצעים באותה `exclusive_group`              | —                                          | הראשון לפי §7.9 נבחר; השני מדולג בשקט ואינו מוצג לאורח                                             | שניהם כשירים → שורת הנחה אחת                                                                     |
| 19  | `units.base_price_agorot = 0` ואין חוק          | ההזמנה תמוחר ב-0                           | ניתן לייצוג, אך המסך מזהיר בהגדרות היחידה, ו-`resolution` מסמן `fallback_zero`                     | יחידה חדשה בלי מחירון: אזהרה מוצגת; ציטוט נכשל ב-`quote.send` עד שנקבע מחיר                      |
| 20  | לחיצה כפולה על "אשר את כל ההמלצות"              | —                                          | מפתח Idempotency אחד לאצווה; השני מקבל `replayed` עם אותה תוצאה                                    | שתי בקשות עם אותו מפתח → שורה אחת ב-`rate_calendar` לכל לילה                                     |
| 21  | תמחור מחדש של הזמנה שהושלמה                     | —                                          | נדחה. התיקון הוא חשבונית זיכוי                                                                     | `status='completed'` → `BusinessRuleError` שמפנה ל-§21-finance                                   |
| 22  | `effective_to` של חוק באמצע שהות                | —                                          | כל לילה נפתר בנפרד. שהות יכולה לחצות שני חוקים, וזה נכון                                           | 3 לילות, החוק נסגר אחרי הראשון → שני מחירים שונים, שניהם ב-`resolution`                          |

---

## 17. מניעת טעות אנוש

| הטעות                                                     | המנגנון                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| מחיר באגורות מוקלד כשקלים (₪1,450 → 1450 אגורות = ₪14.50) | השדה **תמיד** מקבל שקלים ומציג ₪ צמוד; ההמרה בקצה. בנוסף: מחיר שקטן פי 50 מהמחיר הקודם באותה יחידה פותח דיאלוג אישור שנוקב בשני הסכומים |
| חוק תעריף על היחידה הלא נכונה                             | תצוגה מקדימה חובה לפני שמירה (§5.2), עם שם היחידה ושלושה תאריכי דוגמה                                                                   |
| עונה שנשמרה על השנה הלא נכונה                             | התאריכים מוצגים גם בלוח העברי. "כ״א תשרי תשפ״ז" תופס טעות ש-"2026-10-02" לא                                                             |
| עריכה קבוצתית על טווח רחב מדי                             | הדיאלוג נוקב במספר הלילות ובסכום ההפרש המצטבר לפני האישור: "23 לילות · הפרש ₪4,600"                                                     |
| מבצע בלי תאריך סיום                                       | `effective_to` אינו חובה, אך שמירה בלי תאריך מציגה אזהרה מפורשת: "מבצע ללא תאריך סיום ימשיך לרוץ"                                       |
| הנחה שהוזנה כ-50 במקום 5                                  | ולידציה (§8) מגבילה ל-100%, **ובנוסף**: הנחה מעל 30% דורשת אישור נוסף בדיאלוג                                                           |
| אישור המלצות באצווה בלי לקרוא                             | האצווה מציגה את הפער המצטבר בשקלים ואת מספר הלילות שנצבטו, ומגבילה ל-60 לילות בפעולה                                                    |
| שינוי רצפה בטעות                                          | פעולה רגישה: נימוק חובה + אימות מחדש (§13, המלצה)                                                                                       |
| הנחה שהופעלה פעמיים על אותה הזמנה                         | `unique (booking_id, promotion_id)` על `discount_redemptions`                                                                           |
| מחיר שנקבע והזמנה שנוצרה בהפרש של שניות ממחיר ישן         | הציטוט נושא את ה-`hash` של ה-snapshot; יצירת הזמנה עם hash שאינו הנוכחי מציגה את ההפרש ומבקשת אישור                                     |

---

## 18. תלויות

**המודול תלוי ב-**

| במה                            | במה בדיוק                                                                                                 | מצב                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/lib/booking/pricing.ts`   | `priceStay` · `sumLines` · `roundAgorot` · `manualDiscountLine` · `agentCommissionLine` · `taxIncludedIn` | קיים                                                          |
| `src/lib/booking/types.ts`     | `PriceLine` · `PRICE_LINE_KINDS` · `Agorot` · `DateRange` · `nightsBetween`                               | קיים                                                          |
| `src/lib/booking/dates.ts`     | `eachNight` · `localDate` · `formatDayMonth`                                                              | קיים                                                          |
| `src/lib/hebrew-calendar/`     | `isPeakNight` · `summarizeStay` · `isShabbat` · `formatHebrewDate`                                        | קיים                                                          |
| `src/lib/metrics/rounding.ts`  | `safeDivide` · `percentOf` · `allocateEvenly` · `allocateShares`                                          | קיים                                                          |
| `src/lib/metrics/facts.ts`     | תפוסה · ADR · RevPAR                                                                                      | ⚠️ **חסר**                                                    |
| `src/lib/service/operation.ts` | הצינור, Idempotency, Audit                                                                                | קיים                                                          |
| `src/lib/authz/`               | `can` · `PERMISSIONS` · `PRICE_LEVELS`                                                                    | קיים                                                          |
| `src/lib/preparation/types.ts` | `EventType` · `FactBasis`                                                                                 | קיים                                                          |
| מודול הסוכנים                  | `agent_agreements` · תקרת הנחה                                                                            | ⚠️ אינו בקוד. `agency_id` ב-0009 מסומן "foreign key deferred" |
| הגדרות נכס                     | `properties.tax_rate_bps` · `tourist_vat_exempt` · `min_nights`                                           | קיים ב-0008                                                   |

**תלויים במודול —** [`21-finance.md`](21-finance.md) (ההכנסה כולה), מנוע
הזמינות (מינימום לילות), האתר (מחיר לאורח), הערוצים, מודול הסוכנים
(תעריף וקומיסיה), הכנה ותפעול (`PreparationSnapshot.priceLines` צורבת את
מה שהאורח צוטט לצד מה שעולה לספק אותו).

---

## 19. בדיקות נדרשות

**Unit** — מוכיחות את החשבון.

1. סולם §7.2: לכל אחת משמונה רמות הספציפיות, חוק ברמה גבוהה יותר מנצח.
2. ארבעת שוברי השוויון, כל אחד בבידוד; השובר האחרון (`id`) מוכח בשני חוקים
   שנשמרו באותה מילישנייה.
3. חוק 9: שבת ⊕ חול המועד = מקסימום ולא סכום. הבדיקה מ-§7.11 שורה 1.
4. חוק 13: `availableUnitNights = 0` → אין תוספת ביקוש, ו-`resolution.occupancy = null`.
5. עיגול: `roundAgorot` על ‎±0.5 סימטרי — ‎−50.5 → ‎−51 ו-50.5 → 51. הבית לא
   מנצח בשני הצדדים.
6. §7.11 בשלמותה: 3 לילות, 4 אורחים, מבצע, מע״מ, פיקדון → `totalAgorot = 723,276`
   ו-`sumLines(lines) === totalAgorot`.
7. סדר המבצעים §7.9 דטרמיניסטי: אותם מועמדים בסדר הזנה הפוך → אותה בחירה.
8. `exclusive_group`: השני מדולג.
9. שתי הנחות 10% מורידות 20% ולא 19%.
10. `agentCommissionLine` אינה ב-`lines` ואינה משנה את `totalAgorot`.
11. `stayTotalAgorot = totalAgorot − depositAgorot`, עם ובלי פיקדון.
12. גזירת תעריף בעומק 3 עובדת; בעומק 4 נכשלת; מעגל נדחה.

**Integration** — מוכיחות את הצינור.

13. `booking.create` כותב snapshot אחד, שורות מחיר, ו-`bookings.total_agorot`
    מהטריגר — לא מהקוד.
14. תמחור מחדש מייצר `sequence = 2`, מסמן את הראשון `superseded_by`, ומשאיר
    אותו קריא.
15. עריכה קבוצתית עם `expectedVersion` ישן → `ConflictError` 409, ולא כתיבה.
16. שתי עריכות קבוצתיות חופפות בו־זמנית → שתיהן מסתיימות, ללא deadlock.
17. אישור אצווה עם אותו מפתח Idempotency פעמיים → השני `replayed`.
18. `abandon()` אחרי כישלון משחרר את המפתח; ניסיון חוזר מצליח.

**Security** — לכל הרשאה, בדיקה שמוכיחה את **השלילה**.

19. `rate.view_net` חסר → השדה **אינו בתגובה**. לא ריק, לא null — אינו קיים.
20. `rate.view_agent` חסר → כנ״ל.
21. `pricing.manage` חסר → כתיבה נדחית ב-`AuthorizationError` עם
    `missing_permission`, לפני שנקראה שורה.
22. `property_manager` עם `properties[4]` מבקש מחירון של נכס 7 → `out_of_scope`.
    ובנוסף: **גם בייצוא ובדוח**, לא רק במסך.
23. חוצה־ארגון: משתמש מארגון א׳ מבקש `rate_calendar` של ארגון ב׳ → אפס שורות
    ב-RLS, **וגם** סירוב במנוע. שתי הרצפות.
24. `cleaner` על כל אחד מחמשת מסכי המודול → סירוב.
25. `referral_agent` → אפס שדות מחיר בכל תגובה.
26. ה-AI תחת actor מוגבל־טווח מקבל המלצות לטווח שלו בלבד — נבדק על ה**שאילתה**
    (מה נשלף), לא על התוצאה (מה הוחזר).
27. חברות `suspended` → `membership_not_active` לפני כל דבר אחר.

**Regression** — כל אחת מ-22 שורות §16 היא מקרה בדיקה, בשמה.

**E2E** — ציטוט טלפוני מלא: בחירת יחידה → תאריכי סוכות → 4 אורחים → מבצע →
פירוק על המסך → שליחה → אישור האורח → הזמנה עם אותו סכום בדיוק.
ובמובייל: אותו זרימה, RTL, ללא גלילה אופקית.

---

## 20. תנאי קבלה

- [ ] **מסד** — `rate_plans` · `rate_rules` · `rate_calendar` · `rate_modifiers` · `promotions` · `coupons` · `discount_redemptions` · `rate_suggestions` · `dynamic_pricing_policies` · `booking_price_snapshots`, כולן עם `organization_id`, בלוק מטא-דאטה מלא ו-RLS.
- [ ] **מסד** — אילוץ exclusion מונע חוקים חופפים באותה ספציפיות ועדיפות (§16 שורה 4).
- [ ] **מסד** — `booking_price_snapshots` append-only: ההרשאות נשללו ו-trigger מסרב ל-UPDATE/DELETE.
- [ ] **מסד** — `unique (booking_id, promotion_id)` ו-`unique (coupon_id) where single_use`.
- [ ] **שרת** — `resolvePricing` מחזיר `StayPricingRequest` ולא מחיר; `priceStay` הוא המקום היחיד שמייצר סכום.
- [ ] **שרת** — כל פעולת כתיבה עוברת ב-`defineOperation`; אין כתיבה שעוקפת את הצינור.
- [ ] **שרת** — עיגול קורה בדיוק בשני מקומות, ובדיקה מוכיחה שאין שלישי.
- [ ] **הרשאות** — שלושת ה-`rate.view_*` נאכפים בעיצוב התגובה, ולכל אחד בדיקת שלילה.
- [ ] **הרשאות** — `pricing.manage` נוסף ל-`SENSITIVE_ACTIONS` (§13).
- [ ] **ממשק** — חמשת המסכים של §5, עם מצב ריק, טעינה ושגיאה, ובעברית RTL.
- [ ] **ממשק** — כל פירוק מחיר מציג את שם החוק שניצח, לא רק את הסכום.
- [ ] **מובייל** — לוח המחירים ומחשבון התמחור פועלים ללא גלילה אופקית.
- [ ] **בדיקות** — 27 בדיקות §19 עוברות, כולל שמונה בדיקות שלילה.
- [ ] **Audit** — 12 הניסוחים של §14 מיוצרים בפועל, בעברית, עם המספרים.
- [ ] **Audit** — שינוי אוטומטי נושא `actor.type='ai_agent'` ו-`on_behalf_of_user_id`.
- [ ] **שגיאות** — כל סירוב הוא `AppError` עם `userMessage` עברי, `dataOutcome` ו-`retryable`; שום הודעת ספק לא מגיעה למשתמש.
- [ ] **🔒 אי-סחיפה** — בדיקה שמשנה כל אחד מששת מקורות המחיר ומוכיחה שהזמנה קיימת לא זזה באגורה.
