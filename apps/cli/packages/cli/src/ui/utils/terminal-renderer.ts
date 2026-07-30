export type TerminalRenderer = 'auto' | 'viewport' | 'static';
export type ResolvedTerminalRenderer = Exclude<TerminalRenderer, 'auto'>;

let activeRenderer: ResolvedTerminalRenderer | null = null;

export function resolveTerminalRenderer(input: {
  configured?: string;
  legacyViewport?: boolean;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  screenReader?: boolean;
  safeTerminal?: boolean;
}): ResolvedTerminalRenderer {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
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
  // Windows' normal-buffer cursor can fall one row out of sync after Ink
  // commits new <Static> output while the dynamic composer changes height
  // (observed after /export). Every later repaint then scrolls the whole
  // transcript: once per typed character, and once per elapsed-time tick while
  // the model responds. The managed viewport owns fixed screen rows and avoids
  // that cursor-relative normal-buffer path entirely.
  //
  // Keep explicit `terminalRenderer: static`, LAL_TERMINAL_RENDERER=static,
  // --safe-terminal, screen-reader, redirected, and remote sessions as escape
  // hatches above. Auto only selects viewport for a local interactive Windows
  // TTY.
  if (platform === 'win32') return 'viewport';
  // Default non-Windows terminals to `static`, matching how Claude Code's
  // terminal behaves: render inline, never take the alternate screen, and let
  // the TERMINAL own scrollback.
  //
  // `viewport` takes the alternate screen, which has no scrollback of its own.
  // With mouse reporting off (the default since text selection was fixed) the
  // terminal then translates the wheel into arrow keys — byte-identical to
  // real arrows, so the app cannot tell them apart and routes them to prompt
  // history. Reported from the field as "the scrollwheel picks previous
  // messages instead of scrolling the chat".
  //
  // There is no setting that makes viewport give both wheel-scroll and
  // drag-select: with mouse reporting ON the app gets the wheel but the
  // terminal stops painting selections, and with it OFF the wheel becomes
  // arrows. Inline rendering sidesteps the choice entirely — the terminal
  // scrolls its own buffer and selects its own text, exactly as it does for
  // every other CLI. Opt back in with LAL_TERMINAL_RENDERER=viewport.
  return 'static';
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
