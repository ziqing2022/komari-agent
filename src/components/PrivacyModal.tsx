import React, { useState, useEffect } from 'react';
import { X, ShieldCheck, Copy, Check, Terminal, EyeOff, FileText, BellOff } from 'lucide-react';

interface PrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: any;
}

export const PrivacyModal: React.FC<PrivacyModalProps> = ({
  isOpen,
  onClose,
  config,
}) => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [motdStatus, setMotdStatus] = useState<{ loading: boolean; message: string | null; success?: boolean }>({
    loading: false,
    message: null,
  });
  const [systemdService, setSystemdService] = useState<string>('');
  const [instructions, setInstructions] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/agent/systemd-service')
        .then((res) => res.json())
        .then((data) => {
          if (data.serviceFile) setSystemdService(data.serviceFile);
          if (data.installInstructions) setInstructions(data.installInstructions);
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(id);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const handleApplyMotd = async () => {
    setMotdStatus({ loading: true, message: null });
    try {
      const res = await fetch('/api/agent/suppress-motd', { method: 'POST' });
      const data = await res.json();
      setMotdStatus({
        loading: false,
        message: data.message || 'MOTD 已成功屏蔽 (~/.hushlogin)',
        success: data.success,
      });
    } catch (err: any) {
      setMotdStatus({
        loading: false,
        message: `屏蔽失败: ${err.message}`,
        success: false,
      });
    }
  };

  const motdCommands = `# 1. 用户级：在登录用户家目录创建 .hushlogin（推荐，最安全）
touch ~/.hushlogin

# 2. 系统级（Debian/Ubuntu）：禁用动态 MOTD 生成脚本
sudo chmod -x /etc/update-motd.d/* 2>/dev/null || true
sudo truncate -s 0 /etc/motd 2>/dev/null || true

# 3. SSH 服务级（可选）：在 /etc/ssh/sshd_config 中设置
# PrintMotd no
# PrintLastLog no
sudo systemctl restart sshd`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-rose-500/10 p-2 text-rose-400 border border-rose-500/20">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-neutral-100">
                服务器隐私防护与防泄露配置
              </h3>
              <p className="text-xs text-neutral-400">
                不在 top/ps 中显示参数，并去除登录服务器时的 MOTD 提示
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs text-neutral-300">
          {/* Section 1: Top / ps leak solution */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-neutral-100 font-medium">
                <EyeOff className="h-4 w-4 text-emerald-400" />
                <span>1. 解决 top / ps 中泄露网址和 Token</span>
              </div>
              <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400 border border-emerald-500/20">
                已自动启用 config.json
              </span>
            </div>
            <p className="text-neutral-400 leading-relaxed">
              <strong>原理：</strong>在 Linux 下通过命令行参数（如 <code className="text-rose-400 bg-neutral-900 px-1 py-0.5 rounded">-t token -e url</code>）启动时，系统会将完整参数暴露在 <code className="text-neutral-200 bg-neutral-900 px-1 py-0.5 rounded">/proc/$PID/cmdline</code> 中，任何普通用户运行 <code className="text-neutral-200 bg-neutral-900 px-1 py-0.5 rounded">ps aux</code> 或 <code className="text-neutral-200 bg-neutral-900 px-1 py-0.5 rounded">top</code> 均可直视。
            </p>
            <p className="text-neutral-400 leading-relaxed">
              <strong>解决方案：</strong>Agent 已自动将配置加密保存在当前目录下的 <code className="text-emerald-400">config.json</code>（权限 0600）。并且程序启动时将自身进程名直接重命名为 <code className="text-emerald-400">komari-agent</code>。无需在命令行中传入任何参数即可直接启动！
            </p>

            {/* Zero argument systemd */}
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-neutral-400 flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-neutral-500" />
                  无参 Systemd 守护服务文件 (/etc/systemd/system/komari-agent.service)
                </span>
                <button
                  onClick={() => handleCopy(systemdService, 'systemd')}
                  className="flex items-center gap-1 text-[11px] text-rose-400 hover:text-rose-300"
                >
                  {copiedSection === 'systemd' ? (
                    <>
                      <Check className="h-3.5 w-3.5" /> 已复制
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" /> 复制配置
                    </>
                  )}
                </button>
              </div>
              <pre className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 font-mono text-[11px] text-neutral-300 overflow-x-auto">
                {systemdService || 'Loading systemd service template...'}
              </pre>
            </div>
          </div>

          {/* Section 2: MOTD Removal */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-neutral-100 font-medium">
                <BellOff className="h-4 w-4 text-amber-400" />
                <span>2. 去除登录服务器时的 MOTD 欢迎语提示</span>
              </div>
              <button
                onClick={handleApplyMotd}
                disabled={motdStatus.loading}
                className="rounded bg-rose-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-rose-500 disabled:opacity-50 transition"
              >
                {motdStatus.loading ? '正在处理...' : '一键屏蔽 MOTD (~/.hushlogin)'}
              </button>
            </div>

            {motdStatus.message && (
              <div
                className={`rounded-lg p-2.5 text-xs ${
                  motdStatus.success
                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                }`}
              >
                {motdStatus.message}
              </div>
            )}

            <p className="text-neutral-400 leading-relaxed">
              <strong>原理：</strong>Linux OpenSSH 登录时会通过 PAM 调用 <code className="text-neutral-200">pam_motd</code> 执行动态脚本。只要在当前用户家目录下创建空的 <code className="text-emerald-400">~/.hushlogin</code> 文件，SSH 即会完全静默登录，不显示任何系统 MOTD 提示。
            </p>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-neutral-400 flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5 text-neutral-500" />
                  服务器终端执行命令（彻底清除 MOTD）
                </span>
                <button
                  onClick={() => handleCopy(motdCommands, 'motd')}
                  className="flex items-center gap-1 text-[11px] text-rose-400 hover:text-rose-300"
                >
                  {copiedSection === 'motd' ? (
                    <>
                      <Check className="h-3.5 w-3.5" /> 已复制
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" /> 复制命令
                    </>
                  )}
                </button>
              </div>
              <pre className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 font-mono text-[11px] text-neutral-300 overflow-x-auto">
                {motdCommands}
              </pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-800 px-6 py-3.5 bg-neutral-950/50 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-neutral-800 px-4 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-700 transition"
          >
            完成并关闭
          </button>
        </div>
      </div>
    </div>
  );
};
