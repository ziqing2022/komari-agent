import React from 'react';
import { SystemMetrics } from '../types';
import { Layers, Network, Server, HardDrive } from 'lucide-react';

interface ResourceGaugesProps {
  metrics: SystemMetrics | null;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export const ResourceGauges: React.FC<ResourceGaugesProps> = ({ metrics }) => {
  if (!metrics) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Memory & System Load */}
      <div className="p-4 rounded-lg bg-slate-900/80 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-400" />
            Memory Allocation & Load
          </span>
          <span className="text-xs text-slate-500 font-mono">
            {metrics.process} active processes
          </span>
        </div>

        {/* RAM breakdown */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-medium">
            <span className="text-slate-300">RAM Breakdown</span>
            <span className="text-slate-400 font-mono">
              {formatBytes(metrics.ram.used)} / {formatBytes(metrics.ram.total)}
            </span>
          </div>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden flex">
            <div
              className="bg-emerald-500 h-full"
              style={{
                width: `${(metrics.ram.used / (metrics.ram.total || 1)) * 100}%`,
              }}
              title="Used RAM"
            />
            <div
              className="bg-sky-500/60 h-full"
              style={{
                width: `${(metrics.ram.cached / (metrics.ram.total || 1)) * 100}%`,
              }}
              title="Cached RAM"
            />
          </div>
          <div className="flex items-center gap-4 text-[11px] text-slate-400 pt-1">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Used: {formatBytes(metrics.ram.used)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sky-500/60" />
              Cached: {formatBytes(metrics.ram.cached)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-700" />
              Free: {formatBytes(metrics.ram.free)}
            </span>
          </div>
        </div>

        {/* Swap breakdown */}
        <div className="space-y-1.5 pt-1">
          <div className="flex justify-between text-xs font-medium">
            <span className="text-slate-300">Swap Memory</span>
            <span className="text-slate-400 font-mono">
              {formatBytes(metrics.swap.used)} / {formatBytes(metrics.swap.total)}
            </span>
          </div>
          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-violet-500 h-full"
              style={{
                width: `${Math.min(100, (metrics.swap.used / (metrics.swap.total || 1)) * 100)}%`,
              }}
            />
          </div>
        </div>

        {/* Load Averages */}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/60 text-center">
          <div className="p-2 rounded bg-slate-950/60 border border-slate-800/60">
            <div className="text-[10px] text-slate-500 uppercase tracking-wide">1 Min Load</div>
            <div className="text-base font-bold font-mono text-slate-200">{metrics.load.load1}</div>
          </div>
          <div className="p-2 rounded bg-slate-950/60 border border-slate-800/60">
            <div className="text-[10px] text-slate-500 uppercase tracking-wide">5 Min Load</div>
            <div className="text-base font-bold font-mono text-slate-200">{metrics.load.load5}</div>
          </div>
          <div className="p-2 rounded bg-slate-950/60 border border-slate-800/60">
            <div className="text-[10px] text-slate-500 uppercase tracking-wide">15 Min Load</div>
            <div className="text-base font-bold font-mono text-slate-200">{metrics.load.load15}</div>
          </div>
        </div>
      </div>

      {/* Mountpoints & Networking Details */}
      <div className="p-4 rounded-lg bg-slate-900/80 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-amber-400" />
            Storage Mountpoints & Network Sockets
          </span>
          <span className="text-xs text-slate-500 font-mono">
            TCP: {metrics.connections.tcp} / UDP: {metrics.connections.udp}
          </span>
        </div>

        {/* Mountpoints list */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-300">Disk Partitions</div>
          <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
            {metrics.disk.mountpoints.map((mp, idx) => (
              <div
                key={idx}
                className="p-2 rounded bg-slate-950/60 border border-slate-800/60 space-y-1 text-xs"
              >
                <div className="flex justify-between items-center">
                  <span className="font-mono text-slate-200 font-semibold">{mp.mount}</span>
                  <span className="text-slate-400 font-mono">
                    {formatBytes(mp.used)} / {formatBytes(mp.total)} ({mp.percent}%)
                  </span>
                </div>
                <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                  <div
                    className="bg-amber-400 h-full"
                    style={{ width: `${Math.min(100, mp.percent)}%` }}
                  />
                </div>
                <div className="text-[10px] text-slate-500 font-mono truncate">
                  Filesystem: {mp.fs}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Network Interfaces */}
        <div className="pt-2 border-t border-slate-800/60">
          <div className="flex items-center justify-between text-xs font-medium text-slate-300 mb-1.5">
            <span className="flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5 text-sky-400" />
              Active Network Interfaces
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {metrics.network.interfaces.map((iface, i) => (
              <span
                key={i}
                className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-sky-300 border border-slate-700/60"
              >
                {iface}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
