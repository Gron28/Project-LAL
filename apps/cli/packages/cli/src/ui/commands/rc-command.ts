/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import qrcode from 'qrcode-terminal';
import { RemoteRunMirror } from '../../lal/remote-run/remote-run-mirror.js';
import { GatewayClient } from '../../lal/attach/gateway-client.js';

let activeMirror: RemoteRunMirror | null = null;
let activeRemoteUrl: string | null = null;
function terminalQr(value: string): string | null {
  try {
    let output = '';
    qrcode.generate(
      value,
      { small: true },
      (qr) => {
        output = qr.trimEnd();
      },
    );
    return output || null;
  } catch {
    return null;
  }
}

function message(
  messageType: MessageActionReturn['messageType'],
  content: string,
): MessageActionReturn {
  return { type: 'message', messageType, content };
}

export const rcCommand: SlashCommand = {
  name: 'rc',
  altNames: ['remote-control'],
  description:
    'Mirror the active native agent run to your LAL host for cross-device observation',
  argumentHint: '[status|stop]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (context, rawArgs): Promise<MessageActionReturn> => {
    const arg = rawArgs.trim().toLowerCase();
    if (arg === 'status') {
      if (!activeMirror)
        return message(
          'info',
          'Remote control is not active. Use /rc to start mirroring an active native agent.',
        );
      const state = activeMirror.status();
      return message(
        state.lastError ? 'warning' : 'info',
        [
          `Remote control: ${state.state}`,
          state.runId ? `Run: ${state.runId}` : '',
          state.conversationId ? `Conversation: ${state.conversationId}` : '',
          `Queued events: ${state.queuedEvents}`,
          state.lastError ? `Last gateway error: ${state.lastError}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    if (arg === 'link') {
      return activeRemoteUrl
        ? message('info', activeRemoteUrl)
        : message('info', 'Remote control is not active. Use /rc first.');
    }
    if (arg === 'stop' || arg === 'off') {
      if (!activeMirror)
        return message('info', 'Remote control is not active.');
      await activeMirror.stop('stopped');
      activeMirror = null;
      activeRemoteUrl = null;
      return message(
        'info',
        'Stopped remote mirroring. The native agent keeps running locally.',
      );
    }
    if (arg) return message('error', 'Usage: /rc [status|link|stop]');
    if (activeMirror) {
      const state = activeMirror.status();
      return message(
        'info',
        `Remote control is already active for ${state.runId ?? 'a run'}. Use /rc status or /rc stop.`,
      );
    }

    const emitter = context.session.agentEventEmitter;
    if (!emitter) {
      return message(
        'warning',
        'This terminal session does not expose a native agent event stream yet. Remote mirroring is available for AgentInteractive-backed sessions only; no UI history was uploaded.',
      );
    }
    const config = context.services.config;
    const submitRemotePrompt = context.session.submitRemotePrompt;
    if (!submitRemotePrompt) {
      return message(
        'warning',
        'This native session has no normal prompt-submission bridge. Remote mirroring was not started, so phone input cannot be silently dropped.',
      );
    }
    const mirror = new RemoteRunMirror({
      emitter,
      model: config?.getModel() || 'unknown',
      projectLabel: config?.getTargetDir?.(),
      mode: config?.getActiveCodeMode?.(),
      onCommand: (command) => submitRemotePrompt(command.text),
    });
    try {
      await mirror.start();
      activeMirror = mirror;
      const state = mirror.status();
      const link = new URL(
        `/code?conv=${encodeURIComponent(state.conversationId ?? '')}`,
        new GatewayClient().origin,
      );
      link.hash = new URLSearchParams({
        'lal-control': state.controlToken ?? '',
        run: state.runId ?? '',
      }).toString();
      activeRemoteUrl = link.toString();
      const qr = terminalQr(activeRemoteUrl);
      return message(
        'info',
        qr
          ? `Remote control active. Scan this QR code with your phone:\n\n${qr}\n\nIt mirrors local execution and accepts normal prompts. Tool permissions remain local. Use /rc link only if you need the URL.`
          : `Remote control active. QR rendering is unavailable in this terminal. Use /rc link to print the phone URL.`,
      );
    } catch (error) {
      return message(
        'error',
        `Could not register the native run with the LAL host: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};
