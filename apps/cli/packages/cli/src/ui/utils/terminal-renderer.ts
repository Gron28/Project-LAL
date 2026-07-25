export type TerminalRenderer = 'auto' | 'viewport' | 'static';
export type ResolvedTerminalRenderer = Exclude<TerminalRenderer, 'auto'>;

let activeRenderer: ResolvedTerminalRenderer | null = null;

export function resolveTerminalRenderer(input: {
  configured?: string;
  legacyViewport?: boolean;
  environment?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  screenReader?: boolean;
  safeTerminal?: boolean;
}): ResolvedTerminalRenderer {
  const environment = input.environment ?? process.env;
  const override = environment['LAL_TERMINAL_RENDERER'];
  const requested = input.safeTerminal
    ? 'static'
    : override === 'static' || override === 'viewport' || override === 'auto'
      ? override
      : input.configured === 'static' ||
          input.configured === 'viewport' ||
          input.configured === 'auto'
        ? input.configured
        : input.legacyViewport
          ? 'viewport'
          : 'auto';
  if (requested !== 'auto') return requested;
  const term = (environment['TERM'] ?? '').toLowerCase();
  const nonInteractive =
    input.isTTY === false ||
    input.screenReader ||
    term === 'dumb' ||
    environment['CI'] === 'true';
  if (nonInteractive) return 'static';
  // A remote session gets the static renderer.
  //
  // `viewport` takes over the alternate screen and repaints the whole frame on
  // every update. Locally that is smooth; over ssh each repaint is a full screen
  // of bytes across the link, and on a phone terminal the result is a visible
  // flash on every keystroke and every streamed token — reported 2026-07-25 from
  // Termux: "the interface flashes on and off extremely fast ... on desktop and
  // Linux this did not happen".
  //
  // Detection is the ssh server's own variables, because that is all that
  // survives the hop: TERM is forwarded (Termux sends xterm-256color, identical
  // to a desktop terminal) and TERMUX_VERSION is not. So this cannot single out a
  // phone, and does not try to — it distinguishes local from remote, which is the
  // axis that actually predicts the problem.
  //
  // Override in either direction with LAL_TERMINAL_RENDERER=viewport|static.
  if (isRemoteSession(environment)) return 'static';
  return 'viewport';
}

/** True when this process is attached to a terminal on the other end of ssh. */
export function isRemoteSession(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    environment['SSH_TTY'] ||
      environment['SSH_CONNECTION'] ||
      environment['SSH_CLIENT'],
  );
}

export function setTerminalRenderer(renderer: ResolvedTerminalRenderer): void {
  activeRenderer = renderer;
}

export function getTerminalRenderer(): ResolvedTerminalRenderer {
  return activeRenderer ?? 'static';
}

export function isViewportTerminal(legacyViewport = false): boolean {
  return activeRenderer ? activeRenderer === 'viewport' : legacyViewport;
}

export function terminalAnimationsEnabled(): boolean {
  return getTerminalRenderer() !== 'static';
}
