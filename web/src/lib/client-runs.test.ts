import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessClientRun,
  appendClientEvents,
  createClientRun,
  deleteRun,
  enqueueClientCommand,
  finishClientRun,
  heartbeatClientRun,
} from "./runs.ts";

const OWNER = "cli-test-owner-0001";

test("client run ingestion is capability-bound, idempotent, and leases submit commands", () => {
  const { meta, ingestToken } = createClientRun({
    kind: "code", projectLabel: "remote-project", model: "windows-local",
  }, OWNER);
  try {
    assert.equal(accessClientRun(meta.id, "cli-other-device-0002", ingestToken).ok, false);
    assert.equal(accessClientRun(meta.id, OWNER, "wrong").ok, false);
    const access = accessClientRun(meta.id, OWNER, ingestToken);
    assert.equal(access.ok, true);
    if (!access.ok) return;

    const first = appendClientEvents(access.meta, [{ clientEventId: "event-1", event: { k: "text", v: "hello" } }]);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.accepted[0].seq, 1);
    const replay = appendClientEvents(access.meta, [{ clientEventId: "event-1", event: { k: "text", v: "hello" } }]);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.accepted[0].seq, 1, "retry must not duplicate the ledger event");
    assert.equal(appendClientEvents(access.meta, [{ clientEventId: "bad", event: { k: "status", v: "done" } }]).ok, false);

    const queued = enqueueClientCommand(meta.id, "phone-owner-0003", "continue from the phone");
    assert.equal(queued.ok, true);
    const claimed = heartbeatClientRun(access.meta);
    assert.equal(claimed.command?.type, "submit");
    assert.equal(claimed.command?.text, "continue from the phone");
    const acknowledged = heartbeatClientRun(access.meta, { id: claimed.command?.id, leaseId: claimed.command?.leaseId });
    assert.equal(acknowledged.command, undefined);

    assert.deepEqual(finishClientRun(access.meta, "done"), { ok: true });
  } finally {
    deleteRun(meta.id);
  }
});
