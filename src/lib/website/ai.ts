/**
 * THE CONTENT GENERATION PORT.
 *
 * ── There is no model client in this codebase, and this file does not add one ──
 *
 * No API key is read here. No HTTP request is made here. No provider is named
 * in a way that implies one has been chosen. What this file declares is the
 * SHAPE a generator would have to satisfy, and it ships the only implementation
 * that can be honest today: one that refuses and says why.
 *
 * The alternative — half a client, a `TODO`, an environment variable that does
 * not exist — is worse than nothing, because it makes the module look
 * configured. A studio that spins for thirty seconds and then shows a network
 * error teaches people the product is broken. A studio that says "יצירת תוכן
 * אינה מוגדרת בחשבון הזה" is telling the truth, and every other part of the
 * module works with generation switched off.
 *
 * ── THE GROUNDING CONTRACT, WHICH IS THE POINT ────────────────────────────
 *
 * A generator NEVER receives free rein and NEVER returns a claim. It receives:
 *
 *   · a `GenerationBrief` — what is being written, for which page, in Hebrew
 *   · `facts` — a closed set of `SiteClaim`s read from canonical rows, each
 *     already carrying its own provenance
 *
 * and it returns `GeneratedDraft`s that cite fact keys. The cited keys are
 * checked against the offered facts by `groundDraft` in `facts.ts`, which this
 * file does not implement and cannot bypass. A draft citing a fact that was
 * never offered is dropped whole.
 *
 * So the property the module needs — "if the AI drafts a sentence claiming the
 * villa has a heated pool, that claim must be traceable to a property row" —
 * holds by construction: the model is only ever shown facts that came from
 * rows, and anything it says that rests on something else is refused before it
 * can be stored, let alone published.
 *
 * ── What implementing this port would require ─────────────────────────────
 *
 * Whoever wires a real generator implements `generate` and nothing else. They
 * do not get to widen the input, they do not get to return `SiteClaim`, and
 * they do not get to write to any table — the operation layer owns the write,
 * the audit event and the `site.generated` emission. That is deliberate: the
 * blast radius of a new provider is one function.
 */

import type { GeneratedDraft, SiteClaim } from './facts'
import type { SitePageKind, SiteSectionKind } from './types'

/** What is being asked for. Bounded — there is no free-text system prompt. */
export type GenerationBrief = {
  organizationId: string
  siteId: string
  pageKind: SitePageKind
  sectionKind: SiteSectionKind
  /**
   * Which claim keys the section wants filled — `heading`, `body`, `cta`.
   * A generator may return fewer; it may not return others.
   */
  wantedKeys: readonly string[]
  /** The business's own instruction. Hebrew, and shown to them before it runs. */
  instruction: string | null
  /** How the business wants to sound. A closed list, not a prompt. */
  tone: 'warm' | 'plain' | 'upscale' | 'family'
  locale: string
}

export type GenerationRequest = {
  brief: GenerationBrief
  /**
   * THE CLOSED WORLD. Everything the generator is permitted to assert rests on
   * one of these, and every one of them was read from a canonical row by
   * `content.ts`. A generator that wants a fact it was not given must do
   * without it.
   */
  facts: readonly SiteClaim[]
}

export type GenerationOutcome =
  | { status: 'drafted'; drafts: readonly GeneratedDraft[]; provider: string }
  /**
   * The generator will not or cannot answer. `reason` is Hebrew and is shown
   * to the person — this is a normal outcome, not an exception, which is why
   * it is a value in the union rather than a thrown error.
   */
  | { status: 'refused'; reason: string; provider: string }

export interface ContentGenerator {
  /** A stable name recorded on the request row, so history says who wrote it. */
  readonly provider: string
  generate(request: GenerationRequest): Promise<GenerationOutcome>
}

/**
 * The implementation this codebase ships.
 *
 * It refuses. It does not throw, it does not retry, it does not pretend to be
 * slow, and it names itself `none` so that a `site_generation_requests` row
 * written today is distinguishable from one written after somebody wires a
 * real provider.
 *
 * ── Why it still validates the request ────────────────────────────────────
 *
 * Because the refusal it gives back should be the refusal a real generator
 * would give for the same input. A brief asking for a section with no facts at
 * all is not "generation is unconfigured" — it is "there is nothing to write
 * about", and a business hitting that today should hear the same sentence they
 * would hear with a provider connected. Otherwise wiring a provider changes
 * the meaning of every existing message.
 */
export const nullContentGenerator: ContentGenerator = {
  provider: 'none',

  async generate(request: GenerationRequest): Promise<GenerationOutcome> {
    if (request.facts.length === 0) {
      return {
        status: 'refused',
        provider: 'none',
        reason:
          'אין עובדות לכתוב עליהן. שייכו את המקטע לנכס או ליחידה, ואז אפשר יהיה לנסח ממה שמופיע במערכת.',
      }
    }

    if (request.brief.wantedKeys.length === 0) {
      return {
        status: 'refused',
        provider: 'none',
        reason: 'לא צוין מה לנסח.',
      }
    }

    return {
      status: 'refused',
      provider: 'none',
      reason:
        'יצירת תוכן אוטומטית אינה מוגדרת בחשבון הזה. אפשר לכתוב את הטקסט ידנית — כל שאר הכלים בסטודיו עובדים כרגיל.',
    }
  },
}

/**
 * A generator for tests: returns exactly what it was constructed with.
 *
 * Exported from the module rather than hidden in a test file because
 * `operations.test.ts` and `facts.test.ts` both need it, and a double that
 * lives in one test file and is imported by another is a double nobody
 * maintains. It cites whatever it is told to cite — including facts that were
 * never offered — which is how the grounding refusal gets exercised.
 */
export function fixedContentGenerator(
  drafts: readonly GeneratedDraft[],
  provider = 'fixture',
): ContentGenerator {
  return {
    provider,
    async generate() {
      return { status: 'drafted', drafts, provider }
    },
  }
}
