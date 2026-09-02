'use client'

/**
 * The guest journey, configured.
 *
 * ── Seven sections, and nothing switched on that was not asked for ────────
 *
 * The principle this screen is built around is that a business sees complexity
 * only when it has asked for it. So every section that can be off is off in
 * the shipped default, and every section that IS on reveals its detail only
 * once it is: the hours box appears when the release policy is "a fixed time
 * before arrival" and not before, the request categories appear when requests
 * are on, the review link appears when reviews are on. A villa owner who opens
 * this screen and saves nothing already has a working portal.
 *
 * ── Why one save and not seven ────────────────────────────────────────────
 *
 * The row is one row. Seven independent saves would be seven audit events for
 * one sitting, seven chances for half a configuration to land, and seven
 * versions to lock against. The sections are independent in what they *mean* —
 * turning the contract on says nothing about reviews, which is what the
 * requirement is about — and they are not independent in what they write.
 *
 * ── Leaf imports only ─────────────────────────────────────────────────────
 *
 * `@/lib/guest-journey/presets` and `/types` are pure.
 * `@/lib/guest-journey/settings` is NOT — it carries the repository and the
 * operations, and reaches the Postgres driver. Importing it here, or the
 * `@/lib/guest-journey` barrel, takes every route in the application down with
 * `Can't resolve 'fs'`. The labels this form needs live in `presets.ts` for
 * exactly that reason.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  saveJourneySettingsAction,
  type SaveJourneySettingsInput,
} from '@/app/(app)/settings/guest-journey/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { fieldErrorsFrom } from '@/components/onboarding/field-errors'
import { JourneyPreview } from '@/components/journey-settings/journey-preview'
import { Panel, PanelNote } from '@/components/shell-screens/screen'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import type { GuestCollection } from '@/lib/guest-journey/collection'
import {
  CONTRACT_MODE_DESCRIPTION,
  CONTRACT_MODE_LABEL,
  DURING_STAY_TOPICS,
  DURING_STAY_TOPIC_LABEL,
  RECONFIRMATION_TRIGGER_LABEL,
  type DuringStayTopic,
} from '@/lib/guest-journey/presets'
import {
  GUEST_ARRIVAL_RELEASES,
  GUEST_ARRIVAL_RELEASE_LABEL,
  GUEST_CONTRACT_MODES,
  GUEST_DETAIL_FIELDS,
  GUEST_DETAIL_FIELD_LABEL,
  GUEST_REQUEST_CATEGORIES,
  GUEST_REQUEST_CATEGORY_LABEL,
  RECONFIRMATION_TRIGGERS,
  type GuestArrivalRelease,
  type GuestContractMode,
  type GuestDetailField,
  type GuestJourneySettings,
  type GuestRequestCategory,
  type ReconfirmationTrigger,
} from '@/lib/guest-journey/types'

/** What each release policy means for the person who has to choose one. */
const RELEASE_DESCRIPTION: Record<GuestArrivalRelease, string> = {
  immediate:
    'הכתובת וקוד הכניסה גלויים לכל מי שמחזיק בקישור, מרגע ששלחתם אותו.',
  after_confirmation: 'נחשפים ברגע שהאורח מאשר את פרטי ההזמנה.',
  after_contract: 'נחשפים אחרי שהאורח חתם על החוזה. דורש חוזה פעיל.',
  after_deposit: 'נחשפים אחרי שהמקדמה נרשמה במערכת.',
  after_full_payment: 'נחשפים אחרי שההזמנה שולמה במלואה.',
  hours_before: 'נחשפים מספר שעות קבוע לפני מועד ההגעה.',
  manual: 'לא נחשפים עד שמישהו מהצוות משחרר אותם, לכל הזמנה בנפרד.',
}

const TOPIC_DESCRIPTION: Record<DuringStayTopic, string> = {
  wifi: 'שם הרשת והסיסמה, ראשונים בעמוד — זו הבקשה הנפוצה ביותר בכל שהות.',
  guide: 'מדריך הנכס כפי שנכתב בתוכן מסע האורח.',
  access: 'הוראות הכניסה לנכס.',
  checkout: 'מה צריך לעשות לפני שיוצאים.',
}

/** How a single guest detail is treated. Three states, one control. */
type DetailChoice = 'off' | 'optional' | 'required'

function detailChoice(
  settings: GuestJourneySettings,
  field: GuestDetailField,
): DetailChoice {
  if (settings.requiredDetailFields.includes(field)) return 'required'
  if (settings.optionalDetailFields.includes(field)) return 'optional'
  return 'off'
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value]
}

export function JourneySettingsForm({
  initial,
  expectedVersion,
  isShippedDefault,
  collection,
}: {
  /** What is in force: the saved row's values, or 0034's column defaults. */
  initial: GuestJourneySettings
  /** `null` when no row exists yet and saving will create one. */
  expectedVersion: number | null
  /** True when nobody has ever saved — rendered as a statement, not a gap. */
  isShippedDefault: boolean
  /** Resolved on the server, by the payment module's own resolver. */
  collection: GuestCollection
}) {
  const router = useRouter()

  const [draft, setDraft] = useState<GuestJourneySettings>(initial)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)

  const save = useAsyncAction<void>()
  const errors = fieldErrorsFrom(failure)

  function patch(next: Partial<GuestJourneySettings>) {
    setSavedNotice(false)
    setDraft((current) => ({ ...current, ...next }))
  }

  function setDetail(field: GuestDetailField, choice: DetailChoice) {
    patch({
      requiredDetailFields:
        choice === 'required'
          ? [...new Set([...draft.requiredDetailFields, field])]
          : draft.requiredDetailFields.filter((entry) => entry !== field),
      optionalDetailFields:
        choice === 'optional'
          ? [...new Set([...draft.optionalDetailFields, field])]
          : draft.optionalDetailFields.filter((entry) => entry !== field),
    })
  }

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        setFailure(null)
        setSavedNotice(false)
        if (save.pending) return

        const input: SaveJourneySettingsInput = {
          ...draft,
          // Absent is null, never `''` — an empty string is a value, and
          // `guest_journey_settings_review_has_url` treats it as one.
          reviewUrl: draft.reviewUrl?.trim() ? draft.reviewUrl.trim() : null,
          expectedVersion,
          // One key per submission, so a double click is one save and a
          // deliberate second edit is a second one.
          idempotencyKey: crypto.randomUUID(),
        }

        void save.run(async () => {
          const result = await saveJourneySettingsAction(input)
          if (!result.ok) {
            setFailure(result.error)
            return
          }
          setSavedNotice(true)
          router.refresh()
        })
      }}
    >
      {failure && <ActionError error={failure} />}

      {isShippedDefault && (
        <PanelNote>
          עדיין לא נשמרו כאן הגדרות, והאורחים שלכם מקבלים את ברירת המחדל: האורח
          מתבקש לאשר את ההזמנה, לא נדרש תשלום לפני האישור, אין חוזה, ופרטי ההגעה
          נחשפים ברגע האישור. זו הגדרה שלמה — אפשר לשמור אותה כמות שהיא או
          לשנות.
        </PanelNote>
      )}

      {/* ── 1 · Booking confirmation ─────────────────────────────────── */}
      <Panel
        title="אישור ההזמנה"
        description="האם האורח נדרש לאשר את התאריכים, מספר האורחים והמחיר לפני שההזמנה מתקדמת."
      >
        <div className="flex flex-col gap-5">
          <Checkbox
            label="האורח מאשר את פרטי ההזמנה"
            description="כיבוי מתאים לבית אירוח שסוגר הכול בטלפון. האורח עדיין יראה את ההזמנה, פשוט לא יתבקש לאשר."
            checked={draft.requireGuestConfirmation}
            disabled={save.pending}
            onChange={(event) =>
              patch({ requireGuestConfirmation: event.target.checked })
            }
          />

          {draft.requireGuestConfirmation && (
            <fieldset className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4">
              <legend className="px-1 text-sm font-semibold text-foreground">
                מה מבטל אישור שכבר ניתן
              </legend>
              <p className="text-sm text-muted-foreground">
                אורח שאישר ₪7,500 לא אישר ₪8,000. כשאחד מאלה משתנה, האורח מתבקש
                לאשר מחדש.
              </p>
              {RECONFIRMATION_TRIGGERS.map((trigger: ReconfirmationTrigger) => (
                <Checkbox
                  key={trigger}
                  label={RECONFIRMATION_TRIGGER_LABEL[trigger]}
                  checked={draft.reconfirmationTriggers.includes(trigger)}
                  disabled={save.pending}
                  onChange={() =>
                    patch({
                      reconfirmationTriggers: toggle(
                        draft.reconfirmationTriggers,
                        trigger,
                      ),
                    })
                  }
                />
              ))}
            </fieldset>
          )}
        </div>
      </Panel>

      {/* ── 2 · Contract ─────────────────────────────────────────────── */}
      <Panel
        title="חוזה"
        description="נוסח החוזה עצמו נשמר בתבניות החוזה. כאן נקבע רק אם הוא מוצג לאורח, ואם חובה לחתום."
      >
        <Field
          label="חוזה לחתימת האורח"
          description={CONTRACT_MODE_DESCRIPTION[draft.contractMode]}
          error={errors.contractMode}
        >
          <Select
            value={draft.contractMode}
            disabled={save.pending}
            onChange={(event) =>
              patch({ contractMode: event.target.value as GuestContractMode })
            }
          >
            {GUEST_CONTRACT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {CONTRACT_MODE_LABEL[mode]}
              </option>
            ))}
          </Select>
        </Field>
      </Panel>

      {/* ── 3 · Guest information ────────────────────────────────────── */}
      <Panel
        title="פרטי האורח"
        description="מה האורח מתבקש למלא. שדה שאינו נשאל פשוט לא מופיע לו — אין טופס עם שדות אפורים."
      >
        <div className="flex flex-col">
          {GUEST_DETAIL_FIELDS.map((field) => (
            <div
              key={field}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span className="text-[0.9375rem] text-foreground">
                {GUEST_DETAIL_FIELD_LABEL[field]}
              </span>
              <Select
                className="w-44"
                aria-label={GUEST_DETAIL_FIELD_LABEL[field]}
                value={detailChoice(draft, field)}
                disabled={save.pending}
                onChange={(event) =>
                  setDetail(field, event.target.value as DetailChoice)
                }
              >
                <option value="off">לא נשאל</option>
                <option value="optional">רשות</option>
                <option value="required">חובה</option>
              </Select>
            </div>
          ))}
        </div>

        {draft.requiredDetailFields.length === 0 && (
          <PanelNote>
            אין שדות חובה, ולכן שלב &quot;פרטי האורח&quot; לא יופיע לאורח כלל.
            זו הגדרה תקינה.
          </PanelNote>
        )}
      </Panel>

      {/* ── 4 · Arrival ──────────────────────────────────────────────── */}
      <Panel
        title="הגעה"
        description="מתי הכתובת, הוראות ההגעה, החניה וקוד הכניסה נחשפים לאורח. זו החלטת אבטחה, והשינוי נרשם ביומן הביקורת."
      >
        <div className="flex flex-col gap-5">
          <Field
            label="מתי נחשפים פרטי ההגעה"
            description={RELEASE_DESCRIPTION[draft.arrivalRelease]}
            error={errors.arrivalRelease}
          >
            <Select
              value={draft.arrivalRelease}
              disabled={save.pending}
              onChange={(event) =>
                patch({
                  arrivalRelease: event.target.value as GuestArrivalRelease,
                })
              }
            >
              {GUEST_ARRIVAL_RELEASES.map((release) => (
                <option key={release} value={release}>
                  {GUEST_ARRIVAL_RELEASE_LABEL[release]}
                </option>
              ))}
            </Select>
          </Field>

          {draft.arrivalRelease === 'hours_before' && (
            <Field
              label="כמה שעות לפני ההגעה"
              description="בין 0 ל-720 שעות. 24 הוא הערב שלפני."
              error={errors.arrivalReleaseHours}
            >
              <TextInput
                value={String(draft.arrivalReleaseHours)}
                inputMode="numeric"
                dir="ltr"
                disabled={save.pending}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10)
                  patch({
                    arrivalReleaseHours: Number.isNaN(parsed) ? 0 : parsed,
                  })
                }}
              />
            </Field>
          )}

          {draft.arrivalRelease === 'immediate' && (
            <PanelNote>
              כל מי שמחזיק בקישור — כולל מי שקיבל אותו בהעברה — יראה את הכתובת
              ואת קוד הכניסה מיד. זו בחירה לגיטימית, וכדאי שתהיה מודעת.
            </PanelNote>
          )}

          {draft.arrivalRelease === 'after_contract' &&
            draft.contractMode === 'disabled' && (
              <PanelNote>
                בחרתם לשחרר את פרטי ההגעה רק אחרי חתימה, אך החוזה כבוי — כך אף
                אורח לא יקבל את הכתובת לעולם. השמירה תסורב עד שתפעילו חוזה או
                תבחרו מועד אחר.
              </PanelNote>
            )}
        </div>
      </Panel>

      {/* ── 5 · During the stay ──────────────────────────────────────── */}
      <Panel
        title="במהלך השהות"
        description="מה האורח רואה בעמוד השהות, ואם הוא יכול לבקש משהו."
      >
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold text-foreground">
              מה מוצג
            </legend>
            {DURING_STAY_TOPICS.map((topic) => (
              <Checkbox
                key={topic}
                label={DURING_STAY_TOPIC_LABEL[topic]}
                description={TOPIC_DESCRIPTION[topic]}
                checked={draft.duringStayTopics.includes(topic)}
                disabled={save.pending}
                onChange={() =>
                  patch({
                    duringStayTopics: toggle(draft.duringStayTopics, topic),
                  })
                }
              />
            ))}
          </fieldset>

          <Checkbox
            label="האורח יכול לשלוח בקשה"
            description="מגבות, תקלה, ניקיון. הבקשה מגיעה ישירות לרשימת המשימות של הצוות."
            checked={draft.requestsEnabled}
            disabled={save.pending}
            onChange={(event) =>
              patch({ requestsEnabled: event.target.checked })
            }
          />

          {draft.requestsEnabled && (
            <fieldset className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4">
              <legend className="px-1 text-sm font-semibold text-foreground">
                אילו סוגי בקשות
              </legend>
              {errors.requestCategories && (
                <p className="text-sm text-danger">
                  {errors.requestCategories}
                </p>
              )}
              {GUEST_REQUEST_CATEGORIES.map(
                (category: GuestRequestCategory) => (
                  <Checkbox
                    key={category}
                    label={GUEST_REQUEST_CATEGORY_LABEL[category]}
                    checked={draft.requestCategories.includes(category)}
                    disabled={save.pending}
                    onChange={() =>
                      patch({
                        requestCategories: toggle(
                          draft.requestCategories,
                          category,
                        ),
                      })
                    }
                  />
                ),
              )}
            </fieldset>
          )}
        </div>
      </Panel>

      {/* ── 6 · Checkout ─────────────────────────────────────────────── */}
      <Panel
        title="יציאה"
        description="הוראות היציאה עצמן נכתבות לכל נכס בנפרד, בתוכן מסע האורח. כאן נקבע רק אם האורח יכול להצהיר שיצא."
      >
        <Checkbox
          label="האורח יכול להצהיר שיצא"
          description="הצוות רואה את ההצהרה מיד, ויכול לשלוח מנקה בלי לטלפן ולשאול."
          checked={draft.checkoutDeclarationEnabled}
          disabled={save.pending}
          onChange={(event) =>
            patch({ checkoutDeclarationEnabled: event.target.checked })
          }
        />
      </Panel>

      {/* ── 7 · Review ───────────────────────────────────────────────── */}
      <Panel title="ביקורת" description="מה מוצג לאורח אחרי שיצא.">
        <div className="flex flex-col gap-5">
          <Checkbox
            label="בקשת ביקורת"
            description="מוצגת אחרי הצהרת היציאה, עם קישור לאן שתבחרו."
            checked={draft.reviewEnabled}
            disabled={save.pending}
            onChange={(event) => patch({ reviewEnabled: event.target.checked })}
          />

          {draft.reviewEnabled && (
            <Field
              label="קישור לביקורת"
              description="גוגל, פייסבוק, או כל טופס שלכם. חייב להתחיל ב-https://, ובלעדיו השמירה תסורב."
              error={errors.reviewUrl}
              required
            >
              <TextInput
                value={draft.reviewUrl ?? ''}
                dir="ltr"
                maxLength={2000}
                disabled={save.pending}
                onChange={(event) => patch({ reviewUrl: event.target.value })}
              />
            </Field>
          )}

          <Checkbox
            label="הצעה לשהות נוספת"
            description="תאריכים יוצגו רק אם הם באמת פנויים. כשאין מידע זמין, האורח מוזמן לשאול."
            checked={draft.rebookEnabled}
            disabled={save.pending}
            onChange={(event) => patch({ rebookEnabled: event.target.checked })}
          />
        </div>
      </Panel>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.pending}>
          {save.pending ? 'שומר…' : 'שמור הגדרות'}
        </Button>
        {savedNotice && (
          <span role="status" className="text-sm text-muted-foreground">
            נשמר.
          </span>
        )}
      </div>

      {/* ── The consequence, computed from the draft above ───────────── */}
      <Panel
        title="כך זה ייראה לאורח"
        description="מחושב מההגדרות שעל המסך ברגע זה, באותן פונקציות שמפעילות את עמוד האורח האמיתי."
      >
        <JourneyPreview settings={draft} collection={collection} />
      </Panel>
    </form>
  )
}
