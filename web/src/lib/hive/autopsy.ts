import { workflowSnapshot } from "./store";

export type HiveFinding = { code: string; nodeId?: string; detail: string; severity: "warning" | "failure" };

export function diagnoseHiveWorkflow(id: string) {
  const snapshot = workflowSnapshot(id, 2_000);
  if (!snapshot) return null;
  const findings: HiveFinding[] = [];
  const add = (code: string, detail: string, severity: HiveFinding["severity"] = "failure", nodeId?: string) => findings.push({ code, detail, severity, nodeId });
  const retries = new Map<string, number>();
  let swaps = 0;
  for (const node of snapshot.nodes) {
    if (node.attempt > 1) retries.set(node.nodeId, node.attempt - 1);
    if (node.swapMs > 0) swaps++;
    if (node.status === "failed") add("node_failure", node.error || "node failed", "failure", node.nodeId);
    if (node.result?.verification && typeof node.result.verification.passed === "boolean" && !node.result.verification.passed) {
      add(node.role === "verifier" ? "verifier_disagreement" : "verification_failure", node.result.summary, "failure", node.nodeId);
    }
    if (["intake", "decompose", "queries", "plan", "critique"].includes(node.nodeId) && node.result && /\b(implemented|all tests passed|checks passed|successfully completed)\b/i.test(node.result.summary)) {
      add("premature_completion_claim", "A pre-implementation stage described requested outcomes as completed facts.", "failure", node.nodeId);
    }
    if (["implement", "repair"].includes(node.nodeId) && node.attempt > 0 && node.toolCalls === 0) {
      add("worker_no_mutation", "Worker stage made no tool calls; a text-only completion claim cannot establish implementation.", "failure", node.nodeId);
    }
    if (node.nodeId === "verify" && node.result?.verification?.checks.some((c) => !c.passed)) add("unsupported_claims", "Citation checks found claims without valid fetched-source evidence.", "failure", node.nodeId);
    if (["implement", "repair"].includes(node.nodeId) && node.result?.status === "failed") add("incomplete_implementation", node.result.summary, "failure", node.nodeId);
  }
  for (const [nodeId, count] of retries) if (count >= 2) add("repeated_repair_loop", `${count} retries exhausted or repeated`, "warning", nodeId);
  if (swaps > snapshot.workflow.budget.modelSwaps) add("wasted_model_swaps", `${swaps} swaps exceeded budget ${snapshot.workflow.budget.modelSwaps}`);
  const routing = snapshot.events.filter((event) => event.kind === "routing_decision");
  if (!routing.length) add("routing_missing", "No structured routing decisions were recorded.");
  const dispatched = new Set(routing.map((event) => (event.payload as { targetNodeId?: string })?.targetNodeId).filter(Boolean));
  for (const node of snapshot.nodes.filter((n) => n.attempt > 0)) if (!dispatched.has(node.nodeId)) add("routing_error", "Node ran without a recorded dispatch decision.", "failure", node.nodeId);
  if (snapshot.workflow.status === "succeeded" && snapshot.nodes.some((n) => n.result?.verification && !n.result.verification.passed && !["checks", "audit"].includes(n.nodeId))) add("false_completion", "Workflow succeeded despite a required failed verification gate.");
  if (snapshot.events.some((e) => e.kind === "memory_retrieval_failed")) add("memory_retrieval_failure", "A node could not retrieve required external memory.", "warning");
  const hashes = new Set(snapshot.evidence.map((e) => e.sourceHash));
  const blockedSources = snapshot.evidence.filter((e) => /just a moment|enable javascript|cookies to continue/i.test(e.excerpt)).length;
  if (blockedSources) add("blocked_source_content", `${blockedSources} fetched source(s) contained an anti-bot/challenge page instead of useful evidence.`, "warning");
  if (snapshot.evidence.length && hashes.size / snapshot.evidence.length < .9) add("duplicate_source_content", `${snapshot.evidence.length - hashes.size} evidence record(s) duplicate fetched content.`, "warning");
  if (snapshot.workflow.status === "cancelled") add("workflow_cancelled", "The operator or runtime stopped this workflow before all required stages completed.", "warning");
  return {
    workflowId: id,
    verdict: findings.some((f) => f.severity === "failure") ? "failed" : findings.length ? "flawed" : "clean",
    findings,
    firstDivergence: findings[0] || null,
    stats: { nodes: snapshot.nodes.length, completed: snapshot.nodes.filter((n) => n.status === "succeeded").length, retries: [...retries.values()].reduce((a, b) => a + b, 0), swaps, evidence: snapshot.evidence.length },
  };
}
