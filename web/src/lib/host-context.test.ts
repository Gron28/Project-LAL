import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_ADAPTER_CONCERNS,
  createHostContext,
  explainHostConfiguration,
  parseCompatibilityCapsule,
  resolveHostConfiguration,
  type HostAdapterRegistry,
} from "./host-context.ts";
import { parseHostCompatibilityProfile } from "./host-profile.ts";

const adapterSelections = Object.fromEntries(HOST_ADAPTER_CONCERNS.map((concern) => [concern, `${concern}-linux`])) as Record<typeof HOST_ADAPTER_CONCERNS[number], string>;
const registry: HostAdapterRegistry = {
  process: ["process-linux"], service: ["service-linux"], monitor: ["monitor-linux"], runtime: ["runtime-linux"], network: ["network-linux"],
  desktop: ["desktop-linux"], workspace: ["workspace-linux"], "client-distribution": ["client-distribution-linux"], training: ["training-linux"],
};

test("current-host capsule has complete public adapter selections and rejects unsafe fields", () => {
  const capsule = parseCompatibilityCapsule({
    schemaVersion: 1, id: "linux-amd-current", generatedAt: "2026-07-19T00:00:00.000Z", adapters: adapterSelections,
    service: { bind: "loopback", port: 3000 }, network: { remoteExposure: "tailscale-serve", identityAdapter: "tailscale-serve" },
    executables: { llama_server: "/opt/lal/llama-server" }, probeEvidence: [{ adapterId: "runtime-linux", status: "supported", observedAt: "2026-07-19T00:00:00.000Z" }],
  });
  assert.equal(capsule.service?.bind, "loopback");
  assert.equal(capsule.adapters.training, "training-linux");
  assert.throws(() => parseCompatibilityCapsule({ schemaVersion: 1, id: "bad", generatedAt: "2026-07-19T00:00:00.000Z", adapters: adapterSelections, token: "secret" }), /unknown key/);
  assert.throws(() => parseCompatibilityCapsule({ schemaVersion: 1, id: "bad", generatedAt: "2026-07-19T00:00:00.000Z", adapters: adapterSelections, service: { bind: "lan" } }), /loopback/);
});

test("configuration resolution preserves ordered contributions and creates an immutable adapter context", () => {
  const defaults = parseHostCompatibilityProfile({ schemaVersion: 1, id: "defaults", service: { bind: "loopback", port: 3000 }, storage: { quotasMiB: { cache: 128 } } });
  const owner = parseHostCompatibilityProfile({ schemaVersion: 1, id: "owner", service: { bind: "loopback", port: 3400 }, storage: { quotasMiB: { data: 512 } } });
  const configuration = resolveHostConfiguration([{ name: "defaults", profile: defaults }, { name: "owner-profile", profile: owner }]);
  const explanation = explainHostConfiguration(configuration, "service.port");
  assert.equal(explanation.value, 3400);
  assert.deepEqual(explanation.contributions.map((item) => item.layer), ["defaults", "owner-profile"]);
  const context = createHostContext({ configuration, registry, capsule: parseCompatibilityCapsule({ schemaVersion: 1, id: "current", generatedAt: "2026-07-19T00:00:00.000Z", adapters: adapterSelections }) });
  assert.equal(context.adapters.runtime, "runtime-linux");
  assert.throws(() => createHostContext({ configuration, registry, capsule: parseCompatibilityCapsule({ schemaVersion: 1, id: "bad", generatedAt: "2026-07-19T00:00:00.000Z", adapters: { ...adapterSelections, runtime: "not-registered" } }) }), /unavailable runtime adapter/);
});
