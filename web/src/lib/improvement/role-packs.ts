import type { RolePack } from "./contracts.ts";
import { IMPROVEMENT_SCHEMA_VERSION } from "./contracts.ts";

const DEFAULT_POLICY = {
  minimumBaseImprovementPoints: 5,
  confidenceLevel: .95,
  parityMarginPoints: 2,
  maximumRegressionPoints: 2,
  workflowImprovementPoints: 10,
  requireZeroUnauthorizedActions: true,
  requireZeroFalseCompletions: true,
} as const;

export const CORE_TOOL_USE_V1: RolePack = Object.freeze({
  schemaVersion: IMPROVEMENT_SCHEMA_VERSION,
  id: "core-tool-use-v1",
  version: "1.0.0",
  sharedBaseRequired: true,
  roles: [
    { id: "core.coordinator_planner", aliases: ["coordinator_planner", "coordinator", "planner", "comprehension"], description: "Decomposition, routing, dependency order, and completion decisions.", permittedTools: [], objective: "Produce bounded executable plans and evidence-based completion decisions." },
    { id: "core.coder_repairer", aliases: ["coder_repairer", "coder"], description: "Tool selection, mutation correctness, recovery, and preservation.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep", "write_file", "edit_file", "run_shell"], objective: "Implement and repair scoped changes while preserving unrelated work." },
    { id: "core.verifier", aliases: ["verifier"], description: "Evidence-based verdicts, regression detection, and false-completion prevention.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep", "run_shell"], objective: "Verify every claimed outcome against deterministic evidence." },
  ],
  developmentSuites: ["core-tool-use-v1-development"],
  hiddenSuite: "core-tool-use-v1-hidden",
  regressionSuites: ["core-capability-v1"],
  workflowSuite: "core-tool-use-v1-workflow",
  scoringPolicy: DEFAULT_POLICY,
});

const builtIns = new Map([[`${CORE_TOOL_USE_V1.id}@${CORE_TOOL_USE_V1.version}`, CORE_TOOL_USE_V1]]);
const identifier = /^[a-z][a-z0-9._-]{0,127}$/;

export function validateRolePack(pack: RolePack): RolePack {
  if (pack.schemaVersion !== IMPROVEMENT_SCHEMA_VERSION) throw new Error(`role pack schemaVersion must be ${IMPROVEMENT_SCHEMA_VERSION}`);
  if (!identifier.test(pack.id) || !pack.version.trim() || !pack.roles.length) throw new Error("role pack id, version, and roles are required");
  const ids = new Set<string>();
  for (const role of pack.roles) {
    if (!identifier.test(role.id) || ids.has(role.id)) throw new Error("role ids must be unique namespaced identifiers");
    ids.add(role.id);
    for (const alias of role.aliases ?? []) { if (!identifier.test(alias) || ids.has(alias)) throw new Error("role aliases must be unique identifiers"); ids.add(alias); }
    if (!role.description.trim() || !role.objective.trim() || new Set(role.permittedTools).size !== role.permittedTools.length) throw new Error("role definition is incomplete");
  }
  if (!pack.developmentSuites.length || !pack.hiddenSuite || !pack.workflowSuite) throw new Error("role pack suites are incomplete");
  return Object.freeze(structuredClone(pack));
}

export function listRolePacks(): RolePack[] { return [...builtIns.values()]; }
export function getRolePack(id: string, version?: string): RolePack | null { return [...builtIns.values()].find((pack) => pack.id === id && (!version || pack.version === version)) ?? null; }
export function resolveRoleId(pack: RolePack, value: string): string | null { return pack.roles.find((role) => role.id === value || role.aliases?.includes(value))?.id ?? null; }
