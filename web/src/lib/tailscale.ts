// Tiny wrapper around the `tailscale` CLI for exposing a project's dev server on the
// tailnet at the same port it's bound to locally (mirrors the existing :8443->8770
// serve mount this app itself runs behind). Confirmed the app's own OS user can run
// `tailscale serve` without sudo (same session that owns the tailnet).
import { spawn } from "node:child_process";

function run(args: string[], timeoutMs = 15000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("tailscale", args);
    } catch (e) {
      resolve({ ok: false, output: "error: " + (e as Error).message });
      return;
    }
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ ok: false, output: out + "\n[timed out]" }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, output: "error: " + e.message }); });
  });
}

let cachedHost: string | null | undefined; // undefined = not yet fetched

export async function getTailnetHost(): Promise<string | null> {
  if (cachedHost !== undefined) return cachedHost;
  const r = await run(["status", "--json"]);
  try {
    const j = JSON.parse(r.output);
    const dns = (j?.Self?.DNSName as string | undefined)?.replace(/\.$/, "") || null;
    cachedHost = dns;
  } catch { cachedHost = null; }
  return cachedHost;
}

export async function serveOn(port: number): Promise<{ ok: boolean; output: string }> {
  return run(["serve", "--bg", "--https=" + port, "http://127.0.0.1:" + port]);
}

export async function serveOff(port: number): Promise<{ ok: boolean; output: string }> {
  return run(["serve", "--https=" + port, "off"]);
}
