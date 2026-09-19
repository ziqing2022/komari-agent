import express from 'express';
import cors from 'cors';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const AGENT_VERSION = '1.2.10';
const PROTOCOL_VERSION = '2.0';

// 1. Rename process title so in 'top', 'htop', and 'ps', it displays as clean 'komari-agent'
// instead of exposing full Node invocation arguments or token flags.
try {
  process.title = 'komari-agent';
} catch (e) {
  // Ignored in sandbox
}

// In-memory agent configuration with config.json and environment overrides
interface AgentConfigState {
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

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config.json');

function loadConfigFile(): Partial<AgentConfigState> {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Config] Failed to read config.json:', err);
  }
  return {};
}

function saveConfigFile(cfg: AgentConfigState) {
  try {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[Config] Failed to write config.json:', err);
  }
}

// Mask sensitive token for safe display in top/ps/logs
function maskToken(t?: string): string {
  if (!t) return '';
  if (t.length <= 8) return '****';
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

function sanitizePayload(obj: any): any {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return obj.replace(/token=([^&\s]+)/gi, 'token=****');
  }
  if (typeof obj === 'object') {
    const copy = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const key of Object.keys(copy)) {
      if (/token|password|secret|auth/i.test(key) && typeof copy[key] === 'string') {
        copy[key] = maskToken(copy[key]);
      } else if (typeof copy[key] === 'object') {
        copy[key] = sanitizePayload(copy[key]);
      }
    }
    return copy;
  }
  return obj;
}

// Suppress login MOTD message
function suppressServerMotd(): { success: boolean; message: string; method: string } {
  try {
    const homedir = os.homedir();
    const hushloginPath = path.join(homedir, '.hushlogin');
    if (!fs.existsSync(hushloginPath)) {
      fs.writeFileSync(hushloginPath, '');
    }
    return {
      success: true,
      message: `Successfully created ~/.hushlogin at ${hushloginPath}. SSH/terminal logins will now suppress all MOTD prompts and welcome messages.`,
      method: '~/.hushlogin',
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to create ~/.hushlogin: ${err.message}`,
      method: 'manual',
    };
  }
}

const fileCfg = loadConfigFile();

const config: AgentConfigState = {
  endpoint: fileCfg.endpoint || process.env.AGENT_ENDPOINT || 'http://localhost:3000',
  token: fileCfg.token || process.env.AGENT_TOKEN || 'komari-demo-token-1234',
  interval: fileCfg.interval ?? (Number(process.env.AGENT_INTERVAL) || 3),
  disableAutoUpdate: fileCfg.disableAutoUpdate ?? (process.env.AGENT_DISABLE_AUTO_UPDATE === 'true'),
  disableWebSsh: fileCfg.disableWebSsh ?? (process.env.AGENT_DISABLE_WEB_SSH === 'true'),
  ignoreUnsafeCert: fileCfg.ignoreUnsafeCert ?? (process.env.AGENT_IGNORE_UNSAFE_CERT === 'true'),
  includeNics: fileCfg.includeNics ?? (process.env.AGENT_INCLUDE_NICS || ''),
  excludeNics: fileCfg.excludeNics ?? (process.env.AGENT_EXCLUDE_NICS || ''),
  customDns: fileCfg.customDns ?? (process.env.AGENT_CUSTOM_DNS || ''),
  enableGpu: fileCfg.enableGpu ?? (process.env.AGENT_ENABLE_GPU === 'true'),
  disableCompression: fileCfg.disableCompression ?? (process.env.AGENT_DISABLE_COMPRESSION === 'true'),
  preferIpVersion: fileCfg.preferIpVersion ?? ((process.env.AGENT_PREFER_IP_VERSION as any) || 'auto'),
  autoDiscoveryKey: fileCfg.autoDiscoveryKey ?? (process.env.AGENT_AUTO_DISCOVERY_KEY || ''),
  disableMotd: fileCfg.disableMotd ?? true,
  useConfigFile: fileCfg.useConfigFile ?? true,
};

// If disableMotd is configured, create ~/.hushlogin right away
if (config.disableMotd) {
  suppressServerMotd();
}

// Agent state & logs
let isAgentRunning = true;
let agentStartTime = Date.now();
let reportCount = 0;
let lastReportTime: string | null = null;
let lastReportStatus: 'success' | 'failed' | 'idle' = 'idle';
let lastError: string | null = null;
let pendingAckIds: string[] = [];

interface AgentLogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'report' | 'error' | 'event' | 'ping';
  message: string;
  payload?: any;
}

const agentLogs: AgentLogEntry[] = [];
const MAX_LOGS = 100;

function addLog(type: AgentLogEntry['type'], message: string, payload?: any) {
  // Never expose token parameter in plaintext in logs or top output
  const sanitizedMessage = message.replace(/token=([^&\s]+)/gi, 'token=****');
  const entry: AgentLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    type,
    message: sanitizedMessage,
    payload: sanitizePayload(payload),
  };
  agentLogs.unshift(entry);
  if (agentLogs.length > MAX_LOGS) {
    agentLogs.pop();
  }
}

// Mock Server state (built-in receiver)
interface MockReceivedItem {
  id: string;
  receivedAt: string;
  token: string;
  type: 'report' | 'basicInfo' | 'pingResult' | 'pull';
  payload: any;
}

const mockReceivedReports: MockReceivedItem[] = [];
const mockServerEventsQueue: any[] = [];

// CPU tracking variables
let lastCpuMeasure = getCpuTimes();

function getCpuTimes() {
  const cpus = os.cpus();
  let user = 0;
  let nice = 0;
  let sys = 0;
  let idle = 0;
  let irq = 0;
  for (const cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  }
  const total = user + nice + sys + idle + irq;
  return { idle, total };
}

function calculateCpuUsage(): number {
  const current = getCpuTimes();
  const idleDiff = current.idle - lastCpuMeasure.idle;
  const totalDiff = current.total - lastCpuMeasure.total;
  lastCpuMeasure = current;
  if (totalDiff <= 0) return 1.5;
  const usage = Math.max(0.1, Math.min(100, (1 - idleDiff / totalDiff) * 100));
  return Math.round(usage * 100) / 100;
}

// Simulated Network counters
let simulatedNetTotalUp = 1024 * 1024 * 145; // ~145 MB
let simulatedNetTotalDown = 1024 * 1024 * 480; // ~480 MB

function getDiskStats() {
  try {
    const stat = fs.statfsSync('/');
    const total = stat.bsize * stat.blocks;
    const free = stat.bsize * stat.bfree;
    const used = total - free;
    return {
      total,
      used,
      free,
      percent: Math.round((used / total) * 100),
      mountPoint: '/',
    };
  } catch (err) {
    // Fallback if fs.statfsSync is not available
    const total = 50 * 1024 * 1024 * 1024; // 50 GB
    const used = 18 * 1024 * 1024 * 1024; // 18 GB
    return {
      total,
      used,
      free: total - used,
      percent: 36,
      mountPoint: '/',
    };
  }
}

function getSystemMetrics() {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Generic x86_64 Processor';
  const cpuUsage = calculateCpuUsage();

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Swap metrics
  const swapTotal = Math.floor(totalMem * 0.25);
  const swapUsed = Math.floor(swapTotal * 0.08);

  const disk = getDiskStats();
  const loadavg = os.loadavg();

  // Network delta calculation
  const deltaUp = Math.floor(Math.random() * 45000) + 5000;
  const deltaDown = Math.floor(Math.random() * 125000) + 12000;
  simulatedNetTotalUp += deltaUp;
  simulatedNetTotalDown += deltaDown;

  // IP addresses
  let ipv4 = '127.0.0.1';
  let ipv6 = '::1';
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name] || [];
    for (const net of list) {
      if (!net.internal) {
        if (net.family === 'IPv4' && ipv4 === '127.0.0.1') {
          ipv4 = net.address;
        } else if (net.family === 'IPv6' && ipv6 === '::1') {
          ipv6 = net.address;
        }
      }
    }
  }

  return {
    cpu: {
      name: cpuModel,
      cores: cpus.length,
      physicalCores: Math.max(1, Math.floor(cpus.length / 2)),
      arch: os.arch(),
      usage: cpuUsage,
    },
    ram: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usagePercent: Math.round((usedMem / totalMem) * 100),
    },
    swap: {
      total: swapTotal,
      used: swapUsed,
      usagePercent: Math.round((swapUsed / swapTotal) * 100),
    },
    disk: {
      total: disk.total,
      used: disk.used,
      free: disk.free,
      usagePercent: disk.percent,
      mountPoint: disk.mountPoint,
    },
    load: {
      load1: Math.round(loadavg[0] * 100) / 100,
      load5: Math.round(loadavg[1] * 100) / 100,
      load15: Math.round(loadavg[2] * 100) / 100,
    },
    network: {
      up: deltaUp,
      down: deltaDown,
      totalUp: simulatedNetTotalUp,
      totalDown: simulatedNetTotalDown,
    },
    connections: {
      tcp: Math.floor(Math.random() * 20) + 15,
      udp: Math.floor(Math.random() * 6) + 2,
    },
    processCount: 84 + Math.floor(Math.random() * 12),
    uptime: Math.floor(os.uptime()),
    osInfo: {
      platform: os.platform(),
      distro: 'Linux (Cloud Container)',
      release: os.release(),
      arch: os.arch(),
      kernel: os.version ? os.version() : os.release(),
      hostname: os.hostname(),
      ipv4,
      ipv6,
      virtualization: 'docker / container',
    },
  };
}

// Generate Komari v2 JSON-RPC payload
function generateKomariReportPayload(metrics: ReturnType<typeof getSystemMetrics>) {
  return {
    cpu: {
      name: metrics.cpu.name,
      cores: metrics.cpu.cores,
      arch: metrics.cpu.arch,
      usage: metrics.cpu.usage,
    },
    ram: {
      total: metrics.ram.total,
      used: metrics.ram.used,
    },
    swap: {
      total: metrics.swap.total,
      used: metrics.swap.used,
    },
    load: {
      load1: metrics.load.load1,
      load5: metrics.load.load5,
      load15: metrics.load.load15,
    },
    disk: {
      total: metrics.disk.total,
      used: metrics.disk.used,
    },
    network: {
      up: metrics.network.up,
      down: metrics.network.down,
      totalUp: metrics.network.totalUp,
      totalDown: metrics.network.totalDown,
    },
    connections: {
      tcp: metrics.connections.tcp,
      udp: metrics.connections.udp,
    },
    uptime: metrics.uptime,
    process: metrics.processCount,
    message: 'komari-agent-node/1.2.10',
  };
}

// Agent Core Execution Loop
async function sendRpcRequest(method: string, params: any, requestId: string) {
  const payload = {
    jsonrpc: PROTOCOL_VERSION,
    method,
    params,
    id: requestId,
  };

  const endpointUrl = `${config.endpoint.replace(/\/$/, '')}/api/clients/v2/rpc?token=${encodeURIComponent(config.token)}`;

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(`RPC Error [${result.error.code}]: ${result.error.message}`);
  }

  // Handle server events returned in result
  const events = result.result?.events || [];
  if (Array.isArray(events) && events.length > 0) {
    handleServerEvents(events);
  }

  return result;
}

function handleServerEvents(events: any[]) {
  for (const event of events) {
    const eventId = event.id || '';
    const method = event.method;
    addLog('event', `Received server event: ${method}`, event);

    if (method === 'agent.ping') {
      const taskId = event.params?.ping_task_id;
      if (taskId) {
        addLog('ping', `Processing ICMP/Ping task #${taskId}`, event.params);
        // Simulate ping latency between 8ms and 45ms
        const pingLatency = Math.floor(Math.random() * 37) + 8;
        setTimeout(async () => {
          try {
            await sendRpcRequest(
              'agent.pingResult',
              {
                task_id: taskId,
                ping_type: event.params?.ping_type || 'icmp',
                value: pingLatency,
                finished_at: new Date().toISOString(),
              },
              `ping-res-${taskId}-${Date.now()}`
            );
            addLog('ping', `Sent ping response for task #${taskId}: ${pingLatency}ms`);
            if (eventId) {
              pendingAckIds.push(eventId);
            }
          } catch (err: any) {
            addLog('error', `Failed to report ping result: ${err.message}`);
          }
        }, 100);
      }
    } else {
      addLog('info', `Server event ${method} acknowledged`);
      if (eventId) {
        pendingAckIds.push(eventId);
      }
    }
  }
}

async function uploadBasicInfo() {
  const metrics = getSystemMetrics();
  const info = {
    cpu_name: metrics.cpu.name,
    cpu_cores: metrics.cpu.cores,
    cpu_physical_cores: metrics.cpu.physicalCores,
    arch: metrics.cpu.arch,
    os: metrics.osInfo.distro,
    kernel_version: metrics.osInfo.kernel,
    ipv4: metrics.osInfo.ipv4,
    ipv6: metrics.osInfo.ipv6,
    mem_total: metrics.ram.total,
    swap_total: metrics.swap.total,
    disk_total: metrics.disk.total,
    gpu_name: config.enableGpu ? 'NVIDIA GeForce RTX 4090 (Emulated)' : '',
    virtualization: metrics.osInfo.virtualization,
    version: AGENT_VERSION,
  };

  try {
    await sendRpcRequest('agent.basicInfo', { info }, `basic-info-${Date.now()}`);
    addLog('info', 'Hardware and basic system info uploaded successfully', info);
  } catch (err: any) {
    addLog('error', `Failed to upload basic info: ${err.message}`);
    throw err;
  }
}

async function uploadReport() {
  const metrics = getSystemMetrics();
  const reportPayload = generateKomariReportPayload(metrics);
  const acks = [...pendingAckIds];
  pendingAckIds = [];

  try {
    await sendRpcRequest(
      'agent.report',
      {
        report: reportPayload,
        ack_event_ids: acks,
      },
      `report-${Date.now()}`
    );
    reportCount++;
    lastReportTime = new Date().toISOString();
    lastReportStatus = 'success';
    lastError = null;
    addLog('report', `Metrics report #${reportCount} sent successfully (${metrics.cpu.usage}% CPU, ${metrics.ram.usagePercent}% RAM)`);
  } catch (err: any) {
    lastReportStatus = 'failed';
    lastError = err.message;
    addLog('error', `Metric reporting failed: ${err.message}`);
  }
}

// Agent background timer runner
let reportTimer: NodeJS.Timeout | null = null;
let basicInfoTimer: NodeJS.Timeout | null = null;

function startAgentLoop() {
  if (reportTimer) clearInterval(reportTimer);
  if (basicInfoTimer) clearInterval(basicInfoTimer);

  isAgentRunning = true;
  addLog('info', `Komari Agent started (Interval: ${config.interval}s, Target: ${config.endpoint})`);

  // Initial basic info upload
  uploadBasicInfo().catch(() => {});

  // Report timer
  reportTimer = setInterval(() => {
    if (isAgentRunning) {
      uploadReport().catch(() => {});
    }
  }, Math.max(1, config.interval) * 1000);

  // Periodic Basic info timer (every 5 minutes)
  basicInfoTimer = setInterval(() => {
    if (isAgentRunning) {
      uploadBasicInfo().catch(() => {});
    }
  }, 5 * 60 * 1000);
}

function stopAgentLoop() {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  if (basicInfoTimer) {
    clearInterval(basicInfoTimer);
    basicInfoTimer = null;
  }
  isAgentRunning = false;
  addLog('info', 'Komari Agent paused by user');
}

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // -------------------------------------------------------------
  // 1. Built-in Komari v2 Receiver / Mock Server Endpoints
  // -------------------------------------------------------------
  app.post('/api/clients/v2/rpc', (req, res) => {
    const token = (req.query.token as string) || req.headers.authorization || '';
    const body = req.body || {};
    const method = body.method;
    const params = body.params || {};
    const requestId = body.id || null;

    let receivedType: MockReceivedItem['type'] = 'report';
    if (method === 'agent.basicInfo') receivedType = 'basicInfo';
    else if (method === 'agent.pingResult') receivedType = 'pingResult';
    else if (method === 'agent.pull') receivedType = 'pull';

    // Store in mock received reports (mask token and credentials)
    mockReceivedReports.unshift({
      id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      receivedAt: new Date().toISOString(),
      token: maskToken(String(token)),
      type: receivedType,
      payload: sanitizePayload(params),
    });
    if (mockReceivedReports.length > 50) {
      mockReceivedReports.pop();
    }

    // Check if there are events to return to the agent
    const eventsToSend = [...mockServerEventsQueue];
    mockServerEventsQueue.length = 0; // drain queue

    return res.json({
      jsonrpc: PROTOCOL_VERSION,
      id: requestId,
      result: {
        status: 'ok',
        events: eventsToSend,
      },
    });
  });

  // Client registration endpoint (auto-discovery)
  app.post('/api/clients/register', (req, res) => {
    const clientName = (req.query.name as string) || 'komari-agent-client';
    const authHeader = req.headers.authorization || '';
    const newUuid = `client-${Math.random().toString(36).substring(2, 10)}`;
    const newToken = `token-${Math.random().toString(36).substring(2, 16)}`;

    addLog('info', `Auto-discovery registered client "${clientName}" (UUID: ${newUuid})`);

    return res.json({
      status: 'success',
      data: {
        uuid: newUuid,
        token: newToken,
        name: clientName,
      },
    });
  });

  // -------------------------------------------------------------
  // 2. Mock Server Control Endpoints
  // -------------------------------------------------------------
  app.get('/api/mock/received-reports', (req, res) => {
    res.json({
      reports: mockReceivedReports,
      pendingEventsCount: mockServerEventsQueue.length,
    });
  });

  app.post('/api/mock/send-ping-task', (req, res) => {
    const taskId = Math.floor(Math.random() * 90000) + 10000;
    const pingType = req.body?.pingType || 'icmp';
    const event = {
      id: `evt-ping-${taskId}`,
      method: 'agent.ping',
      params: {
        ping_task_id: taskId,
        ping_type: pingType,
      },
    };
    mockServerEventsQueue.push(event);
    addLog('info', `Mock server queued ping task #${taskId} for agent`);
    res.json({ success: true, taskId, event });
  });

  app.post('/api/mock/clear-reports', (req, res) => {
    mockReceivedReports.length = 0;
    res.json({ success: true });
  });

  // -------------------------------------------------------------
  // 3. Agent Management REST Endpoints
  // -------------------------------------------------------------
  app.get(['/api/agent/status', '/api/agent/state'], (req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - agentStartTime) / 1000);
    res.json({
      running: isAgentRunning,
      connected: lastReportStatus === 'success',
      uptimeSeconds,
      reportCount,
      lastReportTime,
      lastReportStatus,
      lastError,
      activeEndpoint: config.endpoint,
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  app.get('/api/agent/config', (req, res) => {
    res.json(config);
  });

  app.post('/api/agent/config', (req, res) => {
    const body = req.body;
    if (typeof body.endpoint === 'string' && body.endpoint.trim()) {
      config.endpoint = body.endpoint.trim();
    }
    if (typeof body.token === 'string') {
      config.token = body.token.trim();
    }
    if (typeof body.interval === 'number' && body.interval >= 1) {
      config.interval = body.interval;
    }
    if (typeof body.disableAutoUpdate === 'boolean') config.disableAutoUpdate = body.disableAutoUpdate;
    if (typeof body.disableWebSsh === 'boolean') config.disableWebSsh = body.disableWebSsh;
    if (typeof body.ignoreUnsafeCert === 'boolean') config.ignoreUnsafeCert = body.ignoreUnsafeCert;
    if (typeof body.enableGpu === 'boolean') config.enableGpu = body.enableGpu;
    if (typeof body.disableCompression === 'boolean') config.disableCompression = body.disableCompression;
    if (body.preferIpVersion) config.preferIpVersion = body.preferIpVersion;
    if (body.customDns !== undefined) config.customDns = body.customDns;
    if (body.includeNics !== undefined) config.includeNics = body.includeNics;
    if (body.excludeNics !== undefined) config.excludeNics = body.excludeNics;
    if (body.autoDiscoveryKey !== undefined) config.autoDiscoveryKey = body.autoDiscoveryKey;
    if (typeof body.disableMotd === 'boolean') {
      config.disableMotd = body.disableMotd;
      if (config.disableMotd) {
        suppressServerMotd();
      }
    }
    if (typeof body.useConfigFile === 'boolean') config.useConfigFile = body.useConfigFile;

    // Automatically persist to config.json so agent can run without CLI arguments (preventing top/ps leakage)
    saveConfigFile(config);

    addLog('info', 'Agent configuration updated and saved to config.json (top/ps parameters masked)', {
      endpoint: config.endpoint,
      token: maskToken(config.token),
      interval: config.interval,
      disableMotd: config.disableMotd,
    });

    // Restart timer if running to apply interval
    if (isAgentRunning) {
      startAgentLoop();
    }

    res.json({ success: true, config });
  });

  // Suppress server login MOTD endpoint
  app.post('/api/agent/suppress-motd', (req, res) => {
    const result = suppressServerMotd();
    config.disableMotd = true;
    saveConfigFile(config);
    addLog('info', 'Server MOTD suppression applied (~/.hushlogin)');
    res.json({
      success: result.success,
      message: result.message,
      commands: [
        '# 1. Disable user-level MOTD banner upon SSH login:',
        'touch ~/.hushlogin',
        '',
        '# 2. (Optional) Disable system-level dynamic MOTD scripts (Debian/Ubuntu):',
        'sudo chmod -x /etc/update-motd.d/* 2>/dev/null || true',
        'sudo truncate -s 0 /etc/motd 2>/dev/null || true',
        '',
        '# 3. (Optional) In /etc/ssh/sshd_config, ensure:',
        '# PrintMotd no',
        '# PrintLastLog no',
      ],
    });
  });

  // Generate zero-argument systemd service template
  app.get('/api/agent/systemd-service', (req, res) => {
    const cwd = process.cwd();
    const serviceContent = `[Unit]
Description=Komari Agent Service (No-Arg Clean Process)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
# User=root
WorkingDirectory=${cwd}
# Starts without passing sensitive flags (--token / --endpoint), loading directly from config.json
ExecStart=/usr/bin/node ${cwd}/dist/server.cjs
Restart=always
RestartSec=5
KillMode=process
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`;
    res.json({
      serviceFile: serviceContent,
      installInstructions: [
        '1. Save the configuration to config.json using the dashboard button.',
        '2. Write this service file to /etc/systemd/system/komari-agent.service:',
        `   sudo tee /etc/systemd/system/komari-agent.service << 'EOF'\n${serviceContent}EOF`,
        '3. Reload systemd and enable service:',
        '   sudo systemctl daemon-reload',
        '   sudo systemctl enable --now komari-agent',
        '4. Verification: Run "ps aux | grep komari-agent" or "top". Notice no sensitive URL or token parameters are exposed!',
      ],
    });
  });

  app.post('/api/agent/start', (req, res) => {
    startAgentLoop();
    res.json({ success: true, running: true });
  });

  app.post('/api/agent/stop', (req, res) => {
    stopAgentLoop();
    res.json({ success: true, running: false });
  });

  app.get('/api/agent/metrics', (req, res) => {
    res.json(getSystemMetrics());
  });

  app.post('/api/agent/trigger-report', async (req, res) => {
    try {
      await uploadReport();
      res.json({ success: true, message: 'Report triggered successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/agent/trigger-basic-info', async (req, res) => {
    try {
      await uploadBasicInfo();
      res.json({ success: true, message: 'Basic info uploaded successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/agent/logs', (req, res) => {
    res.json({ logs: agentLogs });
  });

  app.post('/api/agent/clear-logs', (req, res) => {
    agentLogs.length = 0;
    res.json({ success: true });
  });

  app.post('/api/agent/register-autodiscovery', async (req, res) => {
    const { server, adkey, name } = req.body;
    const targetServer = (server || config.endpoint).replace(/\/$/, '');
    const clientName = name || `agent-${os.hostname()}`;

    try {
      const response = await fetch(`${targetServer}/api/clients/register?name=${encodeURIComponent(clientName)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adkey || config.autoDiscoveryKey || 'demo-adkey'}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error(`Registration HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      if (data.status === 'success' && data.data?.token) {
        config.token = data.data.token;
        config.endpoint = targetServer;
        addLog('info', `Agent registered via Auto-Discovery as "${clientName}". Updated token.`);
        res.json({ success: true, data: data.data });
      } else {
        throw new Error(`Registration failed: ${JSON.stringify(data)}`);
      }
    } catch (err: any) {
      addLog('error', `Auto-discovery registration failed: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 4. Vite Middleware (Dev) vs Static Files (Prod)
  // -------------------------------------------------------------
  // Explicit 404 JSON response for any unhandled /api/* routes so they never fall through to HTML fallback
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found', path: req.path });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Start background agent loop after initialization
  setTimeout(() => {
    startAgentLoop();
  }, 1000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Komari Agent] Service running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
