import type { HealthPanel } from '@/lib/platform'

/**
 * One health panel.
 *
 * ══ A PANEL WITH NO SOURCE RENDERS NO NUMBER ══════════════════════════════
 *
 * The component branches on the discriminated union and there is no shared
 * layout underneath: the `not_connected` branch has no grid, no figure and no
 * placeholder — not a dash, not a zero, not a greyed-out `0`. It prints the
 * sentence explaining what is missing, and that is the whole panel.
 *
 * This matters more than it looks. The natural way to write a dashboard is a
 * row of counters that default to zero, and "0 failed payments today" is the
 * number a person acts on by doing nothing. A console that shows an invented
 * figure is worse than one that shows nothing, because somebody makes a
 * decision on it — so the type refuses to carry a figure on that branch and
 * this component refuses to draw a box shaped like one.
 */
export function HealthPanelCard({ panel }: { panel: HealthPanel }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
          {panel.title}
        </h2>
        {panel.source.kind === 'not_connected' && (
          <span className="whitespace-nowrap rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
            אין מקור נתונים
          </span>
        )}
      </div>

      {panel.source.kind === 'connected' ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          {panel.source.metrics.map((metric) => (
            <div key={metric.label} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{metric.label}</dt>
              <dd
                className={
                  metric.attention
                    ? 'font-display text-xl font-bold text-danger'
                    : 'font-display text-xl font-bold text-foreground'
                }
              >
                {metric.value}
              </dd>
              {metric.note && (
                <p className="text-xs text-muted-foreground">{metric.note}</p>
              )}
            </div>
          ))}
        </dl>
      ) : (
        /*
          No grid, no figure, no placeholder. The reader needs to know whether
          there is somewhere else to go and look, which is what the sentence
          says — and "N/A" would not.
        */
        <p className="text-sm leading-relaxed text-muted-foreground">
          {panel.source.reason}
        </p>
      )}
    </section>
  )
}
