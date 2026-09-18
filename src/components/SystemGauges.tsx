import React from 'react';
import { Cpu, HardDrive, MemoryStick, Activity, Wifi, Server, ShieldCheck, Gauge } from 'lucide-react';
import { SystemMetrics } from '../types';

interface SystemGaugesProps {
  metrics: SystemMetrics | null;
}

function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export const SystemGauges: React.FC<SystemGaugesProps> = ({ metrics }) => {
  if (!metrics) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-8 text-center text-neutral-400">
        <Activity className="mx-auto mb-2 h-6 w-6 animate-spin text-rose-500" />
        <p>Loading host system metrics...</p>
      </div>
    );
  }

  const cpuPercent = Math.min(100, Math.max(0, metrics.cpu.usage));
  const ramPercent = metrics.ram.usagePercent;
  const diskPercent = metrics.disk.usagePercent;

  return (
    <div className="space-y-6">
      {/* 4 Key Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* CPU */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-5 backdrop-blur">
          <div className="flex items-center justify-between pb-3">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-rose-500/10 p-2 text-rose-400">
                <Cpu className="h-5 w-5" />
              </div>
              <span className="text-sm font-medium text-neutral-300">CPU Usage</span>
            </div>
            <span className="font-mono text-xl font-semibold text-neutral-100">{cpuPercent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className={`h-full transition-all duration-500 ${
                cpuPercent > 80 ? 'bg-amber-500' : cpuPercent > 90 ? 'bg-red-500' : 'bg-rose-500'
              }`}
              style={{ width: `${cpuPercent}%` }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-neutral-400">
            <span className="truncate" title={metrics.cpu.name}>
              {metrics.cpu.cores} Cores ({metrics.cpu.arch})
            </span>
            <span className="font-mono">{metrics.load.load1.toFixed(2)} load1</span>
          </div>
        </div>

        {/* RAM */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-5 backdrop-blur">
          <div className="flex items-center justify-between pb-3">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-sky-500/10 p-2 text-sky-400">
                <MemoryStick className="h-5 w-5" />
              </div>
              <span className="text-sm font-medium text-neutral-300">Memory</span>
            </div>
            <span className="font-mono text-xl font-semibold text-neutral-100">{ramPercent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className={`h-full transition-all duration-500 ${
                ramPercent > 85 ? 'bg-amber-500' : 'bg-sky-500'
              }`}
              style={{ width: `${ramPercent}%` }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-neutral-400">
            <span>{formatBytes(metrics.ram.used)} used</span>
            <span className="font-mono">Total {formatBytes(metrics.ram.total)}</span>
          </div>
        </div>

        {/* DISK */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-5 backdrop-blur">
          <div className="flex items-center justify-between pb-3">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-400">
                <HardDrive className="h-5 w-5" />
              </div>
              <span className="text-sm font-medium text-neutral-300">Storage</span>
            </div>
            <span className="font-mono text-xl font-semibold text-neutral-100">{diskPercent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${diskPercent}%` }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-neutral-400">
            <span>{formatBytes(metrics.disk.used)} used</span>
            <span className="font-mono">Total {formatBytes(metrics.disk.total)}</span>
          </div>
        </div>

        {/* NETWORK & TRAFFIC */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-5 backdrop-blur">
          <div className="flex items-center justify-between pb-3">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-indigo-500/10 p-2 text-indigo-400">
                <Wifi className="h-5 w-5" />
              </div>
              <span className="text-sm font-medium text-neutral-300">Bandwidth</span>
            </div>
            <div className="text-right">
              <span className="font-mono text-xs text-neutral-400">TCP: {metrics.connections.tcp}</span>
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-400">↑ Up</span>
              <span className="font-mono text-emerald-400">{formatSpeed(metrics.network.up)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-400">↓ Down</span>
              <span className="font-mono text-sky-400">{formatSpeed(metrics.network.down)}</span>
            </div>
          </div>
          <div className="mt-2.5 border-t border-neutral-800/80 pt-2 flex items-center justify-between text-[11px] text-neutral-500">
            <span>Tot: ↑{formatBytes(metrics.network.totalUp)}</span>
            <span>↓{formatBytes(metrics.network.totalDown)}</span>
          </div>
        </div>
      </div>

      {/* System Hardware & Node Details */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-neutral-400" />
            <h3 className="text-sm font-semibold tracking-wide text-neutral-200 uppercase">System & Host Telemetry</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300">
              Uptime: {formatUptime(metrics.uptime)}
            </span>
            <span className="inline-flex items-center rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300">
              Processes: {metrics.processCount}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
          <div className="rounded-lg bg-neutral-800/40 p-3">
            <span className="text-neutral-500">Operating System</span>
            <p className="mt-1 font-mono font-medium text-neutral-200">{metrics.osInfo.distro}</p>
            <p className="text-[11px] text-neutral-400">{metrics.osInfo.kernel}</p>
          </div>
          <div className="rounded-lg bg-neutral-800/40 p-3">
            <span className="text-neutral-500">CPU Architecture</span>
            <p className="mt-1 font-mono font-medium text-neutral-200">{metrics.cpu.arch} ({metrics.cpu.cores} threads)</p>
            <p className="truncate text-[11px] text-neutral-400">{metrics.cpu.name}</p>
          </div>
          <div className="rounded-lg bg-neutral-800/40 p-3">
            <span className="text-neutral-500">Network IP Address</span>
            <p className="mt-1 font-mono font-medium text-neutral-200">{metrics.osInfo.ipv4}</p>
            <p className="truncate text-[11px] text-neutral-400">{metrics.osInfo.hostname}</p>
          </div>
          <div className="rounded-lg bg-neutral-800/40 p-3">
            <span className="text-neutral-500">Load Average</span>
            <p className="mt-1 font-mono font-medium text-neutral-200">
              {metrics.load.load1} / {metrics.load.load5} / {metrics.load.load15}
            </p>
            <p className="text-[11px] text-neutral-400">1m, 5m, 15m</p>
          </div>
        </div>
      </div>
    </div>
  );
};
