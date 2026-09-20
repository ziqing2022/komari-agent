import React, { useState, useEffect, useCallback } from 'react';
import { SystemMetrics, BasicInfo, AgentConfig, AgentStatus, RPCLogEntry, MockReceiverReport } from './types';
import { Header } from './components/Header';
import { MetricCards } from './components/MetricCards';
import { ResourceGauges } from './components/ResourceGauges';
import { ConfigPanel } from './components/ConfigPanel';
import { RpcLogsPanel } from './components/RpcLogsPanel';
import { HardwareSpecs } from './components/HardwareSpecs';
import { ReceiverModal } from './components/ReceiverModal';
import { Activity, Settings, Terminal, Server, Inbox, AlertTriangle } from 'lucide-react';

export default function App() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [basicInfo, setBasicInfo] = useState<BasicInfo | null>(null);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [logs, setLogs] = useState<RPCLogEntry[]>([]);
  const [receiverReports, setReceiverReports] = useState<MockReceiverReport[]>([]);

  const [activeTab, setActiveTab] = useState<'telemetry' | 'config' | 'logs' | 'specs' | 'receiver'>('telemetry');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Fetch telemetry & status
  const fetchData = useCallback(async () => {
    try {
      const [mRes, sRes] = await Promise.all([
        fetch('/api/metrics'),
        fetch('/api/agent/status'),
      ]);

      if (mRes.ok) {
        const mData = await mRes.json();
        setMetrics(mData);
      }
      if (sRes.ok) {
        const sData = await sRes.json();
        setStatus(sData);
      }
    } catch {
      // Ignore network errors in background poll
    }
  }, []);

  // Fetch logs
  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch {}
  }, []);

  // Fetch static info & config once
  useEffect(() => {
    fetch('/api/basic-info')
      .then(r => r.json())
      .then(setBasicInfo)
      .catch(() => {});

    fetch('/api/config')
      .then(r => r.json())
      .then(setConfig)
      .catch(() => {});

    fetch('/api/receiver/reports')
      .then(r => r.json())
      .then(setReceiverReports)
      .catch(() => {});
  }, []);

  // Periodic polling
  useEffect(() => {
    fetchData();
    fetchLogs();
    const interval = setInterval(() => {
      fetchData();
      fetchLogs();
    }, 2500);
    return () => clearInterval(interval);
  }, [fetchData, fetchLogs]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([fetchData(), fetchLogs()]);
    setIsRefreshing(false);
    showToast('Telemetry refreshed', 'success');
  };

  const handleToggleAgent = async () => {
    try {
      const res = await fetch('/api/agent/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      if (data.success) {
        showToast(data.isRunning ? 'Agent loop started' : 'Agent loop paused', 'info');
        fetchData();
      }
    } catch (err: any) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };

  const handleManualPing = async () => {
    try {
      const res = await fetch('/api/agent/test-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'agent.ping' }),
      });
      const data = await res.json();
      if (data.result?.pong) {
        showToast('Ping acknowledged (pong: true)', 'success');
      } else {
        showToast('Ping sent', 'info');
      }
      fetchLogs();
      fetchData();
    } catch (err: any) {
      showToast(`Ping failed: ${err.message}`, 'error');
    }
  };

  const handleSaveConfig = async (updated: Partial<AgentConfig>) => {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Failed to update config', 'error');
      throw new Error(err.error);
    }
    const data = await res.json();
    setConfig(data.config);
    showToast('Agent configuration updated', 'success');
    fetchData();
  };

  const handleClearLogs = async () => {
    await fetch('/api/agent/clear-logs', { method: 'POST' });
    setLogs([]);
    showToast('Logs cleared', 'info');
  };

  const handleRunTestRpc = async (method: string, params: any) => {
    try {
      const res = await fetch('/api/agent/test-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });
      const data = await res.json();
      showToast(`RPC ${method} completed`, 'success');
      fetchLogs();
      return data;
    } catch (err: any) {
      showToast(`RPC error: ${err.message}`, 'error');
      throw err;
    }
  };

  const handleRefreshReceiver = async () => {
    const res = await fetch('/api/receiver/reports');
    if (res.ok) {
      const data = await res.json();
      setReceiverReports(data);
      showToast('Receiver feed updated', 'info');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-sky-500 selection:text-white">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div
            className={`px-4 py-2.5 rounded-lg shadow-lg text-xs font-medium border flex items-center gap-2 ${
              toast.type === 'success'
                ? 'bg-emerald-950/90 text-emerald-200 border-emerald-800'
                : toast.type === 'error'
                ? 'bg-rose-950/90 text-rose-200 border-rose-800'
                : 'bg-slate-900/95 text-slate-200 border-slate-700'
            }`}
          >
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {/* Header */}
      <Header
        status={status}
        config={config}
        onToggleAgent={handleToggleAgent}
        onManualPing={handleManualPing}
        onRefresh={handleManualRefresh}
        isRefreshing={isRefreshing}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 border-b border-slate-800 pb-2 overflow-x-auto">
          <button
            id="tab-telemetry"
            onClick={() => setActiveTab('telemetry')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md transition whitespace-nowrap ${
              activeTab === 'telemetry'
                ? 'bg-slate-800 text-sky-400 border border-slate-700/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Activity className="w-4 h-4" />
            <span>Live Telemetry</span>
          </button>

          <button
            id="tab-specs"
            onClick={() => setActiveTab('specs')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md transition whitespace-nowrap ${
              activeTab === 'specs'
                ? 'bg-slate-800 text-sky-400 border border-slate-700/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Server className="w-4 h-4" />
            <span>Host Specifications</span>
          </button>

          <button
            id="tab-logs"
            onClick={() => setActiveTab('logs')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md transition whitespace-nowrap ${
              activeTab === 'logs'
                ? 'bg-slate-800 text-sky-400 border border-slate-700/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span>JSON-RPC Inspector</span>
            {logs.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-700 text-slate-300 font-mono">
                {logs.length}
              </span>
            )}
          </button>

          <button
            id="tab-config"
            onClick={() => setActiveTab('config')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md transition whitespace-nowrap ${
              activeTab === 'config'
                ? 'bg-slate-800 text-sky-400 border border-slate-700/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Settings className="w-4 h-4" />
            <span>Configuration</span>
          </button>

          <button
            id="tab-receiver"
            onClick={() => setActiveTab('receiver')}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md transition whitespace-nowrap ${
              activeTab === 'receiver'
                ? 'bg-slate-800 text-sky-400 border border-slate-700/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Inbox className="w-4 h-4" />
            <span>Panel Receiver</span>
            {receiverReports.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-900/60 text-emerald-300 font-mono">
                {receiverReports.length}
              </span>
            )}
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'telemetry' && (
          <div className="space-y-6">
            <MetricCards metrics={metrics} />
            <ResourceGauges metrics={metrics} />
          </div>
        )}

        {activeTab === 'specs' && (
          <HardwareSpecs info={basicInfo} />
        )}

        {activeTab === 'logs' && (
          <RpcLogsPanel
            logs={logs}
            onClearLogs={handleClearLogs}
            onRunTestRpc={handleRunTestRpc}
          />
        )}

        {activeTab === 'config' && (
          <ConfigPanel
            config={config}
            onSaveConfig={handleSaveConfig}
          />
        )}

        {activeTab === 'receiver' && (
          <ReceiverModal
            reports={receiverReports}
            onRefresh={handleRefreshReceiver}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500 font-mono">
        Komari Agent • System Monitoring & JSON-RPC v2 Protocol • Node.js {process.version || 'v22'}
      </footer>
    </div>
  );
}
