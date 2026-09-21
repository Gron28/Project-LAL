/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One bounded coordination recipe on the native project executor.
 *
 * Keep this deliberately sequential: the first migration gate is proving one
 * useful inspect/implement/check/repair path with one inference slot. Parallel
 * specialists and the legacy host DAG are not prerequisites for this path.
 */
export const NATIVE_HIVE_CODING_WORKFLOW = `
export const meta = {
  name: "native-hive-coding",
  description: "Sequential inspect, implement, check, and repair in the CLI-owned project",
  phases: [
    { title: "Inspect" },
    { title: "Implement" },
    { title: "Check" },
    { title: "Repair" }
  ],
  whenToUse: "A bounded coding mission that must execute in the current CLI project"
};

const objective = args && typeof args.objective === "string" ? args.objective.trim() : "";
if (!objective) throw new Error("native HIVE requires a non-empty objective");
const done = Array.isArray(args.definitionOfDone) ? args.definitionOfDone : [];
const acceptance = done.length ? done.join("; ") : "deterministic checks pass and the requested change is audited";

phase("Inspect");
const inspection = await agent(
  "Inspect the current project for this objective: " + objective +
  ". Do not modify files. Return the relevant files, current behavior, constraints, and the smallest implementation plan.",
  { label: "inspect", phase: "Inspect" }
);

phase("Implement");
const implementation = await agent(
  "Implement this objective in the current project: " + objective +
  ". Acceptance criteria: " + acceptance +
  ". Use the prior inspection as guidance, preserve unrelated changes, and make only the necessary edits. Inspection: " + String(inspection).slice(0, 8000),
  { label: "implement", phase: "Implement" }
);

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

// Read a required boolean verdict field out of a structured_output payload.
// Returns null (not true/false) when the payload is missing, malformed, or
// the agent never produced structured output at all (e.g. it returned plain
// text) — that null is the "unchecked" case: fresh evidence was never
// established, so it must never be treated as success.
function readVerdict(candidate, key) {
  if (candidate && typeof candidate === "object" && typeof candidate[key] === "boolean") {
    return candidate[key];
  }
  return null;
}

// Read an optional string-array field, defaulting to [] for a missing or
// malformed payload so downstream .length checks never throw.
function readList(candidate, key) {
  if (candidate && typeof candidate === "object" && Array.isArray(candidate[key])) {
    return candidate[key];
  }
  return [];
}

// Fold a verdict boolean plus its two criteria lists into one of three
// outcomes. This is the fix for the remaining false-completion gap flagged
// in ACCEPTANCE.md's "Native Hive" row ("acceptance defaults are generic"):
// a sub-agent can now commit to a structured boolean, but a vague bar let it
// commit that boolean against nothing. The defaults below ask each criterion
// to be either genuinely executed (pass/fail) or explicitly reported as not
// executable in THIS project (blocked) — never silently folded into either.
//   - met: passed === true.
//   - unchecked: passed is not a boolean at all (no structured verdict —
//     the pre-existing "unchecked" case), OR passed === false but nothing
//     in unmetCriteria actually failed a real check — every remaining item
//     is blockedCriteria (a check that does not exist in this project, e.g.
//     no test command). Reporting that as "unmet"/incomplete would claim a
//     real failing check exists when none does; "unchecked" is the honest
//     outcome, matching Gate 2's "an absent check ... yield blocked, NOT
//     complete and NOT a false failed [i.e. incomplete]".
//   - unmet: passed === false and at least one criterion was actually
//     checked and failed (present in unmetCriteria).
function classifyVerdict(passedValue, unmetList, blockedList) {
  if (passedValue === true) return "met";
  if (passedValue === false) {
    const hasUnmet = unmetList.length > 0;
    const hasBlocked = blockedList.length > 0;
    if (!hasUnmet && hasBlocked) return "unchecked";
    return "unmet";
  }
  return "unchecked";
}

phase("Check");
const CHECK_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    evidence: { type: "string" },
    unmetCriteria: { type: "array", items: { type: "string" } },
    blockedCriteria: { type: "array", items: { type: "string" } }
  },
  required: ["passed", "evidence"]
};
const verification = await agent(
  "Independently verify the working tree against this objective: " + objective +
  ". Acceptance criteria: " + acceptance +
  ". For any criterion that names or implies an executable check (for example: tests, a type check, a lint, a build), first determine whether THIS project actually defines that command by inspecting its own configuration — do not assume any particular language, package manager, or tool, and do not invent or substitute a command the project does not define. " +
  "If the project defines the command, run that exact command yourself in this run and report the exact command text and its exit code as evidence. " +
  "If the project defines no such command, do not guess, do not claim the criterion passed, and do not claim it failed — list it in blockedCriteria instead. Report exact failures for anything you did run, and never claim success without evidence you personally executed this run. " +
  "Call structured_output with {passed, evidence, unmetCriteria, blockedCriteria}: passed must be true only if every acceptance criterion has fresh, executed evidence of success from a command you ran this run. Otherwise set passed false, put criteria you actually ran and that failed in unmetCriteria, and put criteria you could not run at all in this project in blockedCriteria (never both).",
  { label: "check", phase: "Check", schema: CHECK_SCHEMA }
);

const checkPassed = readVerdict(verification, "passed");
const checkUnmet = readList(verification, "unmetCriteria");
const checkBlocked = readList(verification, "blockedCriteria");
// met / unmet / unchecked. Repair only runs when verification did NOT
// already establish a passing verdict — this is the fix for "repair always
// runs even after successful verification".
let verdict = classifyVerdict(checkPassed, checkUnmet, checkBlocked);
let repair = null;

if (verdict !== "met") {
  phase("Repair");
  const REPAIR_SCHEMA = {
    type: "object",
    properties: {
      fixed: { type: "boolean" },
      evidence: { type: "string" },
      remainingUnmet: { type: "array", items: { type: "string" } },
      remainingBlocked: { type: "array", items: { type: "string" } }
    },
    required: ["fixed", "evidence"]
  };
  repair = await agent(
    "Review the verification for this objective: " + objective +
    ". Acceptance criteria: " + acceptance +
    ". The prior check was " + verdict + ": " + safeStringify(verification).slice(0, 8000) +
    ". Repair every criterion in unmetCriteria (a check you can run that actually failed). For blockedCriteria (no such check exists in this project), only act if you can legitimately add the missing, project-appropriate check yourself — otherwise leave it blocked rather than inventing a command to satisfy it. Then rerun the relevant checks yourself. " +
    "Call structured_output with {fixed, evidence, remainingUnmet, remainingBlocked} reflecting the FRESH recheck you just ran, not the original verification: remainingUnmet for checks you ran that still fail, remainingBlocked for checks this project still has no way to run.",
    { label: "repair", phase: "Repair", schema: REPAIR_SCHEMA }
  );
  const repairFixed = readVerdict(repair, "fixed");
  const repairUnmet = readList(repair, "remainingUnmet");
  const repairBlocked = readList(repair, "remainingBlocked");
  verdict = classifyVerdict(repairFixed, repairUnmet, repairBlocked);
}

// Fresh evidence must justify completion (ACCEPTANCE.md Gate 2). A script
// that returns normally here is reported "complete" by the workflow tool
// regardless of what the returned object contains, so an unmet or
// never-established ("unchecked") verdict must throw instead of returning —
// otherwise the run is falsely reported complete. "incomplete" and
// "blocked" stay distinguishable in the message; genuine cancellation
// (AbortError) and infrastructure failures are never caught above, so they
// keep propagating as their own distinct outcomes.
if (verdict !== "met") {
  const outcomeLabel = verdict === "unmet" ? "incomplete" : "blocked";
  throw new Error(
    "native HIVE " + outcomeLabel + ": acceptance criteria not confirmed met for objective '" + objective + "'. " +
    "Verification: " + safeStringify(verification) +
    (repair !== null ? ". Repair: " + safeStringify(repair) : "")
  );
}

return { objective, acceptance, inspection, implementation, verification, repair };
`.trim();

export interface NativeHiveWorkflowArgs {
  objective: string;
  definitionOfDone: string[];
}

export function buildNativeHiveWorkflowParams(objective: string): {
  script: string;
  args: NativeHiveWorkflowArgs;
} {
  const normalized = objective.trim();
  if (!normalized) {
    throw new Error('native HIVE requires a non-empty objective');
  }
  return {
    script: NATIVE_HIVE_CODING_WORKFLOW,
    args: {
      objective: normalized,
      // These are defaults for an ARBITRARY, unknown project — they must be
      // universally checkable without assuming a language, package manager,
      // or specific command, and an absent check must resolve to "blocked",
      // never a false "complete" or a false "incomplete" (ACCEPTANCE.md
      // Gate 2: "an absent check ... yield blocked, NOT complete and NOT a
      // false failed"). Each criterion below is written so the Check/Repair
      // phases (see the schema and prompts above) have somewhere concrete to
      // point an actually-executed command and its exit code, or to say
      // plainly that this project defines no such command — rather than a
      // prose bar a confident sub-agent can assert against without evidence.
      definitionOfDone: [
        // Checkable by direct inspection of the working tree in every
        // project — no tool or language assumption. Not itself an
        // "executable" criterion, but it anchors the other criteria to a
        // concrete, inspectable change rather than a claim.
        'The requested implementation is present in the current CLI project, evidenced by specific files and content inspected in this run (not asserted from memory)',
        // Universally checkable ONLY because it is conditioned on project
        // self-declaration: "if this project defines a test command, run
        // THAT one" rather than assuming npm/pytest/make/etc. A project with
        // no test command legitimately reports this criterion blocked, not
        // passed or failed.
        "If this project defines an automated test command (discovered from the project's own configuration, not assumed), that exact command was executed in this run and its exit code is reported; if this project defines no test command, this criterion is reported blocked rather than passed or failed",
        // Same reasoning as the test criterion, for the other common
        // deterministic gate (type check / lint / build). Kept as one
        // criterion rather than three separate ones so a project that has
        // only one of them is not penalized for lacking the others.
        "If this project defines a type-check, lint, or build command (discovered from the project's own configuration, not assumed), that exact command was executed in this run and its exit code is reported; if this project defines none of these, this criterion is reported blocked rather than passed or failed",
        // The rigor requirement itself, made explicit as a criterion so the
        // Check phase cannot satisfy the two above with prose ("tests
        // pass") instead of an actually-run command plus its exit status.
        'Every criterion above is backed by the exact command executed and its exit code from THIS run, not by an unexecuted assertion of success',
      ],
    },
  };
}
