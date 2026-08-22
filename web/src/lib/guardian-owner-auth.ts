import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCliToken } from "./lal-cli.ts";

const SESSIONS_FILE = path.join(process.cwd(), ".data", "guardian", "owner-sessions.json");
const COOKIE = "lal_guardian_owner";
const SESSION_TTL_MS = 8 * 60 * 60_000;

type Session = { id: string; expiresAt: number; csrfHash: string };
type SessionFile = { version: 1; sessions: Session[] };
export type GuardianOwnerSession = { id: string; csrf: string; expiresAt: number };

const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const signature = (id: string, expiresAt: number) => crypto.createHmac("sha256", getCliToken()).update(`${id}.${expiresAt}`).digest("base64url");

function read(): SessionFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) as Partial<SessionFile>;
    if (parsed.version === 1 && Array.isArray(parsed.sessions)) return { version: 1, sessions: parsed.sessions.filter((session): session is Session => typeof session?.id === "string" && typeof session.expiresAt === "number" && typeof session.csrfHash === "string") };
  } catch {}
  return { version: 1, sessions: [] };
}
function write(file: SessionFile) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true, mode: 0o700 });
  const temp = `${SESSIONS_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
  fs.renameSync(temp, SESSIONS_FILE); fs.chmodSync(SESSIONS_FILE, 0o600);
}
function cookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get("cookie") || "").split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]] : [];
  }));
}

export function guardianOwnerCookie(session: GuardianOwnerSession): string {
  const value = `${session.id}.${session.expiresAt}.${signature(session.id, session.expiresAt)}`;
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export const clearGuardianOwnerCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

/** Pair a browser only after it proves possession of LAL's existing owner token. */
export function createGuardianOwnerSession(suppliedToken: string, now = Date.now()): GuardianOwnerSession | null {
  if (!equal(suppliedToken, getCliToken())) return null;
  const session: GuardianOwnerSession = { id: crypto.randomUUID(), csrf: crypto.randomBytes(32).toString("base64url"), expiresAt: now + SESSION_TTL_MS };
  const file = read();
  file.sessions = [...file.sessions.filter((entry) => entry.expiresAt > now), { id: session.id, expiresAt: session.expiresAt, csrfHash: digest(session.csrf) }].slice(-32);
  write(file); return session;
}

export function readGuardianOwnerSession(request: Request, now = Date.now()): { id: string; expiresAt: number } | null {
  const value = cookies(request)[COOKIE];
  const match = value?.match(/^([0-9a-f-]{36})\.(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const [, id, expiryText, signed] = match;
  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || !equal(signed, signature(id, expiresAt))) return null;
  const file = read();
  const session = file.sessions.find((entry) => entry.id === id && entry.expiresAt === expiresAt);
  return session ? { id, expiresAt } : null;
}

/** A readable CSRF value is rotated whenever an already-paired browser asks for
 * Guardian state. It proves same-browser intent; the HttpOnly owner cookie is
 * still the authentication factor. */
export function refreshGuardianOwnerCsrf(request: Request, now = Date.now()): { csrf: string; expiresAt: number } | null {
  const session = readGuardianOwnerSession(request, now);
  if (!session) return null;
  const csrf = crypto.randomBytes(32).toString("base64url");
  const file = read();
  const index = file.sessions.findIndex((entry) => entry.id === session.id && entry.expiresAt === session.expiresAt);
  if (index < 0) return null;
  file.sessions[index] = { ...file.sessions[index], csrfHash: digest(csrf) };
  write(file);
  return { csrf, expiresAt: session.expiresAt };
}

/** State-changing Guardian routes need both the owner cookie and a browser-held
 * CSRF value. This is deliberately separate from consent/engagement evidence. */
export function authorizeGuardianOwnerMutation(request: Request, now = Date.now()): { ok: true; session: { id: string; expiresAt: number } } | { ok: false; error: string } {
  const session = readGuardianOwnerSession(request, now);
  if (!session) return { ok: false, error: "pair this browser as the LAL owner first" };
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return { ok: false, error: "cross-origin Guardian action refused" };
  const csrf = request.headers.get("x-lal-guardian-csrf") || "";
  const record = read().sessions.find((entry) => entry.id === session.id && entry.expiresAt === session.expiresAt);
  if (!record || !equal(digest(csrf), record.csrfHash)) return { ok: false, error: "Guardian CSRF proof is invalid" };
  return { ok: true, session };
}
