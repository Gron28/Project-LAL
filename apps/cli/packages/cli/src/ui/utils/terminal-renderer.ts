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
  return nonInteractive ? 'static' : 'viewport';
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
