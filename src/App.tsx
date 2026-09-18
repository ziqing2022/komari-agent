import React, { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Activity, Terminal, Layers, RefreshCw, Radio, CheckCircle, XCircle } from 'lucide-react';
import { AgentConfig, AgentStatus, SystemMetrics, AgentLog, ReceivedReport } from './types';
import { SystemGauges } from './components/SystemGauges';
import { AgentControl } from './components/AgentControl';
import { LogsAndPayloads } from './components/LogsAndPayloads';
import { AutoDiscoveryModal } from './components/AutoDiscoveryModal';
import { PrivacyModal } from './components/PrivacyModal';

export const App: React.FC = () => {
  const [config, setConfig] = useState<AgentConfig>({
    endpoint: 'http://localhost:3000',
    token: 'komari-demo-token-1234',
    interval: 3,
    disableAutoUpdate: false,
    disableWebSsh: false,
    ignoreUnsafeCert: false,
    enableGpu: false,
    disableCompression: false,
    preferIpVersion: 'auto',
    disableMotd: true,
    useConfigFile: true,
  });

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [receivedReports, setReceivedReports] = useState<ReceivedReport[]>([]);
  const [showAutoDiscovery, setShowAutoDiscovery] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Fetch agent status & configuration
  const fetchAgentData = useCallback(async () => {
    try {
      const [statusRes, configRes, metricsRes, logsRes, receivedRes] = await Promise.all([
        fetch('/api/agent/status'),
        fetch('/api/agent/config'),
        fetch('/api/agent/metrics'),
        fetch('/api/agent/logs'),
        fetch('/api/mock/received-reports'),
      ]);

      if (statusRes.ok) setStatus(await statusRes.json());
      if (configRes.ok) setConfig(await configRes.json());
      if (metricsRes.ok) setMetrics(await metricsRes.json());
      if (logsRes.ok) {
        const data = await logsRes.json();
        setLogs(data.logs || []);
      }
      if (receivedRes.ok) {
        const data = await receivedRes.json();
        setReceivedReports(data.reports || []);
      }
    } catch (err) {
      console.error('Error polling agent state:', err);
    }
  }, []);

  useEffect(() => {
    fetchAgentData();
    const interval = setInterval(fetchAgentData, 2000);
    return () => clearInterval(interval);
  }, [fetchAgentData]);

  // Handlers
  const handleUpdateConfig = async (newConfig: Partial<AgentConfig>) => {
    try {
      const res = await fetch('/api/agent/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data.config);
        fetchAgentData();
      }
    } catch (err) {
      console.error('Failed to update config:', err);
    }
  };

  const handleToggleRun = async () => {
    const action = status?.running ? 'stop' : 'start';
    try {
      const res = await fetch(`/api/agent/${action}`, { method: 'POST' });
      if (res.ok) {
        fetchAgentData();
      }
    } catch (err) {
      console.error(`Failed to ${action} agent:`, err);
    }
  };

  const handleTriggerReport = async () => {
    try {
      await fetch('/api/agent/trigger-report', { method: 'POST' });
      fetchAgentData();
    } catch (err) {
      console.error('Failed to trigger report:', err);
    }
  };

  const handleTriggerBasicInfo = async () => {
    try {
      await fetch('/api/agent/trigger-basic-info', { method: 'POST' });
      fetchAgentData();
    } catch (err) {
      console.error('Failed to trigger basic info:', err);
    }
  };

  const handleSendPingTask = async () => {
    try {
      await fetch('/api/mock/send-ping-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pingType: 'icmp' }),
      });
      fetchAgentData();
    } catch (err) {
      console.error('Failed to queue ping task:', err);
    }
  };

  const handleClearLogs = async () => {
    try {
      await fetch('/api/agent/clear-logs', { method: 'POST' });
      setLogs([]);
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  const handleClearReceivedReports = async () => {
    try {
      await fetch('/api/mock/clear-reports', { method: 'POST' });
      setReceivedReports([]);
    } catch (err) {
      console.error('Failed to clear received reports:', err);
    }
  };

  const handleRegisterAutoDiscovery = async (server: string, adkey: string, name: string) => {
    const res = await fetch('/api/agent/register-autodiscovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, adkey, name }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to auto-discover');
    }
    fetchAgentData();
    return data.data;
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col selection:bg-rose-500 selection:text-white">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-rose-600 to-rose-400 font-bold text-white shadow-lg shadow-rose-600/20">
              K
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-neutral-100">Komari Agent</h1>
                <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] font-mono text-neutral-400">
                  v{status?.agentVersion || '1.2.10'}
                </span>
                <span className="rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-mono text-rose-400 border border-rose-500/20">
                  RPC v2.0
                </span>
              </div>
              <p className="text-xs text-neutral-400 hidden sm:block">
                Server Monitoring Probe & JSON-RPC Client
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Status indicator */}
            <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/80 px-3 py-1.5 text-xs">
              <span className="relative flex h-2 w-2">
                {status?.running ? (
                  <>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
                  </>
                ) : (
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500"></span>
                )}
              </span>
              <span className="font-medium text-neutral-200">
                {status?.running ? 'Reporting Active' : 'Agent Paused'}
              </span>
              <span className="text-neutral-500">|</span>
              <span className="font-mono text-neutral-400">
                #{status?.reportCount || 0} sent
              </span>
            </div>

            <button
              onClick={async () => {
                setIsRefreshing(true);
                await fetchAgentData();
                setTimeout(() => setIsRefreshing(false), 500);
              }}
              className="rounded-lg border border-neutral-800 bg-neutral-900 p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition"
              title="Manual Sync"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-rose-400' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Dashboard */}
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6">
        {/* Endpoint Banner */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800/80 bg-neutral-900/30 px-4 py-3 text-xs">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-rose-500" />
            <span className="text-neutral-400">Ingest Target:</span>
            <span className="font-mono font-medium text-neutral-200 truncate max-w-xs sm:max-w-md">
              {config.endpoint}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowPrivacy(true)}
              className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-400 hover:bg-emerald-500/20 transition"
              title="配置 top 防泄露及去除 MOTD"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>top 隐藏参数 / 屏蔽 MOTD</span>
            </button>
            <div className="flex items-center gap-4 text-neutral-400">
              <span>Interval: <strong className="text-neutral-200 font-mono">{config.interval}s</strong></span>
              <span>Last Sync: <strong className="text-neutral-200 font-mono">
                {status?.lastReportTime ? new Date(status.lastReportTime).toLocaleTimeString() : 'Pending'}
              </strong></span>
            </div>
          </div>
        </div>

        {/* System Telemetry & Metrics Gauges */}
        <SystemGauges metrics={metrics} />

        {/* Agent Controls & Settings Form */}
        <AgentControl
          config={config}
          status={status}
          onUpdateConfig={handleUpdateConfig}
          onToggleRun={handleToggleRun}
          onTriggerReport={handleTriggerReport}
          onTriggerBasicInfo={handleTriggerBasicInfo}
          onSendPingTask={handleSendPingTask}
          onOpenAutoDiscovery={() => setShowAutoDiscovery(true)}
          onOpenPrivacy={() => setShowPrivacy(true)}
        />

        {/* Logs Stream and Ingest Inspector */}
        <LogsAndPayloads
          logs={logs}
          receivedReports={receivedReports}
          onClearLogs={handleClearLogs}
          onClearReceivedReports={handleClearReceivedReports}
        />
      </main>

      {/* Auto-Discovery Registration Modal */}
      <AutoDiscoveryModal
        isOpen={showAutoDiscovery}
        onClose={() => setShowAutoDiscovery(false)}
        defaultServer={config.endpoint}
        onRegister={handleRegisterAutoDiscovery}
      />

      {/* Privacy & MOTD Modal */}
      <PrivacyModal
        isOpen={showPrivacy}
        onClose={() => setShowPrivacy(false)}
        config={config}
      />

      {/* Footer */}
      <footer className="border-t border-neutral-900 py-6 text-center text-xs text-neutral-600">
        <p>Komari Agent (ziqing2022/komari-agent) migrated to Node.js & React on AI Studio</p>
      </footer>
    </div>
  );
};

export default App;
