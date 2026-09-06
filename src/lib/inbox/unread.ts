/**
 * What this person has not seen.
 *
 * Pure. Takes the threads, this reader's own read marks, and the clock.
 *
 * ══ UNREAD IS PER PERSON, AND THAT IS THE WHOLE DESIGN ══════════════════════
 *
 * The tempting shortcut is a boolean on the conversation. It is wrong, and it
 * is the single most common way a shared mailbox fails: a manager opens a
 * thread at 08:00, the flag clears, and the three colleagues who never saw it
 * now have an inbox that says there is nothing to do. The message is not lost
 * — it is worse than lost, because everyone has been told it was handled.
 *
 * So `conversation_reads` is keyed by `(conversation_id, user_id)`, its policy
 * pins `user_id = auth.uid()`, and this function is handed one reader's marks.
 * There is no function here that answers "is this thread read" without being
 * told by whom, because that question has no answer.
 *
 * ══ ONLY AN ARRIVAL CAN BE UNREAD ═══════════════════════════════════════════
 *
 * `lastInboundAt`, never `lastMessageAt`. A thread where the last event is our
 * own reply has nothing waiting in it, and counting it would mean answering a
 * guest makes your own inbox worse — which teaches people not to answer.
 */

import type { Conversation } from './types'

/** One reader's marks, as `conversationId -> last read`. */
export type ReadMarks = ReadonlyMap<string, Date>

/** Has this reader seen the latest arrival on this thread? */
export function isUnreadFor(
  conversation: Conversation,
  marks: ReadMarks,
): boolean {
  // Nothing has arrived. Our own replies do not make a thread unread.
  if (conversation.lastInboundAt === null) return false

  const readAt = marks.get(conversation.id)
  if (readAt === undefined) return true

  return conversation.lastInboundAt.getTime() > readAt.getTime()
}

export interface InboxCounts {
  /** Threads with an arrival this reader has not seen. */
  readonly unread: number
  /** Threads waiting on the business, whoever has read them. */
  readonly waitingOnUs: number
  /** Waiting on us AND assigned to this reader. */
  readonly mine: number
  /** Waiting on us and assigned to nobody. The ones that fall through. */
  readonly unassigned: number
}

/**
 * The four numbers the screen leads with.
 *
 * `waitingOnUs` is deliberately not filtered by reader: "eleven guests are
 * waiting" is a fact about the business, and showing each person only their
 * own share is how a queue grows while everybody's screen looks calm.
 */
export function countInbox(
  conversations: readonly Conversation[],
  marks: ReadMarks,
  readerUserId: string,
): InboxCounts {
  let unread = 0
  let waitingOnUs = 0
  let mine = 0
  let unassigned = 0

  for (const conversation of conversations) {
    if (conversation.status === 'closed') continue

    if (isUnreadFor(conversation, marks)) unread += 1

    if (conversation.status === 'waiting_on_us') {
      waitingOnUs += 1
      if (conversation.assignedToUserId === readerUserId) mine += 1
      if (conversation.assignedToUserId === null) unassigned += 1
    }
  }

  return { unread, waitingOnUs, mine, unassigned }
}

/**
 * How long a guest has been waiting, in hours, or null if they are not.
 *
 * Measured from `lastInboundAt` and nothing else. A thread reopened, reassigned
 * or relabelled has not been answered, and resetting the clock on any of those
 * would let a queue look healthy while the same person waits three days.
 */
export function hoursWaiting(
  conversation: Conversation,
  now: Date,
): number | null {
  if (conversation.status !== 'waiting_on_us') return null
  if (conversation.lastInboundAt === null) return null
  const ms = now.getTime() - conversation.lastInboundAt.getTime()
  return ms <= 0 ? 0 : ms / (60 * 60 * 1000)
}

/**
 * Longest wait first, then newest arrival.
 *
 * Not "newest first", which is what every mailbox does and what buries the
 * guest who has been waiting since Thursday under this morning's traffic.
 */
export function byLongestWait(
  conversations: readonly Conversation[],
  now: Date,
): readonly Conversation[] {
  return [...conversations].sort((a, b) => {
    const left = hoursWaiting(a, now)
    const right = hoursWaiting(b, now)
    if (left !== null && right !== null) return right - left
    if (left !== null) return -1
    if (right !== null) return 1
    const la = a.lastMessageAt?.getTime() ?? a.openedAt.getTime()
    const lb = b.lastMessageAt?.getTime() ?? b.openedAt.getTime()
    return lb - la
  })
}
