import React, { useState, useEffect } from 'react';
import { AgentConfig } from '../types';
import { Settings, Save, Download, Copy, Check, Sliders, Terminal, ShieldAlert } from 'lucide-react';

interface ConfigPanelProps {
  config: AgentConfig | null;
  onSaveConfig: (updated: Partial<AgentConfig>) => Promise<void>;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ config, onSaveConfig }) => {
  const [formData, setFormData] = useState<AgentConfig>({
    endpoint: '',
    token: '',
    interval: 3,
    disable_auto_update: false,
    disable_web_ssh: false,
    ignore_unsafe_cert: false,
    include_nics: '',
    exclude_nics: '',
    include_mountpoints: '',
    month_rotate: 0,
    auto_discovery_key: '',
    custom_dns: '',
    enable_gpu: false,
    disable_compression: false,
    prefer_ip_version: '',
  });

  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (config) {
      setFormData(config);
    }
  }, [config]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSaveConfig(formData);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2500);
    } finally {
      setIsSaving(false);
    }
  };

  const generateCliCommand = () => {
    const parts = ['./komari-agent'];
    if (formData.endpoint) parts.push(`--endpoint "${formData.endpoint}"`);
    if (formData.token) parts.push(`--token "${formData.token}"`);
    if (formData.interval && formData.interval !== 3) parts.push(`--interval ${formData.interval}`);
    if (formData.disable_auto_update) parts.push('--disable-auto-update');
    if (formData.disable_web_ssh) parts.push('--disable-web-ssh');
    if (formData.ignore_unsafe_cert) parts.push('--ignore-unsafe-cert');
    if (formData.enable_gpu) parts.push('--gpu');
    if (formData.include_nics) parts.push(`--include-nics "${formData.include_nics}"`);
    if (formData.include_mountpoints) parts.push(`--include-mountpoint "${formData.include_mountpoints}"`);
    if (formData.custom_dns) parts.push(`--custom-dns "${formData.custom_dns}"`);
    if (formData.prefer_ip_version) parts.push(`--prefer-ip-version "${formData.prefer_ip_version}"`);
    return parts.join(' ');
  };

  const handleCopyCli = () => {
    navigator.clipboard.writeText(generateCliCommand());
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleExportJson = () => {
    const jsonStr = JSON.stringify(formData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-sky-400" />
          <h2 className="text-sm font-semibold text-slate-100">Agent Configuration</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            id="btn-copy-cli"
            type="button"
            onClick={handleCopyCli}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Terminal className="w-3.5 h-3.5 text-slate-400" />}
            <span>{copiedCmd ? 'Copied' : 'Copy CLI'}</span>
          </button>
          <button
            id="btn-export-json"
            type="button"
            onClick={handleExportJson}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            <Download className="w-3.5 h-3.5 text-slate-400" />
            <span>config.json</span>
          </button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Core Parameters */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Panel Endpoint URL
            </label>
            <input
              id="input-config-endpoint"
              type="text"
              placeholder="e.g. https://panel.example.com (leave blank for local mock receiver)"
              value={formData.endpoint}
              onChange={e => setFormData({ ...formData, endpoint: e.target.value })}
              className="w-full px-3 py-2 text-xs font-mono rounded bg-slate-950 border border-slate-800 focus:border-sky-500 focus:outline-none text-slate-100"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              If empty, agent sends reports to the internal simulator.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Agent Auth Token
            </label>
            <input
              id="input-config-token"
              type="text"
              placeholder="e.g. your-komari-token"
              value={formData.token}
              onChange={e => setFormData({ ...formData, token: e.target.value })}
              className="w-full px-3 py-2 text-xs font-mono rounded bg-slate-950 border border-slate-800 focus:border-sky-500 focus:outline-none text-slate-100"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Matched against panel client token.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Telemetry Interval (seconds)
            </label>
            <input
              id="input-config-interval"
              type="number"
              min={1}
              max={300}
              value={formData.interval}
              onChange={e => setFormData({ ...formData, interval: Number(e.target.value) || 3 })}
              className="w-full px-3 py-2 text-xs font-mono rounded bg-slate-950 border border-slate-800 focus:border-sky-500 focus:outline-none text-slate-100"
            />
            <p className="text-[11px] text-slate-500 mt-1">Default is 3 seconds.</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Auto Discovery Key (Optional)
            </label>
            <input
              id="input-config-autodiscovery"
              type="text"
              placeholder="e.g. registration-secret-key"
              value={formData.auto_discovery_key}
              onChange={e => setFormData({ ...formData, auto_discovery_key: e.target.value })}
              className="w-full px-3 py-2 text-xs font-mono rounded bg-slate-950 border border-slate-800 focus:border-sky-500 focus:outline-none text-slate-100"
            />
            <p className="text-[11px] text-slate-500 mt-1">For automatic registration with panel.</p>
          </div>
        </div>

        {/* Feature Toggles */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-2">
          <label className="flex items-center gap-2.5 p-2.5 rounded bg-slate-950/60 border border-slate-800/80 cursor-pointer text-xs">
            <input
              id="toggle-gpu"
              type="checkbox"
              checked={formData.enable_gpu}
              onChange={e => setFormData({ ...formData, enable_gpu: e.target.checked })}
              className="rounded bg-slate-900 border-slate-700 text-sky-500 focus:ring-0"
            />
            <span className="text-slate-300 font-medium">Enable GPU Telemetry</span>
          </label>

          <label className="flex items-center gap-2.5 p-2.5 rounded bg-slate-950/60 border border-slate-800/80 cursor-pointer text-xs">
            <input
              id="toggle-disable-webssh"
              type="checkbox"
              checked={formData.disable_web_ssh}
              onChange={e => setFormData({ ...formData, disable_web_ssh: e.target.checked })}
              className="rounded bg-slate-900 border-slate-700 text-sky-500 focus:ring-0"
            />
            <span className="text-slate-300 font-medium">Disable Web SSH / Exec</span>
          </label>

          <label className="flex items-center gap-2.5 p-2.5 rounded bg-slate-950/60 border border-slate-800/80 cursor-pointer text-xs">
            <input
              id="toggle-ignore-cert"
              type="checkbox"
              checked={formData.ignore_unsafe_cert}
              onChange={e => setFormData({ ...formData, ignore_unsafe_cert: e.target.checked })}
              className="rounded bg-slate-900 border-slate-700 text-sky-500 focus:ring-0"
            />
            <span className="text-slate-300 font-medium">Ignore Unsafe SSL Cert</span>
          </label>

          <label className="flex items-center gap-2.5 p-2.5 rounded bg-slate-950/60 border border-slate-800/80 cursor-pointer text-xs">
            <input
              id="toggle-disable-compression"
              type="checkbox"
              checked={formData.disable_compression}
              onChange={e => setFormData({ ...formData, disable_compression: e.target.checked })}
              className="rounded bg-slate-900 border-slate-700 text-sky-500 focus:ring-0"
            />
            <span className="text-slate-300 font-medium">Disable Compression</span>
          </label>

          <label className="flex items-center gap-2.5 p-2.5 rounded bg-slate-950/60 border border-slate-800/80 cursor-pointer text-xs">
            <input
              id="toggle-disable-autoupdate"
              type="checkbox"
              checked={formData.disable_auto_update}
              onChange={e => setFormData({ ...formData, disable_auto_update: e.target.checked })}
              className="rounded bg-slate-900 border-slate-700 text-sky-500 focus:ring-0"
            />
            <span className="text-slate-300 font-medium">Disable Auto-Update</span>
          </label>
        </div>

        {/* Advanced Accordion */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition pt-1"
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>{showAdvanced ? 'Hide Advanced Filters' : 'Show Advanced Filters (NICs, Mountpoints, DNS)'}</span>
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 mt-2 rounded bg-slate-950/40 border border-slate-800 text-xs">
              <div>
                <label className="block font-medium text-slate-300 mb-1">Include NICs (comma-separated)</label>
                <input
                  type="text"
                  placeholder="eth0, ens3"
                  value={formData.include_nics}
                  onChange={e => setFormData({ ...formData, include_nics: e.target.value })}
                  className="w-full px-3 py-1.5 font-mono rounded bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Exclude NICs (comma-separated)</label>
                <input
                  type="text"
                  placeholder="docker0, veth*"
                  value={formData.exclude_nics}
                  onChange={e => setFormData({ ...formData, exclude_nics: e.target.value })}
                  className="w-full px-3 py-1.5 font-mono rounded bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Include Mountpoints (semicolon-separated)</label>
                <input
                  type="text"
                  placeholder="/; /data"
                  value={formData.include_mountpoints}
                  onChange={e => setFormData({ ...formData, include_mountpoints: e.target.value })}
                  className="w-full px-3 py-1.5 font-mono rounded bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">Custom DNS Server</label>
                <input
                  type="text"
                  placeholder="8.8.8.8 or 1.1.1.1"
                  value={formData.custom_dns}
                  onChange={e => setFormData({ ...formData, custom_dns: e.target.value })}
                  className="w-full px-3 py-1.5 font-mono rounded bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>
            </div>
          )}
        </div>

        {/* Submit Bar */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-800">
          <div className="text-xs text-slate-400">
            {savedSuccess && (
              <span className="text-emerald-400 flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                Configuration saved & applied
              </span>
            )}
          </div>
          <button
            id="btn-save-config"
            type="submit"
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-sky-600 hover:bg-sky-500 text-white transition disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
