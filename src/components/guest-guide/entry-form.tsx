'use client'

/**
 * WRITING ONE PIECE OF THE GUIDE.
 *
 * ══ THERE IS NO FIELD FOR A DOOR CODE ON THIS FORM ═════════════════════════
 *
 * "מכיל קוד או סוד" is a checkbox, and it declares that a secret belongs to
 * this entry. The value is typed on a different form, in a different request,
 * through a different Server Action — see `SecretForm` and the header of
 * `_lib/actions.ts`. If the code were an input here, every ordinary edit to
 * the pool hours would carry it through the request body, through validation,
 * into the audit diff and into whatever logs the request.
 *
 * ══ THE RELEASE RULE IS ON THIS FORM AND NOT ON A GLOBAL SETTING ═══════════
 *
 * Per entry, because a property genuinely has more than one answer: directions
 * go out immediately, the gate code after the deposit, the wi-fi once the stay
 * has begun. The vocabulary is the same one `guest_journey_settings.
 * arrival_release` uses, so an operator who has already set the journey's
 * policy reads the same words here and does not have to reconcile two.
 *
 * ── Marked sensitive with `immediate` is refused ──────────────────────────
 *
 * Before the request, with a sentence rather than a validation error after the
 * fact. A code that is released immediately is a code on a link, and the
 * database refuses it too — `guide_entries_secret_needs_condition`. Saying so
 * here is what stops somebody discovering it after typing a paragraph.
 *
 * ── Leaf imports only ─────────────────────────────────────────────────────
 *
 * `@/lib/guest-guide/labels` and `.../types` are pure data. The barrel reaches
 * `@/lib/persistence` and the Postgres driver, and importing it from a Client
 * Component would take every route in the application down.
 */

import { useState } from 'react'

import {
  saveGuideEntryAction,
  type ActionResult,
} from '@/app/(app)/settings/guest-guide/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Checkbox, Select, TextInput, Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import {
  RELEASE_MODE_LABEL,
  STAGE_LABEL,
  TOPIC_LABEL,
} from '@/lib/guest-guide/labels'
import {
  GUIDE_ICONS,
  GUIDE_RELEASE_MODES,
  GUIDE_STAGES,
  GUIDE_TOPICS,
  MAX_RELEASE_HOURS,
  TOPIC_DEFAULT_STAGE,
  type GuideEntry,
  type GuideIcon,
  type GuideReleaseMode,
  type GuideStage,
  type GuideTopic,
} from '@/lib/guest-guide/types'

export function EntryForm({
  propertyId,
  entry,
  onSaved,
}: {
  propertyId: string
  /** `null` to add a new entry. */
  entry: GuideEntry | null
  onSaved?: () => void
}) {
  const [topic, setTopic] = useState<GuideTopic>(entry?.topic ?? 'wifi')
  const [stage, setStage] = useState<GuideStage>(
    entry?.stage ?? TOPIC_DEFAULT_STAGE[entry?.topic ?? 'wifi'],
  )
  const [titleHe, setTitleHe] = useState(entry?.title.he ?? '')
  const [titleEn, setTitleEn] = useState(entry?.title.en ?? '')
  const [bodyHe, setBodyHe] = useState(entry?.body?.he ?? '')
  const [bodyEn, setBodyEn] = useState(entry?.body?.en ?? '')
  const [icon, setIcon] = useState<GuideIcon | ''>(entry?.icon ?? '')
  const [linkUrl, setLinkUrl] = useState(entry?.link?.url ?? '')
  const [linkLabel, setLinkLabel] = useState(entry?.link?.label.he ?? '')
  const [sortOrder, setSortOrder] = useState(String(entry?.sortOrder ?? 0))
  const [isActive, setIsActive] = useState(entry?.isActive ?? true)
  const [hasSecret, setHasSecret] = useState(entry?.hasSecret ?? false)
  const [releaseMode, setReleaseMode] = useState<GuideReleaseMode>(
    entry?.release.mode ?? 'immediate',
  )
  const [releaseHours, setReleaseHours] = useState(
    String(entry?.release.hours ?? 24),
  )

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)
  const save = useAsyncAction<void>()

  // Said before the button, never discovered after it. The database refuses
  // the same combination — see the header.
  const secretIsImmediate = hasSecret && releaseMode === 'immediate'
  const linkIsHalfWritten =
    linkUrl.trim().length > 0 !== linkLabel.trim().length > 0

  const blocked =
    titleHe.trim().length === 0 || secretIsImmediate || linkIsHalfWritten

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked || save.pending) return

        setFailure(null)
        setSaved(false)

        void save.run(async () => {
          const result: ActionResult<{ id: string }> =
            await saveGuideEntryAction({
              propertyId,
              entryId: entry?.id ?? null,
              stage,
              topic,
              title: withOptional(titleHe, titleEn),
              body:
                bodyHe.trim().length === 0
                  ? null
                  : withOptional(bodyHe, bodyEn),
              icon: icon === '' ? null : icon,
              linkUrl: linkUrl.trim().length === 0 ? null : linkUrl.trim(),
              linkLabel:
                linkLabel.trim().length === 0 ? null : { he: linkLabel.trim() },
              sortOrder: Number(sortOrder) || 0,
              isActive,
              hasSecret,
              releaseMode,
              releaseHours: Number(releaseHours) || 0,
              idempotencyKey: crypto.randomUUID(),
            })

          if (!result.ok) {
            setFailure(result.error)
            return
          }
          setSaved(true)
          onSaved?.()
        })
      }}
    >
      {failure && <ActionError error={failure} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="נושא" required>
          <Select
            value={topic}
            onChange={(event) => {
              const next = event.target.value as GuideTopic
              setTopic(next)
              // The stage follows the topic until somebody moves it. A guide
              // whose author has to think about "שלב" before writing about the
              // barbecue is a guide with fewer entries in it.
              setStage(TOPIC_DEFAULT_STAGE[next])
            }}
          >
            {GUIDE_TOPICS.map((value) => (
              <option key={value} value={value}>
                {TOPIC_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="שלב" required>
          <Select
            value={stage}
            onChange={(event) => setStage(event.target.value as GuideStage)}
          >
            {GUIDE_STAGES.map((value) => (
              <option key={value} value={value}>
                {STAGE_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="כותרת בעברית"
        required
        error={
          titleHe.trim().length === 0 && saved === false && save.pending
            ? 'שדה חובה'
            : undefined
        }
      >
        <TextInput
          value={titleHe}
          onChange={(event) => setTitleHe(event.target.value)}
          maxLength={200}
        />
      </Field>

      <Field
        label="כותרת באנגלית"
        description="אופציונלי. אורח שיבחר אנגלית ולא ימצא תרגום יקבל את העברית."
      >
        <TextInput
          value={titleEn}
          onChange={(event) => setTitleEn(event.target.value)}
          maxLength={200}
        />
      </Field>

      <Field label="טקסט בעברית">
        <Textarea
          value={bodyHe}
          onChange={(event) => setBodyHe(event.target.value)}
          rows={4}
          maxLength={4000}
        />
      </Field>

      <Field label="טקסט באנגלית">
        <Textarea
          value={bodyEn}
          onChange={(event) => setBodyEn(event.target.value)}
          rows={3}
          maxLength={4000}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="אייקון">
          <Select
            value={icon}
            onChange={(event) => setIcon(event.target.value as GuideIcon | '')}
          >
            <option value="">ללא</option>
            {GUIDE_ICONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="סדר הצגה">
          <TextInput
            type="number"
            min={0}
            max={999}
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="קישור חיצוני"
          description="https:// או נתיב פנימי בלבד."
          error={
            linkIsHalfWritten ? 'לקישור צריך גם כתובת וגם טקסט' : undefined
          }
        >
          <TextInput
            dir="ltr"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            maxLength={2000}
          />
        </Field>

        <Field label="טקסט הקישור">
          <TextInput
            value={linkLabel}
            onChange={(event) => setLinkLabel(event.target.value)}
            maxLength={200}
          />
        </Field>
      </div>

      <Checkbox
        label="פעיל"
        description="ערך כבוי אינו מוצג לאורחים ואינו נכלל בגרסה שתפורסם."
        checked={isActive}
        onChange={(event) => setIsActive(event.target.checked)}
      />

      <Checkbox
        label="הערך מכיל קוד או סוד"
        description="מסמן בלבד. את הקוד עצמו מזינים בטופס נפרד, בבקשה נפרדת."
        checked={hasSecret}
        onChange={(event) => setHasSecret(event.target.checked)}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="מתי נחשף לאורח"
          required
          error={
            secretIsImmediate
              ? 'ערך שמכיל קוד אינו יכול להיחשף מיד. בחר תנאי.'
              : undefined
          }
        >
          <Select
            value={releaseMode}
            onChange={(event) =>
              setReleaseMode(event.target.value as GuideReleaseMode)
            }
          >
            {GUIDE_RELEASE_MODES.map((value) => (
              <option key={value} value={value}>
                {RELEASE_MODE_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>

        {releaseMode === 'hours_before' && (
          <Field label="כמה שעות לפני הכניסה" required>
            <TextInput
              type="number"
              min={0}
              max={MAX_RELEASE_HOURS}
              value={releaseHours}
              onChange={(event) => setReleaseHours(event.target.value)}
            />
          </Field>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={blocked || save.pending}>
          {save.pending ? 'שומר…' : entry === null ? 'הוסף ערך' : 'שמור'}
        </Button>
        {saved && (
          <span className="text-sm text-muted-foreground">
            נשמר. אורחים יראו את השינוי אחרי פרסום.
          </span>
        )}
      </div>
    </form>
  )
}

/**
 * Hebrew, plus English when there is any.
 *
 * The shape `LocalizedText` demands: Hebrew is the required member, so this
 * cannot produce a value with an English body and no Hebrew one.
 */
function withOptional(he: string, en: string): { he: string; en?: string } {
  return en.trim().length > 0
    ? { he: he.trim(), en: en.trim() }
    : { he: he.trim() }
}
