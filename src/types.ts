export interface AgentConfig {
  endpoint: string;
  token: string;
  interval: number;
  disableAutoUpdate: boolean;
  disableWebSsh: boolean;
  ignoreUnsafeCert: boolean;
  includeNics?: string;
  excludeNics?: string;
  customDns?: string;
  enableGpu: boolean;
  disableCompression: boolean;
  preferIpVersion: 'auto' | '4' | '6';
  autoDiscoveryKey?: string;
  disableMotd?: boolean;
  useConfigFile?: boolean;
}

export interface AgentStatus {
  running: boolean;
  connected: boolean;
  uptimeSeconds: number;
  reportCount: number;
  lastReportTime: string | null;
  lastReportStatus: 'success' | 'failed' | 'idle';
  lastError: string | null;
  activeEndpoint: string;
  agentVersion: string;
  protocolVersion: string;
}

export interface SystemMetrics {
  cpu: {
    name: string;
    cores: number;
    physicalCores: number;
    arch: string;
    usage: number; // 0 to 100
  };
  ram: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
  };
  swap: {
    total: number;
    used: number;
    usagePercent: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
    mountPoint: string;
  };
  load: {
    load1: number;
    load5: number;
    load15: number;
  };
  network: {
    up: number; // bytes/sec
    down: number; // bytes/sec
    totalUp: number;
    totalDown: number;
  };
  connections: {
    tcp: number;
    udp: number;
  };
  processCount: number;
  uptime: number;
  osInfo: {
    platform: string;
    distro: string;
    release: string;
    arch: string;
    kernel: string;
    hostname: string;
    ipv4: string;
    ipv6: string;
    virtualization: string;
  };
}

export interface AgentLog {
  id: string;
  timestamp: string;
  type: 'info' | 'report' | 'error' | 'event' | 'ping';
  message: string;
  payload?: any;
}

export interface ReceivedReport {
  id: string;
  receivedAt: string;
  token: string;
  type: 'report' | 'basicInfo' | 'pingResult' | 'pull';
  payload: any;
}
