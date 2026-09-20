import React from 'react';
import { BasicInfo } from '../types';
import { Server, Cpu, Globe, Disc, Shield, HardDrive } from 'lucide-react';

interface HardwareSpecsProps {
  info: BasicInfo | null;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export const HardwareSpecs: React.FC<HardwareSpecsProps> = ({ info }) => {
  if (!info) return null;

  return (
    <div className="p-5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-4">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <Server className="w-4 h-4 text-sky-400" />
          Host Architecture & Specifications (agent.basicInfo)
        </span>
        <span className="text-xs font-mono text-emerald-400">v{info.version}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/60">
          <div className="flex items-center gap-1.5 text-slate-400 mb-1">
            <Cpu className="w-3.5 h-3.5 text-sky-400" />
            Processor
          </div>
          <div className="font-mono text-slate-200 font-semibold truncate" title={info.cpu_name}>
            {info.cpu_name}
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">
            {info.cpu_cores} Logical / {info.cpu_physical_cores} Physical ({info.arch})
          </div>
        </div>

        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/60">
          <div className="flex items-center gap-1.5 text-slate-400 mb-1">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
            Operating System
          </div>
          <div className="font-mono text-slate-200 font-semibold truncate" title={info.os}>
            {info.os}
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">
            Kernel: {info.kernel_version}
          </div>
        </div>

        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/60">
          <div className="flex items-center gap-1.5 text-slate-400 mb-1">
            <Globe className="w-3.5 h-3.5 text-violet-400" />
            Network Identity
          </div>
          <div className="font-mono text-slate-200 font-semibold truncate">
            IPv4: {info.ipv4}
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5 truncate">
            IPv6: {info.ipv6}
          </div>
        </div>

        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/60">
          <div className="flex items-center gap-1.5 text-slate-400 mb-1">
            <HardDrive className="w-3.5 h-3.5 text-amber-400" />
            System Memory & Swap
          </div>
          <div className="font-mono text-slate-200 font-semibold">
            {formatBytes(info.mem_total)} RAM
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">
            Swap: {formatBytes(info.swap_total)}
          </div>
        </div>

        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/60">
          <div className="flex items-center gap-1.5 text-slate-400 mb-1">
            <Disc className="w-3.5 h-3.5 text-rose-400" />
            Virtualization
          </div>
          <div className="font-mono text-slate-200 font-semibold truncate">
            {info.virtualization}
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">
            GPU: {info.gpu_name}
          </div>
        </div>

        <div className="p-3 rounded bg-slate-950/60 border border-slate-800/60">
          <div className="flex items-center gap-1.5 text-slate-400 mb-1">
            <Server className="w-3.5 h-3.5 text-teal-400" />
            Total Storage Capacity
          </div>
          <div className="font-mono text-slate-200 font-semibold">
            {formatBytes(info.disk_total)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">
            Protocol: Komari v2 JSON-RPC
          </div>
        </div>
      </div>
    </div>
  );
};
