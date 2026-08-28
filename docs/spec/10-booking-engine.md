# 10 · מנוע ההזמנות · Canonical Master Edge Specification

> נכתב לפי [`00-TEMPLATE.md`](00-TEMPLATE.md). המבנה, הסדר והכותרות מחייבים.
>
> **מקור האמת הוא הקוד.** כל מה שכתוב כאן על `src/lib/booking/` נקרא משם.
> במקום שבו הקוד והאפיון סותרים — שניהם מופיעים, עם `⚠️ סתירה` והמלצה.
>
> **מצב המימוש בקצרה:** החוזה (`types.ts`), מכונת המצבים (`state-machine.ts`),
> מנוע הזמינות (`availability.ts`), ההחזקות (`holds.ts`), התמחור (`pricing.ts`)
> ושש הפעולות (`operations.ts`) כתובים. **המיגרציה `0009_booking_core.sql`
> אינה קיימת** — אין `bookings`, אין `holds`, ואין אילוץ ההדרה שכל המנוע
> מצהיר שהוא הערובה האמיתית. ראה [⚠️ C-1](#-סתירות-שנמצאו).

---

## 1. מטרת המודול

בעל צימר מוכר לילות. מה שהוא באמת מוכר זה **הבטחה שהיחידה תהיה פנויה**,
ומרגע שההבטחה הזו נשברת פעם אחת — שני אורחים מגיעים לאותה וילה באותה שישי —
הוא מפסיד את הלקוח, את הביקורת ואת הכסף, ולא בהכרח בסדר הזה.

המודול הזה עונה על ארבע שאלות, וכל היתר נגזר מהן:

1. **מה פנוי?** תשובה אחת, לאתר, ליומן הפנימי, לסוכן, ל-OTA ולפקידת הקבלה.
   לא ארבע מערכות שמסתנכרנות.
2. **איך תופסים את זה בלי לאבד אותו?** החזקה קצובה בזמן, שמאפשרת לסגור עסקה
   בטלפון בלי שהתאריכים יימכרו באמצע השיחה — ובלי שסוכן ששכח לסגור ינעל את
   המלאי של העסק לשבוע.
3. **מה קורה כשמשהו משתנה?** תאריכים, אורחים, יחידה, מחיר, תוספות. כל שינוי
   הוא הזמנה חדשה מבחינת הזמינות, ההכנה, הצוות והכסף — ומי שמתייחס אליו
   כעריכת שדה מגלה את זה בערב הצ׳ק-אין.
4. **מה קורה כשזה נופל?** ביטול, אי-הגעה, תשלום שנכשל, תשלום שהצליח מאוחר
   מדי, שני עובדים שעורכים במקביל. אלה לא מקרי קצה — אלה יום שלישי.

מה שהמודול **אינו**: הוא לא גובה כסף (זה `payments`), לא מפיק חשבונית
(זה `invoices`), לא מנקה (זה `tasks`) ולא מחשב עמלה (זה מנוע העמלות).
הוא **מפעיל** את כולם דרך אירועי דומיין, ואינו יודע איך הם עובדים.

---

## 2. משתמשים והרשאות

ההרשאות הן מהקטלוג ב-[`src/lib/authz/permissions.ts`](../../src/lib/authz/permissions.ts).
התפקידים מ-[`roles.ts`](../../src/lib/authz/roles.ts). הטווח הוא `Scope`
מ-[`can.ts`](../../src/lib/authz/can.ts).

| תפקיד | מה הוא עושה כאן | ההרשאות הנדרשות | טווח | מה הוא **לא** רואה |
| --- | --- | --- | --- | --- |
| `reservation_manager` / `general_manager` | הכול: יוצר, משנה, מבטל, עוקף זמינות ומחיר | `booking.*`, `hold.*`, `availability.view`, `booking.override_availability`, `booking.override_price` | `all_organization` או `properties[]` | תיק מסמכי הזהות של האורח אם לא הוענק `guest.view_document_id` |
| `reception` | מוכר בטלפון, מבצע צ׳ק-אין וצ׳ק-אאוט, משנה תאריכים | `booking.view`, `booking.create`, `booking.update`, `AMENDMENT_GRANTS`, `booking.change_status`, `hold.create`, `hold.release`, `hold.extend` | `properties[]` בדרך כלל | `booking.view_profitability`, `rate.view_net`, `booking.export`, `booking.cancel` — **ביטול אינו בערכה של קבלה** |
| `revenue_manager` | קובע מחירים, מינימום לילות, חסימות עונתיות | `pricing.manage`, `availability.view`, `rate.view_*` | `all_organization` | פרטי קשר של אורח |
| `housekeeping_supervisor` / `cleaner` | רואה מה מתפנה ומתי, לא רואה מי ולא בכמה | `booking.view` בטווח מצומצם, `task.*` | `team` / `units[]` | `guest.phone`, `guest.email`, `booking.price`, `booking.source`, `booking.deposit` — **כולם ברמת שדה, ב-`redact()`** |
| `sales_agent` (סוכן חיצוני) | רואה תפוס/פנוי, מחזיק תאריכים, יוצר הזמנה | `availability.view`, `hold.create`, `hold.release`, `hold.extend`, `booking.create`, `guest.create`, `rate.view_agent` | `units[]` או `properties[]` **צר** | 🔒 **את היומן הפנימי.** לא שם אורח (אלא אם `guest.view_name`), לא מחיר ששולם, לא מקור הזמנה, לא הזמנות של אחרים |
| `senior_agent` | בנוסף: משנה הזמנה שלו במגבלות, שולח קישור תשלום | `AMENDMENT_GRANTS`, `payment.request_link` | `own_records` בשילוב `units[]` | `booking.override_price` — חריגה מהתקרה **מייצרת בקשת אישור**, לא מסרבת |
| `property_owner` | רואה תפוסה והכנסה בנכס שלו | `booking.view`, `owner_statement.view` | `properties[]` של הנכס שלו | פרטי אורח, מקור הזמנה, עמלת סוכן |
| `system` (ייבוא ערוצים, מטאטא החזקות) | יוצר הזמנות OTA, משחרר החזקות שפג תוקפן | `booking.create`, `hold.release`, `channel.manage` | `all_organization` | — נרשם ב-Audit כ-`actor_type = 'system'` |
| `ai_agent` | מציע חלופות, עונה "מה פנוי" | 🔒 **בדיוק ההרשאות של המשתמש שהוא משרת** | זהה למשתמש | ראה §12 |

**העמודה האחרונה היא העיקר.** ההפרדה בין "היומן הפנימי" ל"יומן הזמינות"
(`docs/ARCHITECTURE.md` §12) אינה הגדרת תצוגה: `availability.view` מחזיר
`DayAvailability` — תאריך, מצב, ומזהה טכני — ולעולם לא `BookingSnapshot`.
זו הסיבה ש-`availabilityCalendar()` היא פונקציה נפרדת מ-`loadBookings`
ולא סינון שלה.

---

## 3. מודל הנתונים

### 3.1 מה שכבר קיים

`0008_accommodation.sql` יצר את `properties`, `unit_groups`, `units`,
`teams`, `amenities`. הרלוונטי כאן:

- `units.id` נושא את המפתח המורכב `units_id_organization_property_key
  unique (id, organization_id, property_id)`. **הוא קיים בדיוק בשביל
  ההזמנות** — מפתח זר מורכב אליו מוכיח בבת אחת שהיחידה בנכס ושהנכס בארגון.
- `units.max_guests`, `standard_guests`, `min_nights`, `max_nights`,
  `status` — כולם קיימים ו**אף אחד מהם אינו נקרא היום על ידי
  `checkAvailability`**. ראה [⚠️ C-6](#-סתירות-שנמצאו).
- `properties.cancellation_policy jsonb` קיימת **בלי סכימה**. §7.6 קובע אותה.
- `properties.tax_rate_bps`, `tax_included_in_price`, `tourist_vat_exempt`.

### 3.2 `0009_booking_core.sql` — מה שחייב להיווצר

#### `guests`

| עמודה | טיפוס | הערה |
| --- | --- | --- |
| `id` | uuid pk | |
| `organization_id` | uuid not null | RLS |
| `full_name` | text not null | |
| `phone` | text | 🔒 **מפתח הדדופליקציה.** מנורמל ל-E.164 בעמודה מחושבת `phone_e164` |
| `email` | citext | |
| `document_id` | text | שדה רגיש — `guest.view_document_id` |
| `country`, `language` | text | |
| `notes` | text | |
| בלוק מטא-דאטה | | `created_at/by`, `updated_at/by`, `version`, `deleted_at/by` |

`create unique index guests_org_phone_idx on guests (organization_id,
phone_e164) where deleted_at is null and phone_e164 is not null` —
`DATA_MODEL.md` M1 דורש דדופליקציה לפי טלפון, וזה המקום היחיד שבו היא
נאכפת. דדופליקציה בקוד היא דדופליקציה שנשברת בשתי בקשות מקבילות.

#### `bookings`

העמודות נגזרות אחת לאחת מ-`BookingSnapshot` ומ-`BookingDraft`:

| עמודה | טיפוס | הערה |
| --- | --- | --- |
| `id` | uuid pk | |
| `organization_id` | uuid not null | |
| `property_id` | uuid not null | 🔒 **not null, ונגזר מהיחידה** — ראה B-3 |
| `unit_id` | uuid not null | |
| `guest_id` | uuid | null בשלב `inquiry`, לפני שיש אורח |
| `reference` | text not null | המספר שהאורח מצטט בטלפון. ייחודי לארגון |
| `status` | `booking_status` enum | 19 ערכים, **בסדר ובאיות של `BOOKING_STATUSES`** |
| `check_in`, `check_out` | date not null | חצי-פתוח |
| `guest_name` | text not null | denormalised — הזמנה חייבת להיות קריאה גם אם `guests` נמחקה רכה |
| `guest_count`, `adults`, `children`, `infants` | integer | |
| `event_type` | `event_type` enum | מ-`src/lib/preparation/types.ts` — מזין את מנוע ההכנה |
| `source` | `booking_source` enum | 🔒 |
| `source_channel`, `agent_user_id`, `agency_id`, `campaign_id`, `referral_id` | | 🔒 בלוק הייחוס, מ-`BookingAttribution`. **נכנס עכשיו ולא אחר כך** — `ARCHITECTURE.md` §12 |
| `channel_reservation_id` | text | מזהה ההזמנה אצל ה-OTA. `unique (organization_id, source, channel_reservation_id)` — ראה E-14 |
| `lines` | jsonb not null | מערך `PriceLine`. **המקור לכל סכום** |
| `total_agorot` | integer not null | תמיד `sumLines(lines)`, נאכף ב-trigger — §7.1 |
| `deposit_required_agorot`, `deposit_held_agorot` | integer not null default 0 | |
| `paid_agorot` | integer not null default 0 | מתוחזק על ידי `payments`, נקרא כאן |
| `tax_rate_bps_applied`, `tourist_vat_applied` | | 🔒 snapshot. הזמנה לא ממוסה מחדש רטרואקטיבית |
| `cancellation_policy_snapshot` | jsonb | 🔒 המדיניות **כפי שהייתה ברגע ההתחייבות**. שינוי מדיניות בנכס אינו חל על הזמנות קיימות |
| `cancelled_at`, `cancellation_reason`, `cancellation_fee_agorot` | | |
| `committed_at` | timestamptz | הפעם הראשונה שהגיעה לסטטוס תופס. מזין `BookingFactRow.committedOn` |
| `notes`, `internal_notes` | text | `internal_notes` מאחורי `booking.note.internal` |
| בלוק מטא-דאטה | | כולל `version` — נעילה אופטימית |

אילוצים:

```sql
constraint bookings_unit_fkey
  foreign key (unit_id, organization_id, property_id)
  references public.units (id, organization_id, property_id),
constraint bookings_range_valid check (check_out > check_in),
constraint bookings_guest_count_positive check (guest_count >= 1),
constraint bookings_money_nonnegative check (
  total_agorot >= 0 and deposit_required_agorot >= 0
  and deposit_held_agorot >= 0 and paid_agorot >= 0
),
constraint bookings_reference_format check (reference ~ '^[0-9]{4,10}$')
```

🔒 המפתח הזר המורכב הוא **כל** ההגנה מפני הזמנה שנרשמה לנכס הלא נכון.
ראה §17 H-1.

אינדקסים (נגזרים מדפוסי השאילתה בפועל):

```sql
create index bookings_calendar_idx
  on bookings (organization_id, unit_id, check_in, check_out)
  where deleted_at is null;
create index bookings_arrivals_idx
  on bookings (organization_id, property_id, check_in)
  where status = any (array['confirmed','pre_arrival','ready_for_check_in']::booking_status[]);
create index bookings_agent_idx
  on bookings (organization_id, agent_user_id) where agent_user_id is not null;
create index bookings_channel_idx
  on bookings (organization_id, source, channel_reservation_id)
  where channel_reservation_id is not null;
```

#### `booking_status_history`

`DATA_MODEL.md` M1 מבטיח אותה. שורה לכל מעבר: `booking_id`, `from_status`,
`to_status`, `changed_by`, `changed_at`, `reason`, `correlation_id`.
היא **לא** מחליפה את `audit_events` — היא מה שמאפשר לשאול "כמה זמן הזמנה
עמדה ב-`awaiting_payment`" בלי לפרסר טקסט חופשי.

#### `holds`

אחד לאחד עם `Hold` ב-`types.ts`, בתוספת שלוש עמודות שהחוזה חסר:

| עמודה | טיפוס | הערה |
| --- | --- | --- |
| `id`, `organization_id`, `unit_id` | | |
| `property_id` | uuid not null | נגזר מהיחידה, כמו בהזמנה |
| `check_in`, `check_out` | date not null | |
| `reason` | `hold_reason` enum | 4 ערכים מ-`HOLD_REASONS` |
| `held_by_user_id` | uuid not null | |
| `expires_at` | timestamptz **not null** | 🔒 החוזה אוסר החזקה בלי תפוגה |
| `released_at`, `converted_to_booking_id` | | |
| `created_at` | timestamptz not null | ⚠️ **חסר בחוזה** — ראה C-4 |
| `extension_count` | integer not null default 0 | ⚠️ **חסר בחוזה** — ראה C-4 |
| `booking_id` | uuid | ההזמנה שההחזקה נועדה לשרת, כשיש כזו (`guest_checkout`) |

#### `unit_claims` — 🔒 **ההכרעה הטכנית המרכזית של המודול**

`availability.ts` מצהיר בראש הקובץ: "הערובה האמיתית היא במסד — אילוץ
הדרה `GiST` על `(unit_id, daterange)` עבור הזמנות תופסות והחזקות חיות".
**אילוץ כזה אינו ניתן לכתיבה על שתי טבלאות.** PostgreSQL אוכף `EXCLUDE`
בתוך טבלה אחת בלבד. שני אילוצים נפרדים — אחד על `bookings`, אחד על `holds`
— ימנעו הזמנה מול הזמנה והחזקה מול החזקה, ו**לא ימנעו הזמנה מול החזקה**,
שהוא בדיוק המקרה שבגללו ההחזקות קיימות.

**ההכרעה:** טבלת תביעות אחת, שאליה כותבים שניהם.

```sql
create extension if not exists btree_gist;

create table public.unit_claims (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  unit_id          uuid not null,
  kind             public.claim_kind not null,   -- 'booking' | 'hold'
  booking_id       uuid,
  hold_id          uuid,
  stay             daterange not null,
  -- אצל החזקה: מתי היא מפסיקה לתבוע. אצל הזמנה: null.
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),

  constraint unit_claims_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete restrict,
  constraint unit_claims_exactly_one check (
    (kind = 'booking' and booking_id is not null and hold_id is null
     and expires_at is null)
    or
    (kind = 'hold' and hold_id is not null and booking_id is null
     and expires_at is not null)
  ),
  constraint unit_claims_stay_bounds check (
    lower_inc(stay) and not upper_inc(stay) and not isempty(stay)
  ),

  -- ⬇ זו הערובה. אין אחרת.
  constraint unit_claims_no_overlap
    exclude using gist (unit_id with =, stay with &&)
);

create unique index unit_claims_booking_idx on unit_claims (booking_id)
  where booking_id is not null;
create unique index unit_claims_hold_idx on unit_claims (hold_id)
  where hold_id is not null;
create index unit_claims_expiry_idx on unit_claims (expires_at)
  where expires_at is not null;
```

**למה `daterange` ולא שתי עמודות:** `[check_in, check_out)` היא בדיוק
`daterange(check_in, check_out, '[)')`, ואופרטור `&&` הוא בדיוק
`rangesOverlap` מהחוזה. שתי הגדרות של חפיפה הן שתי הגדרות שיסתרו.

**למה טבלה ולא עמודה על `bookings`:** כי אז החזקה לא הייתה בפנים.

**איך תפוגה עובדת בלי משימת רקע** — הבעיה: `EXCLUDE` אינו יכול לשאת
תנאי `where expires_at > now()`, כי `now()` אינה immutable. אילוץ שכולל
החזקות שפג תוקפן ינעל מלאי; אילוץ שמסתמך על מטאטא ינעל מלאי ברגע
שהמטאטא ייעצר בשקט — וזה בדיוק מה ש-`holds.ts` מזהיר מפניו.

🔒 **ההכרעה: ניקוי עצל בתוך הטרנזקציה התובעת.** כל נתיב כתיבה שתובע
תאריכים מריץ, כשלב ראשון באותה טרנזקציה:

```sql
delete from public.unit_claims
 where unit_id = $1 and kind = 'hold' and expires_at <= now();
```

התוצאה: החזקה שפג תוקפה מפסיקה לחסום **ברגע שמישהו מנסה למכור את
התאריכים**, בלי תלות בשום תהליך רקע. המטאטא הלילי (§9 A-7) נשאר בשביל
היגיינה של שורות ושל דוחות, ולא בשביל נכונות. אם הוא ימות בשקט, לא ייסגר
אף לילה למכירה.

**סדר נעילה:** המחיקה נעשית לפי `unit_id` יחיד ובסדר `id` עולה, כדי ששני
מוכרים שמנקים את אותה יחידה לא ייכנסו ל-deadlock.

**מי כותב לטבלה:** רק trigger-ים על `bookings` ועל `holds`, לעולם לא קוד
היישום. `bookings` שנכנסת ל-`OCCUPYING_STATUSES` מקבלת שורת תביעה;
שיוצאת מהן — השורה נמחקת; ששינתה תאריכים או יחידה — השורה מתעדכנת.
זו הסיבה היחידה שהמצב `option` תופס יומן: הוא ב-`OCCUPYING_STATUSES`.

#### `unit_availability_rules` ו-`unit_blocks`

`UnitAvailabilityRules` ב-`availability.ts` מוזרם מ-`loadRules()` וכרגע
**אין לו מקור**. שתי טבלאות:

```sql
create table public.unit_availability_rules (
  unit_id                 uuid primary key,      -- + org/property, מפתח מורכב
  minimum_nights          integer not null default 1,
  maximum_nights          integer,
  sellable                boolean not null default true,
  metadata                jsonb not null default '{}'::jsonb
);

create table public.unit_rate_calendar (
  unit_id           uuid not null,
  night             date not null,
  nightly_agorot    integer,          -- null = מחיר הבסיס של היחידה
  minimum_nights    integer,          -- null = חוק היחידה
  no_arrival        boolean not null default false,
  no_departure      boolean not null default false,
  primary key (unit_id, night)
);
```

`unit_rate_calendar` היא המקור ל-`minimumNightsByArrival`,
`noArrivalDates` ו-`noDepartureDates`, וגם ל-`nightlyOverrides` בתמחור.
לוח אחד לתאריך ולמחיר, כי מנהל הכנסות שמגדיר "שישי בקיץ — ₪1,800 ומינימום
שתי לילות" עושה החלטה אחת ולא שתיים.

```sql
create table public.unit_blocks (
  id, organization_id, property_id, unit_id,
  stay        daterange not null,
  kind        public.block_kind not null,  -- 'maintenance'|'owner_use'|'internal_use'|'seasonal_closure'
  reason      text,
  created_by  uuid,
  constraint unit_blocks_no_overlap
    exclude using gist (unit_id with =, stay with &&) where (kind <> 'seasonal_closure')
);
```

`blockedDates` ב-`UnitAvailabilityRules` הוא ההשטחה של הטבלה הזו ללילות.
⚠️ **ההשטחה מאבדת את `kind`**, ולכן מנוע הזמינות אינו יודע להבדיל בין
תחזוקה לשימוש בעלים — ראה C-7 ו-§4.3.

#### `waitlist_entries`

| עמודה | טיפוס | הערה |
| --- | --- | --- |
| `id`, `organization_id`, `property_id` | | `property_id` **not null**; `unit_id` **nullable** — "כל יחידה בנכס" הוא המקרה השכיח |
| `unit_id`, `unit_group_id` | uuid | |
| `desired` | daterange not null | |
| `flexibility_days` | integer not null default 0 | ± ימים סביב התאריך המבוקש |
| `guest_count` | integer not null | |
| `guest_id`, `guest_name`, `guest_phone` | | |
| `max_agorot` | integer | תקרת מחיר שהאורח הצהיר עליה. null = לא הצהיר |
| `source`, `agent_user_id` | | ייחוס, כמו בהזמנה |
| `status` | `waitlist_status` enum | `waiting` · `offered` · `converted` · `expired` · `withdrawn` |
| `offered_at`, `offer_expires_at`, `offer_hold_id`, `converted_booking_id` | | |
| `position` | integer | נגזר, לא נשמר — ראה §7.7 |

RLS: כל הטבלאות לעיל נושאות `organization_id` ומקבלות
`organization_id in (select my_organizations())` **ברגע יצירתן**, בתוספת
`property_in_scope()` / `unit_in_scope()` מ-`0008`, בדיוק כמו `units`.

---

## 4. מצבים ומעברים

### 4.1 מכונת המצבים של ההזמנה

הרשימה הקנונית היא `BOOKING_STATUSES` ב-
[`types.ts`](../../src/lib/booking/types.ts) — 19 מצבים. הטבלה הקנונית של
המעברים היא `BOOKING_TRANSITIONS` ב-
[`state-machine.ts`](../../src/lib/booking/state-machine.ts). **היא ממומשת
ואין להעתיק אותה לכאן ולתת לשתי הגרסאות להיפרד.** מה שכן נקבע כאן:

**המסלול התקין:**

```
inquiry → quote → option → awaiting_payment → deposit_paid
        → contract_pending → confirmed → pre_arrival
        → ready_for_check_in → checked_in → in_house
        → checkout_pending → checked_out → inspection
        → deposit_release → review_requested → completed
```

**חמישה קיצורים מכוונים שקיימים בקוד ומחייבים:**

| קיצור | למי | התנאי |
| --- | --- | --- |
| `option` / `awaiting_payment` → `confirmed` | עסק שלא גובה מקדמה | `nothingOwedUpFront` — `depositRequiredAgorot = 0` |
| `confirmed` → `ready_for_check_in` | Walk-in שכבר עומד בדלת | — |
| `checked_in` → `checkout_pending` | שהות של לילה אחד | — |
| `in_house` → `checked_out` | יחידה עם צ׳ק-אאוט עצמי | — |
| `checked_out` → `completed` | שהות בלי פיקדון | `noDepositStillHeld` |

**שני יציאות:**

- `cancelled` — מכל מצב עד `checkout_pending` ועד בכלל. **לא** אחרי
  צ׳ק-אאוט: אז השהות קרתה, והמכשירים הנכונים הם זיכוי וחשבונית מתקנת.
- `no_show` — רק מ-`confirmed`, `pre_arrival`, `ready_for_check_in`,
  ורק כש-`localDate(now) >= checkIn`. סימון אי-הגעה לפני מועד ההגעה הוא
  טעות הקלדה, לא אירוע.

**המצבים התופסים** — `OCCUPYING_STATUSES`, עשרה מהם. 🔒 **הוספת סטטוס
לחוזה בלי להכריע אם הוא תופס היא הדרך שבה נולדת הזמנה כפולה.**

### 4.2 ⚠️ סתירה בסדר: `review_requested` מול `completed`

`BOOKING_STATUSES` מונה `completed` **לפני** `review_requested`, ובאותה
נשימה `TERMINAL_STATUSES` מכריז ש-`completed` סופי — "שום דבר לא קורה
להזמנה במצב כזה". שניהם לא יכולים להיות נכונים.

`state-machine.ts` הכריע: המערך הוא **קטלוג ולא רצף**, `TERMINAL_STATUSES`
הוא החוק, ולכן `review_requested` יושב **לפני** `completed`.

**ההמלצה:** לאמץ את ההכרעה הזו רשמית ולתקן את סדר המערך ב-`types.ts`, כך
שקורא חדש לא ילמד את הסדר הלא נכון מהמקום שנקרא ראשון. אם הכוונה הייתה
ההפוכה — שאפשר לבקש חוות דעת אחרי סגירה — אז `completed` אינו סופי, וגם
מנוע הזמינות, גם `REALISED_STATUSES` ב-`metrics/rows.ts` וגם הטבלה הזו
משתנים יחד. **אין אפשרות לשנות רק אחד מהם.**

### 4.3 מצבי הזמינות

שבעה מצבים, כפי שהמוצר מדבר עליהם:

| מצב | מקור | תופס? | מי רואה |
| --- | --- | --- | --- |
| `available` | אין דבר שחוסם | לא | כולם |
| `booked` | `bookings` בסטטוס תופס | כן | סוכן רואה "תפוס"; צוות רואה מי |
| `hold` | `holds` חיה | כן | סוכן רואה "מוחזק"; רק בעליה רואה מי |
| `blocked` | `unit_blocks` kind = `seasonal_closure` | כן | כולם |
| `maintenance` | `unit_blocks` kind = `maintenance` | כן | צוות; סוכן רואה `blocked` |
| `owner_use` | `unit_blocks` kind = `owner_use` | כן | צוות ובעלים; סוכן רואה `blocked` |
| `internal_use` | `unit_blocks` kind = `internal_use` | כן | צוות; סוכן רואה `blocked` |

⚠️ **`DayState` בקוד מכיר בארבעה בלבד** — `free | booked | held | blocked`
— והשלושה האחרונים בטבלה מתקפלים ל-`blocked`. זו לא בהכרח תקלה: כלפי חוץ
זו בדיוק ההתנהגות הרצויה. אבל **הצוות הפנימי צריך לדעת אם היחידה בשיפוץ
או שהבעלים ישן בה**, וכרגע הוא לא יכול. ראה C-7.

### 4.4 מצבי ההחזקה

`live → released` · `live → converted` · `live → expired`.
ההכרעה מתקבלת **בכל קריאה** ב-`isHoldLive(hold, now)` ולעולם לא נשמרת
כדגל. שלוש דרכים להפסיק לחסום: שוחררה, הפכה להזמנה, פג תוקפה.
🔒 ההשוואה קפדנית: החזקה שפוקעת ב-14:30:00 אינה חוסמת ב-14:30:00.

### 4.5 מצבי רשימת ההמתנה

`waiting → offered → converted` · `offered → expired → waiting`
(חוזרת לתור, פעם אחת) · `waiting|offered → withdrawn`.

---

## 5. מסכים

### 5.1 לוח הזמינות (`/calendar`)

- **מטרה:** לראות חודש, לתפוס עכבר על שלושה לילות פנויים ולהתחיל מכירה.
- **תפקידים:** קבלה, מנהל הזמנות, מנהל נכס, מנהל הכנסות. סוכן רואה גרסה
  מצומצמת (5.2).
- **הרשאות:** `availability.view` למינימום; `booking.view` להצגת שם אורח;
  `booking.view_price` להצגת סכום.
- **פריסה:** ציר אנכי = יחידות מקובצות לפי נכס; ציר אופקי = ימים.
  תא = לילה. שהות מוצגת כרצועה רציפה שמתחילה בחצי התא של ההגעה ומסתיימת
  בחצי התא של העזיבה — 🔒 **זו התצוגה היחידה שמראה נכון גיחת יום** ותצוגה
  של תא מלא ממציאה התנגשות שאינה קיימת.
- **שדות בתא:** שם אורח (אם מורשה), מספר אורחים, אייקון מקור, סימן
  "לא שולם".
- **פעולות:** גרירה על תאים פנויים → הזמנה חדשה · גרירת קצה רצועה →
  שינוי תאריכים · לחיצה ימנית על תא פנוי → חסימה / החזקה · לחיצה על רצועה
  → מגירת ההזמנה.
- **מצבים:** טעינה = שלד של הרשת, לא ספינר על מסך ריק. ריק = "אין יחידות
  פעילות בנכס הזה" עם קישור להוספת יחידה. שגיאה = הרשת נשארת עם החודש
  הקודם ופס אדום "לא הצלחנו לרענן את הזמינות, מוצג מצב מלפני X דקות".
  🔒 **לעולם לא רשת ריקה בשגיאה** — רשת ריקה נראית כמו חודש פנוי.
- **מובייל:** ציר מתהפך — יחידה אחת, גלילה אנכית בימים. גרירה מוחלפת
  בבחירת "מ־" ו"עד" בשתי הקשות.
- **מה מתועד:** צפייה לא מתועדת. כל פעולה שיוצאת מהמסך מתועדת בפעולה שלה.

### 5.2 לוח הזמינות של סוכן (`/agent/calendar`)

זהה בפריסה, **שונה בנתונים**: `DayAvailability` בלבד. אין שם, אין סכום,
אין מזהה הזמנה, אין מקור. 🔒 מסך זה נבנה מ-`availabilityCalendar()`
ולעולם לא מ-`loadBookings()` עם סינון בממשק.

### 5.3 אשף הזמנה חדשה (`/bookings/new`)

ארבעה צעדים, ובכוונה **לא** טופס אחד ארוך:

1. **מתי ומה** — נכס → יחידה → תאריכים → אורחים. בדיקת זמינות רצה בכל
   שינוי, עם debounce של 300ms, ומציגה את **כל** ה-`blockers` יחד.
2. **מי** — חיפוש אורח לפי טלפון לפני יצירה. אם נמצא — מוצג "אורח חוזר,
   3 שהויות קודמות".
3. **כמה** — פירוט השורות מ-`priceStay`, לילה-לילה, עם סך הכול.
   הנחה ידנית פותחת שדה **נימוק חובה**.
4. **איך ממשיכים** — סטטוס פתיחה (`inquiry` / `option` / `awaiting_payment`),
   ובחירה בשליחת קישור תשלום או חוזה.

- **הרשאות:** `booking.create` + `guest.create`; הנחה ידנית דורשת
  `booking.override_price`; עקיפת זמינות דורשת `booking.override_availability`.
- **מצב שגיאה:** התנגשות תאריכים אינה מאפסת את הטופס. היא מציגה את
  ההתנגשות ומציעה שלוש חלופות (§7.8).
- **מה מתועד:** `booking.create` עם המשפט המלא (§14).

### 5.4 מסך ההזמנה (`/bookings/[id]`)

- **פריסה:** כותרת (מספר, סטטוס, אורח, תאריכים, סכום) · טאבים: פרטים ·
  כספים · תקשורת · משימות · **ציר זמן**.
- **פעולות:** הכפתורים נבנים מ-`legalNextStatuses(actor, context)` ולא
  מהשוואת סטטוס בממשק. 🔒 זו הסיבה שהפונקציה קיימת: מסך שמחשב לעצמו אילו
  כפתורים להציג יציג כפתור שהשרת יסרב לו.
- **ציר הזמן:** `booking_status_history` + `audit_events`, במשפטים
  בעברית, בסדר יורד.
- **מובייל:** הכותרת דביקה, הטאבים הופכים ל-accordion, הפעולה הראשית
  (הצעד הבא במסלול) יושבת בסרגל תחתון קבוע.

### 5.5 מסך שינוי (`/bookings/[id]/amend`)

מסך אחד לכל השינויים, ו**תצוגה מקדימה חובה לפני שמירה**:

> משנה תאריכים מ-3.9–6.9 ל-5.9–8.9 · 3 לילות · **המחיר משתנה מ-₪4,200
> ל-₪4,800 (+₪600)** · הניקיון שתוכנן ל-6.9 יוזז ל-8.9 · האורח יקבל
> הודעה · **התאריכים החדשים פנויים**

🔒 **תצוגה מקדימה שמחשבת מחדש הכול היא המנגנון שמונע את "לא ידעתי שזה
ישנה את המחיר"**. ראה §17 H-4.

### 5.6 מסך החזקות (`/holds`)

טבלה: יחידה · תאריכים · סיבה · מי מחזיק · **פוקע בעוד** (טיימר חי) ·
פעולות. ברירת המחדל היא החזקות חיות בלבד. סוכן רואה את שלו; מנהל רואה
את כולן ויכול לשחרר. שחרור חייב נימוק אם אינו שחרור עצמי.

### 5.7 מסך ביטול (`/bookings/[id]/cancel`)

- **מציג לפני ולא אחרי:** דמי הביטול המחושבים, הסכום שיוחזר, ומה שנשאר
  אצל העסק — לפי `cancellation_policy_snapshot` ולא לפי המדיניות הנוכחית.
- **נימוק חובה** (`requiresReason: true` בפעולה).
- **ויתור על דמי ביטול** הוא מתג נפרד שדורש `booking.override_price`.
- **כפתור הביטול אדום ודורש הקלדת מספר ההזמנה.** ראה §17 H-6.

### 5.8 רשימת המתנה (`/waitlist`)

טבלה עם מיון לפי תור, כפתור "הצע עכשיו" ידני, ותצוגת "מה נפתח היום"
שמצליבה שחרורי תאריכים מול הרשומות הממתינות.

---

## 6. חוקים עסקיים

מסומנים `B-n`. כל אחד ניתן לבדיקה.

### זמינות ותפיסה

- **B-1** — טווח שהות הוא חצי-פתוח `[check_in, check_out)`. יום העזיבה
  אינו תפוס. כל בדיקת חפיפה במערכת עוברת דרך `rangesOverlap` ואף לא אחת
  מממשת השוואה משלה. 🔒
- **B-2** — 🔒 **מניעת הזמנה כפולה היא אילוץ ההדרה על `unit_claims`
  ותו לא.** `checkAvailability()` הוא תשובה מהירה, לא ערובה. שום נתיב
  כתיבה אינו רשאי להתייחס ל-`available: true` כרישיון לדלג על הכתיבה
  המאולצת.
- **B-3** — 🔒 `property_id` של הזמנה ושל החזקה **נגזר מ-`units`** בשאילתה
  ואינו מתקבל מהקלט. הקלט רשאי לספק אותו רק כאישור, וערך שאינו תואם הוא
  שגיאת ולידציה — לא תיקון שקט.
- **B-4** — יחידה שאינה `status = 'active'` אינה נמכרת. היא **כן** ממשיכה
  לחסום את התאריכים של הזמנות שכבר נמכרו בה.
- **B-5** — `guest_count` חייב `<= units.max_guests`. נאכף ביצירה,
  **ובכל שינוי של מספר אורחים ובכל העברת יחידה.**
- **B-6** — מינימום לילות נאכף ביצירה, בשינוי תאריכים ובהעברת יחידה.
  המקור הוא `minimumNightsFor(rules, checkIn)`: חוק העונה לתאריך ההגעה
  גובר על חוק היחידה, והרצפה היא 1.
- **B-7** — מקסימום לילות (`units.max_nights`) נאכף באותם שלושה מקומות.
- **B-8** — `no_arrival` נבדק מול `check_in` בלבד; `no_departure` מול
  `check_out` בלבד; `blocked` נבדק מול **הלילות** ולא מול יום העזיבה.
- **B-9** — עקיפת זמינות דורשת `booking.override_availability` **ונימוק**.
  היא עוקפת חוקי מינימום, חסימות ותאריכי הגעה — ו🔒 **לעולם אינה עוקפת
  את אילוץ ההדרה.** עקיפה על תאריכים תפוסים באמת נכשלת במסד, כמו שצריך.
- **B-10** — הזמנה במצב שאינו תופס (`inquiry`, `quote`) מותר ליצור ולהזיז
  על תאריכים מכורים. זה בדיוק מה שעסק רוצה: לרשום את הליד ולהציע חלופה.
- **B-11** — ⚠️ **מעבר של הזמנה ממצב לא-תופס למצב תופס חייב לבדוק זמינות.**
  היום `changeBookingStatus` אינו בודק כלום. ראה C-2 — זו החור החמור ביותר
  שנמצא.

### החזקות

- **B-12** — 🔒 החזקה בלי `expires_at` אינה ניתנת לייצוג. לא בטיפוס, לא
  בטבלה.
- **B-13** — משך ההחזקה נבדק מול `HOLD_POLICY[reason].maxMinutes`:
  `agent_quote` 120 · `guest_checkout` 30 · `staff_manual` 1440 ·
  `maintenance_block` 43,200. חסימה ארוכה יותר היא `unit_blocks`, לא החזקה.
- **B-14** — מספר ההחזקות החיות של אדם נבדק מול
  `HOLD_POLICY[reason].maxConcurrent` **לפני** הכתיבה.
  ⚠️ **לא ממומש** — ראה C-3.
- **B-15** — הרחבת החזקה נמדדת מ-`now`, לא מהיצירה, ולכן אינה יכולה
  להאריך מעבר לחלון המדיניות ברגע נתון. ⚠️ תקרת חיים כוללת ותקרת מספר
  הארכות דורשות `created_at` ו-`extension_count` — ראה C-4.
- **B-16** — החזקה שפג תוקפה **אינה מוחייה**. התאריכים חזרו למכירה
  ואולי נמכרו.
- **B-17** — המרת החזקה להזמנה מחייבת שלושה תנאים, כולם ב-
  `loadHoldForConversion`: אותו ארגון, אותה יחידה, חיה, **ומכסה את כל
  טווח ההזמנה** (`assertHoldCovers`). בלי האחרון סוכן מחזיק שני לילות
  זולים והופך אותם לשבועיים.
- **B-18** — המרה מוחקת את התביעה של ההחזקה ויוצרת את זו של ההזמנה
  **באותה טרנזקציה**. החזקה שנשארה חיה תתנגש עם ההזמנה שהיא עצמה יצרה.
- **B-19** — שחרור החזקה שפג תוקפה מותר (זה ניקיון). שחרור החזקה שכבר
  שוחררה או שכבר הומרה — נכשל.

### שינויים

- **B-20** — 🔒 **חוק הבדיקה החוזרת.** כל שינוי מריץ מחדש את כל שבע
  הבדיקות בטבלה של §6.1. אין שינוי "קטן". הבדיקה נגזרת מסוג השינוי
  בטבלה, ולא מהחלטה של מי שקורא לפעולה.
- **B-21** — שינוי תאריכים מתעלם מההזמנה עצמה (`ignoreBookingId`).
  בלעדיו כל הזזה ביום אחד מתנגשת עם עצמה.
- **B-22** — אחרי צ׳ק-אין, `check_in` נעול. רק `check_out` זז, **וקדימה
  בלבד** — זו הארכה. קיצור שהות הוא צ׳ק-אאוט מוקדם, שהוא מעבר סטטוס ולא
  שינוי תאריך.
- **B-23** — אחרי צ׳ק-אאוט התאריכים נעולים לגמרי. תיקון היסטוריה נעשה
  בזיכוי.
- **B-24** — העברת יחידה = שחרור התביעה הישנה ותפיסת החדשה, בטרנזקציה
  אחת. **הצלחה חלקית אינה אפשרית** — ראה E-19.
- **B-25** — שינוי מספר אורחים כלפי מעלה אחרי שהניקיון התחיל מייצר
  **משימת השלמה** ולא מבטל את הקיימת. ראה E-21.
- **B-26** — כל שינוי מייצר `booking.changed` עם `before` ו-`after`
  מלאים. מנוע ההכנה, הצוות והתמחור מגיבים לאירוע ולא נקראים ישירות.

### ביטול

- **B-27** — ביטול דורש נימוק. תמיד. ללא יוצא מן הכלל וללא הרשאה שעוקפת.
- **B-28** — דמי הביטול מחושבים מ-`cancellation_policy_snapshot`
  שנשמר ברגע ההתחייבות, ולא מהמדיניות הנוכחית של הנכס. 🔒
- **B-29** — ויתור על דמי ביטול הוא ויתור על כסף, ולכן דורש
  `booking.override_price` — לא `booking.cancel`.
- **B-30** — ביטול משחרר את התאריכים **מיד**, כולל את התביעה, כולל
  החזקות קשורות.
- **B-31** — `no_show` אינו ביטול. הוא משחרר את התאריכים ומחייב לפי
  מדיניות אי-הגעה, שהיא שדה נפרד במדיניות.
- **B-32** — ביטול של הזמנה ששולמה **אינו** מבצע החזר. הוא מייצר
  `booking.cancelled` עם סכום ההחזר המחושב; ההחזר בפועל הוא `payment.refund`,
  פעולה רגישה בזכות עצמה. 🔒 **הפרדה זו היא מה שמונע החזר אוטומטי לפי
  לחיצה אחת.**

### רשימת המתנה

- **B-33** — רשומת המתנה נוצרת רק כשהזמינות נכשלה בפועל. אינה נוצרת
  לתאריכים פנויים.
- **B-34** — שחרור תאריכים (ביטול, אי-הגעה, פקיעת החזקה, הסרת חסימה)
  מפעיל התאמה מול הרשימה.
- **B-35** — ההצעה **סדרתית** ולא שידור: הראשון בתור מקבל חלון בלעדי.
  שידור לכולם מייצר מרוץ שבו חמישה אורחים מכניסים כרטיס ואחד מקבל את
  הלילות. ❓ החלון עצמו — ראה Q-6.
- **B-36** — הצעה תופסת את התאריכים בהחזקה `staff_manual` לאורך החלון.
  **הצעה בלי החזקה אינה הצעה** — היא הזמנה למרוץ.
- **B-37** — הצעה שפגה מחזירה את הרשומה לתור פעם אחת, ואז `expired`.

---

### 6.1 🔒 מטריצת הבדיקה החוזרת

השורה היא סוג השינוי; העמודה היא הבדיקה. `●` = חובה, `○` = רק אם השדה
הרלוונטי השתנה בפועל.

| שינוי | זמינות | מחיר | הכנה | מלאי | צוות | עלות | התראה |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| תאריכים | ● | ● | ● | ● | ● | ● | ● |
| מספר אורחים | ● | ● | ● | ● | ● | ● | ● |
| יחידה | ● | ● | ● | ● | ● | ● | ● |
| נכס | ● | ● | ● | ● | ● | ● | ● |
| תוספות | ○ | ● | ● | ● | ● | ● | ● |
| מחיר / הנחה | — | ● | — | — | — | ● | ● |
| תוכנית תעריף | — | ● | ○ | ○ | — | ● | ● |
| סוכן / מקור | — | ○ | — | — | — | ● | ● |
| סוג אירוע | — | ● | ● | ● | ● | ● | ● |

**"זמינות" ב"תוספות" הוא `○` ולא `—`** כי תוספת יכולה להיות מיטה נוספת
שמעלה את מספר האורחים מעל הקיבולת, ותוספת יכולה להיות "צ׳ק-אאוט מאוחר"
שמזיז את הרגע שבו היחידה חוזרת למכירה.

**"עלות" תמיד `●` היכן שיש `●` בהכנה**, כי מנוע ההכנה
(`src/lib/preparation/`) מחשב גם כמות וגם עלות מאותן עובדות, ומי שמעדכן
אחת בלי השנייה מקבל רווחיות שקרית.

החוק: **הבדיקה החוזרת מיושמת כמנוי אחד לאירוע `booking.changed`**,
לא כרשימת קריאות שכל פעולה זוכרת לבצע. פעולה שתיווסף בשנה הבאה מקבלת
את הבדיקה בחינם; פעולה ששכחה לקרוא לרשימה היא באג שקט.

---

## 7. חישובים

### 7.1 סך ההזמנה

```
total_agorot = Σ line.amount   (על פני כל שורות ה-PriceLine)
```

🔒 **הסך הוא הסכום של השורות, לא מספר שמישהו הקליד לצידן.**
`sumLines()` הוא הדרך היחידה. השורות שליליות בהנחות, ולכן הסכימה תמיד
חיבור פשוט. trigger במסד אוכף `total_agorot = sum` בכל כתיבה — אחרת שתי
עמודות מספרות שני סיפורים.

### 7.2 עיגול

`roundAgorot(v) = sign(v) × round(|v|)` — **חצי מתרחק מאפס, על הערך
המוחלט**, פעם אחת, ברגע יצירת השורה.

- לא Banker's rounding: החשבון של האורח נבדק במחשבון, והמחשבון מעגל
  ₪0.005 למעלה.
- על הערך המוחלט ולא על הערך החתום: `Math.round(-50.5) = -50` — הנחה של
  חצי אגורה הייתה נגזמת בעוד שעמלה באותו גודל הייתה מתעגלת למעלה. הבית
  מנצח בשני הצדדים.
- פעם אחת: כל אחוז מחושב על סכום של שורות שכבר שלמות. **אין עיגול של
  ערך מעוגל.**

מכנה אפס: כל חלוקה במודול הזה עוברת דרך `safeDivide` ב-
`src/lib/metrics/rounding.ts` ומחזירה `null` ולא `0`. `nightsBetween`
מחזיר `NaN` לטווח לא חוקי ו-**לא** `0`.

### 7.3 סדר בניית ההצעה

בדיוק כפי ש-`priceStay()` מבצע:

1. **לינה** — שורה אחת לכל לילה מ-`eachNight(range)`:
   `nightlyOverrides[night] ?? baseNightlyAgorot`.
   🔒 שורה ללילה ולא סכום שמתפצל — לוח עם ארבעים מחירים שונים מסתכם
   בדיוק, והאורח רואה איזה לילה היה היקר.
2. **אורח נוסף** — `max(0, guests - includedGuests) × extraRate × nights`.
   שורה אחת מסוכמת, כמות = אורחים-נוספים × לילות.
3. **קבועים** — `cleaning_fee`, ואז כל `addon`:
   `unitPrice × quantity`. תוספת בכמות 0 או במחיר 0 אינה מייצרת שורה.
4. **הנחות** — כולן מול **אותו** סכום טרום-הנחה:
   `round(discountable × pct / 100)`. 🔒 שתי הנחות של 10% מורידות 20%
   ולא 19% — סדר הערמה אינו רשאי לשנות את המחיר שהאורח קיבל.
   ההנחה נחתכת ל-`[0, remaining]`: הנחה מביאה לאפס ולעולם לא מתחת.
5. **מע״מ** — על הסכום **אחרי** ההנחה: `round(taxable × rate / 100)`.
   מיסוי לפני הנחה גובה מע״מ על כסף שאיש לא שילם.
6. **פיקדון** — אחרון, ו**מחוץ לבסיס המס**. פיקדון אינו אספקה של דבר,
   הוא כסף של האורח שמוחזק.

```
stay_total_agorot = total_agorot − deposit_agorot
```

**מע״מ במחיר כלול:** `properties.tax_included_in_price = true` פירושו
שהתעריפים כבר מכילים מס. במקרה הזה `taxRatePercent` **אינו** מועבר
ל-`priceStay`, ותצוגת "מתוכם מע״מ" מחושבת ב-
`taxIncludedIn(total, rate) = round(total − total / (1 + rate/100))`.
🔒 זו מחרוזת תצוגה ולא `PriceLine` — שורה כזו הייתה מכפילה את המס או
שוברת את הסכימה, ושתיהן גרועות ממחרוזת.

**פטור תיירים:** `properties.tourist_vat_exempt` נשמר בהזמנה כ-
`tourist_vat_applied`. ❓ Q-9 — מה הראיה הנדרשת ומי מאשר אותה.

### 7.4 עמלת סוכן

```
commission = roundAgorot(stay_total_agorot × percent / 100)
```

🔒 **אינה נכנסת לסך של האורח, לעולם.** העסק משלם אותה מתוך מה שהאורח
שילם. היא מחושבת על הסך **ללא הפיקדון** — אין עמלה על כסף שחוזר.
`agentCommissionLine()` מחזיר אותה בנפרד ואינו נוגע בהצעה.

### 7.5 מקדמה ופיקדון

- `deposit_required_agorot` — מה שהעסק ביקש מראש.
- `deposit_held_agorot` — מה שהוא מחזיק **עכשיו**.
- `completed` דורש `deposit_held_agorot = 0`. הזמנה אינה נסגרת בזמן
  שהעסק מחזיק כסף של האורח.
- `deposit_release` דורש `deposit_held_agorot > 0` **ורק אחרי `inspection`**.
  החזרת פיקדון לפני שמישהו הסתכל על היחידה היא עסק שמשלם על הנזק של עצמו.

❓ Q-2 — גובה המקדמה כאחוז מהשהות, וגובה הפיקדון.

### 7.6 דמי ביטול

`properties.cancellation_policy` היא jsonb. **הסכימה נקבעת כאן** (הפרט
הטכני), **המספרים הם של בעל המוצר** (הפרט העסקי — ❓ Q-1):

```jsonc
{
  "version": 1,
  "tiers": [
    { "days_before": 30, "refund_bps": 10000, "fee_agorot": 0 },
    { "days_before": 14, "refund_bps": 5000,  "fee_agorot": 0 },
    { "days_before": 0,  "refund_bps": 0,     "fee_agorot": 0 }
  ],
  "no_show_refund_bps": 0,
  "deposit_refundable": true,
  "non_refundable": false
}
```

החישוב:

```
days_before = מספר הימים בין localDate(cancelled_at) לבין check_in
              (שלילי אם ההגעה עברה)
tier        = הרובד הראשון שבו days_before >= tier.days_before,
              במיון יורד; אם אין — הרובד האחרון
refundable  = stay_total_agorot  (+ deposit_agorot אם deposit_refundable)
refund      = roundAgorot(refundable × tier.refund_bps / 10000) − tier.fee_agorot
refund      = clamp(refund, 0, paid_agorot)
fee         = paid_agorot − refund
```

- **bps ולא אחוזים** — כמו `properties.tax_rate_bps`. שיעור שנשמר כ-0.5
  בנקודה צפה מייצר בסוף חשבונית שלא מסתכמת.
- **`clamp` מול `paid_agorot`** — אי אפשר להחזיר יותר משהתקבל. הזמנה
  שלא שולמה מקבלת `refund = 0` ו-`fee = 0`, וחוב שנשאר אינו "החזר שלילי"
  אלא **חיוב** שמנוע התשלומים מטפל בו.
- `non_refundable: true` עוקף את הרבדים: `refund = 0`.
- **ויתור:** `waiveCancellationFee` מאפס את `fee` ומחזיר את המלוא, במגבלת
  `paid_agorot`.

### 7.7 מיקום ברשימת ההמתנה

```
position = מספר הרשומות באותו (property_id, unit scope) בסטטוס
           waiting|offered שנוצרו לפני הרשומה הזו + 1
```

נגזר בשאילתה ולא נשמר. עמודה שמורה למיקום היא עמודה שצריך לעדכן בכל
משיכה, ותור שנרשם בשני מקומות הוא תור ששני אנשים חושבים שהם ראשונים בו.

**התאמה:** רשומה תואמת לשחרור אם `desired && freed_range` **ו**
`guest_count <= units.max_guests` **ו** (`max_agorot` הוא null או
`>= stay_total` של ההצעה) **ו** התאריכים החדשים עוברים `checkAvailability`.
`flexibility_days` מרחיב את `desired` לפני בדיקת החפיפה.

### 7.8 חלופות אחרי כישלון זמינות

כשההזמנה נדחתה, המערכת מציעה שלוש חלופות, בסדר הזה:
(א) אותה יחידה בתאריכים הקרובים ביותר הפנויים · (ב) יחידה אחרת באותו נכס
באותם תאריכים, בקיבולת מספקת · (ג) הצטרפות לרשימת ההמתנה.
המרחק בחלופה (א) הוא במספר לילות הזזה, והמינימלי מנצח; שוויון נשבר
לטובת ההזזה קדימה.

---

## 8. ולידציות

| שדה | חובה | טווח / פורמט | ההודעה שהמשתמש רואה |
| --- | :-: | --- | --- |
| `unitId` | כן | uuid קיים, `status = 'active'`, בטווח השחקן | `היחידה אינה זמינה למכירה. בדוק את הגדרות היחידה.` |
| `propertyId` | כן¹ | חייב להיות הנכס של היחידה | `היחידה הזו אינה שייכת לנכס שנבחר.` |
| `checkIn` | כן | `YYYY-MM-DD`, תאריך קיים בלוח | `תאריך חייב להיות בפורמט YYYY-MM-DD.` / `התאריך אינו קיים בלוח השנה.` |
| `checkOut` | כן | `> checkIn` | `תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.` |
| טווח | — | `nights <= max_nights` | `שהות מרבית ביחידה זו היא N לילות.` |
| טווח | — | `nights >= minimum` | `שהות מינימלית בתאריכים אלה היא N לילות, והבקשה היא ל-M.` |
| `guestName` | כן | 2–120 תווים | `שם האורח חייב להכיל לפחות שני תווים.` |
| `guestCount` | כן | שלם, 1–50, `<= max_guests` | `חייב להיות לפחות אורח אחד בהזמנה.` / `היחידה מאכלסת עד N אורחים.` |
| `guestPhone` | כן² | E.164 אחרי נרמול | `מספר טלפון אינו תקין. לדוגמה: 050-1234567` |
| `source` | כן | מ-`BOOKING_SOURCES` | `מקור ההזמנה אינו מוכר.` |
| `status` (ביצירה) | לא | מ-`INITIAL_STATUSES` | `לא ניתן לפתוח הזמנה במצב הזה.` |
| `baseNightlyAgorot` | כן | שלם `>= 0` | `מחיר ללילה חייב להיות מספר שלם של אגורות, ולא שלילי.` |
| `discountPercent` | לא | 0–100 | `הנחה חייבת להיות בין 0 ל-100 אחוזים.` |
| `manualDiscountAgorot` | לא | שלם `>= 0` + נימוק | `הנחה ידנית דורשת נימוק. הסבר בקצרה מדוע היא ניתנת.` |
| `addons[]` | לא | עד 20, כמות 1–99 | `ניתן להוסיף עד 20 תוספות להזמנה.` |
| `taxRatePercent` | לא | 0–100 | `שיעור המע״מ חייב להיות בין 0 ל-100.` |
| `reason` | תלוי | לא ריק אחרי `trim` | `הפעולה הזו דורשת נימוק. הסבר בקצרה מדוע היא מבוצעת.` |
| `expectedVersion` | כן³ | שלם | `לא ידוע איזו גרסה של הרשומה נערכה. רענן את הדף ונסה שוב.` |
| `minutes` (החזקה) | לא | 1–43,200, `<= maxMinutes` | `משך ההחזקה המרבי הוא N דקות. לחסימה ארוכה יותר השתמש בחסימת יחידה.` |
| `reason` (החזקה) | כן | מ-`HOLD_REASONS` | `סיבת ההחזקה אינה מוכרת.` |

¹ ⚠️ היום `propertyId` אופציונלי בסכימת הקלט. ראה C-5.
² מרגע `option` ומעלה. פנייה יכולה להיות בלי טלפון.
³ בכל פעולה עם `requiresVersion: true`.

🔒 **כל הבעיות מדווחות יחד.** `ValidationError` נושא מערך `FieldIssue`,
והמנגנון קיים: הצינור אוסף קלט, נימוק וגרסה לרשימה אחת לפני שהוא זורק.
טופס שחושף את הבעיות שלו אחת-אחת הוא טופס שממלאים ארבע פעמים.

---

## 9. אוטומציות והתראות

התבנית היא **טריגר → תנאי → פעולה**. הטריגר הוא תמיד אירוע דומיין,
לעולם לא קריאה ישירה מהפעולה.

| # | טריגר | תנאי | פעולה | למי | ערוץ |
| --- | --- | --- | --- | --- | --- |
| A-1 | `booking.created` | `status = 'awaiting_payment'` | קישור תשלום | אורח | WhatsApp + מייל |
| A-2 | `booking.optioned` | תמיד | "התאריכים שמורים עד HH:MM" | אורח + סוכן | WhatsApp |
| A-3 | `booking.confirmed` | תמיד | אישור הזמנה + פרטי הגעה | אורח | מייל |
| A-4 | `booking.confirmed` | `agent_user_id` קיים | "העסקה נסגרה, עמלה ₪X" | סוכן | התראה בתוך המוצר |
| A-5 | תזמון יומי | `check_in - 3 ימים`, סטטוס `confirmed` | מעבר ל-`pre_arrival` + הודעת טרום-הגעה | אורח | WhatsApp |
| A-6 | תזמון יומי | `check_in = היום`, `ready_for_check_in` לא הושג עד 12:00 | "היחידה עדיין לא מוכנה" | משק בית | התראה |
| A-7 | תזמון כל 5 דקות | `holds.expires_at <= now()` | מחיקת שורות תביעה + `hold.expired` | מחזיק ההחזקה | התראה בתוך המוצר |
| A-8 | `hold.created` | `reason = 'agent_quote'` | טיימר במסך + התראה 5 דקות לפני הפקיעה | הסוכן | התראה |
| A-9 | `booking.cancelled` | תמיד | התאמה מול `waitlist_entries` | — | פנימי |
| A-10 | `booking.cancelled` | `paid_agorot > 0` | **בקשת החזר**, לא החזר | מנהל כספים | משימה |
| A-11 | `hold.expired` / `unit_block.removed` | תאריכים התפנו | התאמה מול הרשימה | — | פנימי |
| A-12 | `waitlist.matched` | קיים מועמד ראשון | החזקה + הצעה | האורח הממתין | WhatsApp |
| A-13 | `booking.dates_amended` | תמיד | עדכון משימות הכנה וניקיון + הודעה | אורח + צוות | מייל + התראה |
| A-14 | `booking.checked_out` | תמיד | פתיחת ניקיון ובדיקה | משק בית | משימה |
| A-15 | `booking.deposit_released` | תמיד | "הפיקדון שוחרר" | אורח | מייל |
| A-16 | תזמון | `checked_out + 24h` | בקשת חוות דעת | אורח | מייל |
| A-17 | `booking.no_show` | תמיד | חיוב לפי מדיניות + שחרור התאריכים | מנהל כספים | משימה |
| A-18 | תזמון | `awaiting_payment` מעל N שעות | תזכורת, ואז שחרור אוטומטי | אורח, ואז מוכר | WhatsApp |

**כשל משלוח:** אירועי דומיין מתפרסמים **אחרי** ה-commit, ו-
`operation.ts` תופס כשל, מדווח דרך `onEventError` ו**לעולם לא זורק**.
מייל אישור שנכשל אינו רשאי לבטל את ההזמנה שהוא אישר.
🔒 המשמעות: **כל התראה חייבת להיות ניתנת לשליחה חוזרת ידנית מהמסך.**
תור עם ניסיונות חוזרים (3 ניסיונות, backoff מעריכי) ואז שורה ב"התראות
שנכשלו" שמנהל רואה. התראה שנעלמה בשקט היא אישור שאיש אינו יודע שלא נשלח.

**A-18 הוא היחיד שמשחרר מלאי אוטומטית**, ולכן הוא היחיד שדורש אישור
מפורש בהגדרות. ❓ Q-4.

---

## 10. מקביליות ו-Idempotency

### 10.1 שלוש שכבות, ולכל אחת תפקיד אחר

| שכבה | מפני מה מגנה | איפה |
| --- | --- | --- |
| נעילה אופטימית (`version`) | שני עובדים שעורכים את **אותה** הזמנה | `operation.ts` שלב 6 + `WHERE version = $n` ב-`updateBooking` |
| אילוץ הדרה (`unit_claims`) | שני אנשים שמוכרים את **אותם תאריכים** | המסד. 🔒 **הערובה** |
| מפתח Idempotency | **אותה בקשה** שנשלחה פעמיים | `operation.ts` שלב 3 |

🔒 **שלושתן נחוצות ואף אחת אינה מחליפה את השנייה.** גרסה לא מגלה שני
אנשים שהזמינו שתי הזמנות שונות באותה יחידה. אילוץ הדרה לא מגלה שני אנשים
שערכו את אותה הזמנה. מפתח Idempotency לא מגלה אף אחד מהם.

### 10.2 נעילה אופטימית

הבדיקה נעשית פעמיים בכוונה: בזיכרון בצינור (שלב 6, לפני שהחוק העסקי רץ
— חוק שנבדק מול רשומה שכבר השתנתה לא הוכיח דבר), **ושוב** בתוך ה-`WHERE`
של ה-`UPDATE`. הראשונה נותנת הודעה טובה; השנייה היא זו שנכונה.

כל פעולה שמעדכנת הזמנה נושאת `requiresVersion: true`. פעולות יצירה לא —
אין גרסה למשהו שעדיין לא קיים.

### 10.3 איפה אילוץ המסד הוא היחיד שנשאר

- `booking.create` על סטטוס תופס
- `booking.change_status` שנכנס ל-`OCCUPYING_STATUSES`
- `booking.amend_dates`, `booking.change_unit`
- `hold.create`
- המרת החזקה להזמנה

בכל אחת מהן `checkAvailability` רץ קודם ומחזיר תשובה טובה למשתמש,
ואז הכתיבה רצה מול האילוץ. 🔒 **כישלון האילוץ הוא תוצאה תקינה, לא
תקלה** — הוא נתפס והופך ל-`ConflictError` בעברית.

⚠️ `assertAvailable` זורק היום `ConflictError` שהקוד היציב שלו הוא
`version_conflict` גם כשמדובר בהתנגשות תאריכים. ראה C-8.

### 10.4 מפתחות Idempotency — חובה, לא המלצה

| פעולה | מפתח נדרש? | למה |
| --- | :-: | --- |
| `booking.create` מהאתר | **כן** | כפתור כפול = שתי הזמנות לאותו אורח |
| `booking.create` מייבוא ערוץ | **כן** | webhook נשלח שוב זה נורמלי |
| `booking.create` ידני | מומלץ | פקידה לוחצת פעמיים כשהרשת איטית |
| `hold.create` | **כן** | שתי החזקות מקבילות שורפות את המכסה |
| `payment.*` | **כן** | לא המודול הזה, נאמר לשלמות |
| שינוי סטטוס | לא | `version` כבר מונע חזרה |
| ביטול | **כן** | ביטול כפול = שני חישובי דמי ביטול |

הצינור שומר את המפתח **לפני** העבודה ולא אחריה, מזהה `replayed`,
`in_flight` ו-`payload_mismatch`, ומשחרר את המפתח בכישלון כדי שהניסיון
החוזר שאמרנו למשתמש לבצע אכן יוכל להתבצע.

### 10.5 סדר נעילה

כל טרנזקציה שנוגעת ביותר מיחידה אחת (העברת יחידה, ביטול קבוצתי) נועלת
לפי `unit_id` **בסדר עולה**. שתי העברות הופכיות באותו רגע ייכנסו אחרת
ל-deadlock, וההודעה שמשתמש יראה תהיה שגיאת מסד ולא הסבר.

---

## 11. אינטגרציות

| ספק | מה נקרא | מה נכתב | בתקלה | איך מתאזנים |
| --- | --- | --- | --- | --- |
| **Airbnb / Booking.com / VRBO** (ערוצים) | הזמנות חדשות, שינויים, ביטולים | זמינות ומחירים החוצה | **סוגרים החוצה, לא נכנסה** — עדיף מלאי שלא נמכר מאשר overbooking | סנכרון מלא כל 15 דקות; דוח סתירות למנהל |
| **סליקה** | סטטוס תשלום (webhook) | בקשות חיוב, החזרים | ההזמנה נשארת `awaiting_payment`, התזכורת רצה | התאמת webhook מול הזמנות פתוחות פעם בשעה |
| **WhatsApp / מייל** | — | התראות | תור עם 3 ניסיונות, אז "נכשל" גלוי | שליחה ידנית חוזרת מהמסך |
| **מנוע חוזים** | סטטוס חתימה | בקשת חתימה | `contract_pending` נשאר, תזכורת | — |

**חוק ייבוא הערוץ:** 🔒 הזמנת OTA מיובאת **תמיד** כ-`confirmed`, עם
`channel_reservation_id` ייחודי לכל `(organization_id, source)`. ניסיון
שני עם אותו מזהה הוא עדכון, לא הזמנה שנייה — נאכף באינדקס ייחודי, לא
בבדיקה בקוד.

**כשההזמנה המיובאת מתנגשת עם הזמנה קיימת:** ראה E-14. בקצרה — היא
**אינה** נדחית ואינה דורסת. היא נשמרת עם `status = 'confirmed'` ובלי
שורת תביעה, מסומנת כ-`conflict`, ומייצרת אירוע חמור למנהל. ⚠️ זו החלטה
עם השלכה: היא מאפשרת overbooking מודע כדי לא לאבד הזמנה שה-OTA כבר אישר
לאורח. ❓ Q-8.

---

## 12. AI

**מה ה-AI עושה כאן:**

- עונה על "מה פנוי בסופ״ש הקרוב לשישה אנשים" — קורא `checkAvailability`
  ו-`availabilityCalendar`.
- מציע חלופות אחרי כישלון זמינות, לפי §7.8.
- מנסח טיוטת הצעת מחיר מתוך `priceStay` — **לעולם לא ממציא מחיר**.
- מסכם ציר זמן של הזמנה לפסקה.
- מזהה בקשות שינוי בהודעת אורח ומציע את הפעולה, **בלי לבצע**.

**על אילו נתונים:** בדיוק אלה שה-`Actor` שהוא משרת רשאי לקרוא.

🔒 **החוק:** ל-AI יש בדיוק את הרשאות המשתמש שהוא משרת. לא יותר.
**האכיפה בשאילתה, לא בסינון התוצאה.** ה-AI מקבל את אותו `Actor` ועובר
דרך אותו `can()` כמו כל קריאה אחרת. מנוע שרץ על כל המלאי ומסנן בסוף
כבר הדליף — סוכן ששאל "יש משהו פנוי" וקיבל "לא, אבל..." למד על קיומה
של וילה שאסור לו לדעת עליה.

**מה אסור לו, מפורשות:**

- ליצור, לשנות, לבטל או לתמחר הזמנה. הוא **מציע**; אדם מאשר.
- להחזיק תאריכים. החזקה מסירה מלאי מהמכירה, וזו החלטה כלכלית.
- לחשוף שיעורי תפוסה, מחירים ממוצעים או מבנה תמחור לסוכן חיצוני.
- להסיק "כנראה יתפנה" מדפוסי ביטול ולומר את זה לאורח.
- לפעול על טקסט שהגיע מאורח כאילו היה הוראה. הודעת אורח היא **נתון**.

**Audit:** פעולה שנוצרה בעקבות הצעת AI נרשמת עם `actor_type = 'ai'`
ועם מי שאישר. `DECISION_LEDGER` 24.

---

## 13. אבטחה ופרטיות

**מה רגיש כאן:** שם האורח, הטלפון, המייל, מספר מסמך, המחיר ששולם, מקור
ההזמנה, גובה הפיקדון, הרווחיות, ההערות הפנימיות. כולם ב-`SENSITIVE_FIELDS`
ב-`permissions.ts`, וכולם נאכפים ב-`redact()` **בעיצוב התשובה** — לא
בהסתרה במסך, ולא ב-`select` שכל קורא זוכר לכתוב נכון.

🔒 **כל נתיב יציאה עובר באותו מקום:** מסך, API, ייצוא CSV, realtime,
ותשובת AI. ייצוא שעוקף scope הוא הכשל הנפוץ ביותר במערכות כאלה
(`DECISION_LEDGER` 8).

**הפרדת שתי היומנים** (§2) היא ההיקף של המודול הזה מבחינה אבטחתית:
`availability.view` מחזיר `DayAvailability` ותו לא.

**פעולות שדורשות נימוק:**
ביטול · הנחה ידנית · עקיפת זמינות · שחרור פיקדון · שחרור החזקה של אחר ·
כל מעבר שמסומן `requiresReason: true` בטבלת המעברים.

**פעולות שדורשות אימות מחדש:** אלה שב-`SENSITIVE_ACTIONS` —
`booking.delete`, `payment.refund`, `payment.void`, `guest.export`.
⚠️ `booking.cancel` **אינו** ברשימה, ומקבל `requiresReason: true`
מפורשות בפעולה. ההמלצה: להשאיר כך. ביטול הוא פעולה יומיומית של קבלה,
ואימות מחדש בכל ביטול יגרום לאנשים להשאיר את הסשן פתוח.

**גישת אורח:** קישור מאובטח להזמנה אחת. 🔒 האורח אינו `user`, אין לו
`membership` ואין לו `role` (`DECISION_LEDGER` 5). הטוקן חד-הזמנתי,
פג בתום השהות + 30 יום, ומאפשר צפייה, תשלום וחתימה — **ולא** שינוי
תאריכים ולא ביטול.

**RLS:** כל טבלה במודול נושאת `organization_id` ומקבלת
`organization_id in (select my_organizations())` ברגע יצירתה, בתוספת
`property_in_scope()` / `unit_in_scope()`. הרצפה במסד; הדיוק במנוע.

---

## 14. Audit

הניסוח הוא משפט בעברית שמנהל יבין בעוד שנה, לא `booking updated`.
מה שכבר קיים בקוד:

> **דנה כהן** יצרה את הזמנה **8892** עבור **משפחת לוי** ביחידה **וילה הגפן**
> לתאריכים **3.9–6.9** (3 לילות) בסך **₪6,400**

> **דנה כהן** שינתה את סטטוס הזמנה **8892** מ״ממתינה לתשלום״ ל״מקדמה שולמה״

> **דנה כהן** שינתה את תאריכי הזמנה **8892** מ-3.9 ל-5.9 והמחיר חושב
> מחדש ל-**₪4,800**

> **דנה כהן** ביטלה את הזמנה **8892** של **משפחת לוי** לתאריכים **3.9–6.9**

> **דנה כהן** תפסה את היחידה **וילה הגפן** לתאריכים **3.9–6.9** למשך
> 30 דקות (הצעת סוכן)

מה שחייב להתווסף עם הפעולות החסרות:

> **דנה כהן** העבירה את הזמנה **8892** מיחידה **וילה הגפן** ליחידה
> **וילה הרימון**, באותם תאריכים

> **דנה כהן** שינתה את מספר האורחים בהזמנה **8892** מ-6 ל-9, והמחיר
> עלה מ-₪6,400 ל-₪7,300

> **דנה כהן** עקפה את בדיקת הזמינות בהזמנה **8892**. נימוק: "האורח
> מגיע בכל מקרה, סוכם עם הבעלים"

> **המערכת** שחררה את ההחזקה של **יוסי אגם** על **וילה הגפן**
> (3.9–6.9) — פג התוקף

**מה נרשם:** יצירה · כל מעבר סטטוס · כל שינוי · ביטול (עם הנימוק) ·
עקיפת זמינות · עקיפת מחיר · יצירת החזקה · שחרור · הרחבה · המרה ·
שחרור פיקדון · חישוב דמי ביטול · הצעת רשימת המתנה.

**מה לא נרשם:** צפייה בלוח (רועש עד חוסר תועלת), חישוב הצעת מחיר שלא
נשמרה.

🔒 `audit_events` היא append-only ברמת ה-trigger (מ-`0005`). Audit
שאפשר לערוך אינו Audit.

---

## 15. דיווח

המודול **מזין** מדדים ואינו מגדיר אותם.
🔒 **כל מדד נלקח מ-`src/lib/metrics/` ואינו מחושב כאן מחדש.**
"אף אחד מחוץ לתיקייה הזו אינו רשאי לחלק הכנסה בלילות."

מה שההזמנות מזינות אל `BookingFactRow` ומשם אל `MetricFacts`:

| שדה ב-`MetricFacts` | מה ההזמנות תורמות |
| --- | --- |
| `occupiedUnitNights` | לילות של הזמנות ב-`REALISED_STATUSES` |
| `soldUnitNights` | אותם לילות פחות `option` ופחות לילות חינם |
| `heldOptionUnitNights` | לילות ב-`option` — תופסים יומן ואינם מכירה |
| `roomRevenue` | שורות `accommodation`, לילה-לילה, **נטו ממס** |
| `ancillaryRevenue` | `cleaning_fee`, `addon`, `extra_guest` — מוכרות בהגעה |
| `revenueBySource`, `directRevenue` | לפי `source` ו-`DIRECT_SOURCES` |
| `leadTimeDayTotal` | `committedOn − createdOn` |
| `cancelledArrivalCount` | הזמנות שהיו אמורות להגיע בחלון ובוטלו |
| `commission` | `agentCommissionLine`, לילה-לילה |

**מדדים ייחודיים למודול** (מוגדרים ב-`metrics/`, מוזנים מכאן):
שיעור המרה של פנייה להזמנה · שיעור המרה של החזקה להזמנה · זמן ממוצע
בכל סטטוס (מ-`booking_status_history`) · שיעור ביטול לפי מקור ולפי סוכן ·
לילות שאבדו לפקיעת החזקות · שיעור המרה של רשימת ההמתנה.

**האחרון חשוב מהצפוי:** הוא התשובה לשאלה "כמה כסף העסק מפסיד בגלל שהוא
מלא", והוא המדד שמצדיק לבעל צימר להוסיף יחידה.

---

## 16. מטריצת מקרי קצה

**41 מקרים.** "מה קורה היום" מתייחס לקוד כפי שהוא ב-`src/lib/booking/`
ולסכימה כפי שהיא ב-`0008` (כלומר: **בלי `0009`**).

### מרוצים על התאריכים

| # | המקרה | מה קורה היום | מה **צריך** לקרות | איך בודקים |
| --- | --- | --- | --- | --- |
| E-01 | שני סוכנים לוחצים "אשר" על אותם תאריכים באותה שנייה | שניהם עוברים `checkAvailability`, **שניהם נכתבים** — אין אילוץ במסד | הראשון מצליח; השני מקבל `ConflictError` בעברית עם החלופות של §7.8 | Integration: שתי טרנזקציות מקבילות מול Postgres אמיתי, `Promise.allSettled`, קובעים בדיוק הצלחה אחת ו-`23P01` אחד |
| E-02 | הזמנת OTA והזמנה ישירה נכתבות באותו רגע | כנ״ל | הראשונה שמגיעה ל-commit מנצחת. השנייה: אם ישירה — כישלון עם חלופות; אם OTA — נשמרת מסומנת `conflict` + אירוע חמור (§11) | Integration עם השהיה מבוקרת בין ה-`rule` ל-`execute` בשני הזרמים |
| E-03 | תפוגת החזקה בדיוק ברגע ההמרה | `assertHoldIsLive` משתמש ב-`now` של הבקשה; ההשוואה קפדנית | `expiresAt == now` פירושו פקעה. ההמרה נכשלת עם "תוקף ההחזקה פג והתאריכים חזרו למכירה" | Unit: `isHoldLive` בדיוק ב-`expiresAt`, ב-`expiresAt-1ms` וב-`+1ms` |
| E-04 | ההחזקה של סוכן פוקעת באמצע הצ׳ק-אאוט של האורח | ההמרה נכשלת נכון. **התאריכים אולי כבר נמכרו** | הכישלון מבחין בין שני מצבים: התאריכים עדיין פנויים → הצעה להחזיק מחדש בלחיצה; נמכרו → חלופות. **לעולם לא "נסה שוב" סתם** | Integration: פקיעה מבוקרת, ואז שני תרחישים — עם מתחרה ובלי |
| E-05 | שני עובדים עורכים את אותה הזמנה | `version` נבדק בצינור וב-`WHERE` | השני מקבל `ConflictError` שאומר **מה** השתנה ומי שינה, לא רק "רענן" | Integration: שתי בקשות עם אותו `expectedVersion` |
| E-06 | אותה בקשת יצירה נשלחת פעמיים (כפתור כפול) | עם מפתח — replay; **בלי מפתח — שתי הזמנות** | האתר **חייב** לשלוח מפתח. שרת שקיבל יצירה מהאתר בלי מפתח מסרב | E2E: לחיצה כפולה מהירה; Unit: הצינור מחזיר `replayed: true` |
| E-07 | שתי בקשות עם אותו מפתח ותוכן שונה | `payload_mismatch` | 409 עם "בקשה זו כבר בוצעה עם פרטים אחרים" | Unit קיים ב-`idempotency.test.ts`, מורחב להזמנה |
| E-08 | הרחבת שהות של אורח מתנגשת עם ההזמנה הבאה | `checkAvailability` תופס עם `ignoreBookingId` | סירוב עם שם ההזמנה החוסמת ותאריכיה, והצעה: להעביר את האורח הבא ליחידה אחרת | Unit: הזמנה סמוכה, הארכה בלילה אחד |

### תשלום מול מצב

| # | המקרה | מה קורה היום | מה **צריך** לקרות | איך בודקים |
| --- | --- | --- | --- | --- |
| E-09 | האורח משנה תאריכים בזמן שתשלום בדרך | אין קשר בין השניים. **המחיר יכול להשתנות בזמן שהסליקה מחייבת את הישן** | 🔒 הזמנה עם תשלום פתוח **נעולה לשינוי מחיר**. שינוי תאריכים מותר; אם המחיר החדש שונה, השינוי נדחה עד שהתשלום הוכרע. השדה: `payment_in_flight_since` | Integration: פתיחת ניסיון תשלום, ואז `amend_dates` עם מחיר אחר → 409 מוסבר |
| E-10 | התשלום מצליח אחרי שההזמנה בוטלה | ה-webhook יגיע להזמנה במצב `cancelled` | 🔒 **הכסף אינו נדחה — הוא מתקבל ומסומן להחזר.** נוצרת משימת החזר עם הנימוק, האורח מקבל "התשלום התקבל וההזמנה כבר בוטלה, ההחזר בדרך". ההזמנה **נשארת** מבוטלת | Integration: ביטול, ואז webhook הצלחה; קובעים `paid_agorot > 0`, סטטוס `cancelled`, ומשימת החזר אחת |
| E-11 | התשלום מצליח פעמיים על אותה הזמנה | — | חיוב שני עם אותו `idempotencyKey` = replay. בלי מפתח — נרשם, ומסומן לזיכוי | Integration |
| E-12 | האורח משלם מקדמה אחרי שהתאריכים נמכרו למישהו אחר | לא ייתכן היום כי אין תפיסה אמיתית; אחרי `0009` ייתכן אם ההזמנה הייתה `awaiting_payment` ופקעה | `awaiting_payment` **תופס יומן** (הוא ב-`OCCUPYING_STATUSES`), ולכן זה לא יקרה — **אלא** אם A-18 שחררה אותה. אז: הכסף מתקבל, ההזמנה נשארת משוחררת, החזר + התנצלות + חלופות | Integration עם A-18 מופעל |
| E-13 | ביטול של הזמנה שהמע״מ בה השתנה מאז | — | 🔒 חישוב הביטול מבוסס על `tax_rate_bps_applied` ו-`cancellation_policy_snapshot` של ההזמנה, לא על הנכס היום | Unit: מדיניות שונה בנכס מזו שבתמונת המצב |

### ערוצים

| # | המקרה | מה קורה היום | מה **צריך** לקרות | איך בודקים |
| --- | --- | --- | --- | --- |
| E-14 | הזמנת OTA מגיעה על תאריכים שנמכרו ישירות | תיווצר. אין אילוץ | נשמרת `confirmed` **בלי שורת תביעה**, מסומנת `conflict`, אירוע חמור למנהל, ומסך "התנגשות ערוץ" שמציע: להעביר יחידה, לבטל את הישירה, או לבטל מול ה-OTA. 🔒 **לעולם לא דחייה שקטה** — האורח כבר קיבל אישור מ-Airbnb | Integration: ייבוא מול הזמנה קיימת |
| E-15 | אותו webhook מגיע שלוש פעמים | — | האינדקס הייחודי על `(organization_id, source, channel_reservation_id)` הופך את השני והשלישי לעדכון | Integration |
| E-16 | ה-OTA מבטל ואנחנו לא שמענו | — | סנכרון מלא כל 15 דקות; פער מייצר שורה בדוח סתירות ו**אינו מבטל אוטומטית** | Integration עם תגובת ערוץ מזויפת |
| E-17 | הערוץ לא מגיב 20 דקות והמלאי לא נסגר | — | 🔒 סוגרים החוצה בכישלון: אם דחיפת הזמינות נכשלה, היחידה **מסומנת כלא-נמכרת בערוץ** עד הסנכרון המוצלח הבא | Integration עם ספק שנופל |

### שינויים

| # | המקרה | מה קורה היום | מה **צריך** לקרות | איך בודקים |
| --- | --- | --- | --- | --- |
| E-18 | העברה ליחידה שתפוסה **בלילה אחד** מתוך הטווח | אין פעולת העברה בכלל | סירוב שמציין **בדיוק איזה לילה** ומי תופס אותו, ומציע פיצול שהות בין שתי יחידות כאפשרות מפורשת | Unit: יחידה עם הזמנה של לילה אחד בתוך הטווח; קובעים שהודעת ה-blocker נושאת את התאריך |
| E-19 | ההעברה מצליחה חלקית — התביעה הישנה שוחררה, החדשה נכשלה | — | 🔒 **בלתי אפשרי:** שתי הפעולות באותה טרנזקציה. rollback מחזיר את התביעה הישנה | Integration: הזרקת כישלון בין השחרור לתפיסה; קובעים שהמצב זהה לחלוטין לזה שלפני |
| E-20 | ההזמנה עוברת לנכס אחר | אין פעולה. `propertyId` מהקלט ולא מהיחידה | העברת נכס = העברת יחידה שגוררת גם `property_id`. **המפתח הזר המורכב הופך אי-התאמה לבלתי אפשרית**. משימות, צוות ומדיניות מיסוי מחושבים מחדש | Integration: קובעים ש-`property_id` תמיד = של היחידה |
| E-21 | מספר האורחים משתנה אחרי שהניקיון התחיל | — | 🔒 המשימה הקיימת **אינה מבוטלת**. נפתחת משימת **השלמה** על ההפרש בלבד (3 מצעים נוספים, לא 9 מחדש), משויכת לאותו אדם, ועם התראה מיידית. אם הניקיון כבר `completed` — משימה חדשה בעדיפות גבוהה | Integration: משימה ב-`in_progress`, שינוי 6→9; קובעים שתי משימות והפרש נכון |
| E-22 | מספר האורחים יורד אחרי שההכנה הושלמה | — | **אין ביטול משימה.** ההפרש נרשם כעלות שנשרפה בשדה `wasted_cost_agorot` ומופיע ברווחיות | Unit על מנוע ההכנה |
| E-23 | תאריכים משתנים והמחיר יורד מתחת למה ששולם | היום: המחיר מחושב מחדש רק אם נשלח `pricing` | סירוב עד להכרעה: זיכוי או השארת יתרה לזכות האורח. **לא הפחתה שקטה שיוצרת חוב של העסק** | Unit: הזמנה ששולמה במלואה, קיצור לילה |
| E-24 | הנחה ידנית אובדת בשינוי תאריכים | ⚠️ **קורה היום.** `amendBookingDates` מעביר רק `input.pricing` ולא `manualDiscountAgorot`, וההנחה נעלמת | 🔒 שורות הנחה ידנית **נשמרות ומועברות** לתמחור החדש, אלא אם המשתמש הסיר אותן במפורש בתצוגה המקדימה | Unit: הזמנה עם הנחה ידנית → `amend_dates` עם `pricing` → קובעים שהשורה קיימת. **הבדיקה נכשלת היום** |
| E-25 | שינוי סוכן אחרי שהעמלה אושרה | — | העמלה המאושרת **אינה זזה**. נוצרת התאמה: לסוכן הישן נשארת, לחדש נרשמת מנקודת השינוי ❓ Q-7 | Integration מול מנוע העמלות |

### מחזור החיים

| # | המקרה | מה קורה היום | מה **צריך** לקרות | איך בודקים |
| --- | --- | --- | --- | --- |
| E-26 | גיחת יום: יוצא ונכנס באותו יום | `rangesOverlap` חצי-פתוח — **אינם מתנגשים** | נכון. הלוח מציג שני חצאי-תא באותו תא | Unit: `{3.9→5.9}` מול `{5.9→7.9}` = `false`; קיים כדפוס ודורש בדיקה מפורשת |
| E-27 | גיחת יום והצ׳ק-אאוט מתאחר | אין ייצוג. יום העזיבה כבר לא תפוס | 🔒 **התאריכים לא זזים.** נפתחת תקלה `late_checkout`, האורח הנכנס מקבל הודעה יזומה עם שעה מעודכנת, והניקיון מקבל עדיפות דחופה. **צ׳ק-אאוט מאוחר אינו הארכת שהות** — אם הוא כן, זו הארכה בתשלום ואז התאריך כן זז | Integration: `checkout_pending` אחרי `check_out_time`, הזמנה נכנסת באותו יום → קובעים תקלה, התראה ושדרוג עדיפות |
| E-28 | האורח מגיע יום מוקדם מדי | — | סירוב צ׳ק-אין (`stayHasNotEnded` לא מכסה את זה) + הצעה: להוסיף לילה אם פנוי, במחיר של אותו לילה | Unit: תנאי `arrivalDateHasCome` הפוך |
| E-29 | צ׳ק-אאוט מסומן ואז מתברר שהאורח לא עזב | `checked_out` משחרר תאריכים | חזרה ל-`in_house` **אינה מעבר חוקי**. הפעולה הנכונה: הארכה, שהיא `amend_dates` — ולכן היא נבדקת מול הזמינות. אם הלילה כבר נמכר → תקלה, לא תיקון שקט | Unit: `checked_out → in_house` מסורב עם `illegal_transition` |
| E-30 | אי-הגעה מסומנת אך האורח מגיע ב-23:00 | `no_show` הוא **סופי** | 🔒 סטטוס סופי הוא סופי. הפעולה: **הזמנה חדשה** שמקשרת לישנה, עם התאריכים שנותרו. `no_show` שוחרר את התאריכים ולכן הזמינות נבדקת מחדש | Unit: כל מעבר מ-`no_show` נכשל ב-`terminal_status` |
| E-31 | פיקדון לא שוחרר וההזמנה נסגרת | `noDepositStillHeld` חוסם | נכון: `completed` נחסם עם "עדיין מוחזק פיקדון". הודעה יומית למנהל על הזמנות תקועות | Unit קיים כתנאי; דורש בדיקה |
| E-32 | הזמנה שלא הגיעה לתשלום נשארת `awaiting_payment` לנצח | A-18 היא היחידה שמשחררת, וטרם קיימת | 🔒 שחרור אוטומטי מותנה בהגדרה מפורשת, ומודיע **לפני** ולא אחרי. עסק שלא הפעיל — הזמנה נשארת ומופיעה בדוח "מלאי תקוע" | Integration עם שעון מוזרק |

### הרשאות ובידוד

| # | המקרה | מה קורה היום | מה **צריך** לקרות | איך בודקים |
| --- | --- | --- | --- | --- |
| E-33 | מנהל בטווח `properties[A]` יוצר הזמנה עם `propertyId = A` ו-`unitId` של נכס B | ⚠️ **עובר.** `targetResource` בונה משאב מקלט לא מאומת, ו-`isWithinScope` מסתפק ב-`propertyId` | סירוב `out_of_scope`. `property_id` נגזר מהיחידה **לפני** בדיקת ה-scope | Security: בדיקה שמוכיחה את **השלילה**. נכשלת היום |
| E-34 | סוכן מבקש הזמנה של ארגון אחר לפי מזהה | `loadBooking(organizationId, id)` מסנן; RLS תחסום גם | `NotFoundError` ולא `AuthorizationError` — 🔒 "אין הרשאה" מאשר שהרשומה קיימת | Security: קובעים 404 ולא 403 |
| E-35 | מנקה קורא הזמנה ומקבל טלפון ומחיר | `redact()` אמור להסיר | הרשומה מגיעה בלי `guest.phone`, `guest.email`, `booking.price`, `booking.source`, `booking.deposit` | Security: בדיקה לכל שדה ב-`SENSITIVE_FIELDS`, על **כל** נתיב יציאה כולל ייצוא |
| E-36 | סוכן מנסה לשחרר החזקה של סוכן אחר | `hold.release` נבדק על המשאב; טווח `own_records` יסרב | סירוב. מנהל **כן** רשאי, ובנימוק | Security + Unit |
| E-37 | סוכן שהסכמו הסתיים מנסה לשנות הזמנה קיימת | `membership_not_active` | סירוב בשלב הראשון של `authorize`, לפני שנקראה שורה | Security |

### קצוות של נתונים

| # | המקרה | מה קורה היום | מה **צריך** לקרות | איך בודקים |
| --- | --- | --- | --- | --- |
| E-38 | `2026-02-30` בשדה תאריך | `isoDate()` תופס — התבנית עוברת, ה-refine נכשל | `התאריך אינו קיים בלוח השנה.` | Unit קיים בדפוס; דורש בדיקה |
| E-39 | הזמנה שחוצה מעבר שעון קיץ | תאריכים הם מחרוזות בלבד, החישוב ב-UTC | מספר הלילות נכון. `localDate` מטפל ב"היום" | Unit: 26–28.10, וגם `localDate` ב-22:30 UTC |
| E-40 | הזמנה של 400 לילות | `max_nights` אינו נבדק | סירוב, אלא בעקיפה מפורשת. שהות ארוכה היא חוזה שכירות, לא הזמנה | Unit |
| E-41 | `loadRules` מחזיר `null` ליחידה קיימת | דחייה כברירת מחדל — `unknown_unit` | נכון ומכוון. 🔒 **ברירת מחדל מתירנית כאן מוכרת יחידה שאיש לא הגדיר למכירה** | Unit קיים בקוד; דורש בדיקה |

---

## 17. מניעת טעות אנוש

**H-1 · הזמנה על הנכס הלא נכון.**
זו הטעות היקרה והשכיחה ביותר: מנהל עם ארבעה נכסים בוחר "וילה הגפן"
ומקבל את זו שבנכס השני, כי לשניהם יש יחידה בשם דומה.

*המניעה — ארבע שכבות, אף אחת מהן אינה אזהרה:*

1. 🔒 **`property_id` נגזר מהיחידה בשאילתה.** הקלט אינו קובע. מפתח זר
   מורכב `(unit_id, organization_id, property_id) → units` הופך אי-התאמה
   ל**בלתי אפשרית ברמת המסד**.
2. הבורר הוא **היררכי וכפוי**: אי אפשר לבחור יחידה לפני שנבחר נכס.
   רשימה שטוחה של כל היחידות בארגון היא הבאג.
3. שם היחידה במסך **תמיד נושא את הנכס**: "וילה הגפן · הרי יהודה".
4. הזמנה שנוצרה בנכס שאינו `default_property_id` של המשתמש מציגה
   **אישור מפורש**: "ההזמנה תיווצר בנכס *הרי יהודה*, שאינו נכס ברירת
   המחדל שלך." — פעם אחת, לא בכל פעם.

**H-2 · יחידה נכונה, נכס נכון, תאריך שנה קודמת.**
המקרה: 3 בינואר, מקלידים "3.9" ומקבלים ספטמבר שעבר.

*המניעה:* בורר התאריכים נפתח על החודש הנוכחי ו**אינו מאפשר בחירה בעבר
ללא הרשאה**. הזמנה בעבר דורשת `booking.override_availability` + נימוק,
כי היא לגיטימית (רישום היסטורי) אך לעולם לא מקרית. הצגת התאריך המלא
עם היום בשבוע — "**שישי**, 3.9.2026" — כי אדם מזהה יום שגוי מהר יותר
משהוא מזהה שנה שגויה.

**H-3 · אורח כפול.**
*המניעה:* חיפוש לפי טלפון **לפני** יצירה, במסך ולא אחרי. אינדקס ייחודי
על `(organization_id, phone_e164)` — 🔒 דדופליקציה בקוד נשברת בשתי בקשות
מקבילות. שני אורחים עם אותו טלפון (זוג) נפתרים במסך מיזוג, לא בכפילות.

**H-4 · שינוי שגורר שינוי שאיש לא התכוון אליו.**
*המניעה:* 🔒 **תצוגה מקדימה חובה** (§5.5) שמראה את כל ההשלכות מהטבלה
של §6.1 לפני השמירה: מחיר, זמינות, משימות, הודעות. השמירה מבצעת בדיוק
את מה שהוצג, ואם משהו השתנה בינתיים היא נדחית עם ההפרש.

**H-5 · סכום שגוי — אפס עודף.**
*המניעה:* כסף מוקלד בשקלים בממשק ומומר לאגורות בקצה. שדה סכום מציג
`₪1,200.00` בזמן ההקלדה. הנחה מעל סף מציגה **אזהרה עם המספר**:
"זו הנחה של ₪2,400, שהם 38% מהשהות" — אחוז לצד סכום, כי אדם קולט את
הראשון והשני מסתיר את גודל הטעות. חריגה מהתקרה של המשתמש מייצרת
**בקשת אישור** ולא סירוב.

**H-6 · פעולה הרסנית בלחיצה אחת.**
*המניעה:* ביטול דורש **הקלדת מספר ההזמנה** ולא לחיצה על "כן". שחרור
פיקדון דורש נימוק. עקיפת זמינות דורשת נימוק. הכפתורים ההרסניים אינם
צמודים לכפתורים היומיומיים במסך.

**H-7 · פעולה כפולה.**
*המניעה:* מפתח Idempotency (§10.4), כפתור שננעל בהגשה, ובדיקה של השרת
ל"הזמנה זהה נוצרה בדקה האחרונה לאותו אורח באותם תאריכים" → אזהרה עם
קישור לקיימת.

**H-8 · שחרור החזקה של מישהו אחר בטעות.**
*המניעה:* מסך ההחזקות מציג את ההחזקות שלי כברירת מחדל. שחרור החזקה של
אחר דורש נימוק ומודיע למחזיק.

**H-9 · הזמנה שנוצרה כ-`confirmed` בלי שנגבה כסף.**
⚠️ `INITIAL_STATUSES` כולל `confirmed` — נכון לייבוא ערוץ, מסוכן לכל
היתר. *המניעה:* פתיחה ב-`confirmed` מותרת רק כשה-`source` הוא ערוץ,
או לשחקן עם `channel.manage`. אחרת הסטטוס ההתחלתי המרבי הוא
`awaiting_payment`.

**H-10 · הודעה נשלחה לאורח הלא נכון.**
*המניעה:* כל תבנית מציגה תצוגה מקדימה עם שם ומספר ההזמנה. שליחה
ידנית מציגה את הנמען המלא. אין "שלח לכולם" בלי בחירה מפורשת של הקהל.

---

## 18. תלויות

**המודול תלוי ב:**

| במה | לשם מה |
| --- | --- |
| `src/lib/authz/` | `can`, `assertCan`, קטלוג ההרשאות, `Scope` |
| `src/lib/service/` | `defineOperation` — הצינור היחיד; `schema`, `idempotency`, `transaction`, `events` |
| `src/lib/errors/` | `ValidationError`, `ConflictError`, `BusinessRuleError`, `NotFoundError` |
| `src/lib/audit/` | `recordAuditEvent` |
| `src/lib/plans/` | `formatAgorot`, מכסות |
| `src/lib/hebrew-calendar/` | שבתות וחגים ללוח המחירים ולתאריכי אי-הגעה |
| `0008_accommodation.sql` | `units`, `properties`, `property_in_scope`, `unit_in_scope` |
| `btree_gist` | אילוץ ההדרה. **תלות חובה** |

**תלויים בו:**

| מי | במה |
| --- | --- |
| `src/lib/metrics/` | `BookingStatus`, `BookingSource`, `OCCUPYING_STATUSES`, `DateRange`, `nightsBetween` — **תלות ישירה בקוד** |
| `src/lib/preparation/` | `Agorot`, `DateRange`, `PriceLine`, וכל עובדות ההזמנה |
| תשלומים · חשבוניות · חוזים | ההזמנה היא העוגן |
| משימות ומשק בית | `booking.checked_out`, `booking.changed` |
| עמלות | ייחוס + מכונת המצבים |
| האתר הציבורי | 🔒 **קורא את היומן כמקור אמת יחיד.** הזמינות אינה משוכפלת לאתר (`DATA_MODEL.md` M3) |
| רשת הסוכנים | זמינות, החזקות, יצירה |

---

## 19. בדיקות נדרשות

⚠️ **ב-`src/lib/booking/` אין היום ולו קובץ בדיקה אחד.** שמונה קבצי מקור,
אפס `.test.ts`. זו הפער הגדול ביותר במודול אחרי המיגרציה החסרה.

### Unit — מוכיחות שהחשבון נכון

| מה | מוכיחה |
| --- | --- |
| `rangesOverlap` על 12 קומבינציות | חצי-פתוח, כולל גיחת יום |
| `nightsBetween` על טווח הפוך, זהה, לא חוקי | `NaN` ולא `0` |
| `priceStay` — לילות, אורח נוסף, תוספות, שתי הנחות, מס, פיקדון | הסך = סכום השורות, **תמיד** |
| `roundAgorot` על ±0.5, ±0.4, ±0.6, 0 | חצי מתרחק מאפס; אין `-0` |
| שתי הנחות 10% | מורידות 20% ולא 19% |
| הנחה גדולה מהסכום | נחתכת לאפס, לא שלילית |
| `agentCommissionLine` | **אינה** בסך של האורח; מחושבת ללא פיקדון |
| `taxIncludedIn` | אינה `PriceLine` |
| כל 19 המצבים × כל 19 היעדים | בדיוק המעברים ב-`BOOKING_TRANSITIONS` חוקיים; כל היתר נכשל |
| `evaluateTransition` מסטטוס סופי | `terminal` לפני כל בדיקה אחרת |
| סדר הבדיקות | הרשאה **לפני** תנאי — מנקה מקבל "אין הרשאה" ולא "אין פיקדון" |
| `isHoldLive` בדיוק ב-`expiresAt` | `false` |
| `planHold` מעל המכסה / מעל המשך | זורק עם הודעה בעברית |
| `assertHoldCovers` על כיסוי חלקי | זורק |
| `checkAvailability` מחזיר **את כל** ה-blockers | לא רק הראשון |
| `loadRules → null` | `unknown_unit`, לא זמין |
| חישוב דמי ביטול על כל רובד + גבולות | כולל `clamp` מול `paid_agorot` |

### Integration — מוכיחות שהמסד מקיים את ההבטחה

| מה | מוכיחה |
| --- | --- |
| שתי הזמנות חופפות במקביל | בדיוק אחת שורדת, `23P01` |
| הזמנה מול החזקה חיה | האילוץ תופס — **זו הבדיקה שאילוץ פר-טבלה היה מכשיל** |
| החזקה שפג תוקפה + הזמנה חדשה | הניקוי העצל משחרר בלי מטאטא |
| המרת החזקה | תביעה אחת בסוף, לא שתיים |
| כישלון באמצע העברת יחידה | rollback מלא (E-19) |
| שני `expectedVersion` זהים | השני נכשל |
| Replay של מפתח | אותה תוצאה, **בלי שורת Audit שנייה** |
| ייבוא ערוץ פעמיים | עדכון, לא כפילות |

### E2E — מוכיחות שהיום עובד

פנייה מהאתר → הצעה → החזקה → תשלום → אישור → טרום-הגעה → צ׳ק-אין →
שהות → צ׳ק-אאוט → בדיקה → שחרור פיקדון → סגירה.
ובנוסף: ביטול עם החזר · שינוי תאריכים עם תמחור מחדש · לחיצה כפולה על
"אשר" · גיחת יום בין שתי הזמנות.

### Security — 🔒 **לכל הרשאה, בדיקה שמוכיחה את השלילה**

| מה | מוכיחה |
| --- | --- |
| כל אחת מ-`booking.*`, `hold.*`, `availability.view` | שחקן בלעדיה **מסורב**, עם `DenialReason` הנכון |
| `properties[A]` + `unitId` של B (E-33) | `out_of_scope` |
| חוצה-ארגון על כל פעולה | `cross_organization`, ו-404 ולא 403 |
| מנקה על כל שדה ב-`SENSITIVE_FIELDS` | כולל **ייצוא** ו-**realtime** |
| סוכן מול `availabilityCalendar` | מקבל `DayAvailability` בלבד |
| צוות פלטפורמה חוצה-ארגון | נדחה |
| Actor של AI | לא יותר ממי שהוא משרת |
| טוקן אורח | קורא הזמנה אחת; אינו משנה תאריכים ואינו מבטל |

### Regression

`OCCUPYING_STATUSES` × `REALISED_STATUSES` × `POST_STAY_STATUSES` —
בדיקה שכל סטטוס בחוזה מסווג בכל אחד מהם. 🔒 סטטוס שנוסף בלי סיווג
**חייב להכשיל בנייה**, לא להתגלות כהזמנה כפולה.

---

## 20. תנאי קבלה

**מסד**

- [ ] `0009_booking_core.sql` קיים ומכיל `guests`, `bookings`,
      `booking_status_history`, `holds`, `unit_claims`,
      `unit_availability_rules`, `unit_rate_calendar`, `unit_blocks`,
      `waitlist_entries`
- [ ] `btree_gist` מותקן ואילוץ ההדרה על `unit_claims` פעיל
- [ ] מפתח זר מורכב `(unit_id, organization_id, property_id)` על הזמנות,
      החזקות ותביעות
- [ ] אינדקס ייחודי על טלפון אורח, ועל `channel_reservation_id`
- [ ] RLS + `property_in_scope` / `unit_in_scope` על כל טבלה חדשה
- [ ] trigger שאוכף `total_agorot = sum(lines)`
- [ ] trigger שמתחזק `unit_claims` מתוך `bookings` ו-`holds`

**שרת**

- [ ] כל פעולה עוברת ב-`defineOperation` — **אין נתיב שני לשורת הזמנה**
- [ ] הפעולות החסרות קיימות: `booking.change_unit`,
      `booking.amend_guest_count`, `booking.amend_extras`,
      `booking.amend_price`, `hold.extend`, `waitlist.*`
- [ ] `changeBookingStatus` בודק זמינות בכניסה למצב תופס (C-2)
- [ ] `liveHoldCount` קורא באמת מהמאגר (C-3)
- [ ] `property_id` נגזר מהיחידה בכל נתיב (C-5)
- [ ] כישלון האילוץ מתורגם ל-`ConflictError` בעברית

**הרשאות**

- [ ] כל הפעולות ממופות לגרנטים מהקטלוג, וההתאמה בין
      `AMENDMENT_GRANTS` לפעולות סגורה (C-9)
- [ ] `redact()` על כל נתיב יציאה כולל ייצוא ו-realtime
- [ ] לכל הרשאה בדיקת שלילה

**ממשק**

- [ ] לוח זמינות עם רצועות חצי-תא, שגיאה שאינה מציגה לוח ריק
- [ ] אשף יצירה עם בורר היררכי כפוי ובדיקת זמינות חיה
- [ ] תצוגה מקדימה מלאה לפני כל שינוי
- [ ] הכפתורים נבנים מ-`legalNextStatuses`
- [ ] טיימר חי בהחזקות

**בדיקות**

- [ ] כל טבלאות §19, ירוקות
- [ ] בדיקת המקביליות רצה מול Postgres אמיתי ולא מול כפיל

**Audit**

- [ ] משפט בעברית לכל פעולה, בשמות ובסכומים
- [ ] כל ביטול, עקיפה והנחה נושאים נימוק
- [ ] `booking_status_history` נכתבת בכל מעבר

**שגיאות**

- [ ] כל הודעה בעברית ואומרת מה לעשות עכשיו
- [ ] כל בעיות הטופס יחד
- [ ] התנגשות תאריכים מציעה חלופות ואינה מאפסת את הטופס

**מובייל**

- [ ] הלוח שמיש ביד אחת
- [ ] פעולה ראשית בסרגל תחתון קבוע
- [ ] RTL מלא, כולל טווחי תאריכים ומספרים

---

## ⚠️ סתירות שנמצאו

| # | הסתירה | ההמלצה |
| --- | --- | --- |
| **C-1** | `availability.ts`, `repository.ts` ו-`holds.ts` מצהירים שאילוץ ההדרה במסד הוא הערובה. **`0009` אינו קיים; `bookings`, `holds` והאילוץ אינם קיימים.** כל המנוע רץ היום בלי הערובה שהוא מבוסס עליה | לכתוב את `0009` לפי §3.2 לפני כל שימוש אמיתי. **חסם שחרור** |
| **C-2** | `createBooking` מדלג על בדיקת זמינות לסטטוס לא-תופס (נכון), אבל `changeBookingStatus` **אינו בודק זמינות כלל** בכניסה ל-`option`/`awaiting_payment`/`confirmed`. פנייה שנוצרה על תאריכים מכורים הופכת להזמנה תופסת בלי בדיקה | להוסיף בדיקת זמינות ב-`rule` של `changeBookingStatus` כש-`isOccupying(to) && !isOccupying(from)`. **הפער החמור ביותר בקוד** |
| **C-3** | `operations.ts` שורות 952–954: `liveHoldCount()` מחזירה `0` קבוע. מכסת ההחזקות המקבילות שב-`HOLD_POLICY` ושדורשת `ARCHITECTURE.md` §12 **אינה נאכפת בכלל**. `repo.loadHoldsByUser` מוגדר ואינו נקרא | לחבר ל-`loadHoldsByUser` + `countLiveHoldsBy` |
| **C-4** | `Hold` בחוזה חסר `createdAt` ו-`extensionCount`, ולכן שתי ההגנות ש-§12 דורש — תקרת חיים כוללת ותקרת מספר הארכות — **אינן ניתנות לאכיפה**. `holds.ts` מתעד זאת בעצמו | להוסיף שתי עמודות ושני שדות; לעדכן `extendHold` |
| **C-5** | `propertyId` הוא `s.optional(s.string())` ומגיע מהקלט בלי אימות מול היחידה. תוצאה כפולה: הזמנה יכולה להירשם לנכס הלא נכון, **ומנהל בטווח `properties[A]` יכול ליצור הזמנה ביחידה של נכס B** (E-33) | לגזור מהיחידה. אם הקלט מספק ערך — לאמת ולסרב באי-התאמה |
| **C-6** | `checkAvailability` אינו קורא `units.max_guests`, `units.max_nights` ו-`units.status`, אף ששלושתם קיימים ב-`0008`. הזמנה ל-40 אורחים ביחידה לשניים עוברת | להרחיב את `UnitAvailabilityRules` ואת `loadRules` |
| **C-7** | `DayState` מכיר בארבעה מצבים; המוצר מדבר על שבעה. תחזוקה, שימוש בעלים ושימוש פנימי מתקפלים ל-`blocked`, וגם `loadRules → null` מתקפל לשם. הצוות הפנימי אינו יכול להבדיל | להוסיף `kind` ל-`DayAvailability` פנימית ולהשאיר את התצוגה החיצונית מקופלת |
| **C-8** | `assertAvailable` זורק `ConflictError` שהקוד היציב שלו הוא `version_conflict`, גם בהתנגשות תאריכים. הקוד מתעד זאת כפשרה מודעת. לקוח אינו יכול להבדיל בין "מישהו ערך" ל"התאריכים נמכרו" | קוד נפרד `resource_conflict` ב-`errors/` |
| **C-9** | הקטלוג מגדיר `booking.amend_dates`, `booking.amend_guest_count`, `booking.amend_extras`, `booking.amend_price`, והתפקידים מעניקים אותם ב-`AMENDMENT_GRANTS`. **`amendBookingDates` דורש `booking.update`.** סוכן עם `booking.amend_dates` ובלי `booking.update` אינו יכול להזיז תאריך; מי שיש לו `booking.update` עוקף את הפיצול הדק | פעולת שינוי דורשת את הגרנט הספציפי שלה. `booking.update` נשאר לעריכת רשומה כוללת |
| **C-10** | `amendBookingDates` דורש `booking.override_price` על **כל** תמחור מחדש, גם כשהוא בדיוק התעריף המפורסם. `booking.amend_price` קיים בקטלוג ואינו בשימוש | תמחור מחדש בתעריף = `booking.amend_price`. חריגה מהתעריף/התקרה = `booking.override_price` |
| **C-11** | `amendBookingDates` אינו מעביר `manualDiscountAgorot`, ולכן **הנחה ידנית נעלמת** בכל שינוי תאריכים שנושא תמחור (E-24) | לשמר שורות הנחה קיימות ולהעביר אותן |
| **C-12** | `hold.extend` קיימת בקטלוג ומוענקת ב-`SELLING_DESK` ובשלב `availability_hold`. **אין פעולת הרחבה.** `extendHold()` כתובה ואינה מחוברת — ולכן ההרחבה אינה מתועדת ואינה מוגבלת | להגדיר `hold.extend` ב-`operations.ts` |
| **C-13** | `INITIAL_STATUSES` מתיר פתיחה ב-`confirmed` לכל מי שיש לו `booking.create`, בלי התנאי `nothingOwedUpFront` שחל על אותו מעבר במכונת המצבים | לגדר ב-`channel.manage` או ב-`source` שהוא ערוץ (H-9) |
| **C-14** | סדר `BOOKING_STATUSES` מול `TERMINAL_STATUSES` — `review_requested` מול `completed` (§4.2) | לאמץ את הכרעת `state-machine.ts` ולתקן את סדר המערך |
| **C-15** | `BOOKING_SIDE_EFFECTS` מונה `charge_cancellation_fee`, `charge_no_show_fee`, `refund_deposit`, `close_financials` — **שמות בלבד. אין מנוי שמבצע אותם, ואין חישוב דמי ביטול בקוד** | לממש לפי §7.6 כמנויים לאירועים |
| **C-16** | ב-`src/lib/booking/` אין ולו בדיקה אחת, בעוד `metrics/`, `authz/` ו-`service/` נבדקים. זהו המודול היחיד שנוגע בכסף ובמלאי בלי רשת | §19 |

---

## ❓ הכרעות שדורשות את בעל המוצר

| # | השאלה | מתי נדרש |
| --- | --- | --- |
| **Q-1** | **רובדי מדיניות הביטול** — כמה ימים לפני ההגעה, איזה אחוז החזר, ואיזה דמי טיפול קבועים. הסכימה מוכנה (§7.6), המספרים לא | לפני הזמנה אמיתית ראשונה |
| **Q-2** | **מקדמה ופיקדון** — אחוז המקדמה, גובה הפיקדון, והאם הפיקדון מוחזר כשמבטלים | לפני M4 |
| **Q-3** | **מדיניות אי-הגעה** — האם מחייבים לילה אחד, את מלוא השהות, או לפי אותם רבדים | עם Q-1 |
| **Q-4** | **שחרור אוטומטי של `awaiting_payment`** — אחרי כמה שעות, והאם בכלל. שחרור מלאי אוטומטי הוא סיכון עסקי ולא החלטה הנדסית | לפני M4 |
| **Q-5** | **תקרות החזקה לסוכן חדש** — הברירות בקוד (5 החזקות, 30 דקות) הן ניחוש הנדסי. §12 מדבר על ציון אמינות שגדל; **מהי המדרגה** | לפני שסוכן חיצוני ראשון נכנס |
| **Q-6** | **חלון ההצעה ברשימת ההמתנה** — כמה זמן האורח הראשון בתור מקבל בלעדיות. שעה היא אגרסיבית, 24 שעות שורפות את התאריכים | עם רשימת ההמתנה |
| **Q-7** | **החלפת סוכן על הזמנה קיימת** — מי מקבל את העמלה: הראשון, השני, או פיצול | עם מנוע העמלות |
| **Q-8** | **Overbooking מודע** — האם הזמנת OTA שהתנגשה נשמרת (E-14) או נדחית. שמירה = חשיפה לפיצוי; דחייה = אורח שקיבל אישור מ-Airbnb ואין לו חדר | לפני חיבור ערוץ ראשון |
| **Q-9** | **פטור מע״מ לתייר** — איזו ראיה נדרשת (דרכון? חותמת כניסה?) ומי מאשר | לפני M5 |
| **Q-10** | **צ׳ק-אאוט מאוחר** — האם יש תשלום, כמה, ומאיזו שעה הוא הופך ללילה נוסף | לפני M6 |

---

## נספח · סדר הבנייה המומלץ

1. `0009_booking_core.sql` — הטבלאות ואילוץ ההדרה. **חוסם הכול.**
2. תיקוני C-2, C-3, C-5 — שלושתם באגים בקוד שכבר קיים, ושלושתם נוגעים
   במלאי או בבידוד.
3. מימוש `BookingRepository` מול Supabase + בדיקות המקביליות של §19.
4. הפעולות החסרות: `change_unit`, `amend_guest_count`, `amend_extras`,
   `amend_price`, `hold.extend`.
5. חישוב הביטול (§7.6) והמנויים ל-`charge_*` (C-15).
6. רשימת ההמתנה.
7. המסכים.

**כל שלב אינו נחשב גמור בלי הבדיקות שלו.** §19 אינה נספח לסוף.
