import { execFileSync } from "node:child_process";
import fs from "node:fs";

const REQUIRED = ["NoNewPrivileges", "LockPersonality", "RestrictSUIDSGID", "ProtectKernelTunables", "ProtectKernelModules", "ProtectControlGroups", "SystemCallArchitectures"] as const;
export type GuardianIsolationStatus = { service: "enforced" | "partial" | "unavailable"; serviceName: string; checks: Array<{ name: string; enforced: boolean | null; detail: string }>; bubblewrap: "available" | "missing"; userNamespaces: "available" | "disabled" | "unknown" };

export function parseSystemdIsolation(raw: string): Record<string, string> {
  return Object.fromEntries(raw.split("\n").flatMap((line) => { const index = line.indexOf("="); return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : []; }));
}
function executable(name: string): boolean { return (process.env.PATH || "").split(":").some((entry) => { try { return fs.statSync(`${entry}/${name}`).isFile(); } catch { return false; } }); }
function userNamespaces(): "available" | "disabled" | "unknown" {
  try { return fs.readFileSync("/proc/sys/kernel/unprivileged_userns_clone", "utf8").trim() === "0" ? "disabled" : "available"; } catch { return "unknown"; }
}
export function readGuardianIsolation(serviceName = process.env.PROJECT_LAL_SERVICE || "project-lal.service"): GuardianIsolationStatus {
  let values: Record<string, string> = {};
  try { values = parseSystemdIsolation(execFileSync("systemctl", ["--user", "show", serviceName, ...REQUIRED.flatMap((property) => ["-p", property])], { encoding: "utf8", timeout: 2_000 })); } catch {}
  const checks = REQUIRED.map((name) => {
    const value = values[name];
    const enforced = value === undefined ? null : name === "SystemCallArchitectures" ? value === "native" : value === "yes";
    return { name, enforced, detail: value ?? "service status unavailable" };
  });
  return { service: !Object.keys(values).length ? "unavailable" : checks.every((check) => check.enforced) ? "enforced" : "partial", serviceName, checks, bubblewrap: executable("bwrap") ? "available" : "missing", userNamespaces: userNamespaces() };
}
