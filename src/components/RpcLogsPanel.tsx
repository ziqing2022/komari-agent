import React, { useState } from 'react';
import { RPCLogEntry } from '../types';
import { Radio, Terminal, Trash2, ChevronRight, ChevronDown, CheckCircle, AlertCircle, Clock } from 'lucide-react';

interface RpcLogsPanelProps {
  logs: RPCLogEntry[];
  onClearLogs: () => void;
  onRunTestRpc: (method: string, params?: any) => Promise<any>;
}

export const RpcLogsPanel: React.FC<RpcLogsPanelProps> = ({ logs, onClearLogs, onRunTestRpc }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterMethod, setFilterMethod] = useState<string>('all');
  const [testingMethod, setTestingMethod] = useState<string | null>(null);

  const filteredLogs = logs.filter(log => {
    if (filterMethod === 'all') return true;
    return log.method === filterMethod;
  });

  const handleRun = async (method: string, params: any = {}) => {
    setTestingMethod(method);
    try {
      await onRunTestRpc(method, params);
    } finally {
      setTestingMethod(null);
    }
  };

  return (
    <div className="p-5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-sky-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-100">JSON-RPC v2 Protocol Inspector</h2>
            <p className="text-[11px] text-slate-400">Live communication stream of agent events</p>
          </div>
        </div>

        {/* Quick Test Triggers & Clear */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            id="btn-test-ping"
            disabled={testingMethod !== null}
            onClick={() => handleRun('agent.ping')}
            className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            {testingMethod === 'agent.ping' ? 'Sending...' : 'Test agent.ping'}
          </button>
          <button
            id="btn-test-basicinfo"
            disabled={testingMethod !== null}
            onClick={() => handleRun('agent.basicInfo')}
            className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            {testingMethod === 'agent.basicInfo' ? 'Sending...' : 'Test basicInfo'}
          </button>
          <button
            id="btn-test-exec"
            disabled={testingMethod !== null}
            onClick={() => handleRun('agent.exec', { command: 'uname -a' })}
            className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            {testingMethod === 'agent.exec' ? 'Sending...' : 'Test exec'}
          </button>
          <button
            id="btn-clear-logs"
            onClick={onClearLogs}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-rose-400 transition"
            title="Clear logs"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs font-mono">
        {['all', 'agent.report', 'agent.basicInfo', 'agent.ping', 'agent.exec'].map(m => (
          <button
            key={m}
            onClick={() => setFilterMethod(m)}
            className={`px-2.5 py-1 rounded transition whitespace-nowrap ${
              filterMethod === m
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Logs Table / List */}
      <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
        {filteredLogs.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500 font-mono">
            No RPC messages recorded yet. Messages will appear on the next collection tick.
          </div>
        ) : (
          filteredLogs.map(log => {
            const isExpanded = expandedId === log.id;
            const timeStr = new Date(log.timestamp).toLocaleTimeString();

            return (
              <div
                key={log.id}
                className="rounded border border-slate-800/80 bg-slate-950/60 overflow-hidden text-xs"
              >
                <div
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  className="flex items-center justify-between p-2.5 hover:bg-slate-900/60 cursor-pointer transition select-none"
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                    )}
                    <span className="font-mono text-slate-500 text-[11px]">{timeStr}</span>
                    <span className="font-mono font-medium text-sky-300 px-1.5 py-0.5 rounded bg-sky-950/60 border border-sky-800/50">
                      {log.method}
                    </span>
                    <span className="text-slate-500 font-mono text-[11px]">ID: {log.rpcId}</span>
                  </div>

                  <div className="flex items-center gap-3">
                    {log.latencyMs !== undefined && (
                      <span className="font-mono text-[11px] text-slate-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {log.latencyMs}ms
                      </span>
                    )}
                    {log.status === 'success' ? (
                      <span className="flex items-center gap-1 text-emerald-400 text-[11px] font-mono">
                        <CheckCircle className="w-3 h-3" /> 200 OK
                      </span>
                    ) : log.status === 'pending' ? (
                      <span className="text-amber-400 text-[11px] font-mono">Pending...</span>
                    ) : (
                      <span className="flex items-center gap-1 text-rose-400 text-[11px] font-mono">
                        <AlertCircle className="w-3 h-3" /> Error
                      </span>
                    )}
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="p-3 bg-slate-950 border-t border-slate-800/80 space-y-2">
                    {log.error && (
                      <div className="p-2 rounded bg-rose-950/30 border border-rose-800/40 text-rose-300 text-[11px]">
                        <strong>Error:</strong> {log.error}
                      </div>
                    )}
                    <div className="text-[11px] font-mono text-slate-400">JSON-RPC 2.0 Payload:</div>
                    <pre className="p-2.5 rounded bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-48">
                      {JSON.stringify(log.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
