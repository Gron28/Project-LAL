import assert from "node:assert/strict";
import test from "node:test";
import { authorizeBrowserMutation } from "./browser-mutation-guard.ts";

function request(origin?: string, url = "http://lal.local/api/agent/fs"): Request {
  return new Request(url, {
    method: "PUT",
    headers: origin === undefined ? {} : { origin },
  });
}

test("allows an exact same-origin browser mutation", () => {
  assert.deepEqual(authorizeBrowserMutation(request("http://lal.local")), { ok: true });
  assert.deepEqual(authorizeBrowserMutation(request("https://lal.local:8443", "https://lal.local:8443/api/agent/fs")), { ok: true });
});

test("fails closed when Origin is missing or null", () => {
  assert.deepEqual(authorizeBrowserMutation(request()), {
    ok: false, status: 403, code: "origin_required",
  });
  assert.deepEqual(authorizeBrowserMutation(request("null")), {
    ok: false, status: 403, code: "origin_invalid",
  });
});

test("rejects cross-origin, malformed, and non-origin Origin values", () => {
  assert.deepEqual(authorizeBrowserMutation(request("https://attacker.example")), {
    ok: false, status: 403, code: "origin_mismatch",
  });
  assert.deepEqual(authorizeBrowserMutation(request("not a URL")), {
    ok: false, status: 403, code: "origin_invalid",
  });
  assert.deepEqual(authorizeBrowserMutation(request("http://lal.local/extra")), {
    ok: false, status: 403, code: "origin_invalid",
  });
  assert.deepEqual(authorizeBrowserMutation(request("http://user@lal.local")), {
    ok: false, status: 403, code: "origin_invalid",
  });
});
