/**
 * @license
 * Copyright 2025 LAL
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wall-clock time a history item was added, for display beside the message.
 *
 * No new field is needed: `useHistoryManager.getNextMessageId` builds every id as
 * `baseTimestamp + counter`, and all 35 call sites pass `Date.now()`. The id is
 * therefore epoch milliseconds, accurate to within the small monotonic counter
 * (single-digit ms), which is far below display resolution.
 *
 * Ids from a RESTORED session are the timestamps of the original session, which is
 * the honest thing to show — a resumed transcript did not happen just now.
 */
export function messageTimeFromId(
  id: number | undefined,
  now: () => number = Date.now,
): string | undefined {
  if (typeof id !== 'number' || !Number.isFinite(id)) return undefined;
  // Ids below this are not timestamps. Older sessions and synthetic items used
  // small sequential ids, and rendering "01:00" for id=42 would be a fabricated
  // fact — exactly the kind of plausible-looking default worth refusing.
  const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);
  if (id < EARLIEST_PLAUSIBLE_MS) return undefined;
  // Guard the other end too: an id far in the future is a counter that overflowed
  // into timestamp range, not a real time.
  if (id > now() + 86_400_000) return undefined;

  const date = new Date(id);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Same, but includes seconds. Useful when consecutive messages land inside one
 * minute and the user is trying to judge how long a turn took.
 */
export function messageTimeWithSecondsFromId(
  id: number | undefined,
  now: () => number = Date.now,
): string | undefined {
  const base = messageTimeFromId(id, now);
  if (!base) return undefined;
  return `${base}:${String(new Date(id as number).getSeconds()).padStart(2, '0')}`;
}
