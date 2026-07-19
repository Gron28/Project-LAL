import assert from "node:assert/strict";
import test from "node:test";
import { collectRedactedHostFacts, parseHostCompatibilityProfile, parseRecipeRequirements, resolvePlatformDirectories } from "./host-profile.ts";

test("platform directory resolver follows XDG defaults and explicit roots", () => {
  assert.deepEqual(resolvePlatformDirectories({ platform: "linux", homedir: "/owner", tmpdir: "/tmp", env: {} }), { config: "/owner/.config/project-lal", data: "/owner/.local/share/project-lal", state: "/owner/.local/state/project-lal", cache: "/owner/.cache/project-lal", runtime: "/tmp/project-lal" });
  assert.deepEqual(resolvePlatformDirectories({ platform: "linux", homedir: "/owner", tmpdir: "/tmp", env: { XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state", XDG_CACHE_HOME: "/cache", XDG_RUNTIME_DIR: "/run/user/42" } }), { config: "/cfg/project-lal", data: "/data/project-lal", state: "/state/project-lal", cache: "/cache/project-lal", runtime: "/run/user/42/project-lal" });
});
test("platform directory resolver uses local application data on Windows", () => {
  const directories = resolvePlatformDirectories({ platform: "win32", homedir: "C:\\Users\\owner", tmpdir: "C:\\Temp", env: { LOCALAPPDATA: "D:\\OwnerData", TEMP: "D:\\Temp" } });
  assert.equal(directories.config, "D:\\OwnerData/Project-LAL"); assert.equal(directories.data, "D:\\OwnerData/Project-LAL"); assert.equal(directories.cache, "D:\\OwnerData/Project-LAL/Cache"); assert.equal(directories.runtime, "D:\\Temp/Project-LAL");
});
test("host profile and recipe schemas reject unknown and unsafe values", () => {
  assert.equal(parseHostCompatibilityProfile({ schemaVersion: 1, id: "linux-amd-current", service: { bind: "loopback", port: 3000 }, storage: { quotasMiB: { cache: 512 } }, compatibilityPacks: ["amd-rocm"] }).service?.port, 3000);
  assert.deepEqual(parseRecipeRequirements({ schemaVersion: 1, id: "tiny-training", requires: ["accelerator.memory_mib"], compatibilityPacks: ["amd-rocm"] }), { schemaVersion: 1, id: "tiny-training", requires: ["accelerator.memory_mib"], compatibilityPacks: ["amd-rocm"] });
  assert.throws(() => parseHostCompatibilityProfile({ schemaVersion: 1, id: "bad", secret: "token" }), /unknown key/);
  assert.throws(() => parseHostCompatibilityProfile({ schemaVersion: 1, id: "bad", service: { bind: "lan" } }), /loopback/);
  assert.throws(() => parseRecipeRequirements({ schemaVersion: 2, id: "bad" }), /schemaVersion/);
});
test("doctor facts are useful while excluding paths and environment values", () => {
  const facts = collectRedactedHostFacts({ platform: "linux", homedir: "/private/person", env: { SECRET_TOKEN: "do-not-export", XDG_CONFIG_HOME: "/private/config" }, now: () => new Date("2026-07-19T00:00:00.000Z"), cpus: 8, totalMemoryBytes: 8192 * 1024 * 1024, commandAvailable: (name) => name === "git" });
  assert.equal(facts.commands.git, true); assert.equal(facts.commands.ollama, false); assert.equal(facts.totalMemoryMiB, 8192);
  const serialized = JSON.stringify(facts); assert.equal(serialized.includes("/private"), false); assert.equal(serialized.includes("do-not-export"), false);
  assert.deepEqual(facts.directories, { config: "resolved", data: "resolved", state: "resolved", cache: "resolved", runtime: "resolved" });
});
