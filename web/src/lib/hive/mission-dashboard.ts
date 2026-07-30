import type { TaskVerdict } from "./contracts";
import type { HiveEvent, WorkflowNodeRecord, WorkflowRecord } from "./store";
import type { EvidenceRecord } from "./contracts";
import { isContradictionText } from "./research-quality.ts";

const payload = (event: HiveEvent) => event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};

export function buildMissionDashboard(workflow: WorkflowRecord, nodes: WorkflowNodeRecord[], evidence: EvidenceRecord[], events: HiveEvent[], now = Date.now()) {
  const verdict = workflow.working.verdict as TaskVerdict | undefined;
  const active = nodes.find((node) => ["ready", "running", "awaiting_approval"].includes(node.status));
  const lastSeq = events.at(-1)?.seq || 0;
  const started = workflow.startedAt || workflow.createdAt;
  const finished = workflow.finishedAt || now;
  const lifecycle = events.filter((event) => /started|finished|failed|tool|approval|routing|handoff|checkpoint|operator/.test(event.kind));
  const toolEvents = events.filter((event) => /tool_request|tool_result/.test(event.kind));
  const handoffs = events.filter((event) => event.kind === "agent_handoff");
  const policy = events.find((event) => event.kind === "workflow_policy_selected");
  const sourceClassifications = new Map(
    events
      .filter((event) => event.kind === "source_classified")
      .map((event) => [String(payload(event).evidenceId || ""), event]),
  );
  const contradictionFindings = nodes.flatMap((node) =>
    (node.result?.findings || [])
      .filter((finding) => isContradictionText(finding.text))
      .map((finding) => ({ nodeId: node.nodeId, findingId: finding.id, evidenceIds: finding.evidenceIds || [], text: finding.text })),
  );
  const dropped = events.filter((event) => /dropped|reconnect|stale|context_loss/.test(event.kind));
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const criticalPath = new Map<string, number>();
  for (const definition of workflow.spec.nodes) {
    const dependencyMs = Math.max(0, ...definition.dependsOn.map((id) => criticalPath.get(id) || 0));
    criticalPath.set(definition.id, dependencyMs + (nodeById.get(definition.id)?.durationMs || 0));
  }
  const criticalPathMs = Math.max(0, ...criticalPath.values());
  const eventRef = (event: HiveEvent) => ({ eventId: event.eventId, seq: event.seq });
  // A committed node result is itself a durable checkpoint even when an older
  // ledger predates the explicit `checkpoint_*` event name.
  const checkpointEvents = events.filter((event) => /checkpoint|node_finished/.test(event.kind));
  const queryEvents = events.filter((event) => /search/.test(event.kind));
  const approvalEvents = events.filter((event) => /approval/.test(event.kind));
  const operatorEvents = events.filter((event) => /operator|manual_override|workflow_rewound|evidence_decision|execution_policy_updated/.test(event.kind));
  const firstEventTs = events[0]?.ts || started;
  const lastEventTs = events.at(-1)?.ts || finished;
  return {
    generatedAt: now,
    mission: {
      objective: workflow.envelope.objective,
      deliverables: workflow.envelope.deliverables || [],
      criteria: verdict?.criteria || workflow.envelope.acceptanceCriteria || [],
      conclusion: verdict?.reason || workflow.error || "",
      nextAction: active ? `${active.label} (${active.status})` : verdict ? "Run is terminal." : "Waiting for the next schedulable node.",
      blocker: workflow.status === "blocked" ? workflow.error || "External input required." : null,
      elapsedMs: Math.max(0, finished - started),
      forecastMs: active && nodes.filter((node) => node.status === "pending").length
        ? Math.round(nodes.filter((node) => node.durationMs).reduce((sum, node) => sum + (node.durationMs || 0), 0) / Math.max(1, nodes.filter((node) => node.durationMs).length)
          * nodes.filter((node) => ["pending", "ready", "running", "awaiting_approval"].includes(node.status)).length)
        : 0,
      workflowStatus: workflow.status,
    },
    graph: {
      nodes: nodes.map((node) => ({
        id: node.nodeId, label: node.label, status: node.status, attempt: node.attempt,
        durationMs: node.durationMs || 0,
        checkpoint: checkpointEvents.findLast((event) => event.nodeId === node.nodeId) ? eventRef(checkpointEvents.findLast((event) => event.nodeId === node.nodeId)!) : null,
      })),
      routes: workflow.spec.nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: dependency, to: node.id }))),
      currentNodeId: active?.nodeId,
      concurrency: nodes.filter((node) => node.status === "running").length,
      criticalPathMs,
      executionWindowMs: Math.max(0, lastEventTs - firstEventTs),
      checkpoints: checkpointEvents.map((event) => ({ ...eventRef(event), nodeId: event.nodeId, ts: event.ts })),
      skipReasons: events.filter((event) => event.kind === "node_skipped").map((event) => ({ nodeId: event.nodeId, eventId: event.eventId, reason: payload(event).reason })),
      policy: policy ? { eventId: policy.eventId, ...payload(policy) } : null,
    },
    timeline: lifecycle.map((event, index) => ({
      eventId: event.eventId, seq: event.seq, ts: event.ts, kind: event.kind, nodeId: event.nodeId,
      spanId: event.spanId, parentSpanId: event.parentSpanId,
      gapFromPreviousMs: index ? Math.max(0, event.ts - lifecycle[index - 1].ts) : 0,
    })),
    agents: nodes.filter((node) => node.modelVersion).map((node) => ({
      nodeId: node.nodeId, role: node.role, modelVersion: node.modelVersion, promptTokens: node.promptTokens,
      completionTokens: node.completionTokens, contextTokens: node.contextTokens, durationMs: node.durationMs || 0,
      swapMs: node.swapMs, adapterMs: node.adapterMs, structuredOutputValid: node.status !== "failed",
      decodeTokensPerSecond: node.durationMs && node.completionTokens ? node.completionTokens / (node.durationMs / 1_000) : null,
      finishReason: node.status,
    })),
    tools: toolEvents.map((event) => ({
      eventId: event.eventId, nodeId: event.nodeId, kind: event.kind, ts: event.ts,
      tool: payload(event).name, ok: payload(event).ok, latencyMs: payload(event).latencyMs,
      approval: payload(event).approval, idempotency: payload(event).fingerprint, payloadRedacted: event.payloadRedacted,
      resultSize: payload(event).resultSize ?? null,
      sideEffectClass: payload(event).sideEffectClass ?? (/write|edit|shell|git/.test(String(payload(event).name || "")) ? "mutating" : "read_only"),
    })),
    research: {
      queries: queryEvents.map((event) => ({ ...eventRef(event), nodeId: event.nodeId, query: payload(event).query || payload(event).text || null })),
      sources: evidence.map((item) => {
        const classification = sourceClassifications.get(item.id);
        const details = classification ? payload(classification) : {};
        return {
          evidenceId: item.id,
          eventId: classification?.eventId,
          url: item.url,
          origin: (() => { try { return new URL(item.url).origin; } catch { return item.url; } })(),
          stance: item.stance,
          claim: item.claim,
          retrievedAt: item.retrievedAt,
          ageMs: Math.max(0, now - item.retrievedAt),
          sourceClass: details.sourceClass || "unknown",
          authorityScore: details.authorityScore ?? null,
        };
      }),
      independentOrigins: new Set(evidence.map((item) => { try { return new URL(item.url).origin; } catch { return item.url; } })).size,
      contradictions: [
        ...evidence.filter((item) => item.stance === "contradicting").map((item) => ({ evidenceId: item.id })),
        ...contradictionFindings,
      ],
      claims: nodes.flatMap((node) => (node.result?.findings || []).filter((finding) => finding.evidenceIds?.length).map((finding) => ({
        nodeId: node.nodeId, findingId: finding.id, text: finding.text, evidenceIds: finding.evidenceIds,
      }))),
      entailmentChecks: nodes.flatMap((node) => (node.result?.verification?.checks || []).filter((check) => /claim:|entail/i.test(check.code)).map((check) => ({ nodeId: node.nodeId, ...check }))),
      marginalReturn: evidence.length ? new Set(evidence.map((item) => { try { return new URL(item.url).origin; } catch { return item.url; } })).size / evidence.length : 0,
      unresolvedGaps: verdict?.uncheckedProperties || [],
    },
    coding: {
      artifacts: nodes.flatMap((node) => node.result?.artifacts.map((artifact) => ({ nodeId: node.nodeId, ...artifact })) || []),
      checks: nodes.flatMap((node) => node.result?.verification?.checks.map((check) => ({ nodeId: node.nodeId, ...check })) || []),
      mutations: toolEvents.filter((event) => /write|edit|git|shell/.test(String(payload(event).name || ""))).map((event) => ({ ...eventRef(event), nodeId: event.nodeId, tool: payload(event).name })),
      browserChecks: nodes.flatMap((node) => (node.result?.verification?.checks || []).filter((check) => /browser|html001|canvas|interaction/.test(check.code)).map((check) => ({ nodeId: node.nodeId, ...check }))),
      uncheckedBehavior: verdict?.uncheckedProperties || workflow.envelope.unverifiableProperties || [],
    },
    resources: {
      promptTokens: nodes.reduce((sum, node) => sum + node.promptTokens, 0),
      completionTokens: nodes.reduce((sum, node) => sum + node.completionTokens, 0),
      modelSwapMs: nodes.reduce((sum, node) => sum + node.swapMs, 0),
      toolCalls: nodes.reduce((sum, node) => sum + node.toolCalls, 0),
      hostMetricsEndpoint: "/api/sysinfo",
      activeProcessesEndpoint: "/api/sysinfo",
    },
    quality: {
      outcome: verdict?.outcome || workflow.status,
      acceptancePassed: verdict?.criteria.filter((criterion) => criterion.state === "pass").length || 0,
      acceptanceTotal: verdict?.criteria.length || 0,
      handoffs: handoffs.map((event) => ({ eventId: event.eventId, included: payload(event).included, omitted: payload(event).omitted, linkedArtifactHashes: payload(event).linkedArtifactHashes })),
      firstDivergence: events.find((event) => /failed|context_loss|rejected/.test(event.kind))?.eventId,
      trajectoryEfficiency: events.length ? nodes.filter((node) => node.status === "succeeded").length / events.length : 0,
      falseCompletionGuard: verdict?.outcome !== "complete" || (verdict.criteria.length > 0 && verdict.criteria.every((criterion) => criterion.state === "pass")),
      approvals: approvalEvents.map(eventRef),
      interventions: operatorEvents.map((event) => ({ ...eventRef(event), kind: event.kind, ts: event.ts })),
      baselineWorkflowId: workflow.working.baselineWorkflowId || null,
    },
    ledgerHealth: {
      firstSeq: events[0]?.seq || 0,
      lastSeq,
      visibleEvents: events.length,
      sequenceGap: events.some((event, index) => index > 0 && event.seq <= events[index - 1].seq),
      anomalies: dropped.map((event) => ({ eventId: event.eventId, kind: event.kind, seq: event.seq })),
      unknownEventVersions: events.filter((event) => !event.schemaKnown).map((event) => ({ eventId: event.eventId, schemaVersion: event.schemaVersion })),
      snapshotAgeMs: Math.max(0, now - workflow.updatedAt),
    },
  };
}
