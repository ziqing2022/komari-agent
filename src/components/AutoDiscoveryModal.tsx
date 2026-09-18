import React, { useState } from 'react';
import { Sparkles, X, Check, AlertCircle } from 'lucide-react';

interface AutoDiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultServer: string;
  onRegister: (server: string, adkey: string, name: string) => Promise<any>;
}

export const AutoDiscoveryModal: React.FC<AutoDiscoveryModalProps> = ({
  isOpen,
  onClose,
  defaultServer,
  onRegister,
}) => {
  const [server, setServer] = useState(defaultServer);
  const [adkey, setAdkey] = useState('');
  const [clientName, setClientName] = useState('komari-web-agent');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await onRegister(server, adkey, clientName);
      setResult(res);
    } catch (err: any) {
      setError(err.message || 'Auto-discovery registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-rose-500/10 p-2 text-rose-400">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-neutral-100">Auto-Discovery Registration</h3>
              <p className="text-xs text-neutral-400">Register this agent automatically with a Komari dashboard</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
            <div className="flex items-center gap-2 font-semibold">
              <Check className="h-4 w-4" /> Registered successfully!
            </div>
            <p className="mt-1 font-mono text-[11px] text-emerald-400">
              UUID: {result.uuid}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-emerald-400">
              Token: {result.token.slice(0, 16)}...
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-xs">
          <div>
            <label className="mb-1 block font-medium text-neutral-300">Komari Server URL</label>
            <input
              type="text"
              required
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="https://komari.example.com"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-neutral-200 focus:border-rose-500/80 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium text-neutral-300">Auto-Discovery Key (Bearer)</label>
            <input
              type="text"
              required
              value={adkey}
              onChange={(e) => setAdkey(e.target.value)}
              placeholder="Paste Auto-Discovery Key from server"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-neutral-200 focus:border-rose-500/80 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium text-neutral-300">Client Identifier Name</label>
            <input
              type="text"
              required
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="komari-agent-client"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-neutral-200 focus:border-rose-500/80 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-neutral-800 px-4 py-2 text-neutral-400 hover:bg-neutral-800"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-rose-600 px-4 py-2 font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {loading ? 'Registering...' : 'Register Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
