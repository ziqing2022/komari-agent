import React from 'react';
import { AgentStatus, AgentConfig } from '../types';
import { Activity, Play, Pause, Radio, RefreshCw, Send, ShieldCheck, Server } from 'lucide-react';

interface HeaderProps {
  status: AgentStatus | null;
  config: AgentConfig | null;
  onToggleAgent: () => void;
  onManualPing: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  status,
  config,
  onToggleAgent,
  onManualPing,
  onRefresh,
  isRefreshing,
}) => {
  const isRunning = status?.isRunning ?? false;
  const isConnected = status?.connectionState === 'connected';
  const isMock = status?.connectionState === 'mock-receiver-only';

  return (
    <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur px-4 sm:px-6 py-4">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Title and Identity */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-slate-100 tracking-tight">Komari Agent</h1>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                v1.2.10
              </span>
            </div>
            <p className="text-xs text-slate-400">
              {config?.endpoint ? (
                <span className="flex items-center gap-1.5 truncate max-w-sm">
                  <Radio className="w-3 h-3 text-sky-400 shrink-0" />
                  <span className="text-slate-500">Panel:</span> {config.endpoint}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-slate-400">
                  <Server className="w-3 h-3 text-emerald-400" />
                  Local Receiver active (Standalone Simulator)
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Status Indicators & Controls */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Connection Status */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-800/60 border border-slate-700/50 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                isRunning
                  ? isConnected
                    ? 'bg-emerald-400 animate-pulse'
                    : isMock
                    ? 'bg-sky-400 animate-pulse'
                    : 'bg-amber-400'
                  : 'bg-slate-500'
              }`}
            />
            <span className="text-slate-300 font-medium">
              {isRunning
                ? isConnected
                  ? 'Connected'
                  : isMock
                  ? 'Mock Receiver'
                  : 'Connecting'
                : 'Stopped'}
            </span>
            {status?.latencyMs ? (
              <span className="text-slate-500 font-mono">({status.latencyMs}ms)</span>
            ) : null}
          </div>

          {/* Manual Ping button */}
          <button
            id="btn-manual-ping"
            onClick={onManualPing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
            title="Send agent.ping JSON-RPC test"
          >
            <Send className="w-3.5 h-3.5 text-sky-400" />
            <span>Ping RPC</span>
          </button>

          {/* Toggle Agent running */}
          <button
            id="btn-toggle-agent"
            onClick={onToggleAgent}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition ${
              isRunning
                ? 'bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20'
            }`}
          >
            {isRunning ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>Pause Agent</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Start Agent</span>
              </>
            )}
          </button>

          {/* Refresh metrics */}
          <button
            id="btn-refresh-metrics"
            onClick={onRefresh}
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-md hover:bg-slate-800 transition"
            title="Refresh now"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-sky-400' : ''}`} />
          </button>
        </div>
      </div>
    </header>
  );
};
