'use client'

/**
 * The screen where a villa owner decides what "ready" means in their house.
 *
 * ── What is missing without it ────────────────────────────────────────────
 *
 * `PropertyConfiguration` — the beds, their sleeping capacity, the linen each
 * one takes — and `PreparationRule` — how many towels per guest, how many
 * pillows per sleeping place, and when each applies — are read faithfully by
 * the engine and were written by nobody. `no-hardcoded-numbers.test.ts` proves
 * the engine never invents a quantity, which means that until this form
 * existed a business could not produce a single one.
 *
 * ── The order of the sections is the order of the dependency ──────────────
 *
 * Beds first, because two of the quantities a rule can be written against —
 * `sleeping_places` and `extra_beds` — are *outputs* of laying the party
 * across the beds and do not exist until that has been described. A form that
 * asked for the towel rule first would be asking somebody to divide by a
 * number they have not defined.
 *
 * ── The preview is the engine ─────────────────────────────────────────────
 *
 * The button at the bottom posts the draft to `previewPolicyAction`, which
 * runs `previewPlan` — `captureSnapshot`, then the same `assemblePlan` that
 * `buildPlan` runs. Nothing on this screen multiplies anything. A preview
 * computed here in the browser would be a second implementation that agreed
 * with the engine on the easy cases and disagreed on the ones worth checking,
 * and it would answer before the policy was saved by being wrong.
 *
 * It also works on the *unsaved* draft, which is the only order a person can
 * work in: decide what the policy does, then keep it.
 *
 * ── Duplicate submission, both halves ─────────────────────────────────────
 *
 * `useAsyncAction` refuses a second run synchronously, which covers the double
 * click. The idempotency key, generated once per form instance, covers what a
 * disabled button cannot: a retry after a timeout replays the first answer
 * rather than writing the policy twice.
 */

import { useMemo, useState, type ReactNode } from 'react'

import {
  previewPolicyAction,
  savePolicyAction,
  type PolicyPreview,
} from '@/app/(app)/preparation/_lib/actions'
import {
  BASES,
  BASIS_LABEL,
  CATEGORIES,
  CATEGORY_LABEL,
  COMPARATORS,
  COMPARATOR_LABEL,
  EVENTS,
  EVENT_TYPE_LABEL,
  UNITS,
  UNIT_LABEL,
} from '@/app/(app)/preparation/_lib/labels'
import {
  KNOWN_FLAGS,
  SECTION_LABEL_KEYS,
  type PolicyDraft,
  type PreviewParty,
} from '@/app/(app)/preparation/_lib/policy'
import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/components/ui/cn'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, TextInput, Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import type { PlanSectionKey } from '@/lib/preparation'

import { PolicyPreviewPanel } from './policy-preview'

type DraftRule = PolicyDraft['rules'][number]
type DraftBedType = PolicyDraft['bedTypes'][number]
type DraftTemplate = PolicyDraft['eventTemplates'][number]

export type PolicyEditorProps = {
  initial: PolicyDraft
  /** The revision the form was opened on. `null` for a new catalogue. */
  expectedVersion: number | null
  propertyName: string
  /** Stored rules the editor cannot render, named so nothing vanishes silently. */
  unrenderableRuleIds: readonly string[]
}

export function PolicyEditor({
  initial,
  expectedVersion,
  propertyName,
  unrenderableRuleIds,
}: PolicyEditorProps) {
  const [draft, setDraft] = useState<PolicyDraft>(initial)
  const [party, setParty] = useState<PreviewParty>({
    guests: 0,
    adults: 0,
    children: 0,
    nights: 1,
    eventType: 'accommodation',
  })

  const [preview, setPreview] = useState<PolicyPreview | null>(null)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)

  const previewing = useAsyncAction<void>()
  const saving = useAsyncAction<void>()

  /**
   * One key for the life of this form instance, and the version the form was
   * opened on advanced by each successful save — so a person who saves twice
   * without reloading is not told their own first save was somebody else's
   * concurrent edit.
   */
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])
  const version = savedVersion ?? expectedVersion

  const bedTypeOptions = draft.bedTypes.filter((type) => type.id.length > 0)
  const extraOptions = bedTypeOptions.filter((type) => type.usableAsExtra)

  const runPreview = () =>
    previewing.run(async () => {
      setFailure(null)
      const result = await previewPolicyAction({ draft, party })
      if (result.ok) setPreview(result.data)
      else {
        setPreview(null)
        setFailure(result.error)
      }
    })

  const runSave = () =>
    saving.run(async () => {
      setFailure(null)
      const result = await savePolicyAction({
        draft,
        expectedVersion: version,
        idempotencyKey,
      })
      if (result.ok) setSavedVersion(result.data.version)
      else setFailure(result.error)
    })

  return (
    <div className="flex flex-col gap-8">
      {unrenderableRuleIds.length > 0 && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          {unrenderableRuleIds.length === 1
            ? 'כלל אחד שמור עם תנאי מורכב שהמסך הזה אינו יודע להציג'
            : `${unrenderableRuleIds.length} כללים שמורים עם תנאים מורכבים שהמסך הזה אינו יודע להציג`}{' '}
          ({unrenderableRuleIds.join(', ')}). הם מוצגים כאן ללא תנאי, ושמירה
          מכאן תשמור אותם ללא תנאי. ערוך אותם רק אם זו הכוונה.
        </p>
      )}

      {/* ── 1 · The beds ───────────────────────────────────────────────── */}
      <Section
        title="המיטות שבבית"
        description="כמה מקומות שינה כל מיטה נותנת, וכמה יש. מיטה זוגית אחת שנותנת שני מקומות היא לא אותו דבר כמו שתי מיטות יחיד — הראשונה לוקחת סדין זוגי אחד והשנייה שני סדינים, וזה ההבדל שקובע כמה כביסה יוצאת."
      >
        {draft.bedTypes.length === 0 ? (
          <EmptyState
            illustration="task"
            as="h3"
            title="עוד לא הוגדרה אף מיטה"
            body="המערכת לא ממציאה מיטות. עד שתתאר מה יש בבית, אי אפשר לשבץ אף אורח ואי אפשר לחשב אף כמות."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {draft.bedTypes.map((type, index) => (
              <BedTypeCard
                key={index}
                type={type}
                stock={
                  draft.property.beds.find(
                    (entry) => entry.bedTypeId === type.id,
                  ) ?? {
                    bedTypeId: type.id,
                    permanent: 0,
                    storage: 0,
                    missing: 0,
                  }
                }
                onChange={(next, stock) =>
                  setDraft((current) =>
                    replaceBedType(current, index, next, stock),
                  )
                }
                onRemove={() =>
                  setDraft((current) => removeBedType(current, index))
                }
              />
            ))}
          </div>
        )}

        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => setDraft((current) => addBedType(current))}
        >
          הוסף סוג מיטה
        </Button>
      </Section>

      {/* ── 2 · The property ───────────────────────────────────────────── */}
      <Section
        title="הנכס"
        description="חדרים, מאפיינים, והמיטה שמובאת כשנגמרים המקומות. התקרה היא מספר שאישור כיבוי אש קובע, לא מספר שמסיבה גדולה משנה."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="שם הנכס בתוכנית">
            <TextInput
              value={draft.property.label}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  property: { ...current.property, label: event.target.value },
                }))
              }
            />
          </Field>

          <NumberField
            label="חדרי שינה"
            value={draft.property.bedrooms}
            onChange={(bedrooms) =>
              setDraft((current) => ({
                ...current,
                property: { ...current.property, bedrooms },
              }))
            }
          />

          <NumberField
            label="חדרי רחצה"
            value={draft.property.bathrooms}
            onChange={(bathrooms) =>
              setDraft((current) => ({
                ...current,
                property: { ...current.property, bathrooms },
              }))
            }
          />

          <Field
            label="המיטה שמובאת כשנגמרים המקומות"
            description="רק סוג שסומן כשימושי כתוספת. ״הכי זולה עם מקום אחד״ הוא ניחוש שיום אחד יבחר לול למבוגר."
          >
            <Select
              value={draft.property.extraSleepingBedTypeId}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  property: {
                    ...current.property,
                    extraSleepingBedTypeId: event.target.value,
                  },
                }))
              }
            >
              <option value="">— לא נבחר —</option>
              {extraOptions.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label || type.id}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="תקרת מקומות שינה" description="ריק פירושו ללא תקרה.">
            <TextInput
              inputMode="numeric"
              value={draft.property.maximumSleepingPlaces ?? ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  property: {
                    ...current.property,
                    maximumSleepingPlaces:
                      event.target.value.trim() === ''
                        ? null
                        : toNumber(event.target.value),
                  },
                }))
              }
            />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium text-foreground">
            מאפייני הנכס
          </legend>
          <p className="text-xs text-muted-foreground">
            כלל יכול להתנות את עצמו במאפיין — מגבת בריכה רק כשיש בריכה. המשקל
            לצידו הוא כמה המאפיין מוסיף לקושי, ומשם נגזר גודל הצוות.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            {draft.property.flags.map((flag, index) => (
              <div
                key={flag.flag}
                className="flex items-end gap-3 rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex-1">
                  <Checkbox
                    label={labelForFlag(flag.flag)}
                    checked={flag.on}
                    onChange={(event) =>
                      setDraft((current) =>
                        replaceFlag(current, index, {
                          ...flag,
                          on: event.target.checked,
                        }),
                      )
                    }
                  />
                </div>
                <NumberField
                  label="משקל"
                  className="w-24"
                  value={flag.points}
                  onChange={(points) =>
                    setDraft((current) =>
                      replaceFlag(current, index, { ...flag, points }),
                    )
                  }
                />
              </div>
            ))}
          </div>
        </fieldset>
      </Section>

      {/* ── 3 · The quantity rules ─────────────────────────────────────── */}
      <Section
        title="כללי הכמות"
        description="כל כמות שמנקה מקבלת נולדת כאן, ורק כאן. המנוע מכפיל, מחלק, מוסיף מרווח ומעגל כלפי מעלה — חצי מגבת היא מגבת — ואין בו אף מספר משלו."
      >
        {draft.rules.length === 0 ? (
          <EmptyState
            illustration="task"
            as="h3"
            title="עוד לא הוגדר אף כלל כמות"
            body="בלי כלל אחד לפחות, תוכנית ההכנה תכיל את המיטות והמצעים שלהן בלבד — לא מגבות, לא כלים ולא ניקיון."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {draft.rules.map((entry, index) => (
              <RuleCard
                key={index}
                rule={entry}
                sectionLabels={draft.sectionLabels}
                flags={draft.property.flags.map((flag) => flag.flag)}
                onChange={(next) =>
                  setDraft((current) => ({
                    ...current,
                    rules: replaceAt(current.rules, index, next),
                  }))
                }
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    rules: removeAt(current.rules, index),
                  }))
                }
              />
            ))}
          </div>
        )}

        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() =>
            setDraft((current) => ({
              ...current,
              rules: [...current.rules, blankRule()],
            }))
          }
        >
          הוסף כלל
        </Button>
      </Section>

      {/* ── 4 · The event templates ────────────────────────────────────── */}
      <Section
        title="תבניות אירוע"
        description="מה ששבת מוסיפה על לינה רגילה, ומה שחתונה מוסיפה על זה. תבנית אינה מנגנון נפרד — היא אוסף כללים רגילים שמגיע רק עם סוג אירוע אחד, ולכן ״מיחם שני מעל עשרים איש״ הוא עוד כלל מותנה ולא מקרה מיוחד."
      >
        {draft.eventTemplates.map((template, index) => (
          <TemplateCard
            key={index}
            template={template}
            sectionLabels={draft.sectionLabels}
            flags={draft.property.flags.map((flag) => flag.flag)}
            onChange={(next) =>
              setDraft((current) => ({
                ...current,
                eventTemplates: replaceAt(current.eventTemplates, index, next),
              }))
            }
            onRemove={() =>
              setDraft((current) => ({
                ...current,
                eventTemplates: removeAt(current.eventTemplates, index),
              }))
            }
          />
        ))}

        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() =>
            setDraft((current) => ({
              ...current,
              eventTemplates: [...current.eventTemplates, blankTemplate()],
            }))
          }
        >
          הוסף תבנית אירוע
        </Button>
      </Section>

      {/* ── 5 · Crew and clock ─────────────────────────────────────────── */}
      <Section
        title="צוות וזמן"
        description="כמה קשה ההזמנה הזו, ומשם כמה אנשים ולכמה זמן. כל משקל הוא הגדרה: עסק שכל בתיו סטודיו ועסק שמריץ חתונות אינם על אותה עקומה, ולמערכת אין דעה איזו נכונה. תעריף השעה אינו במסך הזה — הוא נתון כספי, וההרשאה שפותחת את המסך הזה אינה הרשאה כספית."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField
            label="נקודות לכל אורח"
            value={draft.complexity.perGuest}
            onChange={(perGuest) => setComplexity(setDraft, { perGuest })}
          />
          <NumberField
            label="נקודות לכל חדר שינה"
            value={draft.complexity.perBedroom}
            onChange={(perBedroom) => setComplexity(setDraft, { perBedroom })}
          />
          <NumberField
            label="נקודות לכל חדר רחצה"
            value={draft.complexity.perBathroom}
            onChange={(perBathroom) => setComplexity(setDraft, { perBathroom })}
          />
          <NumberField
            label="נקודות לכל מיטה נוספת"
            value={draft.complexity.perExtraBed}
            onChange={(perExtraBed) => setComplexity(setDraft, { perExtraBed })}
          />
          <NumberField
            label="נקודות לכל תוספת שהאורח ביקש"
            value={draft.complexity.perExtraItem}
            onChange={(perExtraItem) =>
              setComplexity(setDraft, { perExtraItem })
            }
          />
          <NumberField
            label="נקודות שאיש צוות אחד סופג"
            description="אפס פירושו איש אחד לכל הזמנה."
            value={draft.complexity.scorePerStaff}
            onChange={(scorePerStaff) =>
              setComplexity(setDraft, { scorePerStaff })
            }
          />
          <NumberField
            label="מינימום אנשי צוות"
            value={draft.complexity.minimumStaff}
            onChange={(minimumStaff) =>
              setComplexity(setDraft, { minimumStaff })
            }
          />
          <NumberField
            label="דקות לכל נקודת קושי"
            value={draft.complexity.minutesPerPoint}
            onChange={(minutesPerPoint) =>
              setComplexity(setDraft, { minutesPerPoint })
            }
          />
          <NumberField
            label="מינימום דקות"
            value={draft.complexity.minimumMinutes}
            onChange={(minimumMinutes) =>
              setComplexity(setDraft, { minimumMinutes })
            }
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            label="אחוז מוכנות קריטי"
            value={draft.readinessPolicy.criticalPercent}
            onChange={(criticalPercent) =>
              setReadiness(setDraft, { criticalPercent })
            }
          />
          <NumberField
            label="שעות לפני הגעה שנחשבות ״קרוב״"
            value={draft.readinessPolicy.criticalHours}
            onChange={(criticalHours) =>
              setReadiness(setDraft, { criticalHours })
            }
          />
          <NumberField
            label="אחוז מוכנות לאזהרה"
            value={draft.readinessPolicy.warningPercent}
            onChange={(warningPercent) =>
              setReadiness(setDraft, { warningPercent })
            }
          />
        </div>
      </Section>

      {/* ── 6 · The preview ────────────────────────────────────────────── */}
      <Section
        title="בדיקה על מסיבה אמיתית"
        description="הזן חבורה וקבל את התוכנית שהמנוע באמת מייצר עליה — אותה פונקציה שבונה תוכנית להזמנה אמיתית, על צילום קפוא של המדיניות שכתובה עכשיו במסך. עובד גם לפני שנשמר משהו."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <NumberField
            label="אורחים"
            value={party.guests}
            onChange={(guests) =>
              setParty((current) => ({ ...current, guests }))
            }
          />
          <NumberField
            label="מבוגרים"
            value={party.adults}
            onChange={(adults) =>
              setParty((current) => ({ ...current, adults }))
            }
          />
          <NumberField
            label="ילדים"
            value={party.children}
            onChange={(children) =>
              setParty((current) => ({ ...current, children }))
            }
          />
          <NumberField
            label="לילות"
            value={party.nights}
            onChange={(nights) =>
              setParty((current) => ({ ...current, nights }))
            }
          />
          <Field label="סוג האירוע">
            <Select
              value={party.eventType}
              onChange={(event) =>
                setParty((current) => ({
                  ...current,
                  eventType: event.target.value as PreviewParty['eventType'],
                }))
              }
            >
              {EVENTS.map((type) => (
                <option key={type} value={type}>
                  {EVENT_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Button
          variant="secondary"
          className="self-start"
          disabled={previewing.pending}
          onClick={() => void runPreview()}
        >
          {previewing.pending ? 'מחשב…' : 'חשב תוכנית'}
        </Button>

        {preview && <PolicyPreviewPanel preview={preview} />}
      </Section>

      {/* ── Saving ─────────────────────────────────────────────────────── */}
      {failure && <ActionError error={failure} />}

      {savedVersion !== null && !failure && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          מדיניות ההכנה של ״{propertyName}״ נשמרה. תוכניות שכבר נבנו להזמנות
          קיימות אינן משתנות — הן מחושבות מול צילום קפוא של החוקים שהיו בתוקף
          כשנבנו.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <Button disabled={saving.pending} onClick={() => void runSave()}>
          {saving.pending ? 'שומר…' : 'שמור מדיניות'}
        </Button>
        <span className="text-sm text-muted-foreground">
          {version === null
            ? 'הנכס הזה עוד לא הוגדר. השמירה הראשונה תיצור את המדיניות שלו.'
            : `עורך את גרסה ${version} של המדיניות. אם מישהו אחר ישמור לפניך, תקבל הודעה במקום דריסה שקטה.`}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- sections -- */

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <div className="mt-6 flex flex-col gap-5">{children}</div>
    </Card>
  )
}

/* -------------------------------------------------------------- the beds -- */

function BedTypeCard({
  type,
  stock,
  onChange,
  onRemove,
}: {
  type: DraftBedType
  stock: PolicyDraft['property']['beds'][number]
  onChange: (
    type: DraftBedType,
    stock: PolicyDraft['property']['beds'][number],
  ) => void
  onRemove: () => void
}) {
  const set = (patch: Partial<DraftBedType>) =>
    onChange(
      { ...type, ...patch },
      { ...stock, bedTypeId: patch.id ?? type.id },
    )
  const setStock = (patch: Partial<PolicyDraft['property']['beds'][number]>) =>
    onChange(type, { ...stock, ...patch })

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="שם המיטה" description="מה שמנקה רואה ברשימה.">
          <TextInput
            value={type.label}
            onChange={(event) => set({ label: event.target.value })}
          />
        </Field>

        <Field
          label="מזהה"
          description="מפתח הקטלוג שלך. מחבר כלל, מלאי ועלות."
        >
          <TextInput
            value={type.id}
            onChange={(event) => set({ id: event.target.value })}
          />
        </Field>

        <NumberField
          label="כמה ישנים בה"
          description="מקומות שינה שהמיטה נותנת."
          value={type.capacity}
          onChange={(capacity) => set({ capacity })}
        />

        <NumberField
          label="כמה מזרנים היא"
          description="מיטה יהודית היא שניים. משם נגזרת הכביסה."
          value={type.positions}
          onChange={(positions) => set({ positions })}
        />

        <NumberField
          label="דקות הצבה"
          value={type.setupMinutes}
          onChange={(setupMinutes) => set({ setupMinutes })}
        />

        <NumberField
          label="מוצבות ומוכנות"
          description="עומדות בחדר, לא עולות זמן."
          value={stock.permanent}
          onChange={(permanent) => setStock({ permanent })}
        />

        <NumberField
          label="במחסן"
          description="קיימות, נפתחות, עולות זמן הצבה."
          value={stock.storage}
          onChange={(storage) => setStock({ storage })}
        />

        <NumberField
          label="חסרות"
          description="נרשמו כלא קיימות. לא נספרות בשום מקום."
          value={stock.missing}
          onChange={(missing) => setStock({ missing })}
        />
      </div>

      <Checkbox
        label="אפשר להביא אותה כדי לכסות מחסור"
        description="לול אינו תשובה ל״חסרים לנו שלושה מקומות״."
        checked={type.usableAsExtra}
        onChange={(event) => set({ usableAsExtra: event.target.checked })}
      />

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-foreground">
          מה הצעת המיטה הזו צורכת
        </legend>
        <p className="text-xs text-muted-foreground">
          לכל מיטה מהסוג הזה, לא לכל מזרן. כך מיטה שרוצה מספר אי-זוגי של כריות
          יכולה לומר זאת.
        </p>

        {type.linen.map((item, index) => (
          <div key={index} className="grid gap-3 sm:grid-cols-4">
            <Field label="שם הפריט">
              <TextInput
                value={item.label}
                onChange={(event) =>
                  set({
                    linen: replaceAt(type.linen, index, {
                      ...item,
                      label: event.target.value,
                    }),
                  })
                }
              />
            </Field>
            <Field label="מזהה הפריט">
              <TextInput
                value={item.itemId}
                onChange={(event) =>
                  set({
                    linen: replaceAt(type.linen, index, {
                      ...item,
                      itemId: event.target.value,
                    }),
                  })
                }
              />
            </Field>
            <NumberField
              label="כמות"
              value={item.quantity}
              onChange={(quantity) =>
                set({
                  linen: replaceAt(type.linen, index, { ...item, quantity }),
                })
              }
            />
            <div className="flex items-end gap-2">
              <Field label="יחידה" className="flex-1">
                <Select
                  value={item.unit}
                  onChange={(event) =>
                    set({
                      linen: replaceAt(type.linen, index, {
                        ...item,
                        unit: event.target
                          .value as DraftBedType['linen'][number]['unit'],
                      }),
                    })
                  }
                >
                  {UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {UNIT_LABEL[unit]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set({ linen: removeAt(type.linen, index) })}
              >
                הסר
              </Button>
            </div>
          </div>
        ))}

        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() =>
            set({
              linen: [
                ...type.linen,
                { itemId: '', label: '', quantity: 0, unit: 'piece' as const },
              ],
            })
          }
        >
          הוסף פריט מצעים
        </Button>
      </fieldset>

      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={onRemove}
      >
        הסר את סוג המיטה
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------- the rules -- */

function RuleCard({
  rule,
  sectionLabels,
  flags,
  onChange,
  onRemove,
}: {
  rule: DraftRule
  sectionLabels: PolicyDraft['sectionLabels']
  flags: readonly string[]
  onChange: (rule: DraftRule) => void
  onRemove: () => void
}) {
  const set = (patch: Partial<DraftRule>) => onChange({ ...rule, ...patch })
  const condition = rule.condition
  const buffer = rule.buffer

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="שם הפריט" description="מה שמנקה רואה.">
          <TextInput
            value={rule.label}
            onChange={(event) => set({ label: event.target.value })}
          />
        </Field>

        <Field label="מזהה הפריט">
          <TextInput
            value={rule.itemId}
            onChange={(event) => set({ itemId: event.target.value })}
          />
        </Field>

        <Field
          label="מזהה הכלל"
          description="ייחודי. משמש גם למעקב אחרי שינויים."
        >
          <TextInput
            value={rule.id}
            onChange={(event) => set({ id: event.target.value })}
          />
        </Field>

        <Field label="קטגוריה">
          <Select
            value={rule.category}
            onChange={(event) =>
              set({ category: event.target.value as DraftRule['category'] })
            }
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABEL[category]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="יחידת מידה">
          <Select
            value={rule.unit}
            onChange={(event) =>
              set({ unit: event.target.value as DraftRule['unit'] })
            }
          >
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {UNIT_LABEL[unit]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="מקטע בתוכנית">
          <Select
            value={rule.section}
            onChange={(event) =>
              set({ section: event.target.value as PlanSectionKey })
            }
          >
            {SECTION_LABEL_KEYS.map((key) => (
              <option key={key} value={key}>
                {sectionLabels[key]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-medium text-foreground">
          כמה
        </legend>

        <Field label="נמדד">
          <Select
            value={rule.quantity.basis}
            onChange={(event) =>
              set({
                quantity: {
                  ...rule.quantity,
                  basis: event.target.value as DraftRule['quantity']['basis'],
                },
              })
            }
          >
            {BASES.map((basis) => (
              <option key={basis} value={basis}>
                {BASIS_LABEL[basis]}
              </option>
            ))}
          </Select>
        </Field>

        <NumberField
          label="כפול"
          value={rule.quantity.factor}
          onChange={(factor) => set({ quantity: { ...rule.quantity, factor } })}
        />
        <NumberField
          label="חלקי"
          description="שתיים פירושו ״לכל זוג״."
          value={rule.quantity.divisor}
          onChange={(divisor) =>
            set({ quantity: { ...rule.quantity, divisor } })
          }
        />
        <NumberField
          label="ועוד"
          value={rule.quantity.plus}
          onChange={(plus) => set({ quantity: { ...rule.quantity, plus } })}
        />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-2 text-sm font-medium text-foreground">
          מרווח ביטחון
        </legend>

        <Field
          label="סוג"
          description="אחוז על מספר קטן מתעגל לאפס; שניים קבוע על חתונה אינו מרווח."
        >
          <Select
            value={buffer === null ? 'none' : buffer.kind}
            onChange={(event) => {
              const kind = event.target.value
              set({
                buffer:
                  kind === 'none'
                    ? null
                    : kind === 'percent'
                      ? { kind: 'percent', percent: 0, amount: null }
                      : { kind: 'flat', percent: null, amount: 0 },
              })
            }}
          >
            <option value="none">ללא</option>
            <option value="percent">אחוז</option>
            <option value="flat">תוספת קבועה</option>
          </Select>
        </Field>

        {buffer?.kind === 'percent' && (
          <NumberField
            label="אחוזים"
            value={buffer.percent ?? 0}
            onChange={(percent) =>
              set({ buffer: { kind: 'percent', percent, amount: null } })
            }
          />
        )}

        {buffer?.kind === 'flat' && (
          <NumberField
            label="תוספת"
            value={buffer.amount ?? 0}
            onChange={(amount) =>
              set({ buffer: { kind: 'flat', percent: null, amount } })
            }
          />
        )}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-medium text-foreground">
          מתי הכלל חל
        </legend>

        <Field label="תנאי">
          <Select
            value={condition === null ? 'none' : condition.kind}
            onChange={(event) => {
              const kind = event.target.value
              set({
                condition:
                  kind === 'none'
                    ? null
                    : kind === 'compare'
                      ? {
                          kind: 'compare',
                          basis: 'guests',
                          comparator: 'gte',
                          value: 0,
                          flag: null,
                          equals: null,
                        }
                      : {
                          kind: 'flag',
                          basis: null,
                          comparator: null,
                          value: null,
                          flag: flags[0] ?? '',
                          equals: true,
                        },
              })
            }}
          >
            <option value="none">תמיד</option>
            <option value="compare">לפי כמות</option>
            <option value="flag">לפי מאפיין הנכס</option>
          </Select>
        </Field>

        {condition?.kind === 'compare' && (
          <>
            <Field label="הכמות">
              <Select
                value={condition.basis ?? 'guests'}
                onChange={(event) =>
                  set({
                    condition: {
                      ...condition,
                      basis: event.target
                        .value as DraftRule['quantity']['basis'],
                    },
                  })
                }
              >
                {BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {BASIS_LABEL[basis]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="ההשוואה">
              <Select
                value={condition.comparator ?? 'gte'}
                onChange={(event) =>
                  set({
                    condition: {
                      ...condition,
                      comparator: event.target.value as NonNullable<
                        DraftRule['condition']
                      >['comparator'],
                    },
                  })
                }
              >
                {COMPARATORS.map((comparator) => (
                  <option key={comparator} value={comparator}>
                    {COMPARATOR_LABEL[comparator]}
                  </option>
                ))}
              </Select>
            </Field>

            <NumberField
              label="הערך"
              value={condition.value ?? 0}
              onChange={(value) => set({ condition: { ...condition, value } })}
            />
          </>
        )}

        {condition?.kind === 'flag' && (
          <>
            <Field label="המאפיין">
              <Select
                value={condition.flag ?? ''}
                onChange={(event) =>
                  set({ condition: { ...condition, flag: event.target.value } })
                }
              >
                {flags.map((flag) => (
                  <option key={flag} value={flag}>
                    {labelForFlag(flag)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="כשהוא">
              <Select
                value={condition.equals === false ? 'false' : 'true'}
                onChange={(event) =>
                  set({
                    condition: {
                      ...condition,
                      equals: event.target.value === 'true',
                    },
                  })
                }
              >
                <option value="true">קיים</option>
                <option value="false">לא קיים</option>
              </Select>
            </Field>
          </>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="דקות עבודה ליחידה"
          value={rule.minutesPerUnit}
          onChange={(minutesPerUnit) => set({ minutesPerUnit })}
        />
        <Checkbox
          label="דורש צילום"
          description="כלל שדורש הוכחה גובר על כלל שאינו דורש — בקרה שכלל שני יכול לכבות אינה בקרה."
          checked={rule.requiresPhoto}
          onChange={(event) => set({ requiresPhoto: event.target.checked })}
        />
      </div>

      <Field label="הנחיה שמופיעה מתחת לפריט">
        <Textarea
          rows={2}
          value={rule.instructions ?? ''}
          onChange={(event) =>
            set({
              instructions:
                event.target.value.trim() === '' ? null : event.target.value,
            })
          }
        />
      </Field>

      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={onRemove}
      >
        הסר את הכלל
      </Button>
    </div>
  )
}

/* --------------------------------------------------------- the templates -- */

function TemplateCard({
  template,
  sectionLabels,
  flags,
  onChange,
  onRemove,
}: {
  template: DraftTemplate
  sectionLabels: PolicyDraft['sectionLabels']
  flags: readonly string[]
  onChange: (template: DraftTemplate) => void
  onRemove: () => void
}) {
  const set = (patch: Partial<DraftTemplate>) =>
    onChange({ ...template, ...patch })

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border-strong bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="שם התבנית">
          <TextInput
            value={template.label}
            onChange={(event) => set({ label: event.target.value })}
          />
        </Field>

        <Field label="מזהה">
          <TextInput
            value={template.id}
            onChange={(event) => set({ id: event.target.value })}
          />
        </Field>

        <Field label="סוג האירוע">
          <Select
            value={template.eventType}
            onChange={(event) =>
              set({
                eventType: event.target.value as DraftTemplate['eventType'],
              })
            }
          >
            {EVENTS.map((type) => (
              <option key={type} value={type}>
                {EVENT_TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
        </Field>

        <NumberField
          label="נקודות קושי שהאירוע מוסיף"
          value={template.points}
          onChange={(points) => set({ points })}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-foreground">
          מקטעים שיוצגו גם אם ריקים
        </legend>
        <p className="text-xs text-muted-foreground">
          שבת שעוד אין בה כלום במקטע הקמת האירוע היא מקטע שצריך לראות, לא מקטע
          שצריך להסתיר.
        </p>
        <div className="flex flex-wrap gap-3">
          {SECTION_LABEL_KEYS.map((key) => (
            <label
              key={key}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm',
                template.sections.includes(key)
                  ? 'border-primary bg-surface-raised text-foreground'
                  : 'border-border text-muted-foreground',
              )}
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={template.sections.includes(key)}
                onChange={(event) =>
                  set({
                    sections: event.target.checked
                      ? [...template.sections, key]
                      : template.sections.filter((entry) => entry !== key),
                  })
                }
              />
              {sectionLabels[key]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-4">
        {template.rules.map((entry, index) => (
          <RuleCard
            key={index}
            rule={entry}
            sectionLabels={sectionLabels}
            flags={flags}
            onChange={(next) =>
              set({ rules: replaceAt(template.rules, index, next) })
            }
            onRemove={() => set({ rules: removeAt(template.rules, index) })}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            set({
              rules: [
                ...template.rules,
                { ...blankRule(), section: 'event_setup' as PlanSectionKey },
              ],
            })
          }
        >
          הוסף כלל לתבנית
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          הסר את התבנית
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ primitives -- */

function NumberField({
  label,
  description,
  value,
  onChange,
  className,
}: {
  label: string
  description?: string
  value: number
  onChange: (value: number) => void
  className?: string
}) {
  return (
    <Field label={label} description={description} className={className}>
      <TextInput
        inputMode="decimal"
        value={String(value)}
        onChange={(event) => onChange(toNumber(event.target.value))}
      />
    </Field>
  )
}

/**
 * An empty box is zero, not `NaN`.
 *
 * A rule whose divisor became `NaN` would reach the server, fail the schema and
 * tell somebody about a field they had merely cleared. Zero is what the engine
 * already treats safely — `resolveQuantity` reads a zero divisor as one rather
 * than producing `Infinity`.
 */
function toNumber(raw: string): number {
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function labelForFlag(flag: string): string {
  return KNOWN_FLAGS.find((known) => known.flag === flag)?.label ?? flag
}

function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  return list.map((entry, position) => (position === index ? value : entry))
}

function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, position) => position !== index)
}

function replaceFlag(
  draft: PolicyDraft,
  index: number,
  value: PolicyDraft['property']['flags'][number],
): PolicyDraft {
  return {
    ...draft,
    property: {
      ...draft.property,
      flags: replaceAt(draft.property.flags, index, value),
    },
  }
}

function setComplexity(
  setDraft: (update: (current: PolicyDraft) => PolicyDraft) => void,
  patch: Partial<PolicyDraft['complexity']>,
): void {
  setDraft((current) => ({
    ...current,
    complexity: { ...current.complexity, ...patch },
  }))
}

function setReadiness(
  setDraft: (update: (current: PolicyDraft) => PolicyDraft) => void,
  patch: Partial<PolicyDraft['readinessPolicy']>,
): void {
  setDraft((current) => ({
    ...current,
    readinessPolicy: { ...current.readinessPolicy, ...patch },
  }))
}

/**
 * A bed type and its stock are added and removed together.
 *
 * They live in two arrays on the domain side — a catalogue of kinds, and what
 * one property holds of each — and are one card on screen, because that is one
 * thought: "we have five double beds". A stock row left behind by a deleted
 * bed type is a row the engine skips in silence.
 */
function addBedType(draft: PolicyDraft): PolicyDraft {
  const id = `bed_${draft.bedTypes.length + 1}`
  return {
    ...draft,
    bedTypes: [
      ...draft.bedTypes,
      {
        id,
        label: '',
        capacity: 0,
        positions: 0,
        setupMinutes: 0,
        usableAsExtra: false,
        linen: [],
      },
    ],
    property: {
      ...draft.property,
      beds: [
        ...draft.property.beds,
        { bedTypeId: id, permanent: 0, storage: 0, missing: 0 },
      ],
    },
  }
}

function replaceBedType(
  draft: PolicyDraft,
  index: number,
  type: DraftBedType,
  stock: PolicyDraft['property']['beds'][number],
): PolicyDraft {
  const previousId = draft.bedTypes[index]?.id
  const beds = draft.property.beds.some(
    (entry) => entry.bedTypeId === previousId,
  )
    ? draft.property.beds.map((entry) =>
        entry.bedTypeId === previousId
          ? { ...stock, bedTypeId: type.id }
          : entry,
      )
    : [...draft.property.beds, { ...stock, bedTypeId: type.id }]

  return {
    ...draft,
    bedTypes: replaceAt(draft.bedTypes, index, type),
    property: {
      ...draft.property,
      beds,
      // A renamed bed type takes the "extra sleeping" choice with it, rather
      // than leaving it pointing at an id that no longer exists.
      extraSleepingBedTypeId:
        draft.property.extraSleepingBedTypeId === previousId
          ? type.id
          : draft.property.extraSleepingBedTypeId,
    },
  }
}

function removeBedType(draft: PolicyDraft, index: number): PolicyDraft {
  const removed = draft.bedTypes[index]?.id

  return {
    ...draft,
    bedTypes: removeAt(draft.bedTypes, index),
    property: {
      ...draft.property,
      beds: draft.property.beds.filter((entry) => entry.bedTypeId !== removed),
      extraSleepingBedTypeId:
        draft.property.extraSleepingBedTypeId === removed
          ? ''
          : draft.property.extraSleepingBedTypeId,
    },
  }
}

function blankRule(): DraftRule {
  return {
    id: `rule_${crypto.randomUUID().slice(0, 8)}`,
    category: 'consumables',
    itemId: '',
    label: '',
    unit: 'piece',
    quantity: { basis: 'guests', factor: 1, divisor: 1, plus: 0 },
    condition: null,
    buffer: null,
    section: 'kitchen',
    requiresPhoto: false,
    instructions: null,
    minutesPerUnit: 0,
  }
}

function blankTemplate(): DraftTemplate {
  return {
    id: `template_${crypto.randomUUID().slice(0, 8)}`,
    eventType: 'shabbat',
    label: '',
    sections: ['event_setup'],
    rules: [],
    points: 0,
  }
}
