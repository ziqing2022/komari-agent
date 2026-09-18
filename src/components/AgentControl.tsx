import React, { useState } from 'react';
import { Play, Pause, RefreshCw, Send, Radio, Settings2, Sparkles, Check, AlertCircle, Eye, EyeOff, ShieldCheck, BellOff } from 'lucide-react';
import { AgentConfig, AgentStatus } from '../types';

interface AgentControlProps {
  config: AgentConfig;
  status: AgentStatus | null;
  onUpdateConfig: (newConfig: Partial<AgentConfig>) => Promise<void>;
  onToggleRun: () => Promise<void>;
  onTriggerReport: () => Promise<void>;
  onTriggerBasicInfo: () => Promise<void>;
  onSendPingTask: () => Promise<void>;
  onOpenAutoDiscovery: () => void;
  onOpenPrivacy: () => void;
}

export const AgentControl: React.FC<AgentControlProps> = ({
  config,
  status,
  onUpdateConfig,
  onToggleRun,
  onTriggerReport,
  onTriggerBasicInfo,
  onSendPingTask,
  onOpenAutoDiscovery,
  onOpenPrivacy,
}) => {
  const [endpoint, setEndpoint] = useState(config.endpoint);
  const [token, setToken] = useState(config.token);
  const [showToken, setShowToken] = useState(false);
  const [interval, setIntervalVal] = useState(config.interval);
  const [isSaving, setIsSaving] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onUpdateConfig({
        endpoint,
        token,
        interval: Number(interval),
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSetLocalMock = async () => {
    const localUrl = window.location.origin;
    setEndpoint(localUrl);
    await onUpdateConfig({ endpoint: localUrl });
  };

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 backdrop-blur">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800/80 pb-5">
        <div>
          <h2 className="text-base font-semibold text-neutral-100 flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-rose-500" />
            Agent Control & Configuration
          </h2>
          <p className="mt-1 text-xs text-neutral-400">
            Configure Komari v2 JSON-RPC ingest destination and polling cadence
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onToggleRun}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold tracking-wide transition ${
              status?.running
                ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/30'
                : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30'
            }`}
          >
            {status?.running ? (
              <>
                <Pause className="h-4 w-4" /> Pause Agent
              </>
            ) : (
              <>
                <Play className="h-4 w-4" /> Resume Agent
              </>
            )}
          </button>

          <button
            disabled={isTriggering}
            onClick={async () => {
              setIsTriggering(true);
              try {
                await onTriggerReport();
              } finally {
                setIsTriggering(false);
              }
            }}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
            title="Immediately send agent.report to target endpoint"
          >
            <Send className="h-3.5 w-3.5 text-neutral-400" />
            Send Report Now
          </button>

          <button
            onClick={onTriggerBasicInfo}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-700"
            title="Upload hardware static info"
          >
            <RefreshCw className="h-3.5 w-3.5 text-neutral-400" />
            Upload Basic Info
          </button>

          <button
            onClick={onSendPingTask}
            className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
            title="Queue a ping task on mock server to test agent.ping and agent.pingResult"
          >
            <Radio className="h-3.5 w-3.5 text-rose-400" />
            Simulate Ping Task
          </button>
        </div>
      </div>

      {/* Form Settings */}
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {/* Endpoint Input */}
        <div className="md:col-span-2">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-neutral-300">
              Komari Dashboard Endpoint
            </label>
            <button
              type="button"
              onClick={handleSetLocalMock}
              className="text-[11px] text-rose-400 hover:text-rose-300 underline"
            >
              Use Built-in Local Receiver
            </button>
          </div>
          <div className="flex rounded-lg border border-neutral-800 bg-neutral-950 focus-within:border-rose-500/80">
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="e.g. http://localhost:3000 or https://panel.example.com"
              className="w-full bg-transparent px-3 py-2 text-xs font-mono text-neutral-200 placeholder-neutral-600 focus:outline-none"
            />
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">
            Appends <span className="font-mono text-neutral-400">/api/clients/v2/rpc?token=...</span> automatically
          </p>
        </div>

        {/* Interval */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-neutral-300">
            Report Interval (seconds)
          </label>
          <input
            type="number"
            min={1}
            max={3600}
            value={interval}
            onChange={(e) => setIntervalVal(Number(e.target.value))}
            className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs font-mono text-neutral-200 focus:border-rose-500/80 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-neutral-500">Default: 3s (recommend 1s - 10s)</p>
        </div>

        {/* Token Input with Masking Toggle */}
        <div className="md:col-span-2">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-neutral-300">
              Agent Authentication Token
            </label>
            <span className="text-[11px] text-emerald-400 font-mono flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" /> 自动保存在 config.json (top 不泄漏)
            </span>
          </div>
          <div className="flex rounded-lg border border-neutral-800 bg-neutral-950 focus-within:border-rose-500/80">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Agent secret token from Komari dashboard"
              className="w-full bg-transparent px-3 py-2 text-xs font-mono text-neutral-200 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="px-3 text-neutral-400 hover:text-neutral-200 transition"
              title={showToken ? '隐藏 Token' : '显示完整 Token'}
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-end gap-2">
          <button
            type="submit"
            disabled={isSaving}
            className="flex-1 rounded-lg bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
          >
            {isSaving ? 'Applying...' : saveSuccess ? '✓ Saved to config.json!' : 'Apply Settings'}
          </button>
          <button
            type="button"
            onClick={onOpenPrivacy}
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 transition flex items-center gap-1.5"
            title="查看 top 防泄露说明与 MOTD 屏蔽配置"
          >
            <ShieldCheck className="h-4 w-4" />
            <span className="hidden sm:inline">隐私与 MOTD</span>
          </button>
          <button
            type="button"
            onClick={onOpenAutoDiscovery}
            className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-xs font-medium text-neutral-300 hover:bg-neutral-700"
            title="Auto-discover & register with Komari Dashboard"
          >
            <Sparkles className="h-4 w-4" />
          </button>
        </div>
      </form>

      {/* Flag Switches */}
      <div className="mt-6 border-t border-neutral-800/80 pt-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 text-xs">
          <label className="flex items-center gap-2 text-neutral-300 cursor-pointer">
            <input
              type="checkbox"
              checked={config.disableMotd ?? true}
              onChange={(e) => onUpdateConfig({ disableMotd: e.target.checked })}
              className="rounded border-neutral-700 bg-neutral-900 text-rose-500 focus:ring-0"
            />
            <span className="flex items-center gap-1 text-amber-300">
              <BellOff className="h-3.5 w-3.5" /> 去除登录 MOTD
            </span>
          </label>

          <label className="flex items-center gap-2 text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              checked={!config.disableCompression}
              onChange={(e) => onUpdateConfig({ disableCompression: !e.target.checked })}
              className="rounded border-neutral-700 bg-neutral-900 text-rose-500 focus:ring-0"
            />
            <span>v2 Compression</span>
          </label>

          <label className="flex items-center gap-2 text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              checked={config.enableGpu}
              onChange={(e) => onUpdateConfig({ enableGpu: e.target.checked })}
              className="rounded border-neutral-700 bg-neutral-900 text-rose-500 focus:ring-0"
            />
            <span>Detailed GPU Stats</span>
          </label>

          <label className="flex items-center gap-2 text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              checked={config.ignoreUnsafeCert}
              onChange={(e) => onUpdateConfig({ ignoreUnsafeCert: e.target.checked })}
              className="rounded border-neutral-700 bg-neutral-900 text-rose-500 focus:ring-0"
            />
            <span>Ignore SSL Certs</span>
          </label>

          <label className="flex items-center gap-2 text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              checked={!config.disableWebSsh}
              onChange={(e) => onUpdateConfig({ disableWebSsh: !e.target.checked })}
              className="rounded border-neutral-700 bg-neutral-900 text-rose-500 focus:ring-0"
            />
            <span>Remote Command/SSH</span>
          </label>
        </div>
      </div>
    </div>
  );
};
