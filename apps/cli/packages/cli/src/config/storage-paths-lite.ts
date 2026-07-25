/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// This lite module must not import @lal/core (it runs before the serve
// listener is ready), so the home-directory rule in Storage.getGlobalQwenDir()
// is duplicated below. Keep the two in sync: if the fast path and the normal
// path disagree about where settings live, a daemon started one way reads a
// different config than the same daemon started the other way.
export const LAL_HOME_DIR_NAME = '.lal';
export const LEGACY_HOME_DIR_NAME = '.qwen';
/** The PROJECT-local config dir (<repo>/.qwen) — not the home directory. */
export const SETTINGS_DIRECTORY_NAME = '.qwen';

export function resolveConfigPathLite(dir: string, cwd?: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const relativeSegments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(cwd || process.cwd(), resolved);
  }
  return resolved;
}

export function getGlobalQwenDirLite(): string {
  const envDir = process.env['LAL_HOME'] ?? process.env['QWEN_HOME'];
  if (envDir) {
    return resolveConfigPathLite(envDir);
  }
  const homeDir = os.homedir();
  if (!homeDir) {
    return path.join(os.tmpdir(), LAL_HOME_DIR_NAME);
  }
  // Mirror of Storage.resolveHomeDirName: .lal for a fresh install, .qwen when
  // that is the only one already on disk, .lal when both exist.
  if (!fs.existsSync(path.join(homeDir, LAL_HOME_DIR_NAME))) {
    if (fs.existsSync(path.join(homeDir, LEGACY_HOME_DIR_NAME))) {
      return path.join(homeDir, LEGACY_HOME_DIR_NAME);
    }
  }
  return path.join(homeDir, LAL_HOME_DIR_NAME);
}

export function getSystemSettingsPath(): string {
  if (process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']) {
    return process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  }
  if (os.platform() === 'darwin') {
    return '/Library/Application Support/QwenCode/settings.json';
  }
  if (os.platform() === 'win32') {
    return 'C:\\ProgramData\\qwen-code\\settings.json';
  }
  return '/etc/qwen-code/settings.json';
}

export function getSystemDefaultsPath(): string {
  if (process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']) {
    return process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
  }
  return path.join(
    path.dirname(getSystemSettingsPath()),
    'system-defaults.json',
  );
}
