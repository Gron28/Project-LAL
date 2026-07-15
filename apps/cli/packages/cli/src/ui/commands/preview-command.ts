/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

// Local dev-server preview, mirroring the web app's `/code` preview panel
// (`web/src/app/api/agent/preview/route.ts`, `web/src/lib/tailscale.ts`) but
// run entirely on this machine (local-tools topology): the project's dev
// server is a managed background process on the CLI's own box, not the
// gateway, so it's reachable at the project's actual location. One preview
// at a time, mirroring the web app's single-slot precedent.

const PORT_POLL_INTERVAL_MS = 300;
const PORT_POLL_TIMEOUT_MS = 15000;
const TAILSCALE_TIMEOUT_MS = 15000;

interface PreviewState {
  child: ChildProcess;
  command: string;
  port: number;
  root: string;
  startedAt: number;
  tailscale: { ok: boolean; output: string } | null;
}

// Module-scoped singleton: one CLI process = one terminal session = one
// preview slot, the same "one global slot" the web app's single-tenant GPU
// precedent already established for this box.
let activeState: PreviewState | undefined;

function isRunning(state: PreviewState): boolean {
  return state.child.exitCode === null && state.child.signalCode === null;
}

function runTailscale(
  args: string[],
  timeoutMs = TAILSCALE_TIMEOUT_MS,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn('tailscale', args);
    } catch (e) {
      resolve({ ok: false, output: 'error: ' + (e as Error).message });
      return;
    }
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
      resolve({ ok: false, output: out + '\n[timed out]' });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: 'error: ' + e.message });
    });
  });
}

/** `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` — exact args
 * mirrored from web/src/lib/tailscale.ts's serveOn(). */
function tailscaleServeOn(
  port: number,
): Promise<{ ok: boolean; output: string }> {
  return runTailscale([
    'serve',
    '--bg',
    '--https=' + port,
    'http://127.0.0.1:' + port,
  ]);
}

/** `tailscale serve --https=<port> off` — mirrors serveOff(). */
function tailscaleServeOff(
  port: number,
): Promise<{ ok: boolean; output: string }> {
  return runTailscale(['serve', '--https=' + port, 'off']);
}

/** The tailnet DNS hostname for this machine, via `tailscale status --json`
 * (same approach as getTailnetHost() in web/src/lib/tailscale.ts). */
async function getTailnetHost(): Promise<string | null> {
  const r = await runTailscale(['status', '--json']);
  try {
    const j = JSON.parse(r.output);
    const dns = (j?.Self?.DNSName as string | undefined)?.replace(/\.$/, '');
    return dns || null;
  } catch {
    return null;
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const onFail = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, PORT_POLL_INTERVAL_MS);
        }
      };
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', onFail);
      socket.setTimeout(PORT_POLL_INTERVAL_MS, onFail);
    };
    attempt();
  });
}

/** Parse `<command...> <port>` — the last whitespace-separated token must be a
 * valid TCP port; everything before it is the command to run. */
function parseStartArgs(
  args: string,
): { command: string; port: number } | { error: string } {
  const trimmed = args.trim();
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace === -1) {
    return { error: 'Usage: /preview <command...> <port>' };
  }
  const portStr = trimmed.slice(lastSpace + 1);
  const command = trimmed.slice(0, lastSpace).trim();
  const port = Number(portStr);
  if (!command) {
    return { error: 'Usage: /preview <command...> <port>' };
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return {
      error: `Usage: /preview <command...> <port> — "${portStr}" is not a valid port (1024-65535).`,
    };
  }
  return { command, port };
}

function formatStatus(state: PreviewState): string {
  const uptimeSec = Math.round((Date.now() - state.startedAt) / 1000);
  const running = isRunning(state);
  const lines = [
    `${running ? 'running' : 'exited'}: ${state.command} (pid ${state.child.pid}, port ${state.port}, up ${uptimeSec}s)`,
    `local:      http://127.0.0.1:${state.port}`,
  ];
  if (state.tailscale?.ok) {
    lines.push(
      `(tailscale serve is active on this port — see the start message for the URL, or re-run "/preview status")`,
    );
  } else if (state.tailscale) {
    lines.push(
      `tailscale:  not exposed (${state.tailscale.output.slice(0, 140)})`,
    );
  }
  return lines.join('\n');
}

async function handleStart(
  root: string,
  args: string,
): Promise<MessageActionReturn> {
  if (activeState && isRunning(activeState)) {
    return {
      type: 'message',
      messageType: 'error',
      content: t(
        'A preview is already running: {{command}} on port {{port}} — stop it first with "/preview stop".',
        { command: activeState.command, port: String(activeState.port) },
      ),
    };
  }

  const parsed = parseStartArgs(args);
  if ('error' in parsed) {
    return { type: 'message', messageType: 'error', content: parsed.error };
  }
  const { command, port } = parsed;

  let child: ChildProcess;
  try {
    // detached so "/preview stop" can kill the whole process group — many dev
    // servers (npm run dev, etc.) fork a child of their own, so killing just
    // the shell would leave the real server running.
    child = spawn('bash', ['-c', command], { cwd: root, detached: true });
  } catch (e) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Failed to start: {{error}}', {
        error: (e as Error).message,
      }),
    };
  }
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  child.on('error', () => {});

  const state: PreviewState = {
    child,
    command,
    port,
    root,
    startedAt: Date.now(),
    tailscale: null,
  };
  activeState = state;

  const up = await waitForPort(port, PORT_POLL_TIMEOUT_MS);
  const localUrl = `http://127.0.0.1:${port}`;
  const lines = [
    up
      ? t('Preview started: {{command}} (pid {{pid}}).', {
          command,
          pid: String(child.pid),
        })
      : t(
          'Preview started: {{command}} (pid {{pid}}) — port {{port}} did not respond within {{seconds}}s yet; it may still be starting.',
          {
            command,
            pid: String(child.pid),
            port: String(port),
            seconds: String(Math.round(PORT_POLL_TIMEOUT_MS / 1000)),
          },
        ),
    `local:      ${localUrl}`,
  ];

  let tailscaleBinaryMissing = false;
  const serveResult = await tailscaleServeOn(port).catch(() => ({
    ok: false,
    output: 'error: tailscale serve failed',
  }));
  if (!serveResult.ok && /ENOENT|error: /i.test(serveResult.output)) {
    tailscaleBinaryMissing = true;
  }
  state.tailscale = serveResult;

  if (serveResult.ok) {
    const host = await getTailnetHost();
    if (host) {
      lines.push(`tailscale:  https://${host}:${port}`);
    } else {
      lines.push(
        t(
          'tailscale:  serve is active on port {{port}} but the tailnet hostname could not be resolved — run "tailscale status" to find it.',
          { port: String(port) },
        ),
      );
    }
  } else if (!tailscaleBinaryMissing) {
    lines.push(
      t('tailscale:  exposure failed — reachable locally only ({{output}})', {
        output: serveResult.output.slice(0, 200),
      }),
    );
  }
  // tailscale CLI simply not installed: stay quiet about it beyond the local URL,
  // same as the web app's behavior when tailscale isn't configured on the box.

  return { type: 'message', messageType: 'info', content: lines.join('\n') };
}

async function handleStop(): Promise<MessageActionReturn> {
  if (!activeState) {
    return {
      type: 'message',
      messageType: 'info',
      content: t('No preview is running.'),
    };
  }
  const state = activeState;
  try {
    if (state.child.pid) {
      process.kill(-state.child.pid, 'SIGKILL');
    }
  } catch {
    // process (group) already gone
  }
  let tailscaleOff: { ok: boolean; output: string } | null = null;
  if (state.tailscale?.ok) {
    tailscaleOff = await tailscaleServeOff(state.port).catch(() => null);
  }
  activeState = undefined;
  const lines = [
    t('Stopped preview: {{command}} (port {{port}}).', {
      command: state.command,
      port: String(state.port),
    }),
  ];
  if (tailscaleOff && !tailscaleOff.ok) {
    lines.push(
      t(
        'Warning: "tailscale serve ... off" did not confirm success: {{output}}',
        {
          output: tailscaleOff.output.slice(0, 200),
        },
      ),
    );
  }
  return { type: 'message', messageType: 'info', content: lines.join('\n') };
}

function handleStatus(): MessageActionReturn {
  if (!activeState) {
    return {
      type: 'message',
      messageType: 'info',
      content: t('No preview is running. Usage: /preview <command...> <port>'),
    };
  }
  return {
    type: 'message',
    messageType: 'info',
    content: formatStatus(activeState),
  };
}

export const previewCommand: SlashCommand = {
  name: 'preview',
  get description() {
    return t(
      'Run a project dev server locally and print local + Tailscale URLs; "/preview stop" to stop.',
    );
  },
  argumentHint: '<command...> <port>|stop|status',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    actionArgs: string,
  ): Promise<MessageActionReturn> => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    const raw = context.invocation?.args?.trim() || actionArgs.trim();
    const firstWord = raw.split(/\s+/, 1)[0]?.toLowerCase();

    if (!raw || firstWord === 'status') {
      return handleStatus();
    }
    if (firstWord === 'stop') {
      return handleStop();
    }

    const root = config.getTargetDir();
    return handleStart(root, raw);
  },
};
