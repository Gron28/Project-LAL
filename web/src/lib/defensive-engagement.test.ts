import assert from "node:assert/strict";
import test from "node:test";
import { authorizeDefensiveAction, recordEngagementAction, validateResearchContract, verifyEngagementLedger, type DefensiveEngagement } from "./defensive-engagement.ts";

const engagement: DefensiveEngagement = { id: "lab-review", mode: "local_lab", targets: ["lab:fixture"], excludedTargets: [], allowedTechniques: ["static_review"], startsAt: 10, endsAt: 100, networkEnabled: false, requiresApprovalForContact: true, maxActions: 2, stopConditions: ["unexpected target"] };

test("research remains open while high-stakes conclusions require uncertainty", () => {
  assert.deepEqual(validateResearchContract({ question: "Assess evidence", useContext: "research", requiredOutput: "report", sourceRequirements: [], riskDomain: "security", expertReviewRequired: false, definitionOfDone: ["sources"], uncertaintyRequired: true }), []);
  assert.ok(validateResearchContract({ question: "Assess", useContext: "care", requiredOutput: "advice", sourceRequirements: [], riskDomain: "medical", expertReviewRequired: false, definitionOfDone: ["sources"], uncertaintyRequired: false }).length >= 2);
});

test("defensive actions are constrained by mode, target, technique, approval and an auditable ledger", () => {
  const review = { id: "a", target: "lab:fixture", technique: "static_review", contactsTarget: false, mutatesTarget: false, approved: false, at: 20 };
  assert.deepEqual(authorizeDefensiveAction(engagement, review), { allowed: true });
  assert.match(authorizeDefensiveAction(engagement, { ...review, id: "b", contactsTarget: true, approved: true }).reason ?? "", /network disabled/);
  assert.match(authorizeDefensiveAction(engagement, { ...review, target: "host:other" }).reason ?? "", /out of scope/);
  const first = recordEngagementAction([], engagement, review);
  const second = recordEngagementAction([first], engagement, { ...review, id: "blocked", target: "host:other" });
  assert.equal(second.outcome, "blocked");
  assert.equal(verifyEngagementLedger([first, second]), true);
  assert.equal(verifyEngagementLedger([{ ...first, reason: "tampered" }, second]), false);
});
