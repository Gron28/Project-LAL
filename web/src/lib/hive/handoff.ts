import crypto from "node:crypto";
import type { SpecialistHandoff, TaskEnvelope } from "./contracts";

function stableContract(envelope: TaskEnvelope) {
  return {
    objective: envelope.objective,
    latestUserRequest: envelope.latestUserRequest || envelope.objective,
    requiredOutput: envelope.requiredOutput,
    constraints: envelope.constraints,
    definitionOfDone: envelope.definitionOfDone,
    acceptanceCriteria: envelope.acceptanceCriteria || [],
  };
}

export function taskContractDigest(envelope: TaskEnvelope): string {
  return crypto.createHash("sha256").update(JSON.stringify(stableContract(envelope))).digest("hex");
}

export function validateHandoff(handoff: SpecialistHandoff, envelope: TaskEnvelope): string[] {
  const problems: string[] = [];
  if (handoff.contractDigest !== taskContractDigest(envelope)) problems.push("task contract digest changed across the handoff");
  for (const requirement of envelope.definitionOfDone) {
    if (!handoff.task.definitionOfDone.includes(requirement)) problems.push(`missing requirement: ${requirement}`);
  }
  for (const dependency of handoff.dependencies) {
    if (!handoff.linkedArtifactHashes.some((hash) => dependency.artifacts.some((artifact) => artifact.hash === hash))) {
      if (dependency.artifacts.length) problems.push(`dependency artifacts are not linked: ${dependency.nodeId}`);
    }
  }
  return problems;
}
