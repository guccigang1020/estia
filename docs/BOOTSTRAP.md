# הפעלה ראשונה

> שני דברים שאי אפשר לעשות מתוך המוצר, בתכנון. שניהם פעם אחת בחיי המערכת.
>
> נכתב 7.9.2026. **המסמך הזה קיים כדי שהצעדים האלה יישארו נדירים** — נוהל
> שכתוב הוא נוהל שאפשר לבקר; פעולה שחוזרים עליה מהזיכרון הופכת להרגל, וההרגל
> הזה הוא החזקת מפתח service-role.

---

## 1 · השורה הראשונה ב-`platform_staff`

### למה זה לא אפשרי מתוך המוצר

ביצה ותרנגולת מכוונת:

| מי              | מה יש לו על `platform_staff`                                 |
| --------------- | ------------------------------------------------------------ |
| `authenticated` | `SELECT` בלבד, ומדיניות ה-SELECT דורשת `is_platform_staff()` |
| `anon`          | כלום                                                         |
| `service_role`  | `INSERT`                                                     |

כלומר **רק מי שכבר רשום שם יכול לראות את הטבלה**, ורק מפתח service-role יכול
לכתוב אליה. זה נכון: קונסולת פלטפורמה שאפשר להצטרף אליה מבפנים אינה קונסולת
פלטפורמה.

### מה חסום עד שהשורה קיימת

- כל קונסולת הפלטפורמה
- `platform_set_autopilot_capability` — כלומר **אי אפשר להעניק Autopilot לאף
  ארגון**, וזו נקודת המכירה של המודול
- `platform_set_organization_capabilities` ו-`platform_set_organization_status`

### הפקודה

מריצים אותה **פעם אחת**, בידי מפעיל הפלטפורמה, מחוץ למוצר — ב-SQL Editor של
Supabase או ב-`psql` עם חיבור ישיר. היא בוחרת את המשתמש המאומת הוותיק ביותר
ומסרבת לרוץ פעמיים.

```sql
insert into public.platform_staff (user_id, role_id, status, note, created_by, updated_by)
select u.id, r.id, 'active'::public.platform_staff_status,
       'Bootstrap. See docs/BOOTSTRAP.md.', u.id, u.id
from auth.users u
cross join public.roles r
where u.email_confirmed_at is not null
  and r.code = 'platform_super_admin' and r.organization_id is null
  and not exists (select 1 from public.platform_staff)
order by u.created_at
limit 1
returning id, user_id;
```

`not exists (select 1 from public.platform_staff)` הוא מה שהופך אותה לפעם
אחת: הרצה שנייה מחזירה אפס שורות במקום לצרף עוד מנהל-על בטעות.

**אימות:**

```sql
select u.email, r.code, s.status
from public.platform_staff s
join auth.users u on u.id = s.user_id
join public.roles r on r.id = s.role_id;
```

---

## 2 · מרחב העבודה הראשון

### זה כבר אינו bootstrap

עד `0064_first_workspace.sql` יצירת ארגון דרשה `DATABASE_URL` או מפתח
service-role. **כבר לא.** `create_first_workspace` היא פונקציית
`SECURITY DEFINER` שיוצרת ארגון עבור `auth.uid()` ואינה מקבלת מזהה משתמש
בכלל — היא לא יכולה לנקוב בשם אף אחד מלבד הקורא לה.

**הדרך הנכונה היא המסכים:** להיכנס, ולמלא את טופס ההצטרפות. אין צורך בשום
סוד, ואין סיבה לעקוף.

### הכתובת נקבעת פעם אחת

`organizations.slug` הוא **בלתי ניתן לשינוי במוצר**, ובכוונה — `0001` אומר
זאת על העמודה, ו-`settings/organization/_lib/actions.ts` מסביר למה: כתובת
שמשתנה שוברת כל לינק שכבר נשלח לאורח. שם העסק ניתן לעריכה בהגדרות; הכתובת
לא.

**לכן זו החלטה של בעל העסק ולא של מי שמקים לו את המערכת.** בחרו אותה לפני
הלחיצה.

---

## מה שאין כאן, ולמה

**אין כאן פקודה שיוצרת ארגון ב-SQL.** אפשר לכתוב אחת, והיא תעבוד — וזו בדיוק
הסיבה שהיא לא כאן. ארגון שנוצר מחוץ למסכים לא מוכיח שמסלול ההצטרפות עובד,
וזו הייתה כל השאלה של `G-023`. הפונקציה עצמה הוכחה בנפרד — קריאה כ-
`authenticated` אמיתי בטרנזקציה שהתגלגלה לאחור, כולל לחיצה כפולה על אותו slug
שהחזירה את אותו מזהה — אבל **המסלול דרך הדפדפן טרם נצפה עובד**, וזה ההבדל
היחיד שנשאר.
