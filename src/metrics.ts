// Metrik laptop + status otak (tanpa lib; pakai os bawaan).
// CPU dihitung dari selisih time slice; hasil di-cache 2 detik.
import { cpus, totalmem, freemem, uptime, loadavg, networkInterfaces, platform } from "node:os";
import { spawn } from "node:child_process";

export interface Metrics {
  cpuPercent: number;
  load1: number;
  memTotal: number;
  memFree: number;
  memUsedPercent: number;
  uptimeSec: number;
  procMemMb: number;
  procUptimeSec: number;
  node: string;
  platform: string;
  net: { name: string; address: string }[];
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Persen CPU selama jendela sample (default 500 ms). */
export async function sampleCpu(ms = 500): Promise<number> {
  const a = cpuTimes();
  await sleep(ms);
  const b = cpuTimes();
  const dIdle = b.idle - a.idle;
  const dTotal = b.total - a.total;
  if (dTotal <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)));
}

let cache: { at: number; m: Metrics } | null = null;

export async function getMetrics(): Promise<Metrics> {
  if (cache && Date.now() - cache.at < 2000) return cache.m;
  const total = totalmem();
  const free = freemem();
  const nets: { name: string; address: string }[] = [];
  try {
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.internal || a.family !== "IPv4") continue;
        nets.push({ name, address: a.address });
      }
    }
  } catch {
    // environment terbatas (container/sandbox) → network kosong, metrik tetap jalan
  }
  const m: Metrics = {
    cpuPercent: await sampleCpu(),
    load1: Math.round((loadavg()[0] || 0) * 100) / 100,
    memTotal: total,
    memFree: free,
    memUsedPercent: Math.round(((total - free) / total) * 100),
    uptimeSec: Math.round(uptime()),
    procMemMb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
    procUptimeSec: Math.round(process.uptime()),
    node: process.version,
    platform: platform(),
    net: nets.slice(0, 6),
  };
  cache = { at: Date.now(), m };
  return m;
}

export interface BrainStatus {
  bin: string;
  ok: boolean;
  version: string;
  checkedAt: string;
}

let brainCache: { at: number; b: BrainStatus } | null = null;

/** Cek CLI otak tersedia + versinya (cache 60 dtk). */
export function checkBrain(bin: string): Promise<BrainStatus> {
  if (brainCache && Date.now() - brainCache.at < 60_000 && brainCache.b.bin === bin) {
    return Promise.resolve(brainCache.b);
  }
  return new Promise((resolve) => {
    const done = (b: BrainStatus) => { brainCache = { at: Date.now(), b }; resolve(b); };
    const fail = () => done({ bin, ok: false, version: "", checkedAt: new Date().toISOString() });
    try {
      const child = spawn(bin, ["--version"], { timeout: 10_000, shell: false });
      let out = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.on("error", fail);
      child.on("close", (code) => {
        if (code !== 0) { fail(); return; }
        done({ bin, ok: true, version: out.trim().slice(0, 80) || "ok", checkedAt: new Date().toISOString() });
      });
    } catch { fail(); }
  });
}
