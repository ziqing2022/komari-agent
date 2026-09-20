export interface SystemMetrics {
  cpu: {
    usage: number; // 0 - 100
    cores: number;
    model: string;
  };
  ram: {
    total: number;
    used: number;
    free: number;
    cached: number;
    usagePercent: number;
  };
  swap: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
  };
  load: {
    load1: number;
    load5: number;
    load15: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
    mountpoints: Array<{
      fs: string;
      mount: string;
      total: number;
      used: number;
      free: number;
      percent: number;
    }>;
  };
  network: {
    up: number; // bytes per second
    down: number; // bytes per second
    totalUp: number; // total bytes
    totalDown: number; // total bytes
    interfaces: string[];
  };
  connections: {
    tcp: number;
    udp: number;
  };
  gpu?: {
    count: number;
    average_usage: number;
    detailed_info: Array<{
      name: string;
      memory_total: number;
      memory_used: number;
      utilization: number;
      temperature: number;
    }>;
  };
  uptime: number; // seconds
  process: number;
  message?: string;
  timestamp: number;
}

export interface BasicInfo {
  cpu_name: string;
  cpu_cores: number;
  cpu_physical_cores: number;
  arch: string;
  os: string;
  kernel_version: string;
  ipv4: string;
  ipv6: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  gpu_name: string;
  virtualization: string;
  version: string;
}

export interface AgentConfig {
  endpoint: string;
  token: string;
  interval: number;
  disable_auto_update: boolean;
  disable_web_ssh: boolean;
  ignore_unsafe_cert: boolean;
  include_nics: string;
  exclude_nics: string;
  include_mountpoints: string;
  month_rotate: number;
  auto_discovery_key: string;
  custom_dns: string;
  enable_gpu: boolean;
  disable_compression: boolean;
  prefer_ip_version: string;
}

export interface RPCLogEntry {
  id: string;
  timestamp: number;
  direction: 'outgoing' | 'incoming';
  method: string;
  rpcId?: string | number;
  payload: any;
  status: 'success' | 'pending' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface AgentStatus {
  isRunning: boolean;
  isReporting: boolean;
  connectionState: 'connected' | 'connecting' | 'disconnected' | 'mock-receiver-only';
  endpoint: string;
  lastReportTime: number | null;
  totalReportsSent: number;
  latencyMs: number;
  lastError: string | null;
  activeTarget: 'remote' | 'builtin-mock' | 'idle';
  mockReceiverCount: number;
}

export interface MockReceiverReport {
  id: string;
  clientId: string;
  receivedAt: number;
  method: string;
  params: any;
}
