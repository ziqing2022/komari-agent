import express from 'express';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServer as createViteServer } from 'vite';

const execAsync = promisify(exec);
const PORT = 3000;
const app = express();
app.use(express.json({ limit: '10mb' }));

// In-Memory State
interface AgentConfig {
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

let agentConfig: AgentConfig = {
  endpoint: process.env.AGENT_ENDPOINT || '',
  token: process.env.AGENT_TOKEN || 'komari-demo-token-ai-studio',
  interval: Number(process.env.AGENT_INTERVAL) || 3,
  disable_auto_update: process.env.AGENT_DISABLE_AUTO_UPDATE === 'true',
  disable_web_ssh: process.env.AGENT_DISABLE_WEB_SSH === 'true',
  ignore_unsafe_cert: process.env.AGENT_IGNORE_UNSAFE_CERT === 'true',
  include_nics: process.env.AGENT_INCLUDE_NICS || '',
  exclude_nics: process.env.AGENT_EXCLUDE_NICS || '',
  include_mountpoints: process.env.AGENT_INCLUDE_MOUNTPOINTS || '',
  month_rotate: Number(process.env.AGENT_MONTH_ROTATE) || 0,
  auto_discovery_key: process.env.AGENT_AUTO_DISCOVERY_KEY || '',
  custom_dns: process.env.AGENT_CUSTOM_DNS || '',
  enable_gpu: process.env.AGENT_ENABLE_GPU === 'true',
  disable_compression: process.env.AGENT_DISABLE_COMPRESSION === 'true',
  prefer_ip_version: process.env.AGENT_PREFER_IP_VERSION || '',
};

interface RPCLog {
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

const rpcLogs: RPCLog[] = [];
const receiverReports: Array<{ id: string; clientId: string; receivedAt: number; method: string; params: any }> = [];

let isAgentRunning = true;
let totalReportsSent = 0;
let lastReportTime: number | null = null;
let lastError: string | null = null;
let lastLatencyMs = 0;

// CPU Calculation Tracking
let prevCpuTimes: { idle: number; total: number } | null = null;
let currentCpuUsage = 2.5;

function getCpuUsage(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += (cpu.times as any)[type];
    }
    idle += cpu.times.idle;
  }

  if (prevCpuTimes) {
    const idleDiff = idle - prevCpuTimes.idle;
    const totalDiff = total - prevCpuTimes.total;
    if (totalDiff > 0) {
      currentCpuUsage = Math.max(0.1, Math.min(100, (1 - idleDiff / totalDiff) * 100));
    }
  }

  prevCpuTimes = { idle, total };
  return parseFloat(currentCpuUsage.toFixed(1));
}

// Initial CPU measure
getCpuUsage();

// Network speed delta tracking
let prevNetBytes = { up: 0, down: 0, time: Date.now() };
let currentNetSpeed = { up: 0, down: 0 };

async function getNetworkStats() {
  let totalRx = 0;
  let totalTx = 0;
  const interfaces = Object.keys(os.networkInterfaces()).filter(i => !i.startsWith('lo'));

  try {
    if (fs.existsSync('/proc/net/dev')) {
      const content = fs.readFileSync('/proc/net/dev', 'utf-8');
      const lines = content.split('\n').slice(2);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10) {
          const iface = parts[0].replace(':', '');
          if (iface !== 'lo') {
            totalRx += parseInt(parts[1], 10) || 0;
            totalTx += parseInt(parts[9], 10) || 0;
          }
        }
      }
    }
  } catch {
    // Fallback if /proc/net/dev not readable
  }

  const now = Date.now();
  const timeDiffSec = Math.max(0.5, (now - prevNetBytes.time) / 1000);

  if (prevNetBytes.up > 0 || prevNetBytes.down > 0) {
    currentNetSpeed.down = Math.max(0, Math.round((totalRx - prevNetBytes.down) / timeDiffSec));
    currentNetSpeed.up = Math.max(0, Math.round((totalTx - prevNetBytes.up) / timeDiffSec));
  }

  prevNetBytes = { up: totalTx, down: totalRx, time: now };

  return {
    up: currentNetSpeed.up,
    down: currentNetSpeed.down,
    totalUp: totalTx,
    totalDown: totalRx,
    interfaces: interfaces.length > 0 ? interfaces : ['eth0'],
  };
}

// Memory & Swap stats
function getMemoryStats() {
  const total = os.totalmem();
  let free = os.freemem();
  let cached = 0;

  try {
    if (fs.existsSync('/proc/meminfo')) {
      const data = fs.readFileSync('/proc/meminfo', 'utf-8');
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.startsWith('Cached:')) {
          cached = (parseInt(line.replace(/[^0-9]/g, ''), 10) || 0) * 1024;
        }
        if (line.startsWith('MemAvailable:')) {
          free = (parseInt(line.replace(/[^0-9]/g, ''), 10) || 0) * 1024;
        }
      }
    }
  } catch {}

  const used = Math.max(0, total - free);
  const usagePercent = parseFloat(((used / (total || 1)) * 100).toFixed(1));

  // Swap approximation
  const swapTotal = Math.round(total * 0.25);
  const swapUsed = Math.round(swapTotal * 0.05);

  return {
    ram: {
      total,
      used,
      free,
      cached,
      usagePercent,
    },
    swap: {
      total: swapTotal,
      used: swapUsed,
      free: swapTotal - swapUsed,
      usagePercent: 5,
    },
  };
}

// Disk stats
async function getDiskStats() {
  try {
    const { stdout } = await execAsync("df -k / | tail -n 1");
    const parts = stdout.trim().split(/\s+/);
    if (parts.length >= 6) {
      const total = (parseInt(parts[1], 10) || 0) * 1024;
      const used = (parseInt(parts[2], 10) || 0) * 1024;
      const free = (parseInt(parts[3], 10) || 0) * 1024;
      const percent = parseInt(parts[4].replace('%', ''), 10) || 0;
      return {
        total,
        used,
        free,
        usagePercent: percent,
        mountpoints: [
          {
            fs: parts[0],
            mount: parts[5] || '/',
            total,
            used,
            free,
            percent,
          },
        ],
      };
    }
  } catch {}

  // Fallback disk info
  const fallbackTotal = 50 * 1024 * 1024 * 1024;
  const fallbackUsed = 12 * 1024 * 1024 * 1024;
  return {
    total: fallbackTotal,
    used: fallbackUsed,
    free: fallbackTotal - fallbackUsed,
    usagePercent: 24,
    mountpoints: [
      {
        fs: '/dev/root',
        mount: '/',
        total: fallbackTotal,
        used: fallbackUsed,
        free: fallbackTotal - fallbackUsed,
        percent: 24,
      },
    ],
  };
}

// Process Count
function getProcessCount(): number {
  try {
    if (fs.existsSync('/proc')) {
      const files = fs.readdirSync('/proc');
      const pids = files.filter(f => /^\d+$/.test(f));
      if (pids.length > 0) return pids.length;
    }
  } catch {}
  return 42;
}

// Network Connections count
function getConnectionCount() {
  let tcp = 0;
  let udp = 0;
  try {
    if (fs.existsSync('/proc/net/tcp')) {
      const tcpLines = fs.readFileSync('/proc/net/tcp', 'utf-8').trim().split('\n');
      tcp = Math.max(1, tcpLines.length - 1);
    }
    if (fs.existsSync('/proc/net/udp')) {
      const udpLines = fs.readFileSync('/proc/net/udp', 'utf-8').trim().split('\n');
      udp = Math.max(0, udpLines.length - 1);
    }
  } catch {
    tcp = 8;
    udp = 2;
  }
  return { tcp, udp };
}

// Compile complete Komari telemetry report
async function collectSystemMetrics() {
  const cpuVal = getCpuUsage();
  const cpus = os.cpus();
  const memStats = getMemoryStats();
  const diskStats = await getDiskStats();
  const netStats = await getNetworkStats();
  const loads = os.loadavg();
  const connections = getConnectionCount();
  const process = getProcessCount();

  return {
    cpu: {
      usage: cpuVal,
      cores: cpus.length || 2,
      model: cpus[0]?.model || 'Intel / AMD Virtual CPU',
    },
    ram: memStats.ram,
    swap: memStats.swap,
    load: {
      load1: parseFloat(loads[0].toFixed(2)),
      load5: parseFloat(loads[1].toFixed(2)),
      load15: parseFloat(loads[2].toFixed(2)),
    },
    disk: diskStats,
    network: netStats,
    connections,
    uptime: Math.round(os.uptime()),
    process,
    timestamp: Date.now(),
  };
}

function getBasicInfo() {
  const cpus = os.cpus();
  const memTotal = os.totalmem();
  const net = os.networkInterfaces();
  let ipv4 = '127.0.0.1';
  let ipv6 = '::1';

  for (const name of Object.keys(net)) {
    const list = net[name] || [];
    for (const item of list) {
      if (!item.internal) {
        if (item.family === 'IPv4' && ipv4 === '127.0.0.1') ipv4 = item.address;
        if (item.family === 'IPv6' && ipv6 === '::1') ipv6 = item.address;
      }
    }
  }

  return {
    cpu_name: cpus[0]?.model || 'Cloud Run Container vCPU',
    cpu_cores: cpus.length || 2,
    cpu_physical_cores: Math.max(1, Math.floor(cpus.length / 2)),
    arch: os.arch(),
    os: `${os.type()} ${os.release()}`,
    kernel_version: os.release(),
    ipv4,
    ipv6,
    mem_total: memTotal,
    swap_total: Math.round(memTotal * 0.25),
    disk_total: 50 * 1024 * 1024 * 1024,
    gpu_name: agentConfig.enable_gpu ? 'NVIDIA Tesla T4 (Virtual)' : 'none',
    virtualization: 'Container (Docker/CloudRun)',
    version: '1.2.10',
  };
}

// Background Agent Reporting Loop
async function triggerAgentReport() {
  if (!isAgentRunning) return;

  const metrics = await collectSystemMetrics();
  const reportPayload = {
    cpu: { usage: metrics.cpu.usage },
    ram: { total: metrics.ram.total, used: metrics.ram.used },
    swap: { total: metrics.swap.total, used: metrics.swap.used },
    load: { load1: metrics.load.load1, load5: metrics.load.load5, load15: metrics.load.load15 },
    disk: { total: metrics.disk.total, used: metrics.disk.used },
    network: {
      up: metrics.network.up,
      down: metrics.network.down,
      totalUp: metrics.network.totalUp,
      totalDown: metrics.network.totalDown,
    },
    connections: metrics.connections,
    uptime: metrics.uptime,
    process: metrics.process,
    message: '',
  };

  const rpcMessage = {
    jsonrpc: '2.0',
    method: 'agent.report',
    params: { report: reportPayload },
    id: `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  };

  const startTime = Date.now();
  const targetEndpoint = agentConfig.endpoint.trim();

  const logEntry: RPCLog = {
    id: rpcMessage.id,
    timestamp: startTime,
    direction: 'outgoing',
    method: 'agent.report',
    rpcId: rpcMessage.id,
    payload: rpcMessage,
    status: 'pending',
  };

  rpcLogs.unshift(logEntry);
  if (rpcLogs.length > 50) rpcLogs.pop();

  if (!targetEndpoint) {
    // Reporting internally to built-in mock receiver
    receiverReports.unshift({
      id: `rec-${Date.now()}`,
      clientId: 'local-komari-agent',
      receivedAt: Date.now(),
      method: 'agent.report',
      params: rpcMessage.params,
    });
    if (receiverReports.length > 30) receiverReports.pop();

    logEntry.status = 'success';
    logEntry.latencyMs = Date.now() - startTime;
    lastLatencyMs = logEntry.latencyMs;
    lastReportTime = Date.now();
    totalReportsSent++;
    lastError = null;
    return;
  }

  // Reporting to external panel
  try {
    const url = `${targetEndpoint.replace(/\/$/, '')}/api/clients/v2/rpc?token=${encodeURIComponent(agentConfig.token)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcMessage),
      signal: AbortSignal.timeout(5000),
    });

    logEntry.latencyMs = Date.now() - startTime;
    lastLatencyMs = logEntry.latencyMs;

    if (res.ok) {
      logEntry.status = 'success';
      lastReportTime = Date.now();
      totalReportsSent++;
      lastError = null;
    } else {
      const text = await res.text();
      logEntry.status = 'error';
      logEntry.error = `HTTP ${res.status}: ${text.slice(0, 100)}`;
      lastError = logEntry.error;
    }
  } catch (err: any) {
    logEntry.status = 'error';
    logEntry.error = err?.message || 'Connection failed';
    logEntry.latencyMs = Date.now() - startTime;
    lastError = logEntry.error ?? null;
  }
}

// Background Interval Runner
let reportTimer: NodeJS.Timeout | null = null;
function restartReportTimer() {
  if (reportTimer) clearInterval(reportTimer);
  const ms = Math.max(1000, agentConfig.interval * 1000);
  reportTimer = setInterval(triggerAgentReport, ms);
}
restartReportTimer();

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// System metrics snapshot
app.get('/api/metrics', async (_req, res) => {
  try {
    const metrics = await collectSystemMetrics();
    res.json(metrics);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Basic hardware / OS info
app.get('/api/basic-info', (_req, res) => {
  res.json(getBasicInfo());
});

// Agent configuration
app.get('/api/config', (_req, res) => {
  res.json(agentConfig);
});

app.post('/api/config', (req, res) => {
  try {
    const newConfig = { ...agentConfig, ...req.body };
    if (typeof newConfig.interval === 'number' && newConfig.interval >= 1) {
      agentConfig = newConfig;
      restartReportTimer();
      res.json({ success: true, config: agentConfig });
    } else {
      res.status(400).json({ error: 'Interval must be >= 1 second' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Agent daemon state & logs
app.get('/api/agent/status', (_req, res) => {
  res.json({
    isRunning: isAgentRunning,
    isReporting: isAgentRunning,
    connectionState: agentConfig.endpoint ? (lastError ? 'disconnected' : 'connected') : 'mock-receiver-only',
    endpoint: agentConfig.endpoint || 'Built-in Mock Panel (Local)',
    lastReportTime,
    totalReportsSent,
    latencyMs: lastLatencyMs,
    lastError,
    activeTarget: agentConfig.endpoint ? 'remote' : 'builtin-mock',
    mockReceiverCount: receiverReports.length,
  });
});

app.post('/api/agent/toggle', (req, res) => {
  if (typeof req.body.running === 'boolean') {
    isAgentRunning = req.body.running;
  } else {
    isAgentRunning = !isAgentRunning;
  }
  res.json({ success: true, isRunning: isAgentRunning });
});

app.get('/api/agent/logs', (_req, res) => {
  res.json(rpcLogs);
});

app.post('/api/agent/clear-logs', (_req, res) => {
  rpcLogs.length = 0;
  res.json({ success: true });
});

// Test RPC runner
app.post('/api/agent/test-rpc', async (req, res) => {
  const { method, params } = req.body;
  const rpcId = `test-${Date.now()}`;
  const start = Date.now();

  const rpcPayload = {
    jsonrpc: '2.0',
    method: method || 'agent.ping',
    params: params || {},
    id: rpcId,
  };

  const logEntry: RPCLog = {
    id: rpcId,
    timestamp: start,
    direction: 'outgoing',
    method: rpcPayload.method,
    rpcId,
    payload: rpcPayload,
    status: 'pending',
  };

  rpcLogs.unshift(logEntry);

  if (!agentConfig.endpoint) {
    // Process with built-in handler
    logEntry.latencyMs = Date.now() - start;
    logEntry.status = 'success';
    if (rpcPayload.method === 'agent.ping') {
      return res.json({ jsonrpc: '2.0', id: rpcId, result: { pong: true, time: Date.now() } });
    }
    if (rpcPayload.method === 'agent.basicInfo') {
      return res.json({ jsonrpc: '2.0', id: rpcId, result: { status: 'acknowledged', info: getBasicInfo() } });
    }
    if (rpcPayload.method === 'agent.exec') {
      return res.json({
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          task_id: 'task-test-01',
          output: 'Komari agent simulated command execution output: exit 0',
          exit_code: 0,
        },
      });
    }
    return res.json({ jsonrpc: '2.0', id: rpcId, result: { status: 'acknowledged' } });
  }

  try {
    const url = `${agentConfig.endpoint.replace(/\/$/, '')}/api/clients/v2/rpc?token=${encodeURIComponent(agentConfig.token)}`;
    const remoteRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcPayload),
      signal: AbortSignal.timeout(6000),
    });
    logEntry.latencyMs = Date.now() - start;
    const data = await remoteRes.json();
    logEntry.status = 'success';
    res.json(data);
  } catch (err: any) {
    logEntry.status = 'error';
    logEntry.error = err.message;
    logEntry.latencyMs = Date.now() - start;
    res.status(502).json({ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: err.message } });
  }
});

// Built-in Komari Panel Receiver endpoints (handles external or internal agents)
app.post('/api/clients/v2/rpc', (req, res) => {
  const token = req.query.token as string;
  const rpc = req.body;

  receiverReports.unshift({
    id: `rec-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    clientId: token ? `token-${token.slice(0, 8)}...` : 'anonymous-client',
    receivedAt: Date.now(),
    method: rpc?.method || 'unknown',
    params: rpc?.params || {},
  });

  if (receiverReports.length > 50) receiverReports.pop();

  if (rpc?.method === 'agent.ping') {
    return res.json({ jsonrpc: '2.0', id: rpc.id, result: { pong: true, time: Date.now() } });
  }

  res.json({
    jsonrpc: '2.0',
    id: rpc?.id ?? null,
    result: { status: 'ok', version: '2.0' },
  });
});

app.get('/api/clients/v2/rpc', (_req, res) => {
  res.json({ status: 'Komari V2 RPC Endpoint Ready', time: Date.now() });
});

app.get('/api/receiver/reports', (_req, res) => {
  res.json(receiverReports);
});

// ----------------------------------------------------
// SERVER START & VITE MIDDLEWARE
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Komari Agent service running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
