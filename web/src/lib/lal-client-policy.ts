export const LAL_MANAGED_MODEL_POLICY = {
  maxSessionTurns: -1,
  skipLoopDetection: true,
  maxToolCallsPerTurn: -1,
} as const;

// Two minutes is too short for real local builds, test suites, and cold model
// workflows. Retain a deadman instead of making foreground mistakes immortal.
export const LAL_MANAGED_SHELL_DEFAULT_TIMEOUT_MS = 600_000;
