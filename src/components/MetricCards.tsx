import React from 'react';
import { SystemMetrics } from '../types';
import { Cpu, HardDrive, Network, Clock, Layers, Database } from 'lucide-react';

interface MetricCardsProps {
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
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export const MetricCards: React.FC<MetricCardsProps> = ({ metrics }) => {
  if (!metrics) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-pulse">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-28 rounded-lg bg-slate-900 border border-slate-800/80" />
        ))}
      </div>
    );
  }

  const cpuPercent = metrics.cpu.usage;
  const ramPercent = metrics.ram.usagePercent;
  const diskPercent = metrics.disk.usagePercent;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* CPU Card */}
      <div id="card-metric-cpu" className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
        <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span className="flex items-center gap-1.5 font-medium text-slate-300">
            <Cpu className="w-4 h-4 text-sky-400" />
            CPU Utilization
          </span>
          <span className="font-mono text-slate-400">{metrics.cpu.cores} Cores</span>
        </div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-2xl font-bold font-mono text-slate-100">{cpuPercent}%</span>
          <span className="text-xs text-slate-400 font-mono">
            Load: {metrics.load.load1} / {metrics.load.load5}
          </span>
        </div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              cpuPercent > 85 ? 'bg-rose-500' : cpuPercent > 60 ? 'bg-amber-400' : 'bg-sky-400'
            }`}
            style={{ width: `${Math.min(100, Math.max(1, cpuPercent))}%` }}
          />
        </div>
      </div>

      {/* RAM Card */}
      <div id="card-metric-ram" className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
        <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span className="flex items-center gap-1.5 font-medium text-slate-300">
            <Database className="w-4 h-4 text-emerald-400" />
            Memory (RAM)
          </span>
          <span className="font-mono text-slate-400">{formatBytes(metrics.ram.total)}</span>
        </div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-2xl font-bold font-mono text-slate-100">{ramPercent}%</span>
          <span className="text-xs text-slate-400 font-mono">
            Used {formatBytes(metrics.ram.used)}
          </span>
        </div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              ramPercent > 85 ? 'bg-rose-500' : ramPercent > 70 ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
            style={{ width: `${Math.min(100, Math.max(1, ramPercent))}%` }}
          />
        </div>
      </div>

      {/* Disk Storage Card */}
      <div id="card-metric-disk" className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
        <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span className="flex items-center gap-1.5 font-medium text-slate-300">
            <HardDrive className="w-4 h-4 text-amber-400" />
            Storage Disk
          </span>
          <span className="font-mono text-slate-400">{formatBytes(metrics.disk.total)}</span>
        </div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-2xl font-bold font-mono text-slate-100">{diskPercent}%</span>
          <span className="text-xs text-slate-400 font-mono">
            Free {formatBytes(metrics.disk.free)}
          </span>
        </div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              diskPercent > 85 ? 'bg-rose-500' : diskPercent > 70 ? 'bg-amber-400' : 'bg-amber-500'
            }`}
            style={{ width: `${Math.min(100, Math.max(1, diskPercent))}%` }}
          />
        </div>
      </div>

      {/* Network IO Card */}
      <div id="card-metric-network" className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
        <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
          <span className="flex items-center gap-1.5 font-medium text-slate-300">
            <Network className="w-4 h-4 text-violet-400" />
            Network Traffic
          </span>
          <span className="font-mono text-slate-400 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatUptime(metrics.uptime)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-1">
          <div>
            <div className="text-[11px] text-slate-500">Upload</div>
            <div className="text-sm font-semibold font-mono text-slate-200">
              {formatSpeed(metrics.network.up)}
            </div>
            <div className="text-[10px] text-slate-500">Σ {formatBytes(metrics.network.totalUp)}</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500">Download</div>
            <div className="text-sm font-semibold font-mono text-slate-200">
              {formatSpeed(metrics.network.down)}
            </div>
            <div className="text-[10px] text-slate-500">Σ {formatBytes(metrics.network.totalDown)}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
