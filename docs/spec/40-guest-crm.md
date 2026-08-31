# 40 · אורחים, לידים ותיבת הודעות · Guest CRM

> אפיון קצה. נכתב לפי [`00-TEMPLATE.md`](00-TEMPLATE.md), במבנה הזה ובסדר הזה.
> המודול המשלים: [`41-guest-portal.md`](41-guest-portal.md) — מה שהאורח עצמו רואה.

---

## 1. מטרת המודול

בעל צימר מכיר את האורחים שלו בראש, לא במערכת. הוא זוכר שמשפחת לוי מגיעה
כל פסח, שדנה ביקשה מיטת תינוק, ושמישהו ביטל ברגע האחרון לפני שנתיים.
כשהעסק גדל משלושה חדרים לשלושים, הזיכרון הזה נגמר — והמערכת שמחליפה אותו
מחזיקה **את האדם פעם אחת**, לא עותק של השם והטלפון על כל הזמנה.

המודול הזה עונה על ארבע שאלות:

1. **מי האורח הזה?** פרופיל אחד לכל אדם, עם כל השהיות, כל הכסף, כל
   ההעדפות וכל ההודעות — גם כשהוא הזמין פעם מהאתר, פעם בטלפון ופעם דרך סוכן.
2. **מי פנה ולא הזמין?** ליד הוא כסף שעדיין לא נכנס. עסק שלא עוקב אחריו
   מגלה בסוף החודש שענה לחצי מהפניות.
3. **מה הצענו לו, בכמה, ועד מתי?** הצעת מחיר היא מסמך שנשלח החוצה. מרגע
   שנשלחה היא לא משתנה מתחת לידיים של מי שקיבל אותה.
4. **מי ענה לו, מתי, ובאיזה ערוץ?** אורח כותב בוואטסאפ, שולח מייל, ומגיב
   דרך Airbnb — ומצפה שנזכור. שני עובדים שעונים לו במקביל זו התקלה שהוא
   רואה.

**מה זה לא:** זה לא מודול ההזמנות. הזמנה, זמינות, תמחור ומכונת המצבים
חיים ב-`src/lib/booking/` ובאפיון ההזמנות. כאן מטפלים באדם, בפנייה,
בהצעה ובשיחה.

---

## 2. משתמשים והרשאות

הרשאות מהקטלוג ב-[`src/lib/authz/permissions.ts`](../../src/lib/authz/permissions.ts).
תפקידים מ-[`src/lib/authz/roles.ts`](../../src/lib/authz/roles.ts).

| תפקיד                                            | מה הוא עושה כאן                                         | הרשאות                                                                                                                                  | Scope                                   | מה הוא **לא** רואה                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `organization_owner` · `administrator`           | הכול, כולל מיזוג ומחיקה של אורחים וייצוא                | `guest.*` · `lead.*` · `quote.*` · `message.*` · `guest.view_name` · `guest.view_phone` · `guest.view_email` · `guest.view_document_id` | `all_organization`                      | —                                                                                                                          |
| `general_manager`                                | מנהל את הצוות בתיבה, מאשר הצעות חריגות, רואה 360° מלא   | `guest.view/create/update` · `lead.*` · `quote.*` · `message.*` · שדות זהות מלאים                                                       | `all_organization`                      | `guest.delete` · `guest.export` אלא אם הוענקו במפורש                                                                       |
| `property_manager`                               | עובד עם אורחי הנכסים שלו בלבד                           | כמו לעיל                                                                                                                                | `properties[...]`                       | אורחים שכל השהיות שלהם בנכסים אחרים · לידים שלא שויכו לנכס שלו                                                             |
| `reservation_manager`                            | הליבה: לידים, הצעות, המרה להזמנה                        | `lead.*` · `quote.*` · `guest.view/create/update` · `message.view/send` · `guest.view_name/phone/email`                                 | `all_organization` או `properties[...]` | `guest.view_document_id` · רווחיות · `rate.view_net`                                                                       |
| `reception`                                      | עונה בתיבה, פותח לידים, לא מתמחר                        | `lead.view/create/update` · `quote.view` · `message.view/send` · `guest.view_name/phone`                                                | `properties[...]`                       | `guest.view_email` (ברירת מחדל) · `guest.view_document_id` · `quote.create` · `quote.send`                                 |
| `revenue_manager`                                | מתמחר הצעות, מנתח המרה                                  | `quote.*` · `lead.view` · `rate.view_public/agent/net`                                                                                  | `all_organization`                      | `guest.view_phone` · `guest.view_email` · `message.send`                                                                   |
| `finance_manager` · `accountant`                 | מגיע לאורח כדי לגבות או להוציא חשבונית                  | `guest.view` · `guest.view_name` · `finance.*`                                                                                          | `all_organization`                      | `message.send` · `lead.*` · `quote.create` · `guest.view_document_id`                                                      |
| `marketing_editor`                               | פילוח לקמפיין, תגיות, ביקורות                           | `guest.view` · `review.view/manage`                                                                                                     | `all_organization`                      | `guest.view_phone` · `guest.view_email` · `guest.export` · `message.send`                                                  |
| `operations_manager` · `housekeeping_supervisor` | רואה שם ובקשות אורח כדי לתפעל                           | `guest.view` · `guest.view_name` · `task.*`                                                                                             | `properties[...]`                       | טלפון · מייל · מסמך מזהה · מחיר · פרופיל 360°                                                                              |
| `cleaner` · `maintenance`                        | לא נכנס למודול הזה בכלל                                 | —                                                                                                                                       | `own_records`                           | הכול. אין להם `guest.view`                                                                                                 |
| `sales_agent` · `senior_agent`                   | ליד והצעה ללקוח **שלו**                                 | `lead.view/create/update` · `quote.view/create/update/send` · `guest.view` + סולם `GUEST_DATA_LEVELS`                                   | `own_records`                           | לידים של אחרים · לקוחות של העסק שלא הוא הביא · `guest.view_email` (הסולם עוצר לפי ההסכם) · `rate.view_net` · הערות פנימיות |
| `referral_agent`                                 | מפנה בלבד                                               | `lead.create`                                                                                                                           | `own_records`                           | הכול חוץ מהליד שהוא יצר                                                                                                    |
| `property_owner`                                 | רואה מי מתארח אצלו                                      | `guest.view` · `guest.view_name`                                                                                                        | `properties[...]`                       | טלפון · מייל · מסמך מזהה · שהיות באחרים · תיבת ההודעות                                                                     |
| `platform_support` (ESTIA)                       | תמיכה בתוך ארגון שנכנס אליו                             | לפי `isPlatformStaff`                                                                                                                   | עוקף Scope בתוך הארגון בלבד             | לא עוקף `organization_id` · כל כניסה נרשמת                                                                                 |
| **Guest**                                        | **אינו משתמש.** אין לו חשבון, אין Membership, אין תפקיד | —                                                                                                                                       | קישור יכולת להזמנה אחת                  | ראה [`41`](41-guest-portal.md) §13                                                                                         |

⚠️ **`guest.merge` לא קיים בקטלוג.** ראה §6 ח40-19: עד שיתווסף, מיזוג
דורש `guest.update` **וגם** `guest.delete` יחד, ומטופל כפעולה רגישה.
**המלצה:** להוסיף `guest.merge` ל-`PERMISSIONS` ול-`SENSITIVE_ACTIONS`,
כי מיזוג אינו עדכון ואינו מחיקה — הוא שינוי בלתי הפיך למעשה של היסטוריה
כספית, והוא צריך שם משלו כדי שיהיה ניתן לשלול אותו בנפרד.

⚠️ **`guest.view_contact` אינו קיים.** מסמכים ישנים מזכירים אותו;
בקוד הוא פוצל ל-`guest.view_name` · `guest.view_phone` ·
`guest.view_email` · `guest.view_document_id`. **הקוד גובר.** כל טקסט
במוצר שמדבר על "פרטי קשר" כיחידה אחת שגוי.

---

## 3. מודל הנתונים

כל טבלה נושאת `organization_id` ואת בלוק המטא-דאטה
(`created_at` · `created_by` · `updated_at` · `updated_by` · `version` ·
`deleted_at` · `deleted_by`), וכל טבלה מקבלת RLS
`organization_id IN (SELECT public.my_organizations())` בארבע מדיניויות
נפרדות, כמו ב-`0004_rls.sql`.

### 3.1 `guests` — קיים

מוגדר ב-[`0009_booking_core.sql`](../../supabase/migrations/0009_booking_core.sql).
**לא מומצא כאן מחדש.** מה שקיים ומשמעותי למודול:

| עמודה                                        | הערה                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `phone` · `phone_e164`                       | `phone_e164` היא **עמודה מחושבת** (`generated always as normalize_phone_il(phone) stored`). מפתח הדדופליקציה. אף נתיב כתיבה לא יכול לדלג עליה |
| `email` (`citext`)                           | מאונדקס, **לא ייחודי** בכוונה — זוג שמזמין משני תאריכים מאותה כתובת הוא המקרה הרגיל                                                           |
| `id_document_type/number/country`            | מאחורי `guest.view_document_id` בלבד                                                                                                          |
| `tags text[]`                                | GIN. אוצר מילים עובד, לא טקסונומיה                                                                                                            |
| `marketing_consent` · `marketing_consent_at` | ברירת מחדל `false`                                                                                                                            |
| `is_blocked` · `blocked_reason`              | אילוץ: אין נימוק בלי חסימה                                                                                                                    |
| `guests_organization_phone_idx`              | `unique (organization_id, phone_e164) where phone_e164 is not null and deleted_at is null` — **חוק הדדופליקציה כאילוץ, לא כמוסכמה**           |

**עמודות שהמודול הזה דורש להוסיף ל-`guests`:**

| עמודה                                                    | טיפוס                                     | למה                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merged_into_guest_id`                                   | `uuid references guests(id)`              | אורח שמוזג נשאר בשורה שלו, מסומן ומצביע על השורד. ID ישן שממשיך להופיע בקישור חיצוני חייב להוביל לאדם הנכון                                          |
| `preferred_channel`                                      | `text` (`whatsapp`/`email`/`sms`/`phone`) | לאן שולחים. בלי זה כל אוטומציה מנחשת                                                                                                                 |
| `preferences`                                            | `jsonb`                                   | העדפות מובנות: `bed_setup` · `dietary` · `accessibility` · `arrival_time` · `allergies` · `free_text`. `jsonb` ולא טבלה כי זה לא נשאל בשאילתה מצטברת |
| `first_stay_at` · `last_stay_at` · `stay_count`          | `date` · `date` · `integer`               | מתוחזקים בטריגר מ-`bookings`. נדרשים לפילוח וחיפוש; חישוב חי על כל תצוגה הוא סריקה מיותרת                                                            |
| `lifetime_revenue_agorot`                                | `integer`                                 | כנ"ל. **מתוחזק בטריגר, לעולם לא נכתב ע"י Caller** — אותו כלל כמו `bookings.total_agorot`                                                             |
| `erasure_state`                                          | `text` (`active`/`restricted`/`erased`)   | ראה §13.6                                                                                                                                            |
| `erasure_requested_at` · `erased_at` · `retention_until` | `timestamptz`                             | תיעוד בקשת מחיקה מול חובת שמירה                                                                                                                      |
| `source_first_touch`                                     | `text`                                    | איך האדם הזה הגיע לעסק בפעם הראשונה. לא זהה ל-`bookings.source` של שהות מסוימת                                                                       |

אינדקסים נוספים: `guests (organization_id, last_stay_at desc)` לרשימת
"אורחים אחרונים"; `guests (organization_id, merged_into_guest_id) where
merged_into_guest_id is not null` לניתוב ID ישן;
`guests using gin (to_tsvector('simple', full_name))` לחיפוש חופשי בשם.

### 3.2 `guest_merges`

| עמודה                                     | טיפוס                  | הערה                                                                                                                                |
| ----------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                      | `uuid pk`              |                                                                                                                                     |
| `organization_id`                         | `uuid not null`        |                                                                                                                                     |
| `survivor_guest_id` · `merged_guest_id`   | `uuid not null`        |                                                                                                                                     |
| `field_resolutions`                       | `jsonb not null`       | לכל שדה: מאיפה נלקח הערך ומה היה הערך שנדרס                                                                                         |
| `moved`                                   | `jsonb not null`       | **רשימת מזהי שורות שהוזזו**, לפי טבלה: `bookings[]` · `conversations[]` · `leads[]` · `quotes[]` · `guest_requests[]` · `reviews[]` |
| `reason`                                  | `text not null`        | חובה. "למה מיזגת" נשאל חודשיים אחרי                                                                                                 |
| `performed_by`                            | `uuid not null`        |                                                                                                                                     |
| `performed_at`                            | `timestamptz not null` |                                                                                                                                     |
| `undone_at` · `undone_by` · `undo_reason` |                        |                                                                                                                                     |
| `undo_deadline`                           | `timestamptz not null` | `performed_at + 30 days`                                                                                                            |

🔒 `moved` ו-`field_resolutions` הם **תנאי הביטול**. מיזוג בלי תמונת מצב
מלאה הוא מיזוג בלתי הפיך, ואת זה אי אפשר לתקן בדיעבד.

### 3.3 `leads`

| עמודה                                                         | טיפוס                   | הערה                                                                                                       |
| ------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id` · `organization_id`                                      |                         |                                                                                                            |
| `property_id`                                                 | `uuid null`             | פנייה יכולה לא לנקוב בנכס                                                                                  |
| `guest_id`                                                    | `uuid null`             | מתמלא ברגע שזוהתה התאמה. ראה ח40-08                                                                        |
| `status`                                                      | `lead_status`           | enum ב-DB. ראה §4                                                                                          |
| `source`                                                      | `lead_source`           | `website` · `phone` · `whatsapp` · `agent` · `ota_enquiry` · `social` · `walk_in` · `referral`             |
| `source_detail`                                               | `text`                  | "instagram_story_apr26", "booking.com enquiry #…"                                                          |
| `raw_name` · `raw_phone` · `raw_email`                        | `text`                  | **כפי שהוקלד.** לא מנורמל, לא מתוקן. מקור האמת של מה שהאדם באמת כתב                                        |
| `phone_e164`                                                  | `text generated`        | `normalize_phone_il(raw_phone)`. מפתח ההצמדה לאורח                                                         |
| `requested_check_in` · `requested_check_out`                  | `date null`             |                                                                                                            |
| `party_adults` · `party_children` · `party_infants`           | `integer`               |                                                                                                            |
| `budget_agorot`                                               | `integer null`          |                                                                                                            |
| `message`                                                     | `text`                  | מה הוא כתב                                                                                                 |
| `assigned_to_user_id` · `assigned_team_id`                    | `uuid null`             |                                                                                                            |
| `first_response_at`                                           | `timestamptz null`      | נכתב פעם אחת בלבד (ח40-12)                                                                                 |
| `next_action_at`                                              | `timestamptz null`      | מזין את רשימת "לטפל היום"                                                                                  |
| `status_changed_at`                                           | `timestamptz`           |                                                                                                            |
| `lost_reason`                                                 | `lead_lost_reason null` | `price` · `dates_unavailable` · `no_response` · `booked_elsewhere` · `not_serious` · `duplicate` · `other` |
| `lost_note`                                                   | `text null`             | חובה כאשר `lost_reason = 'other'`                                                                          |
| `booking_id`                                                  | `uuid null`             | נקבע ב-`booked`                                                                                            |
| `agent_user_id` · `agency_id` · `campaign_id` · `referral_id` |                         | ייחוס, באותו אוצר מילים של `BookingAttribution`                                                            |

אילוץ: `lost_reason is not null` כאשר `status = 'lost'`; `booking_id is
not null` כאשר `status = 'booked'`.

אינדקסים: `(organization_id, status, next_action_at)` — מסך העבודה
היומי; `(organization_id, phone_e164)` — הצמדה ואיתור כפילות;
`(organization_id, assigned_to_user_id, status)` — "הלידים שלי";
`(organization_id, created_at desc)`.

### 3.4 `quotes` ו-`quote_lines`

| `quotes`                                                        | טיפוס                            | הערה                                                                             |
| --------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| `id` · `organization_id` · `property_id` · `unit_id`            |                                  |                                                                                  |
| `lead_id` · `booking_id` · `guest_id`                           | `uuid null`                      | הצעה יכולה לתלות בליד, בהזמנה בסטטוס `quote`, או בשניהם                          |
| `version_number`                                                | `integer not null default 1`     |                                                                                  |
| `supersedes_quote_id`                                           | `uuid null`                      |                                                                                  |
| `status`                                                        | `quote_status`                   | `draft` · `sent` · `viewed` · `accepted` · `declined` · `expired` · `superseded` |
| `check_in` · `check_out`                                        | `date`                           | חצי־פתוח `[check_in, check_out)`, כמו `DateRange`                                |
| `adults` · `children` · `infants`                               | `integer`                        |                                                                                  |
| `currency`                                                      | `text default 'ILS'`             |                                                                                  |
| `total_agorot`                                                  | `integer not null`               | סכום `quote_lines`. **מתוחזק בטריגר**, כמו `bookings.total_agorot`               |
| `lines_snapshot`                                                | `jsonb`                          | הקפאה של השורות ברגע השליחה. ראה ח40-24                                          |
| `valid_until`                                                   | `timestamptz not null`           |                                                                                  |
| `hold_id`                                                       | `uuid null references holds(id)` | הצעה יכולה להחזיק תאריכים                                                        |
| `agent_user_id` · `agency_id`                                   | `uuid null`                      |                                                                                  |
| `note_to_recipient`                                             | `text`                           | מה שהאורח יראה                                                                   |
| `internal_note`                                                 | `text`                           | מאחורי `booking.note.internal`                                                   |
| `sent_at` · `first_viewed_at` · `last_viewed_at` · `view_count` |                                  |                                                                                  |
| `accepted_at` · `declined_at` · `decline_reason`                |                                  |                                                                                  |
| `document_sha256`                                               | `text null`                      | חתימת התוכן ששודר. נדרש כדי לענות "מה בדיוק שלחנו"                               |

`quote_lines` — אותו אוצר מילים של `PriceLine` ב-`src/lib/booking/types.ts`:
`kind` (`PRICE_LINE_KINDS`) · `label` · `amount_agorot` (שלילי בהנחה) ·
`quantity` · `date`. **לא ממציאים סוג שורה חדש כאן.**

🔒 קישור השיתוף של הצעה **אינו** עמודה ב-`quotes`. הוא רשומה ב-
`guest_access_links` (§3.7) עם `purpose = 'quote'`. הצעה נשלחת שלוש פעמים
= שלושה קישורים, שכל אחד ניתן לביטול בנפרד.

### 3.5 `conversations`

| עמודה                                                      | טיפוס                          | הערה                                                                             |
| ---------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `id` · `organization_id` · `property_id`                   |                                | `property_id` null כשאין עדיין נכס                                               |
| `guest_id` · `booking_id` · `lead_id`                      | `uuid null`                    | שיחה יכולה להתחיל לפני שיודעים מי זה                                             |
| `channel`                                                  | `message_channel`              | `whatsapp` · `email` · `website` · `ota` · `guest_portal` · `sms` · `phone_note` |
| `channel_account_id`                                       | `uuid`                         | דרך איזה חשבון שלנו — מספר WhatsApp, תיבת מייל, חשבון Airbnb                     |
| `external_thread_id`                                       | `text null`                    | מזהה השרשור אצל הספק                                                             |
| `subject`                                                  | `text null`                    | למייל                                                                            |
| `state`                                                    | `conversation_state`           | `unassigned` · `assigned` · `resolved` · `snoozed`                               |
| `assignee_user_id` · `assignee_team_id`                    | `uuid null`                    |                                                                                  |
| `snoozed_until`                                            | `timestamptz null`             |                                                                                  |
| `last_message_at` · `last_inbound_at` · `last_outbound_at` |                                |                                                                                  |
| `first_response_at`                                        | `timestamptz null`             |                                                                                  |
| `sla_due_at`                                               | `timestamptz null`             |                                                                                  |
| `priority`                                                 | `text` (`low`/`normal`/`high`) |                                                                                  |
| `unread`                                                   | `boolean`                      | ברמת השיחה, לא לכל משתמש. ראה ח40-31                                             |
| `version`                                                  | `integer`                      | נעילה אופטימית על שיוך ומצב                                                      |

ייחודיות: `unique (organization_id, channel, channel_account_id,
external_thread_id) where external_thread_id is not null` — Webhook שמגיע
פעמיים לא יוצר שתי שיחות.

אינדקסים: `(organization_id, state, last_message_at desc)` — התיבה;
`(organization_id, assignee_user_id, state)` — "שלי";
`(organization_id, guest_id, last_message_at desc)` — לשונית ההודעות
בפרופיל 360°; `(organization_id, sla_due_at) where state in
('unassigned','assigned')`.

### 3.6 `messages`

| עמודה                                  | הערה                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `conversation_id` · `organization_id`  |                                                                                               |
| `direction`                            | `inbound` · `outbound`                                                                        |
| `sender_kind`                          | `guest` · `user` · `system` · `ai_agent` — **תואם ל-`ActorType` ב-`src/lib/audit/events.ts`** |
| `sender_user_id`                       | null לנכנס ולאוטומטי                                                                          |
| `body` · `body_format`                 | `text` · `html` · `template`                                                                  |
| `attachments`                          | `jsonb`: נתיב באחסון פרטי, שם, גודל, mime. **הקובץ עצמו לא בשורה**                            |
| `template_id` · `template_variables`   | מה נשלח ובאילו ערכים — ראה §9                                                                 |
| `rendered_at`                          | הרינדור מוקפא. תבנית שתשתנה מחר לא תשנה מה שנשלח                                              |
| `external_message_id`                  | מזהה אצל הספק                                                                                 |
| `delivery_status`                      | `queued` · `sent` · `delivered` · `read` · `failed`                                           |
| `failure_reason` · `failure_code`      |                                                                                               |
| `sent_at` · `delivered_at` · `read_at` |                                                                                               |
| `ai_suggested` · `ai_edited`           | 🔒 החלטה 24 ב-DECISION_LEDGER: "מי כתב את זה" חייבת תשובה                                     |
| `idempotency_key`                      | ייחודי לכל ארגון. ראה §10                                                                     |

`messages` היא **append-only** לתוכן: `update` מותר רק על
`delivery_status` · `delivered_at` · `read_at` · `external_message_id`,
ונאכף בטריגר. הודעה שנשלחה ואז נערכה בבסיס הנתונים היא הודעה שאי אפשר
להעיד עליה.

### 3.7 `guest_access_links` — משותפת עם מודול 41

מוגדרת במלואה ב-[`41-guest-portal.md`](41-guest-portal.md) §3.2 §13.
כאן היא נדרשת עבור `purpose = 'quote'` (קישור להצעת מחיר) ו-
`purpose = 'lead_reply'`.

### 3.8 `message_templates`

| עמודה                                                       | הערה                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` · `organization_id` · `property_id` (null = כל הנכסים) |                                                                                                                                                                            |
| `key`                                                       | `booking_confirmed` · `payment_balance` · `contract_sign` · `review_request` · `invite_back` · `pay_bit` · `pay_paybox` · `pay_bank` · `pre_arrival` · `checkout_reminder` |
| `channel`                                                   | `whatsapp` · `email` · `sms`                                                                                                                                               |
| `language`                                                  | `he` · `en` · `ar` · `ru` · `fr`                                                                                                                                           |
| `subject`                                                   | למייל                                                                                                                                                                      |
| `body`                                                      | טקסט עם `{{משתנה}}` — **תווי שורה אמיתיים, לא `\n` מוקלד** (ראה ח40-36)                                                                                                    |
| `is_active` · `version_number` · `supersedes_template_id`   |                                                                                                                                                                            |

---

## 4. מצבים ומעברים

### 4.1 `lead_status`

הרשימה הקנונית: `new` · `contacted` · `interested` · `quote_sent` ·
`negotiation` · `booked` · `lost`.

| מ-                                          | ל-            | מי                                            | תנאים                                                   | תופעות לוואי                                                    | Audit                              |
| ------------------------------------------- | ------------- | --------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| —                                           | `new`         | `lead.create` · או המערכת (טופס אתר, Webhook) | חובה `raw_phone` **או** `raw_email`                     | הצמדה ל-`guest` (ח40-08); `sla_due_at`; `lead.created`          | "ליד חדש מ{{מקור}} · {{שם}}"       |
| `new`                                       | `contacted`   | `lead.update`                                 | קיימת הודעה יוצאת בשיחה המשויכת, או סימון ידני עם נימוק | `first_response_at` נכתב אם ריק                                 | "רוני יצרה קשר עם ליד — דנה לוי"   |
| `contacted`                                 | `interested`  | `lead.update`                                 | —                                                       | `next_action_at` חובה                                           | `lead.status_changed`              |
| `new` · `contacted` · `interested`          | `quote_sent`  | **לא ידני.** נגזר משליחת הצעה                 | קיימת `quotes` בסטטוס `sent` המקושרת לליד               | —                                                               | "נשלחה הצעה #{{מספר}} — ₪{{סכום}}" |
| `quote_sent`                                | `negotiation` | `lead.update`                                 | —                                                       | —                                                               |                                    |
| `quote_sent` · `negotiation` · `interested` | `booked`      | `booking.create`                              | נוצרה הזמנה מקושרת בסטטוס שאינו `inquiry`               | `booking_id` נקבע; שחרור `hold` שלא הומר; `lead.status_changed` | "הליד הומר להזמנה {{reference}}"   |
| כל מצב שאינו `booked`                       | `lost`        | `lead.update`                                 | `lost_reason` חובה                                      | `hold` משוחרר; הצעות פתוחות → `declined`; שיחה → `resolved`     | "הליד נסגר — לא זמין בתאריכים"     |
| `lost`                                      | `contacted`   | `lead.update`                                 | נימוק חובה                                              | `lost_reason` מתאפס                                             | "רוני פתחה מחדש ליד שנסגר"         |
| `booked`                                    | ✗             | —                                             | **סופי.** ביטול ההזמנה לא מחזיר את הליד                 |                                                                 |                                    |

מעבר שאינו ברשימה נכשל עם `BusinessRuleError` והודעה בעברית:
"אי אפשר להעביר ליד מ־{{מ}} ל־{{ל}}."

### 4.2 `quote_status`

`draft` · `sent` · `viewed` · `accepted` · `declined` · `expired` · `superseded`

| מ-                | ל-           | מי                                 | תנאים                                                                    | תופעות לוואי                                                                                      | Audit                                                      |
| ----------------- | ------------ | ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| —                 | `draft`      | `quote.create`                     | —                                                                        | —                                                                                                 |                                                            |
| `draft`           | `sent`       | `quote.send`                       | הצעה מלאה (§8); `valid_until` בעתיד; היחידה זמינה **או** קיים `hold` תקף | 🔒 הקפאת `lines_snapshot` + `document_sha256`; הנפקת `guest_access_links` חד־נמענית; `quote.sent` | "שי שלח הצעה ל־דנה לוי · 23–26.4 · ₪6,400 · בתוקף עד 30.3" |
| `sent`            | `viewed`     | הנמען                              | פתיחה ראשונה של הקישור                                                   | `first_viewed_at`; `quote.viewed`; התראה לשולח                                                    | "ההצעה נצפתה"                                              |
| `sent` · `viewed` | `accepted`   | הנמען, או `quote.update` בשם האורח | טרם פג; היחידה עדיין זמינה                                               | יצירת/עדכון הזמנה; המרת `hold`; `quote.accepted`                                                  | "דנה לוי אישרה את ההצעה"                                   |
| `sent` · `viewed` | `declined`   | הנמען או צוות                      | —                                                                        | שחרור `hold`                                                                                      |                                                            |
| `sent` · `viewed` | `expired`    | **המערכת**                         | `now() > valid_until`                                                    | שחרור `hold`; `quote.expired`; התראה לשולח                                                        | "ההצעה פגה"                                                |
| `sent` · `viewed` | `superseded` | `quote.update`                     | נוצרה גרסה חדשה                                                          | ביטול הקישור הישן; הקישור הישן מציג "ההצעה עודכנה"                                                | "שי החליף את ההצעה בגרסה 2 · ₪6,100"                       |
| `accepted`        | ✗            | —                                  | 🔒 סופי. שינוי אחרי אישור = הצעה חדשה                                    |                                                                                                   |                                                            |

### 4.3 `conversation_state`

`unassigned` · `assigned` · `resolved` · `snoozed`

| מ-                        | ל-               | מי                                                | תנאים                                                 | תופעות לוואי                    | Audit                          |
| ------------------------- | ---------------- | ------------------------------------------------- | ----------------------------------------------------- | ------------------------------- | ------------------------------ |
| —                         | `unassigned`     | הודעה נכנסת                                       | —                                                     | `sla_due_at`; ניתוב לפי כללים   |                                |
| `unassigned`              | `assigned`       | `message.assign`, או **אוטומטית בשליחה** (ח40-29) | יעד הוא חבר פעיל בארגון עם `message.view` בטווח       |                                 | "השיחה שויכה לדנה"             |
| `assigned`                | `assigned` (אחר) | `message.assign`                                  |                                                       | הטיוטה של הקודם נשמרת ולא נמחקת | "השיחה הועברה מדנה לרוני"      |
| `assigned` · `unassigned` | `resolved`       | `message.view` + בעלות, או `message.assign`       | —                                                     | `sla_due_at` מתאפס              | "רוני סימנה את השיחה כטופלה"   |
| `assigned`                | `snoozed`        | בעל השיחה                                         | `snoozed_until` בעתיד וחובה                           | חוזרת ל-`assigned` בזמן         | "השיחה נדחתה למחר 09:00"       |
| `resolved` · `snoozed`    | `assigned`       | הודעה נכנסת חדשה                                  | 🔒 **אוטומטי.** שיחה שנסגרה ואורח כתב שוב חוזרת לתיבה | התראה לבעלים הקודם              | "האורח חזר — השיחה נפתחה מחדש" |

---

## 5. מסכים

### 5.1 פרופיל אורח 360°

**מטרה:** כל מה שידוע על האדם, במסך אחד, בלי לחפש.
**תפקידים:** owner · admin · GM · property manager · reservation manager · reception (מצומצם) · agent (מצומצם).
**הרשאות:** `guest.view` + שדות זהות לפי הענקה.

**פריסה** (מובייל: אקורדיון; דסקטופ: עמודה ימנית קבועה + לשוניות):

- **כותרת:** שם · תגיות · שפה · דגל חסום · מספר שהיות · הכנסה מצטברת · תאריך שהות אחרונה. שדות מוגנים מוחלפים ב-`•••` עם tooltip "אין לך הרשאה לראות טלפון של אורח".
- **פעולות:** ✏️ עריכה · 🏷️ תגית · 💬 הודעה · ➕ הזמנה חדשה · 🔀 מיזוג · ⛔ חסימה · ⬇️ ייצוא (מאחורי `guest.export`, פעולה רגישה) · 🗑️ מחיקה.
- **לשונית שהיות:** כל ההזמנות — reference · נכס/יחידה · תאריכים · לילות · סטטוס · סה"כ (מאחורי `booking.view_price`) · מקור (מאחורי `booking.view_source`). שורה נלחצת → ההזמנה.
- **לשונית כספים:** סה"כ ששולם · יתרה פתוחה · חשבוניות · פיקדונות ומה שנוכה. כולה מאחורי `finance.view`; ללא ההרשאה הלשונית **לא מוצגת כלל** — לא מוצגת ריקה.
- **לשונית העדפות:** מבנה מיטות · תזונה · נגישות · אלרגיות · שעת הגעה מועדפת · טקסט חופשי. כל שדה מציג "עודכן ע"י X ב־Y".
- **לשונית תגיות ופילוח:** תגיות ידניות + תגיות נגזרות לקריאה בלבד (`חוזר`, `VIP` לפי סף, `לא ענה 3 פעמים`).
- **לשונית ביקורות:** דירוג + טקסט + השהות + התגובה הפומבית.
- **לשונית הודעות:** כל השיחות מכל הערוצים, ממוזגות לפי זמן, עם תג ערוץ. מאחורי `message.view`.
- **לשונית הערות:** הערות פנימיות מאחורי `booking.note.internal`. **לא מוצגות לסוכן חיצוני, בשום סולם.**
- **לשונית מסמכים:** חוזים חתומים (קישור ל-41), מספר מסמך מזהה — **מוסתר תמיד, ניתן ל"חשיפה חד־פעמית" מאחורי `guest.view_document_id` + נימוק, ונרשם ב-Audit.**

**מצב ריק:** "אורח חדש — עוד אין שהיות. ➕ צור הזמנה ראשונה."
**מצב טעינה:** שלד; הכותרת נטענת ראשונה כי היא מזהה שהגעת לאדם הנכון.
**מצב שגיאה:** `userMessage` מה-`AppError` + `DATA_OUTCOME_MESSAGE`. אף פעם לא "שגיאה".
**מתועד:** צפייה בפרופיל **לא** נרשמת (רעש). חשיפת מסמך מזהה, ייצוא, מיזוג, חסימה — נרשמים.

### 5.2 רשימת אורחים

חיפוש חופשי (שם · טלפון בכל פורמט · מייל · reference של הזמנה).
🔒 החיפוש בטלפון מנרמל את מחרוזת החיפוש דרך `normalize_phone_il` לפני
השאילתה — אחרת `050-1234567` לא ימצא את `+972501234567` ופקידה תיצור כפילות.
סינון: תגית · חוזר/חדש · נכס · טווח שהות אחרונה · חסום · הסכמת שיווק.
בחירה מרובה: תיוג · ייצוא · שליחת קמפיין — כולן מוגבלות ל-Scope, **כולל
הייצוא**. ⚠️ נקודת הכשל הנפוצה: מנהל של 3 נכסים שמייצא ומקבל את כל החברה.

**מצב ריק בסינון:** "אין אורחים שתואמים לסינון" + כפתור ניקוי. שונה
מ"עוד אין אורחים" — הראשון הוא סינון, השני הוא עסק חדש.

### 5.3 מסך מיזוג

שתי עמודות זו מול זו. לכל שדה סותר — בורר. למטה: מונים ("4 הזמנות · 2
שיחות · 1 ביקורת יעברו ל..."). אישור דורש **הקלדת שם האורח השורד**, לא
לחיצה. שדה נימוק חובה. אחרי המיזוג — באנר 30 יום: "מוזג לפני 3 ימים ·
בטל מיזוג".

### 5.4 לוח לידים

Kanban לפי `lead_status` (מובייל: רשימה מקובצת עם מסנן סטטוס).
כרטיס: שם · טלפון מוסתר חלקית · מקור · תאריכים מבוקשים · תקציב · אחראי ·
"לא נגעו כבר X".
גרירה בין עמודות = מעבר מצב, ועוברת דרך אותה בדיקת מעברים של §4.1 —
גרירה ל-`lost` פותחת דיאלוג נימוק ולא משנה כלום עד שנבחר.
**מצב ריק:** "אין לידים פתוחים. כל הפניות טופלו 🌿".

### 5.5 עורך הצעת מחיר

נכס → יחידה → תאריכים → אורחים → שורות מחיר → תוספות → תוקף → הערה.
פאנל תצוגה מקדימה **בדיוק כמו שהנמען יראה**, בזמן אמת.
לפני שליחה: מסך אישור עם שם הנמען, ארבע ספרות אחרונות של הטלפון, נכס,
ותאריכים **במילים ובספרות** ("23–26 באפריל 2026 · 3 לילות").
אחרי שליחה המסמך **נעול**; הכפתור הופך ל"צור גרסה חדשה".

### 5.6 תיבת ההודעות

שלוש עמודות בדסקטופ, ניווט בשלושה מסכים במובייל.
רשימה: מסנני `הכול · שלי · לא משויך · טופל · נדחה` + מסנן ערוץ.
שרשור: הודעות עם כיוון, ערוץ, סטטוס מסירה, ומי שלח (כולל תג 🤖 להודעה
שנוצרה ב-AI).
**פאנל הקשר קבוע בצד:** מי האורח · איזו הזמנה · תאריכים · יתרה · סטטוס
חוזה. בלי זה עונים "מתי הצ׳ק־אין?" מהזיכרון.
**מחוון נוכחות:** "דנה כותבת תשובה כרגע" (ח40-30).
**מצב ריק:** "אין הודעות שממתינות. 🌿"
**מצב שגיאה בשליחה:** ההודעה נשארת בשרשור עם ⚠️ ו"נסה שוב" — לעולם לא נעלמת.

---

## 6. חוקים עסקיים

### דדופליקציה וזהות

**ח40-01** — טלפון של אורח מנורמל ל-E.164 דרך `normalize_phone_il` **בכתיבה**,
כעמודה מחושבת. אין נתיב כתיבה שיכול לדלג על הנרמול.

**ח40-02** — הפורמטים הבאים חייבים להתנרמל כולם ל-`+972501234567`:
`0501234567` · `050-1234567` · `050 123 4567` · `+972501234567` ·
`+972-50-123-4567` · `972501234567` · `00972501234567` · `972-50-1234567` ·
`+972 (50) 123-4567`. מספר בן 9 ספרות שמתחיל ב-`5` (`501234567`) מתנרמל
גם הוא. בדיקה: פונקציה טהורה, טבלת קלט/פלט.

**ח40-03** — מגבלה ידועה ומתועדת: מספר שמתחיל ב-`972` **בלי** `+` או `00`
נקרא כישראלי. מספר זר חייב להגיע עם `+` או `00`. ⚠️ הממשק חייב להציג
בשדה טלפון "מספר בחו"ל? התחילו ב-+". זו החלטה מודעת של הפונקציה בקוד,
לא באג.

**ח40-04** — שני אורחים חיים באותו ארגון לא יכולים לחלוק `phone_e164`.
נאכף באינדקס ייחודי חלקי (`where phone_e164 is not null and deleted_at is
null`), לא בקוד.

**ח40-05** — הייחודיות היא **בתוך ארגון**. שני עסקים שמארחים את אותו אדם
הוא המקרה הרגיל, וייחודיות גלובלית הייתה מדליפה רשימת לקוחות של ארגון
אחד לאחר דרך התנגשות.

**ח40-06** — מייל **אינו** מפתח ייחודי. הוא מפתח **מועמד** בלבד. זוג
שמזמין שתי שהיות מאותה כתובת חייב להצליח.

**ח40-07** — מספר מסמך מזהה הוא מפתח מועמד בלבד, לא אילוץ. ספרה שהוקלדה
לא נכון בדלפק לא יכולה לחסום יצירת הזמנה.
❓ **שאלה למשפטן:** האם מותר להחזיק מספר תעודת זהות של אורח, ולכמה זמן,
ובאילו תנאים אבטחה — לפי חוק הגנת הפרטיות והתיקון שנכנס לתוקף ב-2025;
והאם מותר להשתמש בו כמפתח לזיהוי חוזר. **זו לא שאלה למפתח.**

**ח40-08** — ליד נצמד לאורח קיים כאשר `phone_e164` שלו זהה. אם אין
התאמת טלפון והמייל זהה — הצמדה **מוצעת**, לא מבוצעת. יצירת ליד **לעולם
לא יוצרת אורח כפול**: או שהיא מצמידה, או שהיא משאירה `guest_id` ריק.

**ח40-09** — ציון התאמה (§7.1) מעל 0.85 → הצעת מיזוג בממשק. מתחת →
לא מציעים. **המערכת לעולם לא ממזגת מעצמה.** מיזוג אוטומטי שגוי מערבב את
הכסף של שני אנשים ואת זה כמעט אי אפשר להתיר.

### מיזוג

**ח40-10** — מיזוג דורש נימוק בטקסט חופשי ואישור בהקלדת שם השורד.

**ח40-11** — במיזוג עוברות **כל** השורות המפנות לאורח המוזג:
`bookings` · `conversations` · `leads` · `quotes` · `guest_requests` ·
`reviews` · `contracts` · `orders`. תשלומים וחשבוניות תלויים בהזמנה ולא
באורח, ולכן **לא זזים** — הם עוברים יחד עם ההזמנה שלהם. כל מזהה שהוזז
נרשם ב-`guest_merges.moved`.

**ח40-12** — שדה סותר מוכרע ידנית. ברירות מחדל:
`marketing_consent` — **הסירוב גובר**; אם שני הצדדים הסכימו, נשמרת
ההסכמה עם ה-`marketing_consent_at` המאוחר יותר.
`is_blocked` — **החסימה גוברת**, והנימוקים משורשרים.
`tags` — איחוד.
`notes` — שרשור עם כותרת "מפרופיל שמוזג ב-{{תאריך}}".
`preferences` — מיזוג עמוק, השורד גובר בהתנגשות.

**ח40-13** — האורח המוזג **לא נמחק קשה**. `deleted_at` נקבע,
`merged_into_guest_id` מצביע על השורד. הוא יוצא מהאינדקס הייחודי החלקי,
ולכן הטלפון פנוי לשורד.

**ח40-14** — ביטול מיזוג אפשרי 30 יום. הוא מחזיר **בדיוק** את מזהי
השורות ב-`moved` ואת הערכים ב-`field_resolutions`.

**ח40-15** — ביטול מיזוג **נדחה** אם רשומה שהוזזה השתנתה מאז המיזוג
(`updated_at > performed_at`). המשתמש מקבל רשימה של מה השתנה ומטפל ידנית.
ביטול ששקט מוחק עבודה שנעשתה מאז גרוע מאין ביטול בכלל.

**ח40-16** — מיזוג נועל את שתי שורות ה-`guests` ב-`select … for update`
**בסדר עולה לפי `id`**, כדי שמיזוגים מקבילים לא ייתקעו זה בזה.

**ח40-17** — מיזוג נכשל אם ל-`version` של אחת השורות יש ערך שונה ממה
שנטען למסך.

**ח40-18** — יצירת הזמנה מול אורח שסומן `deleted_at` נכשלת עם שגיאה
שמפנה לשורד: "האורח מוזג לפרופיל של דנה לוי. ההזמנה תיווצר על הפרופיל
המאוחד." הפעולה **ניתנת לניסיון חוזר** (`retryable`) והשירות מחליף את
`guest_id` בשורד.

**ח40-19** — ⚠️ עד שתתווסף `guest.merge`: המיזוג דורש `guest.update`
**וגם** `guest.delete`, ומטופל כפעולה ב-`SENSITIVE_ACTIONS` — נימוק חובה
ו-Audit מלא.

### לידים

**ח40-20** — ליד חייב `raw_phone` או `raw_email`. פנייה בלי דרך להשיב
היא לא ליד.

**ח40-21** — `lost_reason` חובה במעבר ל-`lost`; `lost_note` חובה כאשר
`lost_reason = 'other'`.

**ח40-22** — `first_response_at` נכתב **פעם אחת** — בהודעה היוצאת
הראשונה או בסימון "יצרתי קשר". כתיבה חוזרת נדחית, אחרת מדד זמן התגובה
משקר.

**ח40-23** — ליד שמומר להזמנה מציב `booking_id` ועובר ל-`booked`, ואת
המעבר הזה עושה יצירת ההזמנה — לא אדם.

### הצעות מחיר

**ח40-24** — 🔒 **הצעה שנשלחה אינה משתנה.** שינוי יוצר גרסה חדשה עם
`supersedes_quote_id`; הקודמת עוברת ל-`superseded` והקישור שלה מציג
"ההצעה עודכנה — קיבלת גרסה חדשה", לא מחיר אחר בשקט. זהו אותו כשל בדיוק
שהמערכת החיה עשתה בחוזה, ואת זה לא מעתיקים.

**ח40-25** — `valid_until` חובה. ברירת מחדל **7 ימים** מהשליחה, לכל
היותר 90 יום. _נימוק:_ הצעה בלי תפוגה נועלת מחיר ומלאי בלי סוף, ו-7 ימים
הוא חלון החלטה סביר לשהות פנאי. ❓ ברירת המחדל לכל ארגון היא החלטת בעל
המוצר.

**ח40-26** — הצעה שפגה משחררת את ה-`hold` שלה. `HOLD_REASONS` כולל
`agent_quote`, ו-`Hold.expiresAt` הוא `never null` בחוזה הטיפוסים —
המודול הזה לא מוסיף נתיב שמייצר החזקה בלי תפוגה.

**ח40-27** — 🔒 **הצעה מרונדרת עם הקרנת מחיר ציבורי קבועה**, ולא עם
ההענקות של השולח. גם ל-`revenue_manager` עם `rate.view_net` — הנמען מקבל
`rate.public` בלבד. עמלת סוכן, מחיר נטו ורווחיות **לעולם לא נכנסים למסמך
שיוצא החוצה**.

**ח40-28** — קבלת הצעה נבדקת מול הזמינות **בטרנזקציה**. הצעה שהתאריכים
שלה נתפסו בינתיים ואין לה `hold` פעיל — הקבלה נדחית: "התאריכים נתפסו
בינתיים. נציג יחזור אליך עם חלופה." והצוות מקבל התראה מיידית.

### תיבת ההודעות

**ח40-29** — שליחה משיחה `unassigned` משייכת אותה לשולח **באותה
טרנזקציה**. אי אפשר לענות ולהשאיר את השיחה חסרת בעלים.

**ח40-30** — 🔒 **שני עובדים לא עונים לאותו אורח בו־זמנית — במחוון, לא
בנעילה.** פתיחת עורך התשובה יוצרת `conversation_drafts` עם דופק כל 30
שניות ותפוגה אחרי 90. עובד שני רואה "דנה כותבת תשובה כרגע (החל מ-14:32)"
וכפתור השליחה מוחלף ב"שלח בכל זאת" שדורש אישור מפורש ונרשם ב-Audit.
_למה לא נעילה קשיחה:_ טאב שנסגר משאיר נעילה תקועה, ואורח שמחכה לתשובה
לא יכול להיחסם בגלל תקלה טכנית בצד שלנו. **זמינות גוברת על נוחות; שקיפות
מונעת את הכפילות.**

**ח40-31** — `unread` הוא ברמת השיחה, לא לכל משתמש. _נימוק:_ בעסק אירוח
"מישהו ענה" הוא מה שחשוב; מונה אישי לכל אחד מייצר תיבה שאף פעם לא ריקה
לאף אחד. בעסק גדול זו החלטה שראוי לבחון מחדש — ⚠️ מסומן כהחלטה מודעת עם
עלות ידועה.

**ח40-32** — שיחה `resolved` שמקבלת הודעה נכנסת חוזרת ל-`assigned` אצל
מי שטיפל בה קודם. אורח שחוזר לא מתחיל מחדש בתור.

**ח40-33** — שליחה יוצאת דורשת `message.send` **ו**-Scope שמכיל את הנכס
של השיחה. סוכן חיצוני שולח רק בשיחות שמקושרות ללידים או להזמנות שלו.

**ח40-34** — שיחה בערוץ `guest_portal` מגיעה מקישור יכולת ולא ממשתמש
מאומת. היא **תמיד** מקושרת להזמנה אחת, ולעולם לא מתמזגת עם שיחת
וואטסאפ של אותו אורח אלא בפעולה יזומה של הצוות.

### תבניות

**ח40-35** — 🔒 שמות המשתנים בתבניות נשארים **בעברית** (`{{שם}}`,
`{{יתרה}}`). _נימוק:_ מי שעורך את התבניות הוא בעל העסק, לא מפתח, ו-
`{{guest_name}}` הוא טקסט שהוא לא יכול לקרוא. מתחת לפני השטח כל שם עברי
ממופה למפתח קנוני באנגלית (§9.2) כדי שהרינדור יהיה נבדק ותבנית תוכל
להיות מתורגמת.

**ח40-36** — תבניות נשמרות עם **תווי שורה אמיתיים**. ⚠️ המערכת החיה
שמרה `\n` כטקסט ותיקנה בקריאה עם `replace(/\\+n/g,'\n')` — טלאי שמסתיר
פגם ומחמיר בכל ייצוא/ייבוא. ייבוא מהמערכת החיה מבצע את הנרמול **פעם
אחת**, בייבוא, ואז לא שוב.

**ח40-37** — משתנה שאין לו ערך אינו מרונדר כמחרוזת ריקה. השליחה **נחסמת**
עם "בתבנית יש {{וויפי}} ולנכס אין סיסמת WiFi. השלימו או הסירו את המשתנה."
הודעה שנשלחה עם "WiFi: " ריק היא הודעה שהאורח מתקשר בגללה.

---

## 7. חישובים

כסף = **אגורות שלמות** (`Agorot` ב-`src/lib/booking/types.ts`).
עיגול, חלוקה וטיפול במכנה אפס — **מ-[`src/lib/metrics/rounding.ts`](../../src/lib/metrics/rounding.ts)**
(`roundAgorot` · `safeDivide` · `percentOf` · `averagePer`), ולא מוגדרים
כאן מחדש. `safeDivide` מחזיר `null` במכנה אפס, והממשק מציג `—` ולא `0%`.

### 7.1 ציון התאמה לזיהוי כפילות

```
score = 0.60·phone + 0.20·email + 0.12·name + 0.08·document
```

| רכיב       | ערך                                                                                    |
| ---------- | -------------------------------------------------------------------------------------- |
| `phone`    | 1 אם `phone_e164` זהה; 0.5 אם 7 הספרות האחרונות זהות והקידומת שונה; אחרת 0             |
| `email`    | 1 אם זהה (`citext`); 0.4 אם החלק לפני ה-`@` זהה והדומיין שונה; אחרת 0                  |
| `name`     | Jaro-Winkler על `full_name` מנורמל (רווחים כפולים, גרשיים, ניקוד, `ו'` מול `ואו`), 0–1 |
| `document` | 1 אם `id_document_number` זהה **וגם** `id_document_country` זהה; אחרת 0                |

ספים: `≥0.85` → מוצע למיזוג · `0.60–0.85` → "ייתכן שזה אותו אדם" בפרופיל,
בלי הצעה · `<0.60` → שקט. הציון מעוגל ב-`roundTo(x, 2)`.

_נימוק המשקלות:_ הטלפון נושא את רוב המשקל כי הוא גם המפתח הייחודי במסד
וגם הדבר שאדם נותן נכון. שם לבדו לעולם לא חוצה סף — "דוד כהן" אינו זיהוי.

### 7.2 יתרה בהצעה

```
total_agorot = Σ quote_lines.amount_agorot        // הנחות שליליות
```

`total_agorot` מתוחזק בטריגר, כמו `bookings.total_agorot`. ערך שסיפק
Caller **נזרק**.

### 7.3 תוקף

```
valid_until = sent_at + interval '7 days'         // ברירת מחדל
expired      ⟺ now() > valid_until AND status IN ('sent','viewed')
```

ההשוואה ב-UTC; התצוגה לאורח באזור `Asia/Jerusalem`. הצעה "בתוקף עד
30.3" פגה ב-23:59:59 בשעון ישראל של 30.3 — הגבול הזה מחושב מהתאריך
המקומי ונשמר כ-`timestamptz`, כדי שמעבר שעון קיץ לא יזיז אותו בשעה.

### 7.4 זמן תגובה ראשון

```
first_response_minutes = (first_response_at − created_at) / 60
```

נספר רק על לידים ושיחות עם `first_response_at` לא ריק. חציון ולא ממוצע:
פנייה אחת שנשכחה לשבוע גוררת ממוצע ומסתירה עשרים תגובות טובות.
דלי אחוזון 90 מדווח לצדו.

### 7.5 המרה

```
lead_conversion = percentOf(leads WHERE status='booked', leads created in range)
quote_acceptance = percentOf(quotes accepted, quotes sent in range)
quote_view_rate  = percentOf(quotes with first_viewed_at, quotes sent)
```

המכנה הוא **לידים שנוצרו בטווח**, לא לידים שנסגרו בו — אחרת חודש שבו
נסגרו לידים ישנים ייראה כמו חודש מוצלח.
מכנה אפס → `safeDivide` → `null` → `—`.

### 7.6 ערך אורח

```
lifetime_revenue_agorot = Σ bookings.total_agorot WHERE status ∈ REALISED_STATUSES
stay_count              = COUNT(אותן הזמנות)
average_stay_value      = averagePer(lifetime_revenue_agorot, stay_count)
```

🔒 `REALISED_STATUSES` נלקח מ-[`src/lib/metrics/rows.ts`](../../src/lib/metrics/rows.ts)
ולא מוגדר כאן מחדש. הזמנה שבוטלה אינה הכנסה, ואורח שביטל שלוש פעמים
אינו VIP.

---

## 8. ולידציות

| שדה                           | חובה              | טווח / פורמט                                         | הודעה בעברית                                      |
| ----------------------------- | ----------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `guests.full_name`            | ✓                 | 2–120, לא רק רווחים                                  | "יש להזין שם אורח."                               |
| `guests.phone`                | טלפון **או** מייל | חייב להתנרמל לערך לא ריק                             | "מספר הטלפון אינו תקין. מספר בחו״ל — התחילו ב-+." |
| `guests.email`                | —                 | `^[^@\s]+@[^@\s]+\.[^@\s]+$` (אילוץ קיים ב-DB)       | "כתובת המייל אינה תקינה."                         |
| `guests.id_document_number`   | —                 | 5–20, ספרות ואותיות. **אין בדיקת ספרת ביקורת חוסמת** | "מספר המסמך אינו תקין."                           |
| `guests.id_document_country`  | כשיש מסמך         | `^[A-Z]{2}$`                                         | "יש לבחור מדינת הנפקה."                           |
| `guests.language`             | ✓                 | `he`/`en`/`ar`/`ru`/`fr`                             | "יש לבחור שפה."                                   |
| `guests.tags`                 | —                 | ≤ 20 תגיות, כל אחת ≤ 30 תווים                        | "אפשר עד 20 תגיות."                               |
| `guests.blocked_reason`       | כשחסום            | ≥ 10 תווים                                           | "יש להסביר למה האורח חסום."                       |
| `leads.raw_phone/raw_email`   | לפחות אחד         | —                                                    | "צריך טלפון או מייל כדי לחזור לפונה."             |
| `leads.requested_check_out`   | —                 | `> requested_check_in`                               | "תאריך היציאה חייב להיות אחרי תאריך הכניסה."      |
| `leads.party_adults`          | ✓                 | ≥ 1                                                  | "חייב להיות לפחות מבוגר אחד."                     |
| `leads.lost_reason`           | כש-`lost`         | מהרשימה                                              | "יש לבחור סיבת סגירה."                            |
| `quotes.check_in/check_out`   | ✓                 | `check_out > check_in`, `check_in ≥ היום`            | "לא ניתן להציע תאריכים שעברו."                    |
| `quotes.valid_until`          | ✓                 | `> now()`, ≤ `now() + 90 יום`                        | "תוקף ההצעה חייב להיות בעתיד, ולכל היותר 90 יום." |
| `quote_lines.amount_agorot`   | ✓                 | מספר שלם; שלילי מותר רק ב-`discount`/`promotion`     | "סכום שלילי מותר רק בשורת הנחה."                  |
| `quotes.total_agorot`         | —                 | חייב `> 0` בשליחה                                    | "לא ניתן לשלוח הצעה בסכום אפס."                   |
| `messages.body`               | ✓ (אין קובץ)      | 1–4096 ב-WhatsApp/SMS; 100,000 במייל                 | "אי אפשר לשלוח הודעה ריקה."                       |
| `messages.attachments`        | —                 | ≤ 10 קבצים, ≤ 16MB לקובץ, MIME מרשימת היתר           | "הקובץ גדול מדי (מקסימום 16MB)."                  |
| `message_templates.body`      | ✓                 | כל `{{משתנה}}` חייב להיות בקטלוג §9.2                | "המשתנה {{X}} אינו קיים. המשתנים הזמינים: …"      |
| `conversations.snoozed_until` | כש-`snoozed`      | בעתיד, ≤ 90 יום                                      | "יש לבחור מועד עתידי לדחייה."                     |
| `guest_merges.reason`         | ✓                 | ≥ 10 תווים                                           | "יש להסביר למה מיזגת את הפרופילים."               |

**החלטה: אין בדיקת ספרת ביקורת חוסמת על ת"ז.** האלגוריתם מוכר וקל
לממש, אבל אורח זר עם דרכון, קטין בלי ת"ז, וטעות הקלדה בדלפק — כולם מגיעים
מדי יום, וחסימה תעצור צ׳ק־אין אמיתי. **הבדיקה רצה כאזהרה** ("המספר לא
עובר בדיקת תקינות — לבדוק?") ולא כחסימה. הכלל מ-DECISION_LEDGER: המבחן
הוא "האם הסירוב ימנע מהעסק לשרת אורח היום?"

---

## 9. אוטומציות והתראות

### 9.1 טריגר → תנאי → פעולה

| טריגר (Domain Event)                      | תנאי                      | פעולה                                           | נמען · ערוץ                       |
| ----------------------------------------- | ------------------------- | ----------------------------------------------- | --------------------------------- |
| `lead.created`                            | ליד לא משויך              | ניתוב לפי נכס/תורנות; אם אין כלל → `unassigned` | צוות מכירות · Notification Center |
| `lead.created` + 30 דק'                   | `first_response_at` ריק   | הסלמה                                           | מנהל · Push + מייל                |
| `lead.status_changed` → `interested`      | `next_action_at` ריק      | חסימת המעבר עם בקשה למועד                       | המשתמש · במסך                     |
| `quote.sent`                              | —                         | תבנית `quote_sent` עם `{{לינק}}`                | אורח · הערוץ המועדף               |
| `quote.viewed`                            | פעם ראשונה                | "דנה פתחה את ההצעה"                             | השולח · Push                      |
| `quote.expired`                           | —                         | תבנית "ההצעה פגה — נשמח לעדכן"; פנימית לשולח    | אורח + שולח                       |
| הצעה 48 שעות לפני `valid_until`           | `status ∈ (sent, viewed)` | תזכורת עדינה, **פעם אחת**                       | אורח                              |
| `booking.confirmed`                       | —                         | תבנית `booking_confirmed` (§9.3)                | אורח · WhatsApp                   |
| `guest.merged`                            | —                         | רישום ובאנר ביטול                               | המבצע · במסך                      |
| הודעה נכנסת                               | שיחה `resolved`/`snoozed` | פתיחה מחדש + התראה                              | הבעלים הקודם · Push               |
| שיחה `unassigned` מעל 15 דק' בשעות פעילות | —                         | הסלמה                                           | מנהל                              |
| `sla_due_at` עבר                          | לא `resolved`             | סימון אדום + הסלמה                              | מנהל                              |
| `message` יוצאת `failed`                  | —                         | סימון בשרשור + התראה. **ההודעה לא נעלמת**       | השולח                             |
| אורח `is_blocked` נכנס לליד חדש           | —                         | סימון בולט "אורח חסום — {{סיבה}}"               | המטפל                             |
| `checked_out` + 24 שעות                   | אין ביקורת                | תבנית `review_request`                          | אורח                              |

### 9.2 קטלוג המשתנים

🔒 השם העברי הוא הממשק; המפתח האנגלי הוא החוזה.

| בתבנית            | מפתח קנוני                | מקור                                               | הערה                                                                            |
| ----------------- | ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `{{שם}}`          | `guest.first_name`        | `guests.first_name` או המילה הראשונה ב-`full_name` |                                                                                 |
| `{{וילה}}`        | `property.name`           | `properties.name`                                  | במקור היה שם העסק; במוצר רב־נכסי זה **שם הנכס**                                 |
| `{{תאריכים}}`     | `stay.range_short`        | `"23–26.4"`; שהות של יום אחד → תאריך יחיד          |                                                                                 |
| `{{כניסה}}`       | `stay.check_in_full`      | `"23.4 · 14:00"`                                   | שעה מההזמנה, ואם ריקה — מהיחידה                                                 |
| `{{יציאה}}`       | `stay.check_out_full`     | `"26.4 · 11:00"`                                   |                                                                                 |
| `{{אורחים}}`      | `stay.guest_count`        | `adults + children`                                | תינוקות לא נספרים                                                               |
| `{{זוגות}}`       | `stay.couples`            | `bookings.metadata.couples`                        | ⚠️ שדה של המערכת החיה. **נשמר** (`KEEP`) כי התמחור של וילות אירוח משתמש בו      |
| `{{טלפון}}`       | `guest.phone`             |                                                    | 🔒 **אסור בתבנית שנשלחת לאורח.** מותר בתבנית פנימית בלבד                        |
| `{{כתובת}}`       | `property.address`        |                                                    | משוחרר לפי מדיניות ([`41`](41-guest-portal.md) §6)                              |
| `{{סהכ}}`         | `booking.total`           | `total_agorot`, מפורמט `₪6,400`                    |                                                                                 |
| `{{יתרה}}`        | `booking.balance_due`     | `total − paid`                                     |                                                                                 |
| `{{מקדמה}}`       | `booking.advance_paid`    |                                                    |                                                                                 |
| `{{פיקדון}}`      | `booking.deposit_amount`  | **מההזמנה, לא מהגדרת הנכס**                        | ⚠️ במערכת החיה זה נלקח מהגדרת הוילה, ולכן שינוי הגדרה שינה למפרע מה שנכתב לאורח |
| `{{וויפי}}`       | `property.wifi`           |                                                    | ⚠️ ראה §13.5 — הוסר מברירת המחדל                                                |
| `{{ניווט}}`       | `property.navigation_url` | Waze/Google                                        |                                                                                 |
| `{{לינק}}`        | `portal.link`             | 🔒 **מנפיק קישור חדש בכל רינדור**                  | ראה [`41`](41-guest-portal.md) §13                                              |
| `{{לינקחוותדעת}}` | `portal.review_link`      | קישור עם `purpose='review'`                        |                                                                                 |
| `{{לינקהצעה}}`    | `quote.link`              | חדש. `purpose='quote'`                             |                                                                                 |
| `{{מספרהזמנה}}`   | `booking.reference`       | `bookings.reference`                               | חדש. `B` + 8 תווים — מה שמצטטים בטלפון                                          |
| `{{שםעסק}}`       | `organization.name`       |                                                    | חדש. הפרדה בין שם העסק לשם הנכס                                                 |

### 9.3 התבניות שנשמרות מהמערכת החיה

הועתקו כלשונן. `\n` = מעבר שורה אמיתי בעת השמירה (ח40-36).

**`booking_confirmed`** — ⚠️ בגרסה החדשה **בלי** שורת ה-WiFi (§13.5):

```
שלום {{שם}}! 🌿

ההזמנה שלך ל-{{וילה}} מאושרת ✨

🗓️ כניסה: {{כניסה}}
🗓️ יציאה: {{יציאה}}
👥 אורחים: {{אורחים}}
💑 זוגות: {{זוגות}}
💰 סה״כ: {{סהכ}}
⏳ יתרה לתשלום: {{יתרה}}

🧭 ניווט לוילה:
{{ניווט}}

📲 כל הפרטים בעמוד האישי שלך:
{{לינק}}

נשמח לעמוד לרשותך 💚
```

**`payment_balance`**

```
שלום {{שם}} 🌿
לקראת ההגעה שלך ({{תאריכים}}) ל{{וילה}}:
נשמח להשלים את יתרת התשלום ({{יתרה}}).
תודה ונתראה בקרוב! 🫒
```

**`contract_sign`**

```
שלום {{שם}} 🌿
לקראת ההגעה שלך ({{תאריכים}}) ל{{וילה}}:
נשמח שתשלים/י חתימה על החוזה בקישור האישי שלך 🙏
{{לינק}}
תודה!
```

**`review_request`**

```
שלום {{שם}} 🌿
תודה שהתארחתם אצלנו ב{{וילה}} ({{תאריכים}})!
נשמח מאוד אם תוכלו לשתף חוות דעת קצרה על החוויה — זה עוזר לנו המון 🙏
להשארת חוות דעת: {{לינקחוותדעת}}
מקווים לראותכם שוב! 🫒
```

**`invite_back`** — קמפיין לאורחים חוזרים:

```
שלום {{שם}} 🌿

כאן {{וילה}} — שמחנו לארח אותך בעבר!
נשמח מאוד לראות אותך שוב אצלנו 😊

אם תרצה/י לשריין תאריכים או לשמוע מה מתחדש — אנחנו כאן.
להתראות בקרוב 🫒
```

🔒 `invite_back` נשלחת **רק** לאורחים עם `marketing_consent = true`.
במערכת החיה זה היה כפתור "הזמן לחזור" בלי בדיקת הסכמה. זה שינוי מהותי
ולא ייעול.

**`pay_bit`** · **`pay_paybox`** · **`pay_bank`** — הוראות תשלום. הפרטים
הקונקרטיים (מספר, שם מוטב, בנק/סניף/חשבון) הם **הגדרות ארגון**, לא טקסט
בתבנית:

```
📲 תשלום ב-Bit:
העבירו ל: {{ביטמספר}} (על שם {{ביטשם}})
סכום: {{יתרה}}
ציינו בהערה את שם המזמין 🙏
```

```
🏦 העברה בנקאית:
בנק: {{בנק}}  סניף: {{סניף}}
מס׳ חשבון: {{חשבון}}
על שם: {{מוטב}}
סכום: {{יתרה}}
נא לשלוח צילום אישור העברה 🙏
```

⚠️ במערכת החיה הפרטים היו טקסט חופשי בתוך התבנית, ולכן שינוי חשבון בנק
היה עריכה ידנית בשלושה מקומות. כאן הם שדות — ושינוי חשבון בנק הוא
`SENSITIVE_ACTION` שדורש MFA מחדש (ARCHITECTURE §7).

### 9.4 כשל במשלוח

| כשל                                  | תגובה                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ספק החזיר `4xx` (מספר לא תקין, חסום) | `failed` + `failure_code`. **אין ניסיון חוזר.** האורח מסומן "טלפון לא ניתן להשגה" והשולח מקבל התראה                                          |
| ספק החזיר `5xx` / timeout            | ניסיון חוזר עם השהיה מעריכה: 30ש׳ · 2ד׳ · 10ד׳ · 60ד׳, לכל היותר 4. **תמיד עם אותו `idempotency_key`**                                       |
| חלון 24 השעות של WhatsApp נסגר       | מעבר אוטומטי לתבנית מאושרת; אם אין — הודעה לצוות "צריך לפתוח שיחה מחדש" ולא שליחה שקטה שנכשלת                                                |
| נכשל אחרי כל הניסיונות               | ההודעה נשארת בשרשור עם ⚠️, נוצרת משימת מעקב, והשיחה חוזרת ל-`assigned`                                                                       |
| הודעה אוטומטית נכשלה                 | **התהליך העסקי לא נעצר.** אישור הזמנה תקף גם אם הוואטסאפ לא יצא — `contracts/events.ts`: מנוי שנכשל מדווח ולעולם לא נזרק בחזרה לפעולה העסקית |

---

## 10. מקביליות ו-Idempotency

| תרחיש                           | מנגנון                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| שני עובדים עורכים אותו אורח     | `guests.version`. השני מקבל: "רוני עדכנה את הפרופיל לפני רגע. רענן כדי לראות את השינוי." + diff                                                  |
| שני מיזוגים על אותם פרופילים    | נעילת שתי השורות `for update` בסדר `id` עולה + בדיקת `version` (ח40-16, ח40-17)                                                                  |
| מיזוג בזמן יצירת הזמנה          | שורת האורח נעולה; היצירה ממתינה ואז נכשלת `retryable` עם השורד (ח40-18)                                                                          |
| שני אורחים נוצרים עם אותו טלפון | האינדקס הייחודי החלקי דוחה. השירות תופס `23505` ומחזיר `ConflictError` עם קישור לאורח הקיים — לא "שגיאת מסד"                                     |
| Webhook של ערוץ מגיע פעמיים     | `unique (organization_id, channel, channel_account_id, external_thread_id)` על השיחה + `unique (organization_id, external_message_id)` על ההודעה |
| לחיצה כפולה על "שלח"            | `messages.idempotency_key` ייחודי לארגון. ניסיון שני מחזיר את ההודעה הראשונה. תשתית: `src/lib/service/idempotency.ts`                            |
| שני עובדים עונים במקביל         | ח40-30 — מחוון + עקיפה מפורשת מתועדת                                                                                                             |
| שליחת הצעה פעמיים               | `quote.send` אידמפוטנטי לפי `(quote_id, version_number)`. הניסיון השני מחזיר את השליחה הראשונה **ולא מנפיק קישור שני**                           |
| קבלת הצעה בזמן שהתאריכים נתפסו  | `SERIALIZABLE` / `select … for update` על `unit_occupancy`; ההזמנה נכשלת ומחזירה חלופה (ח40-28)                                                  |
| שיוך שיחה במקביל                | `conversations.version`. השני: "השיחה שויכה לדנה לפני רגע."                                                                                      |
| ייצוא אורחים פעמיים             | `guest.export` הוא `SENSITIVE_ACTION`; הייצוא מקבל מפתח ייחודי, ובקשה חוזרת מחזירה את אותו קובץ                                                  |

פעולות שחייבות מפתח ייחודי: שליחת הודעה · שליחת הצעה · קבלת הצעה ·
מיזוג · ביטול מיזוג · ייצוא · הנפקת קישור.

---

## 11. אינטגרציות

| ספק                                                                        | קורא                                 | כותב                                        | תקלה                                     | איזון אחריה                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WhatsApp Business API** ❓ (ספק לא הוכרע — FEATURE_MATRIX "החלטה פתוחה") | Webhook להודעות נכנסות, סטטוסי מסירה | הודעות ותבניות מאושרות                      | תור עם ניסיון חוזר; חלון 24 שעות         | סנכרון סטטוסים ב-Webhook; משיכה תקופתית של הודעות מהשעה האחרונה כדי לגלות Webhook שאבד                                                                                                |
| **`wa.me` deep link** (רמת הכניסה)                                         | —                                    | פותח וואטסאפ אצל העובד עם טקסט מוכן         | אין                                      | ⚠️ אין סטטוס מסירה ואין הודעות נכנסות. זה מה שהמערכת החיה עשתה, וזה מספיק לעסק אחד. ההודעה נרשמת כ-`delivery_status='sent'` **עם דגל `unverified_delivery`** — לא מתחזים לוודאות שאין |
| **מייל** ❓ (ספק לא הוכרע)                                                 | Webhook לנכנס, bounce, תלונת ספאם    | יוצא + מעקב פתיחות                          | תור                                      | bounce → סימון המייל כלא תקין בפרופיל                                                                                                                                                 |
| **SMS** ❓                                                                 | סטטוס מסירה                          | יוצא                                        | —                                        | גיבוי לוואטסאפ שנכשל, אם הארגון הפעיל                                                                                                                                                 |
| **הודעות OTA** (Airbnb · Booking) ❓ זמינות API                            | הודעות בשרשור ההזמנה                 | תשובות                                      | הגבלת קצב; חלונות זמן                    | סנכרון תקופתי; הודעה שלא נשלחה מסומנת ולא נעלמת                                                                                                                                       |
| **טופס האתר** (Website Studio)                                             | —                                    | יוצר `lead` דרך שכבת השירות, לא ישירות למסד | reCAPTCHA/honeypot; הגבלת קצב לפי IP     | ליד שנחסם כספאם נשמר ב-`leads_quarantine` ולא נמחק                                                                                                                                    |
| **אחסון קבצים** (Supabase Storage, דלי פרטי)                               | קבצים מצורפים                        |                                             | קישורים חתומים לזמן קצוב בלבד            |                                                                                                                                                                                       |
| **ספק AI**                                                                 | ראה §12                              |                                             | כשל → אין הצעת תשובה. **לעולם לא שליחה** |                                                                                                                                                                                       |

---

## 12. AI

🔒 **ל-AI יש בדיוק את הרשאות המשתמש שהוא משרת.** הוא מקבל את אותו
`Actor` ועובר דרך אותו `can()`. **האכיפה בשאילתה, לא בסינון התוצאה.**

### 12.1 עוזר התשובות בתיבה

**מה הוא עושה:** מציע טיוטת תשובה בשפת האורח.

**על אילו נתונים — רשימת היתר סגורה:**

1. עובדות ההזמנה הזו: תאריכים, שעות, יחידה, מספר אורחים, סה"כ, ששולם,
   יתרה, סטטוס, סטטוס חוזה, סטטוס פיקדון.
2. עובדות הנכס **שפורסמו לאורחים**: מתקנים מרשימה מובנית, כללי בית,
   שעות צ׳ק־אין/אאוט, כתובת, קישור ניווט, מדיניות ביטול.
3. מסמכי מדיניות של הארגון.
4. **השיחה הזו בלבד.**
5. תבניות ההודעות של הארגון.

**מה אסור לו — מוחלט:**

- להמציא מתקן ("יש ג׳קוזי"), מרחק ("10 דקות מהים"), שעה, מחיר או מדיניות
  שאין לה רשומה. חסר עובדה → הטיוטה כותבת `[חסר: מרחק מהים]` ולא מספר.
  _נימוק:_ חור גלוי הוא פגם שרואים; מספר שגוי הוא פגם שלא רואים.
- לענות על זמינות. זמינות היא חישוב טרנזקציוני, לא ניחוש טקסטואלי.
- להבטיח החזר, הנחה, שדרוג או צ׳ק־אאוט מאוחר.
- לצטט מחיר שלמשתמש שהוא משרת אין הרשאה לראות (`rate.view_net`).
- להזכיר אורח אחר, הזמנה אחרת או נכס מחוץ ל-Scope.
- **לשלוח.** 🔒 **העוזר לעולם לא שולח — הוא מציע.** אדם לוחץ "שלח".

**שומר הזיות:** כל טענה עובדתית בטיוטה נדרשת להצביע על רשומת מקור.
משפט בלי מקור מסומן בממשק, והשליחה נחסמת עד עריכה או אישור מפורש
שנרשם. ראה `KNOWN_RISKS.md` R-02.

**רישום:** `messages.ai_suggested = true`; אם המשתמש ערך —
`ai_edited = true`. ב-Audit `actor_type = 'ai_agent'` עם
`onBehalfOfUserId` של מי שלחץ שלח (החלטה 24).

### 12.2 סיווג ותקצור לידים

הצעת `lead_source`, תאריכים ומספר אורחים מטקסט חופשי. **הצעה בלבד**, כל
שדה ניתן לדריסה, ואף שדה לא נשמר בלי שאדם ראה אותו.

### 12.3 זיהוי כפילות

ה-AI **לא** מריץ את הדדופליקציה. ציון ההתאמה (§7.1) הוא נוסחה
דטרמיניסטית ונבדקת. ה-AI רק **מנסח** את ההסבר ("כנראה אותו אדם — אותו
טלפון, שם דומה"). _נימוק:_ החלטה שמערבבת כסף של שני אנשים חייבת להיות
ניתנת לשחזור ולבדיקה, ומודל לשוני אינו כזה.

### 12.4 מה לא נכנס

צ׳אט-בוט **פונה לאורח** אינו כאן — הוא ב-[`41`](41-guest-portal.md) §12,
עם משטר הרשאות שונה לגמרי: שם השחקן הוא קישור יכולת, לא עובד.

---

## 13. אבטחה ופרטיות

### 13.1 מה רגיש

| נתון                        | הגנה                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| טלפון                       | `guest.view_phone`                                               |
| מייל                        | `guest.view_email`                                               |
| שם                          | `guest.view_name` — **כן, גם השם.** מנקה מקבל יחידה ושעה, לא אדם |
| מספר מסמך מזהה              | `guest.view_document_id` + חשיפה חד־פעמית + נימוק + Audit        |
| הערות פנימיות               | `booking.note.internal`                                          |
| מחיר, מקור, פיקדון, רווחיות | `booking.view_*`                                                 |
| מחיר נטו / עמלה             | `rate.view_net` — **לעולם לא במסמך יוצא** (ח40-27)               |
| תוכן שיחות                  | `message.view` + Scope                                           |
| קבצים מצורפים               | דלי פרטי, קישור חתום לזמן קצוב                                   |

הסתרה נעשית **בשכבת השירות בעת עיצוב התשובה**, לא בהסתרה במסך.
🔒 **הסתרת כפתור אינה אבטחה.**

### 13.2 פעולות שדורשות יותר מהרשאה

| פעולה                                                | דרישה נוספת                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `guest.export`                                       | ב-`SENSITIVE_ACTIONS` · נימוק · Audit · אירוע `security.bulk_export` · מגבלת קצב |
| מיזוג                                                | נימוק + הקלדת שם השורד                                                           |
| ביטול מיזוג                                          | נימוק                                                                            |
| חשיפת מסמך מזהה                                      | נימוק + Audit לכל חשיפה                                                          |
| שינוי פרטי תשלום בתבנית (`{{ביטמספר}}`, `{{חשבון}}`) | אימות מחדש (MFA) — ARCHITECTURE §7                                               |
| מחיקת אורח                                           | נימוק + בדיקת §13.6                                                              |
| שליחה לנמען שאינו האורח הרשום                        | נימוק + Audit (§17)                                                              |

### 13.3 סוכן חיצוני

הסולם `GUEST_DATA_LEVELS` עוצר ב-`email`. מסמך מזהה, פירוט תשלומים
מלא והערות פנימיות **אינם שלבים בסולם** — אין מצב של החוגה שמדליק אותם
לצד חיצוני. סוכן רואה לידים והזמנות **שלו**, לא את ספר הלקוחות.

### 13.4 קישורים יוצאים

כל `{{לינק}}`, `{{לינקהצעה}}` ו-`{{לינקחוותדעת}}` הם רשומות
ב-`guest_access_links`, **חד־נמעניות וניתנות לביטול בנפרד**. הפרטים
המלאים: [`41-guest-portal.md`](41-guest-portal.md) §13.

### 13.5 ⚠️ WiFi בהודעת האישור

המערכת החיה שלחה `📶 WiFi: {{וויפי}}` בהודעת האישור — כלומר את סיסמת
הרשת של הבית, בוואטסאפ, ברגע ההזמנה, לפעמים חודשים לפני ההגעה, לקבוצה
שההודעה מועברת אליה.

**החלטה:** המשתנה `{{וויפי}}` **נשאר בקטלוג** (אין מוחקים יכולת), אבל
מוסר מתבנית ברירת המחדל, ועורך התבניות מציג אזהרה כשמוסיפים אותו. ה-WiFi
משתחרר בפורטל בחלון ההגעה ([`41`](41-guest-portal.md) §6).

### 13.6 מחיקה מול חובת שמירה

בקשת "שכחו אותי" מפעילה מסלול **בשלוש שכבות**, לא מחיקה אחת:

1. **נמחק מיד:** טלפון, מייל, כתובת, תאריך לידה, אזרחות, העדפות, תגיות,
   הערות חופשיות, קבצים מצורפים לא־מסמכיים, הסכמת שיווק, ותוכן הודעות
   שיווקיות. `phone_e164` נמחק — ולכן **מפתח הדדופליקציה נעלם**, וזה מקובל.
2. **נשמר תחת הגבלה** (`erasure_state='restricted'`, נגיש רק ל-
   `organization_owner` + `finance_manager`, כל גישה נרשמת): חוזים חתומים,
   חשבוניות, רשומות תשלום ופיקדון, וכל מסמך שמזוהה כמסמך חובה.
3. **תמצית (tombstone):** שורת `guests` נשארת עם `organization_id`,
   `erased_at`, `retention_until` ו-`merged_into_guest_id`, כדי שהזמנות
   וחשבוניות היסטוריות ימשיכו להיפתר. `full_name` מוחלף ב-"אורח שנמחק".

❓ **שאלות למשפטן, לא למפתח:**

- כמה זמן חייבים לשמור חוזה חתום וחשבונית לפי דיני המס בישראל, ומה
  התאריך שממנו סופרים.
- האם בקשת מחיקה לפי חוק הגנת הפרטיות (התיקון שנכנס לתוקף ב-2025) גוברת
  על חובת שמירה, או שהמענה הנכון הוא הגבלת עיבוד כמו בשכבה 2.
- האם "אורח שנמחק" עם `retention_until` הוא מענה מספק, או שנדרש להודיע
  למבקש מה נשמר ולמה.
- האם החזקת מספר ת"ז מחייבת רישום מאגר.

**עד שתתקבל תשובה, ברירת המחדל היא השמרנית:** לא נמחק מסמך שנחתם או
שנרשם כמסמך כספי.

### 13.7 RLS

כל טבלה במודול מקבלת ארבע מדיניויות נפרדות
(`select`/`insert`/`update`/`delete`), וב-`insert` תמיד `with check`.
`messages` מקבלת בנוסף טריגר שדוחה `update` על שדות התוכן ו-`delete`
לחלוטין — אותו דפוס של `audit_events` ב-`0005` ו-`booking_status_history`
ב-`0009`. **אין `using (true)` על אף טבלה במודול.**

---

## 14. Audit

הניסוח הוא משפט בעברית, לא שם פעולה. `AuditEventInput.summary`
נבנה ע"י הקורא, שיודע את המשמעות העסקית.

| פעולה              | ניסוח                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| יצירת אורח         | "רוני יצרה אורח חדש — דנה לוי · 050-•••4567"                                                                   |
| עדכון טלפון        | "שי שינה טלפון של דנה לוי מ-050-•••4567 ל-052-•••1122"                                                         |
| חשיפת מסמך מזהה    | "דנה חשפה את מספר תעודת הזהות של משה כהן · סיבה: אימות בצ׳ק־אין"                                               |
| מיזוג              | "שי מיזג את משה כהן (2 שהיות) לתוך משה כהן (5 שהיות) · הועברו 2 הזמנות, 1 שיחה · סיבה: אותו טלפון בשתי הקלדות" |
| ביטול מיזוג        | "רוני ביטלה את המיזוג מ-14.4 · הוחזרו 2 הזמנות"                                                                |
| חסימה              | "שי חסם את דן ישראלי · סיבה: נזק לרכוש שלא שולם"                                                               |
| ייצוא              | "דנה ייצאה 412 אורחים · סיבה: קמפיין פסח · IP 82.•••"                                                          |
| שליחת הצעה         | "שי שלח הצעה #Q-1042 לדנה לוי · 23–26.4 · ₪6,400 · בתוקף עד 30.3"                                              |
| גרסת הצעה          | "שי החליף את הצעה #Q-1042 בגרסה 2 · ₪6,400 → ₪6,100"                                                           |
| סגירת ליד          | "רוני סגרה ליד — דנה לוי · סיבה: התאריכים לא היו זמינים"                                                       |
| שיוך שיחה          | "השיחה עם דנה לוי הועברה משי לרוני"                                                                            |
| עקיפת מחוון נוכחות | "⚠️ שי שלח תשובה בזמן שרוני כתבה באותה שיחה"                                                                   |
| שליחה לנמען חורג   | "⚠️ דנה שלחה קישור של הזמנה B4A2F1C9 למספר 054-•••9988 שאינו טלפון האורח · סיבה: הבן מטפל בהזמנה"              |
| הודעה מ-AI         | "שי שלח תשובה שנוצרה ע"י ESTIA ונערכה על ידו" (`actor_type='ai_agent'`, `onBehalfOfUserId=שי`)                 |
| בקשת מחיקה         | "משה כהן ביקש מחיקה · נמחקו פרטי קשר · נשמרו 3 חשבוניות ו-1 חוזה עד 2033"                                      |

**לא נרשם:** צפייה בפרופיל, פתיחת שיחה, סינון ברשימה. רישום שכולל את
הכול לא נקרא ע"י איש.
**לעולם לא נרשם:** תוכן הודעה מלא, מספר מסמך מזהה, טוקן. ה-`NEVER_LOGGED`
ב-`src/lib/audit/events.ts` הוא הרשימה המחייבת.

---

## 15. דיווח

🔒 מדד שקיים ב-[`src/lib/metrics/`](../../src/lib/metrics/) **נלקח משם**.
`revenueBySource` · `directRevenue` · `leadTimeDayTotal` /
`leadTimeSample` · `soldBookingCount` · `REALISED_STATUSES` — כולם
מ-`facts.ts` ו-`rows.ts`, ולא מוגדרים כאן מחדש.

מדדים שהמודול הזה **מזין**:

| מדד                           | נוסחה                                            | לאיזה דוח          |
| ----------------------------- | ------------------------------------------------ | ------------------ |
| לידים שנוצרו                  | ספירה                                            | משפך מכירות        |
| המרת ליד להזמנה               | §7.5                                             | משפך · ביצועי סוכן |
| זמן תגובה ראשון (חציון + P90) | §7.4                                             | תפעול · SLA        |
| הצעות שנשלחו / נצפו / התקבלו  | ספירה + §7.5                                     | משפך               |
| זמן מהצעה לאישור              | חציון `accepted_at − sent_at`                    | משפך               |
| פילוח סיבות סגירה             | קיבוץ `lost_reason`                              | תמחור ומלאי        |
| אורחים חוזרים                 | `percentOf(guests WHERE stay_count > 1, guests)` | נאמנות             |
| ערך אורח מצטבר                | §7.6                                             | נאמנות · שיווק     |
| נפח שיחות לפי ערוץ            | ספירה                                            | תפעול              |
| שיחות שנפתחו מחדש             | ספירה                                            | איכות שירות        |
| חלק ההודעות שנוצרו ב-AI       | `percentOf(ai_suggested, outbound)`              | ממשל AI            |
| כפילויות שזוהו / מוזגו        | ספירה                                            | איכות נתונים       |

**כל דוח מכבד Scope.** מנהל של 3 נכסים רואה משפך של 3 נכסים —
**כולל בייצוא**.

---

## 16. מטריצת מקרי קצה

22 מקרים.

| #      | המקרה                                                        | מה קורה היום (מערכת חיה) | מה **צריך** לקרות                                                                                                        | איך בודקים                                                                        |
| ------ | ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| ק40-01 | טלפון מוקלד `050-123-4567` והאורח כבר קיים כ-`+972501234567` | נוצר אורח שני            | הנרמול מזהה; ה-DB דוחה; הממשק מציג את הקיים                                                                              | Integration: שני `insert`, השני נכשל `23505` ומחזיר `ConflictError` עם ה-ID הקיים |
| ק40-02 | מספר זר `+33612345678`                                       | נשמר כמחרוזת             | נשמר כ-`+33612345678`, לא כישראלי                                                                                        | Unit על `normalize_phone_il`                                                      |
| ק40-03 | מספר `972501234567` בלי `+`                                  | —                        | מתפרש כישראלי (מגבלה מתועדת, ח40-03). הממשק הזהיר לפני כן                                                                | Unit + בדיקת קיום האזהרה בממשק                                                    |
| ק40-04 | אותו מייל לשני אנשים (זוג)                                   | —                        | **מותר.** שני אורחים, בלי אזהרה                                                                                          | Integration: שתי יצירות מצליחות                                                   |
| ק40-05 | טלפון ריק, מייל בלבד                                         | —                        | אורח נוצר; `phone_e164` null ולכן מחוץ לאינדקס הייחודי; דדופליקציה לפי מייל = הצעה בלבד                                  | Integration                                                                       |
| ק40-06 | **מיזוג בזמן שנוצרת הזמנה מול המוזג**                        | לא קיים                  | שורת האורח נעולה; היצירה ממתינה ואז נכשלת `retryable` עם השורד; ניסיון חוזר מצליח על השורד                               | Concurrency: שתי טרנזקציות במקביל. אין הזמנה יתומה, אין כפילות                    |
| ק40-07 | ביטול מיזוג אחרי שהזמנה שהוזזה עודכנה                        | לא קיים                  | הביטול **נדחה** ומפרט מה השתנה (ח40-15)                                                                                  | Integration                                                                       |
| ק40-08 | ביטול מיזוג אחרי 31 יום                                      | לא קיים                  | נדחה: "חלון הביטול (30 יום) חלף. פנו לתמיכה."                                                                            | Unit על גבול הזמן                                                                 |
| ק40-09 | מיזוג של אורח לתוך עצמו                                      | לא קיים                  | נדחה בוולידציה                                                                                                           | Unit                                                                              |
| ק40-10 | מיזוג משורשר: A→B, ואז B→C                                   | לא קיים                  | `A.merged_into` מתעדכן ל-C. קישור ישן ל-A מגיע ל-C                                                                       | Integration + מעבר על שרשרת                                                       |
| ק40-11 | שני עובדים ממזגים את אותו זוג במקביל                         | לא קיים                  | הראשון מנצח; השני מקבל "הפרופילים כבר מוזגו"                                                                             | Concurrency, נעילה בסדר `id`                                                      |
| ק40-12 | ליד נכנס לאורח **חסום**                                      | לא קיים                  | הליד נוצר עם דגל בולט "אורח חסום — {{סיבה}}". הצעה נחסמת עד אישור מנהל                                                   | Integration + בדיקת שלילה                                                         |
| ק40-13 | ליד ללא טלפון וללא מייל                                      | —                        | נדחה בוולידציה                                                                                                           | Unit                                                                              |
| ק40-14 | ליד נסגר `lost`, האדם חוזר חודש אחרי                         | —                        | **ליד חדש**, מוצמד לאותו `guest_id`. הישן נשאר `lost` — כדי שסטטיסטיקת הסיבות לא תשקר                                    | Integration                                                                       |
| ק40-15 | הצעה מתקבלת אחרי שהתאריכים נתפסו                             | לא קיים                  | נדחית עם הודעה + התראה מיידית לצוות + הצעת חלופה                                                                         | Concurrency: קבלה + הזמנה מתחרה                                                   |
| ק40-16 | הצעה נערכת אחרי שנשלחה                                       | ניתן היה לשנות בשקט      | נוצרת גרסה 2; הקישור הישן מציג "ההצעה עודכנה" ולא מחיר אחר                                                               | E2E: פתיחת הקישור הישן                                                            |
| ק40-17 | הצעה פגה בזמן שהאורח פתוח בדף                                | לא קיים                  | הקבלה נדחית עם "ההצעה פגה ב-30.3". הדף מציג "בקש הצעה מעודכנת"                                                           | E2E עם שעון מוקפא                                                                 |
| ק40-18 | שני עובדים כותבים תשובה לאותה שיחה                           | לא קיים                  | השני רואה מחוון; שליחה דורשת אישור מפורש ונרשמת (ח40-30)                                                                 | E2E שני דפדפנים                                                                   |
| ק40-19 | Webhook של הודעה נכנסת מגיע פעמיים                           | —                        | הודעה אחת. ייחודיות על `external_message_id`                                                                             | Integration: שני POST זהים                                                        |
| ק40-20 | אורח כותב בוואטסאפ ובמייל על אותה הזמנה                      | —                        | **שתי שיחות** (ערוצים שונים), שתיהן בלשונית ההודעות של הפרופיל וב-`booking`. מיזוג שיחות הוא פעולה יזומה                 | Integration                                                                       |
| ק40-21 | הודעה יוצאת נכשלת סופית                                      | נעלמת                    | נשארת בשרשור עם ⚠️, נוצרת משימת מעקב, השיחה חוזרת ל-`assigned`                                                           | Integration עם ספק מדומה שנכשל                                                    |
| ק40-22 | **בקשת מחיקה כשיש חוזה חתום וחשבונית**                       | לא קיים                  | פרטי קשר נמחקים; חוזה וחשבונית עוברים ל-`restricted` עם `retention_until`; tombstone נשאר; המבקש מקבל פירוט מה נשמר ולמה | Integration + Security: משתמש בלי `finance.view` לא מגיע לשכבה 2                  |

---

## 17. מניעת טעות אנוש

| הטעות                                 | המנגנון                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **יצירת אורח כפול בדלפק**             | חיפוש מנרמל את מחרוזת החיפוש; טופס היצירה בודק תוך כדי הקלדה ומציג "כבר קיים אורח עם הטלפון הזה — דנה לוי, 3 שהיות" עם כפתור "השתמש בקיים" |
| **מיזוג של שני אנשים שונים**          | מסך זו-מול-זו · מונים · אישור בהקלדת שם השורד · נימוק חובה · באנר ביטול 30 יום · הצעה רק מעל 0.85 · **המערכת לעולם לא ממזגת מעצמה**        |
| **הצעה בתאריכים שגויים**              | אישור לפני שליחה עם התאריכים **במילים ובספרות** — "23–26 באפריל 2026 · 3 לילות". שתי טעויות הקלדה לא נראות אותו דבר במילים                 |
| **הצעה בסכום שגוי**                   | סכום חריג ביחס למחירון הנכס (סטייה >30%) מציג "המחיר נמוך ב-42% מהמחירון. להמשיך?"                                                         |
| **תשובה בשיחה הלא נכונה**             | כותרת העורך מציגה שם + נכס + תאריכים בקבוע; טיוטה נשמרת **לפי שיחה** ולא נגררת בין שיחות; החלפת שיחה עם טיוטה פתוחה מבקשת אישור            |
| **שליחה לאורח שכבר עזב**              | ההודעה מציגה תג "האורח עזב ב-26.4" ליד שדה השליחה                                                                                          |
| **ייצוא של כל הארגון ע"י מנהל נכס**   | הייצוא נבנה מתוך אותה שאילתה מוגבלת-Scope; מסך האישור מציג "412 אורחים · 3 נכסים: …" לפני ההורדה; בדיקת שלילה אוטומטית                     |
| **קמפיין לאורח שביקש שלא**            | `invite_back` מסננת `marketing_consent = true` **בשאילתה**, לא בבדיקה בסוף                                                                 |
| **חשיפת מסמך מזהה בטעות**             | מוסתר תמיד; חשיפה חד־פעמית עם נימוק; נרשמת בשם המשתמש                                                                                      |
| **תבנית עם משתנה שאין לו ערך**        | השליחה נחסמת (ח40-37)                                                                                                                      |
| **פעולה כפולה** (שליחה, מיזוג, ייצוא) | מפתח ייחודי לכל אחת (§10)                                                                                                                  |

### 🔴 שליחת הקישור של האורח הלא נכון

זו הטעות שקורה באמת: העובד מעתיק קישור מהזמנה אחת ומדביק בשיחה של אורח
אחר. במערכת החיה זה מסתיים בכך שאדם זר רואה שם, טלפון, תאריכים, סכומים
וחוזה של מישהו אחר — **ואין דרך לבטל.**

המנגנון, בשש שכבות:

1. **אין "העתק קישור" חשוף מהרשימה.** הפעולה היא **"שלח לאורח"**, וקשורה
   להזמנה. העובד בוחר הזמנה, לא מספר טלפון.
2. **הנמען נגזר מההזמנה.** ברירת המחדל היא `guests.phone` של אותה הזמנה
   בלבד.
3. **פס אישור לפני שליחה:** שם האורח · 4 ספרות אחרונות של הנמען · שם
   הנכס · התאריכים במילים. שתי הזמנות שונות מייצרות פס שנראה שונה.
4. **נמען חורג הוא פעולה נפרדת.** הקלדת מספר אחר דורשת נימוק, מנפיקה
   **קישור נפרד** לאותו נמען, ונרשמת: "⚠️ דנה שלחה קישור של הזמנה
   B4A2F1C9 למספר 054-•••9988 שאינו טלפון האורח".
5. **60 שניות לביטול.** "בטל שליחה" מבטל את הקישור מיידית, ובוואטסאפ
   מנסה גם מחיקה לכולם. הקישור מת גם אם ההודעה נשארה.
6. 🔒 **הקישור הוא חד־נמעני.** זו התמורה של כל התכנון ב-
   [`41`](41-guest-portal.md) §13: ביטול הקישור השגוי **לא שובר את הקישור
   של האורח הנכון**, כי הם שני קישורים שונים. במערכת החיה — שבה הסוד היה
   מזהה ההזמנה — לא הייתה שום פעולה שיכולה לעשות את זה.

**כשהטעות מתגלה מאוחר:** כפתור אחד בהזמנה — "הקישור נשלח בטעות" —
מבטל את הקישור הספציפי, מנפיק חדש לאורח הנכון, ורושם. פאנל "מי פתח את
הקישור" (זמן פתיחה ראשון, מספר פתיחות, מיקום גס) מאפשר לענות "האם מישהו
כבר ראה".

---

## 18. תלויות

**המודול תלוי ב:**

| תלות                                                                 | לשם מה                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/authz/` (`can`, `permissions`, `roles`)                     | כל בדיקת גישה                                                            |
| `src/lib/actor/`                                                     | `Actor`, כולל השחקן של ה-AI                                              |
| `src/lib/service/operation.ts` · `idempotency.ts` · `transaction.ts` | נתיב הפעולה, מפתחות ייחודיים, אטומיות                                    |
| `src/lib/errors/`                                                    | `AppError`, `ConflictError`, `BusinessRuleError`, `DATA_OUTCOME_MESSAGE` |
| `src/lib/audit/`                                                     | `AuditEventInput`, `ActorType`, `diffFields`, `NEVER_LOGGED`             |
| `src/lib/contracts/events.ts`                                        | `guest.created` · `guest.merged` · `lead.*` · `quote.*`                  |
| `src/lib/contracts/states.ts`                                        | `Page` · `MAX_PAGE_SIZE` · `APPROVAL_*`                                  |
| `src/lib/booking/types.ts`                                           | `BookingStatus` · `BookingSource` · `PriceLine` · `Hold` · `DateRange`   |
| `src/lib/metrics/`                                                   | כל חישוב, עיגול וחלוקה                                                   |
| `public.normalize_phone_il`                                          | דדופליקציה                                                               |
| `0009_booking_core.sql`                                              | `guests` · `bookings` · `holds`                                          |
| מודול הנכסים                                                         | `properties` · `units` · עובדות שפורסמו                                  |
| מודול התשלומים                                                       | יתרה, סטטוס תשלום                                                        |

**תלויים בו:**

| מי                                         | במה                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| [`41-guest-portal.md`](41-guest-portal.md) | `guests` · `guest_access_links` · `message_templates` · שיחות `guest_portal` |
| מודול ההזמנות                              | `guest_id` חובה על כל הזמנה                                                  |
| Website Studio                             | טופס יצירת קשר → `lead`                                                      |
| מודול הערוצים                              | הודעות OTA → `conversations`                                                 |
| מודול הסוכנים                              | לידים והצעות של סוכן; ייחוס עמלה                                             |
| דוחות                                      | משפך, נאמנות, פילוח ערוצים                                                   |
| מודול החשבוניות                            | פרטי אורח על חשבונית                                                         |

---

## 19. בדיקות נדרשות

### Unit

| בדיקה                                      | מה היא מוכיחה                                                  |
| ------------------------------------------ | -------------------------------------------------------------- |
| `normalize_phone_il` על 9 הפורמטים בח40-02 | הדדופליקציה עובדת על מה שאנשים באמת מקלידים                    |
| נרמול מחזיר `null` על קלט ריק / לא ספרתי   | לא נוצר מפתח דדופליקציה מזבל                                   |
| ציון התאמה §7.1                            | הסף 0.85 לא מציע מיזוג של "דוד כהן" ו"דוד כהן" בלי טלפון משותף |
| מכונת מצבי ליד                             | כל מעבר לא חוקי נדחה, כולל `booked → lost`                     |
| מכונת מצבי הצעה                            | `accepted` סופי; `sent → draft` נדחה                           |
| חישוב `valid_until` סביב שעון קיץ          | הצעה לא פגה שעה מוקדם מדי                                      |
| רינדור תבנית                               | כל 17 המשתנים; משתנה חסר **חוסם** ולא מרנדר ריק                |
| נרמול `\n` בייבוא                          | פעם אחת בלבד                                                   |
| `safeDivide` במכנה אפס                     | `null`, לא `0`, לא חלוקה באפס                                  |

### Integration

| בדיקה                           | מה היא מוכיחה                                                           |
| ------------------------------- | ----------------------------------------------------------------------- |
| שתי יצירות עם אותו טלפון        | האינדקס דוחה; `ConflictError` מפנה לקיים                                |
| מיזוג מלא                       | כל הילדים זזו; `moved` שלם; המוזג `deleted_at` + `merged_into_guest_id` |
| ביטול מיזוג                     | חוזר בדיוק, כולל שדות שנדרסו                                            |
| ביטול אחרי שינוי                | **נדחה**, ומפרט                                                         |
| שליחת הצעה                      | `lines_snapshot` + `document_sha256` הוקפאו; קישור הונפק                |
| עריכה אחרי שליחה                | נוצרה גרסה 2; הקישור הישן בוטל                                          |
| Webhook כפול                    | שיחה אחת, הודעה אחת                                                     |
| כשל משלוח                       | ההודעה נשארת; משימה נוצרה                                               |
| טריגר `lifetime_revenue_agorot` | מתעדכן ב-`confirmed` וב-`cancelled`, ולא מקבל ערך מ-Caller              |

### E2E

יום מלא של פנייה: ליד מהאתר → הצמדה לאורח קיים → הצעה → צפייה → קבלה →
הזמנה → הודעת אישור → שיחה בתיבה → סגירה. **בלי לזרוע כלום שהמוצר לא
יכול ליצור בעצמו.**
בנוסף: שני דפדפנים בו־זמנית על אותה שיחה (ק40-18); פתיחת קישור להצעה
שהוחלפה (ק40-16).

### Security — 🔒 לכל הרשאה בדיקה שמוכיחה את **השלילה**

```
cleaner cannot view guest
cleaner cannot read guest phone
cleaner cannot read guest email
housekeeping_supervisor cannot read guest phone
marketing_editor cannot read guest phone
marketing_editor cannot export guests
reception cannot send a quote
reception cannot read guest document id
revenue_manager cannot send a message
accountant cannot create a lead
property_manager cannot export guests outside scope
property_manager cannot read a guest whose stays are all in another property
sales_agent cannot view another agent's lead
sales_agent cannot read guest email when the ladder stops at phone
sales_agent cannot read internal notes at any ladder level
sales_agent cannot read rate.net in a quote
property_owner cannot open the inbox
organization A cannot query organization B's guests
organization A cannot merge into organization B's guest
a revoked quote link returns nothing
an expired quote link returns nothing
a forged quote token returns nothing
AI assistant cannot read a unit outside the serving user's scope
AI assistant cannot send a message
exported CSV contains no row outside the actor's scope
```

בנוסף, מטריצת בידוד תוקפנית: החלפת `organization_id` בגוף הבקשה ·
החלפת `guest_id` · פנייה ישירה ל-API · שימוש ב-session אחרי השעיה ·
שימוש בקישור ישן. **כולן חייבות להיחסם.**

### Regression

| בדיקה                                                         | מה היא מוכיחה                |
| ------------------------------------------------------------- | ---------------------------- |
| הצעה שנשלחה ב-1.1 מציגה את אותו מחיר אחרי שינוי מחירון        | ההקפאה עובדת                 |
| תבנית שהשתנתה לא משנה הודעה שכבר נשלחה                        | `rendered_at` + הקפאה        |
| ה-17 משתנים העבריים ממשיכים לעבוד אחרי כל שינוי במנוע התבניות | לא איבדנו יכולת מהמערכת החיה |
| `guest_merges` ישנים נשארים ניתנים לקריאה                     | ביטול מיזוג לא נשבר בשדרוג   |

---

## 20. תנאי קבלה

**מסד**

- [ ] `guests` הורחבה: `merged_into_guest_id` · `preferred_channel` · `preferences` · `first_stay_at` · `last_stay_at` · `stay_count` · `lifetime_revenue_agorot` · `erasure_state` · `erasure_requested_at` · `erased_at` · `retention_until` · `source_first_touch`
- [ ] `guest_merges` · `leads` · `quotes` · `quote_lines` · `conversations` · `messages` · `conversation_drafts` · `message_templates` נוצרו, כולן עם `organization_id` ובלוק מטא-דאטה
- [ ] אינדקסים לפי §3
- [ ] `messages` append-only לתוכן, נאכף בטריגר
- [ ] `quotes.total_agorot` ו-`guests.lifetime_revenue_agorot` מתוחזקים בטריגר; ערך מ-Caller נזרק
- [ ] RLS על כל טבלה, ארבע מדיניויות, `with check` ב-`insert`, אין `using (true)`

**שרת**

- [ ] כל פעולה משנת-מצב עוברת `can()` → ולידציה → חוק עסקי → טרנזקציה → Audit → Domain Event
- [ ] מפתחות ייחודיים על שליחה · שליחת הצעה · קבלה · מיזוג · ביטול · ייצוא · הנפקת קישור
- [ ] נעילה אופטימית על `guests` · `quotes` · `conversations`
- [ ] מיזוג נועל בסדר `id` עולה
- [ ] ההצעה מרונדרת בהקרנת `rate.public` קבועה, ולא בהענקות השולח

**הרשאות**

- [ ] הסתרה ברמת שדה בשכבת השירות, לא במסך
- [ ] ⚠️ `guest.merge` נוסף לקטלוג, או שהמיזוג דורש `guest.update` + `guest.delete` יחד
- [ ] כל דוח וכל ייצוא מכבדים Scope

**ממשק**

- [ ] פרופיל 360° · רשימת אורחים · מיזוג · לוח לידים · עורך הצעה · תיבה
- [ ] לכל מסך: מצב ריק, מצב טעינה, מצב שגיאה — נבדלים זה מזה
- [ ] מובייל: לוח לידים כרשימה מקובצת, תיבה בשלושה מסכים
- [ ] מחוון נוכחות בשיחה

**בדיקות**

- [ ] כל בדיקות §19 עוברות
- [ ] לכל הרשאה קיימת בדיקת שלילה

**Audit**

- [ ] כל אירוע ב-§14 נרשם כמשפט בעברית עם לפני/אחרי
- [ ] תוכן הודעה, מסמך מזהה וטוקן לעולם לא נרשמים

**שגיאות**

- [ ] כל כשל מחזיר `AppError` עם `userMessage` בעברית, `dataOutcome` ו-`retryable` נכונים
- [ ] הודעה שנכשלה נשארת גלויה בשרשור

**פתוח וממתין לבעל המוצר / למשפטן**

- [ ] ❓ החזקת מספר ת"ז: מותר, לכמה זמן, ובאילו תנאים (ח40-07)
- [ ] ❓ מחיקה מול חובת שמירה: תקופות ומעמד בקשת המחיקה (§13.6)
- [ ] ❓ ברירת מחדל לתוקף הצעה לכל ארגון (ח40-25)
- [ ] ❓ ספק WhatsApp / מייל / SMS / הודעות OTA (§11)
