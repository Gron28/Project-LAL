// Sysfs/procfs readers shared by /api/sysinfo (polled by the old Monitor page)
// and /api/dashboard/stream (pushed to dashboard widgets). Extracted verbatim
// from the original api/sysinfo/route.ts — pure move, no behavior change.
import fs from "node:fs";
import { execSync } from "node:child_process";

export type SysInfo = {
  cpu: number; ramUsedGb: number; ramTotalGb: number; ramPct: number;
  gpu: number | null; vramUsedGb: number | null; vramTotalGb: number | null; vramPct: number | null;
  cpuTemp: number | null; gpuTemp: number | null; nvmeTemp: number | null; ollamaLoaded: string | null;
};

function cpuSnap() {
  const p = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = p[3] + (p[4] || 0);
  const total = p.reduce((a, b) => a + b, 0);
  return { idle, total };
}
function num(p: string): number | null { try { return parseInt(fs.readFileSync(p, "utf8")); } catch { return null; } }
function hwmonTemp(want: string): number | null {
  try {
    for (const h of fs.readdirSync("/sys/class/hwmon")) {
      const base = "/sys/class/hwmon/" + h;
      let name = ""; try { name = fs.readFileSync(base + "/name", "utf8").trim(); } catch {}
      if (name === want) { const t = num(base + "/temp1_input"); if (t) return Math.round(t / 1000); }
    }
  } catch {}
  return null;
}

export async function readSysInfo(): Promise<SysInfo> {
  const a = cpuSnap();
  await new Promise((r) => setTimeout(r, 200));
  const b = cpuSnap();
  const cpu = Math.max(0, Math.round(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total))));

  const mi = fs.readFileSync("/proc/meminfo", "utf8");
  const mt = +(mi.match(/MemTotal:\s+(\d+)/)?.[1] || 0);
  const ma = +(mi.match(/MemAvailable:\s+(\d+)/)?.[1] || 0);

  const card = "/sys/class/drm/card1/device";
  const vu = num(card + "/mem_info_vram_used");
  const vt = num(card + "/mem_info_vram_total");

  let loaded: string | null = null;
  try {
    const ps = execSync("ollama ps", { timeout: 3000 }).toString().trim().split("\n").slice(1);
    loaded = ps.length ? ps.map((l) => l.split(/\s{2,}/)[0]).join(", ") : null;
  } catch {}

  return {
    cpu,
    ramUsedGb: +((mt - ma) / 1048576).toFixed(1),
    ramTotalGb: +(mt / 1048576).toFixed(1),
    ramPct: mt ? Math.round((100 * (mt - ma)) / mt) : 0,
    gpu: num(card + "/gpu_busy_percent"),
    vramUsedGb: vu ? +(vu / 1e9).toFixed(1) : null,
    vramTotalGb: vt ? +(vt / 1e9).toFixed(1) : null,
    vramPct: vu && vt ? Math.round((100 * vu) / vt) : null,
    cpuTemp: hwmonTemp("k10temp") ?? hwmonTemp("coretemp"),
    gpuTemp: hwmonTemp("amdgpu"),
    nvmeTemp: hwmonTemp("nvme"),
    ollamaLoaded: loaded,
  };
}
