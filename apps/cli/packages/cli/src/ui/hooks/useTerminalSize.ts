/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';

type TerminalSize = { columns: number; rows: number };
let snapshot: TerminalSize = {
  columns: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
};
const subscribers = new Set<() => void>();
const updateSnapshot = () => {
  const next = {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
  if (next.columns === snapshot.columns && next.rows === snapshot.rows) return;
  snapshot = next;
  for (const subscriber of subscribers) subscriber();
};

function subscribe(subscriber: () => void) {
  updateSnapshot();
  subscribers.add(subscriber);
  if (subscribers.size === 1) process.stdout.on('resize', updateSnapshot);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) process.stdout.off('resize', updateSnapshot);
  };
}

/**
 * Returns the actual terminal size without any padding adjustments.
 * Components should handle their own margins/padding as needed.
 */
export function useTerminalSize(): { columns: number; rows: number } {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
