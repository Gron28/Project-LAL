/**
 * Process-local reference to the optional /rc mirror.  Keeping it separate
 * from the slash command lets the normal prompt pipeline report prompts
 * without importing terminal UI command code (and without a module cycle).
 */
import type { RemoteRunMirror } from './remote-run-mirror.js';

let activeMirror: RemoteRunMirror | null = null;

export function setActiveRemoteRunMirror(mirror: RemoteRunMirror | null): void {
  activeMirror = mirror;
}

/** Records only prompts that are actually accepted by the native turn path. */
export function recordMirroredPrompt(prompt: string): void {
  activeMirror?.recordPrompt(prompt);
}
