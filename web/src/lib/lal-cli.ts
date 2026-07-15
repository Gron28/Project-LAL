import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const TOKEN_FILE = path.join(DATA_DIR, "cli-token");
const DEVICES_FILE = path.join(DATA_DIR, "cli-devices.json");

type DeviceRecord = {
  id: string;
  name: string;
  platform: string;
  clientVersion: string;
  firstSeen: string;
  lastSeen: string;
  lastActivity: string;
  lastIp: string;
  userAgent: string;
  tailnetLogin: string;
  requests: number;
};

type DeviceRegistry = {
  version: 1;
  devices: Record<string, DeviceRecord>;
  denied: { total: number; lastSeen: string; lastIp: string; userAgent: string };
};

type QueueState = { tail: Promise<void> };
const globalState = globalThis as unknown as { __lalCliQueue?: QueueState };
if (!globalState.__lalCliQueue) globalState.__lalCliQueue = { tail: Promise.resolve() };

export function getCliToken(): string {
  const fromEnv = process.env.LAL_CLI_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

export function cliAuthorized(request: Request): boolean {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = getCliToken();
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function unauthorizedResponse(): Response {
  return Response.json(
    { error: { message: "Invalid LAL pairing token", type: "authentication_error" } },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
}

function clean(value: string | null, limit = 160): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit);
}

function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  return clean(forwarded ?? request.headers.get("x-real-ip") ?? "unknown", 80);
}

function emptyRegistry(): DeviceRegistry {
  return { version: 1, devices: {}, denied: { total: 0, lastSeen: "", lastIp: "", userAgent: "" } };
}

function readDeviceRegistry(): DeviceRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8")) as Partial<DeviceRegistry>;
    if (parsed.version === 1 && parsed.devices && parsed.denied) return parsed as DeviceRegistry;
  } catch {}
  return emptyRegistry();
}

function writeDeviceRegistry(registry: DeviceRegistry): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${DEVICES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, DEVICES_FILE);
}

export function cliDeviceCustomHeaders(request: Request): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of ["x-lal-device-id", "x-lal-device-name", "x-lal-platform", "x-lal-client-version"]) {
    const value = clean(request.headers.get(name));
    if (value) values[name] = value;
  }
  return values;
}

/** A client-owned run is attributed to a stable, explicitly supplied device id.
 * Unlike the display-oriented registry fallback, ingestion must never silently
 * merge two callers by IP address: the owner is an authorization boundary. */
export function cliAuthenticatedDeviceId(request: Request): string | null {
  const explicitId = clean(request.headers.get("x-lal-device-id"), 128);
  return /^[A-Za-z0-9._:-]{8,128}$/.test(explicitId) ? explicitId : null;
}

/** Persist connection metadata only; prompts, paths, and request bodies are never recorded. */
export function recordCliAccess(request: Request, activity: string, authorized: boolean): void {
  const registry = readDeviceRegistry();
  const now = new Date().toISOString();
  const ip = requestIp(request);
  const userAgent = clean(request.headers.get("user-agent"));
  if (!authorized) {
    registry.denied = {
      total: registry.denied.total + 1,
      lastSeen: now,
      lastIp: ip,
      userAgent,
    };
    writeDeviceRegistry(registry);
    return;
  }

  const explicitId = clean(request.headers.get("x-lal-device-id"), 128);
  const validId = /^[A-Za-z0-9._:-]{8,128}$/.test(explicitId) ? explicitId : "";
  const matchingIds = Object.values(registry.devices)
    .filter((device) => device.lastIp === ip)
    .map((device) => device.id);
  const id = validId || (matchingIds.length === 1
    ? matchingIds[0]
    : `legacy-${crypto.createHash("sha256").update(`${ip}\n${userAgent}`).digest("hex").slice(0, 16)}`);
  const previous = registry.devices[id];
  registry.devices[id] = {
    id,
    name: clean(request.headers.get("x-lal-device-name"), 100) || previous?.name || "unidentified client",
    platform: clean(request.headers.get("x-lal-platform"), 100) || previous?.platform || "unknown",
    clientVersion: clean(request.headers.get("x-lal-client-version"), 40) || previous?.clientVersion || "unknown",
    firstSeen: previous?.firstSeen || now,
    lastSeen: now,
    lastActivity: clean(activity, 80),
    lastIp: ip,
    userAgent,
    tailnetLogin: clean(request.headers.get("tailscale-user-login"), 160) || previous?.tailnetLogin || "",
    requests: (previous?.requests || 0) + 1,
  };
  writeDeviceRegistry(registry);
}

export async function acquireCliGpuLease(): Promise<() => void> {
  const state = globalState.__lalCliQueue!;
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export function streamWithRelease(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { release(); }
    },
  });
}
