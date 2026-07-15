/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

// Local git integration for the CLI's own repository — mirrors the web app's
// git panel (`web/src/components/code/git-panel.tsx`,
// `web/src/app/api/agent/git/route.ts`), but runs entirely on this machine via
// the local `git` binary (local-tools topology: no gateway round trip).

const OUTPUT_CAP = 16384;
const TIMEOUT_MS = 30000;
// runGit() renders truly-empty command output as this literal sentinel (readable
// in a status/diff display); callers checking "did this produce anything" must
// treat the sentinel the same as an empty string.
const NO_OUTPUT_SENTINEL = '(no output)';
function isEmptyGitOutput(s: string): boolean {
  const trimmed = s.trim();
  return !trimmed || trimmed === NO_OUTPUT_SENTINEL;
}

/** Spawn `git <args>` in `cwd` as an argv array (no shell — no quoting/injection
 * surface for commit messages or paths with spaces/special characters). */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_EDITOR: 'true',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
        },
      });
    } catch (e) {
      resolve('error: ' + (e as Error).message);
      return;
    }
    const append = (d: Buffer) => {
      if (out.length < OUTPUT_CAP) out += d.toString();
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let done = false;
    const finish = (msg: string) => {
      if (done) return;
      done = true;
      resolve((msg || '(no output)').slice(0, OUTPUT_CAP));
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
      finish(out + '\n[timed out after 30s]');
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(out + (code ? `\n[exit ${code}]` : ''));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish('error: ' + e.message);
    });
  });
}

function isRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

interface StatusFile {
  path: string;
  x: string;
  y: string;
}

interface ParsedStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: StatusFile[];
}

/** Parse `git status --porcelain=v1 -b` output. */
function parseStatus(out: string): ParsedStatus {
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files: StatusFile[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      // "## main...origin/main [ahead 1, behind 2]" | "## No commits yet on main"
      const m = line.slice(3);
      branch = (m.split('...')[0] || m)
        .replace(/^No commits yet on /, '')
        .trim();
      const a = m.match(/ahead (\d+)/);
      if (a) ahead = parseInt(a[1], 10);
      const b = m.match(/behind (\d+)/);
      if (b) behind = parseInt(b[1], 10);
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let p = line.slice(3);
    const arrow = p.indexOf(' -> '); // rename: take the new path
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) {
      try {
        p = JSON.parse(p);
      } catch {
        // keep the raw quoted form
      }
    }
    files.push({ path: p, x, y });
  }
  return { branch, ahead, behind, files };
}

function statusLineLabel(f: StatusFile): string {
  if (f.x === '?' && f.y === '?') return 'untracked';
  const codes: Record<string, string> = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    U: 'unmerged',
  };
  const staged =
    f.x !== ' ' && f.x !== '?' ? `staged:${codes[f.x] ?? f.x}` : '';
  const unstaged =
    f.y !== ' ' && f.y !== '?' ? `unstaged:${codes[f.y] ?? f.y}` : '';
  return [staged, unstaged].filter(Boolean).join(' ') || `${f.x}${f.y}`;
}

function formatStatus(s: ParsedStatus): string {
  const header = `On branch ${s.branch || '(unknown)'}${
    s.ahead || s.behind ? ` [ahead ${s.ahead}, behind ${s.behind}]` : ''
  }`;
  if (s.files.length === 0) {
    return `${header}\nWorking tree clean.`;
  }
  const lines = s.files.map((f) => `  ${statusLineLabel(f)}  ${f.path}`);
  return `${header}\n${lines.join('\n')}`;
}

async function handleStatus(root: string): Promise<MessageActionReturn> {
  const out = await runGit(root, ['status', '--porcelain=v1', '-b']);
  if (out.startsWith('error:')) {
    return { type: 'message', messageType: 'error', content: out };
  }
  return {
    type: 'message',
    messageType: 'info',
    content: formatStatus(parseStatus(out)),
  };
}

async function handleDiff(
  root: string,
  rel: string | undefined,
): Promise<MessageActionReturn> {
  if (!rel) {
    const out = await runGit(root, ['diff', 'HEAD']);
    if (isEmptyGitOutput(out)) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('No unstaged changes against HEAD.'),
      };
    }
    return {
      type: 'message',
      messageType: 'info',
      content: out.length >= OUTPUT_CAP ? out + '\n[truncated]' : out,
    };
  }
  // Untracked files have no HEAD side; diff --no-index against /dev/null
  // renders them as all-additions instead of erroring.
  const statusOut = await runGit(root, ['status', '--porcelain=v1', '--', rel]);
  const untracked = statusOut.split('\n').some((l) => l.startsWith('??'));
  const out = untracked
    ? await runGit(root, ['diff', '--no-index', '--', '/dev/null', rel])
    : await runGit(root, ['diff', 'HEAD', '--', rel]);
  const diff = out.replace(/\n\[exit 1\]$/, ''); // --no-index exit 1 = "differences found"
  if (isEmptyGitOutput(diff)) {
    return {
      type: 'message',
      messageType: 'info',
      content: t('No differences for {{path}}.', { path: rel }),
    };
  }
  return { type: 'message', messageType: 'info', content: diff };
}

async function handleAdd(
  root: string,
  args: string,
): Promise<MessageActionReturn> {
  const trimmed = args.trim();
  const gitArgs =
    trimmed === '--all' || trimmed === '-A' || !trimmed
      ? ['add', '-A']
      : ['add', '--', ...trimmed.split(/\s+/)];
  const out = await runGit(root, gitArgs);
  const ok = !out.startsWith('error:') && !/\[exit \d+\]/.test(out);
  return {
    type: 'message',
    messageType: ok ? 'info' : 'error',
    content: ok
      ? t('Staged: {{paths}}', {
          paths: trimmed || 'all changes (-A)',
        })
      : out,
  };
}

async function handleCommit(
  root: string,
  message: string,
): Promise<MessageActionReturn> {
  if (!message.trim()) {
    return {
      type: 'message',
      messageType: 'error',
      content: t(
        'Usage: /git commit <message> (commits whatever is currently staged).',
      ),
    };
  }
  const staged = await runGit(root, ['diff', '--cached', '--name-only']);
  if (isEmptyGitOutput(staged)) {
    return {
      type: 'message',
      messageType: 'error',
      content: t(
        'Nothing staged. Use "/git add <path>" or "/git add --all" first.',
      ),
    };
  }
  const out = await runGit(root, ['commit', '-m', message]);
  const ok = !out.startsWith('error:') && !/\[exit \d+\]/.test(out);
  return { type: 'message', messageType: ok ? 'info' : 'error', content: out };
}

export const gitCommand: SlashCommand = {
  name: 'git',
  get description() {
    return t(
      "Local git: status, diff [path], add <path|--all>, commit <message> — operates on this machine's repo.",
    );
  },
  argumentHint: '[status|diff [path]|add <path|--all>|commit <message>]',
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

    const root = config.getTargetDir();
    if (!isRepo(root)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Not a git repository: {{root}}', { root }),
      };
    }

    const raw = context.invocation?.args?.trim() || actionArgs.trim();
    const spaceIdx = raw.indexOf(' ');
    const sub = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim();

    switch (sub) {
      case '':
      case 'status':
        return handleStatus(root);
      case 'diff':
        return handleDiff(root, rest || undefined);
      case 'add':
        return handleAdd(root, rest);
      case 'commit':
        return handleCommit(root, rest);
      default:
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Unknown /git subcommand "{{sub}}". Use: status, diff [path], add <path|--all>, commit <message>.',
            { sub },
          ),
        };
    }
  },
};
