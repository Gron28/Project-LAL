import assert from "node:assert/strict";
import test from "node:test";
import { extractRequestIdentity, isLoopbackAddress } from "./request-identity.ts";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://lal.local/api/example", { headers });
}

test("recognises Node loopback peer address forms", () => {
  for (const address of ["127.0.0.1", "127.44.1.9", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "[::1]:443"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["192.168.1.8", "100.64.0.7", "::ffff:192.168.1.8", "127.0.0.999"]) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});

test("accepts a Tailscale Serve identity only from a loopback socket", () => {
  const identity = extractRequestIdentity(request({
    "Tailscale-User-Login": "alice@example.com",
    "Tailscale-User-Name": "Alice Architect",
    "Tailscale-User-Profile-Pic": "https://id.example/alice.png",
  }), { peerAddress: "::ffff:127.0.0.1" });

  assert.deepEqual(identity, {
    state: "authenticated",
    source: "tailscale-serve",
    subject: "alice@example.com",
    displayName: "Alice Architect",
    profilePictureUrl: "https://id.example/alice.png",
  });
});

test("rejects spoofed Tailscale identity headers from direct or LAN requests", () => {
  const spoofed = request({ "Tailscale-User-Login": "attacker@example.com" });
  assert.deepEqual(extractRequestIdentity(spoofed, { peerAddress: "192.168.1.42" }), {
    state: "rejected", reason: "untrusted_tailscale_headers",
  });
  assert.deepEqual(extractRequestIdentity(spoofed, { peerAddress: "100.84.0.8" }), {
    state: "rejected", reason: "untrusted_tailscale_headers",
  });
  assert.deepEqual(extractRequestIdentity(spoofed, {}), {
    state: "rejected", reason: "untrusted_tailscale_headers",
  });
});

test("rejects incomplete Tailscale assertions even on loopback", () => {
  assert.deepEqual(extractRequestIdentity(request({ "Tailscale-User-Name": "Alice" }), { peerAddress: "127.0.0.1" }), {
    state: "rejected", reason: "invalid_tailscale_identity",
  });
});

test("does not mistake ordinary or forwarded requests for an authenticated identity", () => {
  assert.deepEqual(extractRequestIdentity(request(), { peerAddress: "127.0.0.1" }), {
    state: "anonymous", connection: "loopback",
  });
  assert.deepEqual(extractRequestIdentity(request({ "X-Forwarded-For": "127.0.0.1" }), { peerAddress: "192.168.1.42" }), {
    state: "anonymous", connection: "remote",
  });
});
