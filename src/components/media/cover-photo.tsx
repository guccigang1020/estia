'use client'

/**
 * The customer's own photograph of their property, and how it gets there.
 *
 * ══ WHAT SITS HERE BEFORE ANYBODY UPLOADS ══════════════════════════════════
 *
 * Not a grey rectangle, and not a stock villa. A grey rectangle makes a fresh
 * account look broken on the first screen somebody sees, and a stock
 * photograph is a claim about a property this business does not own — the same
 * refusal `messaging/null-provider.ts` and `fiscal/null-provider.ts` make about
 * inventing an answer.
 *
 * What sits here is a drawn dusk scene with the invitation written on it. It
 * is obviously a drawing, so nobody mistakes it for their villa, and it is
 * warm enough that an empty account still looks like a product.
 *
 * ══ THE VEIL IS NOT DECORATION ═════════════════════════════════════════════
 *
 * `estia-photo-veil` is a token in globals.css and it is what keeps the label
 * legible over ANY picture a customer uploads. A bright midday photograph of a
 * white-walled villa would otherwise erase every word placed on it — which is
 * the difference between a feature that works and one that works on the single
 * photograph it was designed against.
 *
 * ══ IT SHOWS THE NEW PICTURE BEFORE THE SERVER HAS IT ══════════════════════
 *
 * A local object URL goes up the instant the file is chosen, so a business on
 * a rural connection sees their villa immediately rather than a spinner. If
 * the upload then fails the preview is rolled back and the refusal is shown —
 * an optimistic view that never corrects itself would be worse than a spinner.
 */

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { fromSafeError } from '@/components/states/error-copy'
import { checkPhoto, photoProblemMessage } from '@/lib/media/photo'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import {
  removePropertyPhotoAction,
  uploadPropertyPhotoAction,
} from '@/app/(app)/properties/_lib/photo-actions'

export function CoverPhoto({
  propertyId,
  propertyName,
  url,
  canEdit,
  children,
}: {
  propertyId: string
  propertyName: string
  url: string | null
  canEdit: boolean
  /** Anything the caller wants laid over the picture — a unit picker, counts. */
  children?: React.ReactNode
}) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [shown, setShown] = useState<string | null>(url)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  /**
   * Re-sync when the server sends a different picture, adjusted DURING render
   * rather than in an effect.
   *
   * `useEffect(() => setShown(url), [url])` is the obvious way to write this
   * and it is wrong twice: React renders once with the stale picture before
   * the effect runs, so a refresh flashes the previous photograph — and it is
   * a cascading render, which is what the lint rule is about. Setting state
   * while rendering is the documented pattern for exactly this case: React
   * discards the output and re-renders the component immediately, before
   * anything reaches the screen.
   */
  const [syncedTo, setSyncedTo] = useState(url)
  if (url !== syncedTo) {
    setSyncedTo(url)
    setShown(url)
  }

  async function send(file: File | undefined) {
    if (!file) return

    // The same rules the server and the bucket apply, run here first so the
    // refusal arrives before the bytes do.
    const problems = checkPhoto({ type: file.type, size: file.size })
    if (problems.length > 0) {
      setError(photoProblemMessage(problems[0]!))
      return
    }

    const preview = URL.createObjectURL(file)
    const previous = shown
    setShown(preview)
    setBusy(true)
    setError(null)

    const form = new FormData()
    form.set('propertyId', propertyId)
    form.set('photo', file)

    const outcome = await uploadPropertyPhotoAction(form)
    setBusy(false)
    URL.revokeObjectURL(preview)

    if (outcome.ok) {
      setShown(outcome.url)
      router.refresh()
      return
    }

    setShown(previous)
    setError(describe(outcome.error))
  }

  async function drop() {
    setBusy(true)
    setError(null)
    const outcome = await removePropertyPhotoAction({ propertyId })
    setBusy(false)
    if (outcome.ok) {
      setShown(null)
      router.refresh()
      return
    }
    setError(describe(outcome.error))
  }

  return (
    <div
      className="relative isolate min-h-64 overflow-hidden rounded-2xl border border-border shadow-lift"
      onDragEnter={(e) => {
        if (!canEdit) return
        e.preventDefault()
        setOver(true)
      }}
      onDragOver={(e) => {
        if (!canEdit) return
        e.preventDefault()
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!canEdit) return
        e.preventDefault()
        setOver(false)
        void send(e.dataTransfer.files[0])
      }}
    >
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element -- the URL is a
        // Supabase Storage public URL or a local object URL; next/image would
        // need every customer's storage host in the remote allowlist, and an
        // object URL cannot be optimised at all.
        <img
          src={shown}
          alt={`צילום של ${propertyName}`}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <EmptyScene />
      )}

      <div className="estia-photo-veil pointer-events-none absolute inset-0" />

      {over && (
        <div className="absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-white/70 bg-black/50 text-white">
          שחררו כאן
        </div>
      )}

      {!shown && canEdit && (
        <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-sm text-white/90">
          גררו לכאן צילום של {propertyName} — הוא יופיע כאן ובאתר שלכם
        </span>
      )}

      <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">{children}</div>

        {canEdit && (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => input.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-black/45 px-3 py-1.5 text-xs text-white backdrop-blur transition hover:bg-black/70 disabled:opacity-60"
            >
              {busy ? 'מעלה…' : shown ? 'החליפו תמונה' : 'העלו תמונה'}
            </button>
            {shown && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void drop()}
                className="rounded-md border border-white/20 bg-black/45 px-3 py-1.5 text-xs text-white backdrop-blur transition hover:bg-black/70 disabled:opacity-60"
              >
                הסירו
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="absolute inset-x-3 top-3 rounded-md bg-danger/95 px-3 py-1.5 text-xs text-surface"
        >
          {error}
        </p>
      )}

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        hidden
        onChange={(e) => void send(e.target.files?.[0])}
      />
    </div>
  )
}

function describe(error: SafeErrorBody): string {
  // The server's own Hebrew wins where it wrote one; `fromSafeError` is the
  // shared fallback so an unexpected code still reads as a sentence.
  return error.message || fromSafeError(error).title
}

/**
 * Dusk over a villa, drawn rather than photographed.
 *
 * Deliberately stylised: it must not be mistaken for the customer's own
 * property. Pure CSS gradients — no asset to load, nothing to go missing, and
 * it renders identically on a rural connection.
 */
function EmptyScene() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{
        background: [
          'radial-gradient(60% 42% at 74% 62%, rgb(255 214 160 / .55), transparent 62%)',
          'linear-gradient(to bottom, #1b2740 0%, #3d3b52 38%, #8a5d55 70%, #d09055 100%)',
        ].join(','),
      }}
    >
      <div
        className="absolute inset-x-0 bottom-0 h-2/5"
        style={{
          background: 'linear-gradient(to bottom, #16202c, #0d141c)',
          clipPath:
            'polygon(0 38%, 14% 26%, 32% 40%, 48% 22%, 66% 34%, 84% 18%, 100% 30%, 100% 100%, 0 100%)',
        }}
      />
      <div
        className="absolute inset-x-6 bottom-4 h-1/4 rounded-lg"
        style={{
          background: 'linear-gradient(to bottom, #3f8a90, #12333c)',
          opacity: 0.9,
        }}
      />
    </div>
  )
}
