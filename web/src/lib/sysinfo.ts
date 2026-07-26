// Sysfs/procfs readers shared by /api/sysinfo (polled by the old Monitor page)
// and /api/dashboard/stream (pushed to dashboard widgets). Extracted verbatim
// from the original api/sysinfo/route.ts — pure move, no behavior change.
import fs from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";

export type SysInfo = {
  cpu: number; ramUsedGb: number; ramTotalGb: number; ramPct: number;
  gpu: number | null; vramUsedGb: number | null; vramTotalGb: number | null; vramPct: number | null;
  cpuTemp: number | null; gpuTemp: number | null; nvmeTemp: number | null; ollamaLoaded: string | null;
};

function cpuSnap() {
  const times = os.cpus().map((cpu) => cpu.times);
  const idle = times.reduce((sum, time) => sum + time.idle, 0);
  const total = times.reduce(
    (sum, time) => sum + time.user + time.nice + time.sys + time.idle + time.irq,
    0,
  );
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
  // Every reader here is Linux sysfs/procfs; on any other OS (or a locked-down
  // container) they throw. Degrade to nulls instead of 500ing the whole endpoint —
  // the HUD that polls this should show "—", not go blank on an error.
  let cpu = 0;
  try {
    const a = cpuSnap();
    await new Promise((r) => setTimeout(r, 200));
    const b = cpuSnap();
    cpu = Math.max(0, Math.round(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total))));
  } catch {}

  const mt = os.totalmem();
  const ma = os.freemem();

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
    ramUsedGb: +((mt - ma) / 1073741824).toFixed(1),
    ramTotalGb: +(mt / 1073741824).toFixed(1),
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
