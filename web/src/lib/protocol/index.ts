// Compatibility façade for historical web imports. The real contract lives in
// packages/protocol and is consumed directly by the host and terminal client.
export {
  isKnownEventKind,
  KNOWN_EVENT_KINDS,
  PROTOCOL_VERSION,
} from "@project-lal/protocol";

export type {
  AdditionalRouteEvent,
  DeliberateEvent,
  HiveTaggedToolLoopEvent,
  HiveWorkflowEvent,
  ProtocolEvent,
  ProtocolHandshakeEvent,
  Role,
  RunEnvelopeEvent,
  RunStatus,
  ToolLoopEvent,
} from "@project-lal/protocol";
