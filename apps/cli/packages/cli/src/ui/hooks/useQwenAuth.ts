/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// The hosted Qwen OAuth device-code flow was removed with the rest of the
// inherited cloud surface (PLAN 7.2), taking its event emitter with it. The
// state shape survives because the auth UI (DialogManager, AppContainer) is
// generic over it and still renders an "authenticating" panel for the
// providers that remain; it simply never leaves 'idle' now.

export interface QwenAuthState {
  deviceAuth: null;
  authStatus: 'idle' | 'polling' | 'success' | 'error' | 'timeout' | 'rate_limit';
  authMessage: string | null;
}

export const IDLE_QWEN_AUTH_STATE: QwenAuthState = Object.freeze({
  deviceAuth: null,
  authStatus: 'idle',
  authMessage: null,
});

export interface ExternalAuthState {
  title: string;
  message: string;
  detail?: string;
}
