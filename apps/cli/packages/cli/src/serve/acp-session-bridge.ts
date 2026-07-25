/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stage 1 HTTP→ACP bridge — backward-compat re-export shim.
 *
 * #4175 PR F1 lifted the bridge core (`BridgeClient`,
 * `defaultSpawnChannelFactory`, `createAcpSessionBridge` factory closure,
 * plus the supporting types/errors/options/status) to
 * `@lal/acp-bridge`. This shim preserves the CLI-local bridge import
 * surface so `server.ts`, `run-qwen-serve.ts`, `workspace-agents.ts`,
 * `workspace-memory.ts`, `index.ts`, plus the bridge test suite, keep resolving
 * through one module.
 *
 * The implementation now lives at:
 *   - `@lal/acp-bridge/bridge` — `createAcpSessionBridge` factory
 *   - `@lal/acp-bridge/bridgeClient` — `BridgeClient` class +
 *     permission record types
 *   - `@lal/acp-bridge/spawnChannel` — `defaultSpawnChannelFactory`
 *   - `@lal/acp-bridge/bridgeOptions` — `BridgeOptions` +
 *     `DaemonStatusProvider` interfaces
 *   - `@lal/acp-bridge/bridgeTypes` — bridge session + heartbeat
 *     types + `AcpSessionBridge` interface
 *   - `@lal/acp-bridge/bridgeErrors` — typed bridge error classes
 *   - `@lal/acp-bridge/workspacePaths` — `canonicalizeWorkspace`
 *     + `MAX_WORKSPACE_PATH_LENGTH`
 *   - `@lal/acp-bridge/status` — protocol-versioned status types
 *     + idle envelope helpers
 *   - `@lal/acp-bridge/channel` — `AcpChannel` + `ChannelFactory`
 *
 * The bridge is bound to a single canonical workspace
 * (`BridgeOptions.boundWorkspace`); multi-workspace deployments use
 * multiple daemon processes. See the module docstring on `bridge.ts`
 * in the lifted package for the full Stage 1/Stage 2 contract.
 */

export {
  createAcpSessionBridge,
  createHttpAcpBridge,
} from '@lal/acp-bridge/bridge';
export { defaultSpawnChannelFactory } from '@lal/acp-bridge/spawnChannel';
// `MAX_RESOLVED_PERMISSION_RECORDS`, `PendingPermission`,
// `PermissionResolutionRecord` re-exports were removed alongside the
// source definitions — the mediator now owns pending+resolved state.
export { BridgeClient } from '@lal/acp-bridge/bridgeClient';
export type { BridgeClientSessionEntry } from '@lal/acp-bridge/bridgeClient';

export type {
  AcpChannel,
  AcpChannelExitInfo,
  ChannelFactory,
} from '@lal/acp-bridge';

export type {
  BridgeFreshSessionAdmission,
  BridgeFreshSessionAdmissionContext,
  BridgeFreshSessionReservation,
  BridgeSessionLifecycle,
  BridgeSessionLifecycleEvent,
  BridgeOptions,
  DaemonStatusProvider,
} from '@lal/acp-bridge/bridgeOptions';

export type { BridgeFileSystem } from '@lal/acp-bridge/bridgeFileSystem';

export type {
  BridgeSpawnRequest,
  BridgeSession,
  BridgeRestoreSessionRequest,
  BridgeSessionState,
  BridgeRestoredSession,
  BridgeSessionTranscriptPage,
  BridgeSessionTranscriptPageRequest,
  BridgeSessionSummary,
  SessionMetadataUpdate,
  BridgeClientRequestContext,
  BridgeHeartbeatResult,
  BridgeHeartbeatState,
  BridgeWorkspaceMemoryRememberContextMode,
  BridgeWorkspaceMemoryRememberRequest,
  BridgeWorkspaceMemoryRememberResult,
  BridgeAutoMemoryTopic,
  BridgeWorkspaceMemoryForgetRequest,
  BridgeWorkspaceMemoryForgetMatch,
  BridgeWorkspaceMemoryForgetResult,
  BridgeWorkspaceMemoryDreamResult,
  BridgeDaemonStatusLimits,
  BridgeDaemonSessionDiagnostic,
  BridgeDaemonStatusSnapshot,
  BridgeShutdownOptions,
  AcpSessionBridge,
  HttpAcpBridge,
} from '@lal/acp-bridge/bridgeTypes';

export {
  BranchWhilePromptActiveError,
  CdWhilePromptActiveError,
  SessionNotFoundError,
  RestoreInProgressError,
  SessionArchivedError,
  SessionConflictError,
  SessionArchivingError,
  InvalidSessionScopeError,
  SessionLimitExceededError,
  PromptQueueFullError,
  WorkspaceMismatchError,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  SessionBusyError,
  WorkspaceDrainingError,
  InvalidRewindTargetError,
  TotalSessionLimitExceededError,
  NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE,
  // Multi-client permission coordination errors.
  CancelSentinelCollisionError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
} from '@lal/acp-bridge/bridgeErrors';

export {
  MAX_WORKSPACE_PATH_LENGTH,
  canonicalizeWorkspace,
} from '@lal/acp-bridge/workspacePaths';

export {
  SessionArtifactAuthorizationError,
  SessionArtifactValidationError,
} from '@lal/acp-bridge/sessionArtifacts';
