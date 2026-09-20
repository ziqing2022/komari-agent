import React from 'react';
import { MockReceiverReport } from '../types';
import { Radio, Inbox, CheckCircle, Clock } from 'lucide-react';

interface ReceiverModalProps {
  reports: MockReceiverReport[];
  onRefresh: () => void;
}

export const ReceiverModal: React.FC<ReceiverModalProps> = ({ reports, onRefresh }) => {
  return (
    <div className="p-5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-4">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-emerald-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Built-in Mock Panel Receiver</h2>
            <p className="text-[11px] text-slate-400">
              Receives incoming agent reports at <code className="font-mono text-slate-300">/api/clients/v2/rpc</code>
            </p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
        >
          Refresh Feed
        </button>
      </div>

      <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
        {reports.length === 0 ? (
          <div className="text-center py-6 text-xs text-slate-500 font-mono">
            No incoming client reports received yet.
          </div>
        ) : (
          reports.map(rep => (
            <div
              key={rep.id}
              className="p-3 rounded bg-slate-950/60 border border-slate-800/80 space-y-1.5 text-xs font-mono"
            >
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-sky-300 font-semibold">{rep.method}</span>
                <span className="text-[11px] text-slate-500 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {new Date(rep.receivedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-slate-400 text-[11px]">
                Client: <span className="text-slate-200">{rep.clientId}</span>
              </div>
              <pre className="p-2 rounded bg-slate-900 text-[11px] text-slate-300 overflow-x-auto max-h-32">
                {JSON.stringify(rep.params, null, 2)}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
