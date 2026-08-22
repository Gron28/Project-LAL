import assert from "node:assert/strict";
import test from "node:test";
import { authorizeBrowserMutation } from "./browser-mutation-guard.ts";

function request(
  origin?: string,
  url = "http://lal.local/api/agent/fs",
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "PUT",
    headers: origin === undefined ? extraHeaders : { ...extraHeaders, origin },
  });
}

test("allows an exact same-origin browser mutation", () => {
  assert.deepEqual(authorizeBrowserMutation(request("http://lal.local")), { ok: true });
  assert.deepEqual(authorizeBrowserMutation(request("https://lal.local:8443", "https://lal.local:8443/api/agent/fs")), { ok: true });
});

test("uses the browser-facing authority when Next.js is bound to localhost", () => {
  assert.deepEqual(authorizeBrowserMutation(request(
    "http://192.168.1.3:8770",
    "http://localhost:8770/api/agent/fs",
    { host: "192.168.1.3:8770" },
  )), { ok: true });

  assert.deepEqual(authorizeBrowserMutation(request(
    "https://main-pc.example.ts.net:8443",
    "https://localhost:8770/api/agent/fs",
    { host: "main-pc.example.ts.net:8443", "x-forwarded-proto": "https" },
  )), { ok: true });

  assert.deepEqual(authorizeBrowserMutation(request(
    "https://main-pc.example.ts.net:8443",
    "http://localhost:8770/api/agent/fs",
    {
      host: "127.0.0.1:8770",
      "x-forwarded-host": "main-pc.example.ts.net:8443",
      "x-forwarded-proto": "https",
    },
  )), { ok: true });
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
  assert.deepEqual(authorizeBrowserMutation(request(
    "https://attacker.example",
    "https://localhost:8770/api/agent/fs",
    { host: "lal.local" },
  )), {
    ok: false, status: 403, code: "origin_mismatch",
  });
});

test("fails closed on malformed or ambiguous target headers", () => {
  assert.deepEqual(authorizeBrowserMutation(request(
    "https://lal.local",
    "http://localhost:8770/api/agent/fs",
    { host: "lal.local", "x-forwarded-proto": "https,http" },
  )), {
    ok: false, status: 403, code: "origin_invalid",
  });
  assert.deepEqual(authorizeBrowserMutation(request(
    "https://lal.local",
    "http://localhost:8770/api/agent/fs",
    { host: "lal.local/path", "x-forwarded-proto": "https" },
  )), {
    ok: false, status: 403, code: "origin_invalid",
  });
});
