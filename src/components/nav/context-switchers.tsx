/**
 * The two controls that decide what everything else means.
 *
 * Rendered on the server — only the open/closed state inside `Popover` is
 * client-side — so the forms below post straight to Server Actions and work
 * before any JavaScript has loaded. On a phone on a weak connection at a
 * guesthouse in the Galilee, that is not a theoretical benefit.
 *
 * Both switchers show the CURRENT choice on the trigger itself, not only
 * inside the panel. The charter's human-error rule is specific about this: a
 * booking created against the wrong property is real and expensive, and the
 * defence is that nobody ever has to remember which context they are in.
 */

import { cn } from '@/components/ui/cn'

import { NavIcon } from './icons'
import { Popover } from './popover'

export type WorkspaceChoice = {
  organizationId: string
  name: string
  slug: string
}

export type PropertyChoice = {
  id: string
  name: string | null
}

/** Shared row styling for the two panels. */
const ROW =
  'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start text-sm transition-colors'

function CurrentRow({
  title,
  detail,
}: {
  title: string
  detail?: string | null
}) {
  return (
    <div
      className={cn(ROW, 'bg-primary-soft font-semibold text-primary')}
      aria-current="true"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        {detail ? (
          <span dir="ltr" className="truncate text-xs font-normal opacity-80">
            {detail}
          </span>
        ) : null}
      </span>
      <NavIcon name="check" className="size-4 shrink-0" />
    </div>
  )
}

function ChoiceButton({
  name,
  value,
  title,
  detail,
}: {
  name: string
  value: string
  title: string
  detail?: string | null
}) {
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={cn(
        ROW,
        'text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        {detail ? (
          <span dir="ltr" className="truncate text-xs text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/* ------------------------------------------------------------ workspace -- */

export function WorkspaceSwitcher({
  workspaces,
  activeOrganizationId,
  action,
}: {
  workspaces: readonly WorkspaceChoice[]
  activeOrganizationId: string
  action: (formData: FormData) => Promise<void>
}) {
  const active = workspaces.find(
    (workspace) => workspace.organizationId === activeOrganizationId,
  )
  const others = workspaces.filter(
    (workspace) => workspace.organizationId !== activeOrganizationId,
  )

  return (
    <Popover
      label="החלפת ארגון"
      icon="building"
      triggerContent={active?.name ?? 'ארגון'}
      triggerDetail="ארגון"
      withChevron
      triggerClassName="h-11 max-w-[11rem] px-3 sm:max-w-[16rem]"
      panelClassName="w-72"
    >
      <form action={action} className="flex flex-col py-1">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
          הארגונים שלך
        </p>

        {active ? (
          <CurrentRow title={active.name} detail={active.slug} />
        ) : null}

        {others.map((workspace) => (
          <ChoiceButton
            key={workspace.organizationId}
            name="organizationId"
            value={workspace.organizationId}
            title={workspace.name}
            detail={workspace.slug}
          />
        ))}

        {others.length === 0 ? (
          <p className="px-3 pb-2 pt-1 text-xs text-muted-foreground">
            אתה חבר בארגון אחד בלבד.
          </p>
        ) : null}
      </form>
    </Popover>
  )
}

/* ------------------------------------------------------------- property -- */

/**
 * `properties` is empty in every organization today, and the panel says so
 * rather than showing a plausible-looking list. There is no `properties` table
 * in the schema yet; the names will arrive with it.
 */
export function PropertySwitcher({
  properties,
  selectedPropertyId,
  allValue,
  action,
}: {
  properties: readonly PropertyChoice[]
  selectedPropertyId: string
  allValue: string
  action: (formData: FormData) => Promise<void>
}) {
  const selected = properties.find(
    (property) => property.id === selectedPropertyId,
  )
  const showingAll = selectedPropertyId === allValue

  const label = showingAll
    ? 'כל הנכסים'
    : (selected?.name ?? `נכס ${selectedPropertyId.slice(0, 8)}`)

  return (
    <Popover
      label="בחירת נכס"
      icon="property"
      triggerContent={label}
      triggerDetail="נכס"
      withChevron
      triggerClassName="h-11 max-w-[11rem] px-3 sm:max-w-[16rem]"
      panelClassName="w-72"
    >
      <form action={action} className="flex flex-col py-1">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
          תצוגה
        </p>

        {showingAll ? (
          <CurrentRow title="כל הנכסים" />
        ) : (
          <ChoiceButton name="propertyId" value={allValue} title="כל הנכסים" />
        )}

        {properties.map((property) =>
          property.id === selectedPropertyId ? (
            <CurrentRow
              key={property.id}
              title={property.name ?? 'נכס'}
              detail={property.name ? null : property.id.slice(0, 8)}
            />
          ) : (
            <ChoiceButton
              key={property.id}
              name="propertyId"
              value={property.id}
              title={property.name ?? 'נכס'}
              detail={property.name ? null : property.id.slice(0, 8)}
            />
          ),
        )}

        {properties.length === 0 ? (
          <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-muted-foreground">
            עוד לא הוגדרו נכסים. כשמודול הנכסים יעלה, אפשר יהיה לצמצם את המסך
            לנכס אחד.
          </p>
        ) : null}
      </form>
    </Popover>
  )
}
