import React, { useState } from 'react';
import { Terminal, Database, Trash2, ChevronRight, ChevronDown, CheckCircle2, AlertTriangle, Radio } from 'lucide-react';
import { AgentLog, ReceivedReport } from '../types';

interface LogsAndPayloadsProps {
  logs: AgentLog[];
  receivedReports: ReceivedReport[];
  onClearLogs: () => Promise<void>;
  onClearReceivedReports: () => Promise<void>;
}

export const LogsAndPayloads: React.FC<LogsAndPayloadsProps> = ({
  logs,
  receivedReports,
  onClearLogs,
  onClearReceivedReports,
}) => {
  const [activeTab, setActiveTab] = useState<'logs' | 'received'>('logs');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 backdrop-blur">
      {/* Tab Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('logs')}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
              activeTab === 'logs'
                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Terminal className="h-4 w-4" />
            Agent Activity Logs ({logs.length})
          </button>
          <button
            onClick={() => setActiveTab('received')}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
              activeTab === 'received'
                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Database className="h-4 w-4" />
            Received Ingest Payloads ({receivedReports.length})
          </button>
        </div>

        <div>
          {activeTab === 'logs' ? (
            <button
              onClick={onClearLogs}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear Logs
            </button>
          ) : (
            <button
              onClick={onClearReceivedReports}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear Ingest History
            </button>
          )}
        </div>
      </div>

      {/* Tab 1: Agent Logs */}
      {activeTab === 'logs' && (
        <div className="mt-4 max-h-96 overflow-y-auto font-mono text-xs divide-y divide-neutral-800/60">
          {logs.length === 0 ? (
            <div className="py-12 text-center text-neutral-500 font-sans">
              No activity logs yet. Ensure the agent is running.
            </div>
          ) : (
            logs.map((log) => {
              const isExpanded = expandedId === log.id;
              return (
                <div key={log.id} className="py-2 hover:bg-neutral-800/30 px-2 rounded transition">
                  <div
                    onClick={() => log.payload && toggleExpand(log.id)}
                    className={`flex items-start gap-2.5 ${log.payload ? 'cursor-pointer' : ''}`}
                  >
                    <span className="text-neutral-500 select-none whitespace-nowrap text-[11px] pt-0.5">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>

                    {/* Type icon */}
                    <div className="pt-0.5">
                      {log.type === 'report' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                      {log.type === 'error' && <AlertTriangle className="h-3.5 w-3.5 text-red-400" />}
                      {log.type === 'ping' && <Radio className="h-3.5 w-3.5 text-rose-400" />}
                      {log.type === 'info' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 mt-1" />}
                      {log.type === 'event' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 mt-1" />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-semibold uppercase text-[10px] tracking-wider px-1 rounded ${
                            log.type === 'report'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : log.type === 'error'
                              ? 'bg-red-500/10 text-red-400'
                              : log.type === 'ping'
                              ? 'bg-rose-500/10 text-rose-400'
                              : 'bg-neutral-800 text-neutral-400'
                          }`}
                        >
                          {log.type}
                        </span>
                        <span className="text-neutral-200">{log.message}</span>
                      </div>

                      {/* Expandable payload */}
                      {log.payload && (
                        <div className="mt-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpand(log.id);
                            }}
                            className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-300"
                          >
                            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            {isExpanded ? 'Hide Payload' : 'Inspect JSON-RPC Data'}
                          </button>
                          {isExpanded && (
                            <pre className="mt-2 rounded bg-neutral-950 p-2.5 text-[11px] text-neutral-300 overflow-x-auto border border-neutral-800">
                              {JSON.stringify(log.payload, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Tab 2: Received Reports (Mock Server Ingest) */}
      {activeTab === 'received' && (
        <div className="mt-4 max-h-96 overflow-y-auto divide-y divide-neutral-800/60 font-mono text-xs">
          {receivedReports.length === 0 ? (
            <div className="py-12 text-center text-neutral-500 font-sans">
              No payloads received yet. The local mock receiver will display incoming JSON-RPC items here.
            </div>
          ) : (
            receivedReports.map((item) => {
              const isExpanded = expandedId === item.id;
              return (
                <div key={item.id} className="py-2.5 px-2 hover:bg-neutral-800/30 rounded">
                  <div
                    onClick={() => toggleExpand(item.id)}
                    className="flex items-center justify-between cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-neutral-500 text-[11px]">
                        {new Date(item.receivedAt).toLocaleTimeString()}
                      </span>
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase font-bold text-neutral-300">
                        {item.type}
                      </span>
                      <span className="text-neutral-300 text-xs font-sans">
                        {item.type === 'report' && `CPU ${item.payload?.report?.cpu?.usage}% | RAM ${Math.round((item.payload?.report?.ram?.used / item.payload?.report?.ram?.total) * 100)}%`}
                        {item.type === 'basicInfo' && `${item.payload?.info?.os} (${item.payload?.info?.cpu_name})`}
                        {item.type === 'pingResult' && `Task #${item.payload?.task_id} result: ${item.payload?.value}ms`}
                        {item.type === 'pull' && `Caps: ${JSON.stringify(item.payload?.capabilities || [])}`}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-neutral-500">
                      <span className="text-[10px]">token: {item.token ? item.token.slice(0, 10) + '...' : 'none'}</span>
                      {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </div>
                  </div>

                  {isExpanded && (
                    <pre className="mt-2.5 rounded bg-neutral-950 p-3 text-[11px] text-neutral-300 overflow-x-auto border border-neutral-800">
                      {JSON.stringify(item.payload, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
