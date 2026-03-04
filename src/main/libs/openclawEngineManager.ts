import { app, utilityProcess, type UtilityProcess } from 'electron';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import path from 'path';

const DEFAULT_OPENCLAW_VERSION = '2026.2.23';
const DEFAULT_GATEWAY_PORT = 18789;
const GATEWAY_PORT_SCAN_LIMIT = 80;
const GATEWAY_BOOT_TIMEOUT_MS = 30 * 1000;
const GATEWAY_RESTART_DELAY_MS = 3000;

export type OpenClawEnginePhase =
  | 'not_installed'
  | 'installing'
  | 'ready'
  | 'starting'
  | 'running'
  | 'error';

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
}

export interface OpenClawGatewayConnectionInfo {
  version: string | null;
  port: number | null;
  token: string | null;
  url: string | null;
  clientEntryPath: string | null;
}

interface OpenClawEngineManagerEvents {
  status: (status: OpenClawEngineStatus) => void;
}

type RuntimeMetadata = {
  root: string | null;
  version: string | null;
  expectedPathHint: string;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const parseJsonFile = <T>(filePath: string): T | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const findPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const isPortAvailable = async (port: number): Promise<boolean> => {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
};

const isPortReachable = (host: string, port: number, timeoutMs = 1200): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
};

const isUtilityProcessAlive = (child: UtilityProcess | null): child is UtilityProcess => {
  return Boolean(child && typeof child.pid === 'number');
};

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }
};

export class OpenClawEngineManager extends EventEmitter {
  private readonly baseDir: string;
  private readonly logsDir: string;
  private readonly stateDir: string;
  private readonly gatewayTokenPath: string;
  private readonly gatewayPortPath: string;
  private readonly gatewayLogPath: string;
  private readonly configPath: string;

  private desiredVersion: string;
  private status: OpenClawEngineStatus;
  private gatewayProcess: UtilityProcess | null = null;
  private readonly expectedGatewayExits = new WeakSet<UtilityProcess>();
  private gatewayRestartTimer: NodeJS.Timeout | null = null;
  private shutdownRequested = false;
  private gatewayPort: number | null = null;

  constructor() {
    super();

    const userDataPath = app.getPath('userData');
    this.baseDir = path.join(userDataPath, 'openclaw');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.stateDir = path.join(this.baseDir, 'state');

    this.gatewayTokenPath = path.join(this.stateDir, 'gateway-token');
    this.gatewayPortPath = path.join(this.stateDir, 'gateway-port.json');
    this.gatewayLogPath = path.join(this.logsDir, 'gateway.log');
    this.configPath = path.join(this.stateDir, 'openclaw.json');

    ensureDir(this.baseDir);
    ensureDir(this.logsDir);
    ensureDir(this.stateDir);

    const runtime = this.resolveRuntimeMetadata();
    this.desiredVersion = runtime.version || DEFAULT_OPENCLAW_VERSION;

    this.status = runtime.root
      ? {
          phase: 'ready',
          version: this.desiredVersion,
          message: 'OpenClaw runtime is ready.',
          canRetry: false,
        }
      : {
          phase: 'not_installed',
          version: null,
          message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
          canRetry: true,
        };
  }

  override on<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    listener: OpenClawEngineManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override emit<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    ...args: Parameters<OpenClawEngineManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): OpenClawEngineStatus {
    return { ...this.status };
  }

  setExternalError(message: string): OpenClawEngineStatus {
    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: 'error',
      version: runtime.version || this.status.version || null,
      message: message.slice(0, 500),
      canRetry: true,
    });
    return this.getStatus();
  }

  getDesiredVersion(): string {
    return this.desiredVersion;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getGatewayConnectionInfo(): OpenClawGatewayConnectionInfo {
    const runtime = this.resolveRuntimeMetadata();
    const port = this.gatewayPort ?? this.readGatewayPort();
    const token = this.readGatewayToken();
    const clientEntryPath = runtime.root ? this.resolveGatewayClientEntry(runtime.root) : null;

    return {
      version: runtime.version,
      port,
      token,
      url: port ? `ws://127.0.0.1:${port}` : null,
      clientEntryPath,
    };
  }

  async ensureReady(_options: { forceReinstall?: boolean } = {}): Promise<OpenClawEngineStatus> {
    const runtime = this.resolveRuntimeMetadata();
    this.desiredVersion = runtime.version || DEFAULT_OPENCLAW_VERSION;

    if (!runtime.root) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    if (this.status.phase === 'running') {
      return this.getStatus();
    }

    this.setStatus({
      phase: 'ready',
      version: this.desiredVersion,
      message: 'OpenClaw runtime is ready.',
      canRetry: false,
    });
    return this.getStatus();
  }

  async startGateway(): Promise<OpenClawEngineStatus> {
    this.shutdownRequested = false;

    const ensured = await this.ensureReady();
    if (ensured.phase !== 'ready' && ensured.phase !== 'running') {
      return ensured;
    }

    if (isUtilityProcessAlive(this.gatewayProcess)) {
      const port = this.gatewayPort ?? this.readGatewayPort();
      if (port) {
        const healthy = await this.isGatewayHealthy(port);
        if (healthy) {
          if (this.status.phase !== 'running') {
            this.setStatus({
              phase: 'running',
              version: this.desiredVersion,
              message: `OpenClaw gateway is running on loopback:${port}.`,
              canRetry: false,
            });
          }
          return this.getStatus();
        }
      }

      this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    if (!runtime.root) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const openclawEntry = this.resolveOpenClawEntry(runtime.root);
    if (!openclawEntry) {
      this.setStatus({
        phase: 'error',
        version: runtime.version,
        message: `OpenClaw entry file is missing in runtime: ${runtime.root}.`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const token = this.ensureGatewayToken();
    const port = await this.resolveGatewayPort();
    this.gatewayPort = port;
    this.writeGatewayPort(port);
    this.ensureConfigFile();

    this.setStatus({
      phase: 'starting',
      version: runtime.version,
      progressPercent: 10,
      message: 'Starting OpenClaw gateway...',
      canRetry: false,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_HOME: runtime.root,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_ENGINE_VERSION: runtime.version || DEFAULT_OPENCLAW_VERSION,
    };

    const child = utilityProcess.fork(
      openclawEntry,
      ['gateway', '--bind', 'loopback', '--port', String(port), '--token', token],
      {
        cwd: runtime.root,
        env,
        stdio: 'pipe',
        serviceName: 'OpenClaw Gateway',
      },
    );

    this.gatewayProcess = child;
    this.attachGatewayProcessLogs(child);
    this.attachGatewayExitHandlers(child);

    const ready = await this.waitForGatewayReady(port, GATEWAY_BOOT_TIMEOUT_MS);
    if (!ready) {
      this.setStatus({
        phase: 'error',
        version: runtime.version,
        message: 'OpenClaw gateway failed to become healthy in time.',
        canRetry: true,
      });
      this.stopGatewayProcess(child);
      return this.getStatus();
    }

    this.setStatus({
      phase: 'running',
      version: runtime.version,
      progressPercent: 100,
      message: `OpenClaw gateway is running on loopback:${port}.`,
      canRetry: false,
    });

    return this.getStatus();
  }

  async stopGateway(): Promise<void> {
    this.shutdownRequested = true;

    if (this.gatewayRestartTimer) {
      clearTimeout(this.gatewayRestartTimer);
      this.gatewayRestartTimer = null;
    }

    if (this.gatewayProcess) {
      this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: runtime.root ? 'ready' : 'not_installed',
      version: runtime.version,
      message: runtime.root
        ? 'OpenClaw runtime is ready. Gateway is stopped.'
        : `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
      canRetry: !runtime.root,
    });
  }

  private resolveRuntimeMetadata(): RuntimeMetadata {
    const candidateRoots = app.isPackaged
      ? [path.join(process.resourcesPath, 'cfmind')]
      : [
          path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
          path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
        ];

    const runtimeRoot = findPath(candidateRoots);
    const expectedPathHint = app.isPackaged
      ? path.join(process.resourcesPath, 'cfmind')
      : path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current');

    if (!runtimeRoot) {
      return {
        root: null,
        version: null,
        expectedPathHint,
      };
    }

    return {
      root: runtimeRoot,
      version: this.readRuntimeVersion(runtimeRoot) || DEFAULT_OPENCLAW_VERSION,
      expectedPathHint,
    };
  }

  private readRuntimeVersion(runtimeRoot: string): string | null {
    const fromRootPackage = parseJsonFile<{ version?: string }>(path.join(runtimeRoot, 'package.json'))?.version;
    if (typeof fromRootPackage === 'string' && fromRootPackage.trim()) {
      return fromRootPackage.trim();
    }

    const fromOpenClawPackage = parseJsonFile<{ version?: string }>(
      path.join(runtimeRoot, 'node_modules', 'openclaw', 'package.json'),
    )?.version;
    if (typeof fromOpenClawPackage === 'string' && fromOpenClawPackage.trim()) {
      return fromOpenClawPackage.trim();
    }

    const fromBuildInfo = parseJsonFile<{ version?: string }>(path.join(runtimeRoot, 'runtime-build-info.json'))?.version;
    if (typeof fromBuildInfo === 'string' && fromBuildInfo.trim()) {
      return fromBuildInfo.trim();
    }

    return null;
  }

  private resolveOpenClawEntry(runtimeRoot: string): string | null {
    return findPath([
      path.join(runtimeRoot, 'gateway.asar', 'openclaw.mjs'),
      path.join(runtimeRoot, 'openclaw.mjs'),
      path.join(runtimeRoot, 'dist', 'entry.js'),
      path.join(runtimeRoot, 'dist', 'entry.mjs'),
    ]);
  }

  private resolveGatewayClientEntry(runtimeRoot: string): string | null {
    const distRoots = [
      path.join(runtimeRoot, 'gateway.asar', 'dist'),
      path.join(runtimeRoot, 'dist'),
    ];

    for (const distRoot of distRoots) {
      const clientEntry = this.findGatewayClientEntryFromDistRoot(distRoot);
      if (clientEntry) {
        return clientEntry;
      }
    }

    return null;
  }

  private findGatewayClientEntryFromDistRoot(distRoot: string): string | null {
    const gatewayClient = path.join(distRoot, 'gateway', 'client.js');
    if (fs.existsSync(gatewayClient)) {
      return gatewayClient;
    }

    const directClient = path.join(distRoot, 'client.js');
    if (fs.existsSync(directClient)) {
      return directClient;
    }

    try {
      if (!fs.existsSync(distRoot) || !fs.statSync(distRoot).isDirectory()) {
        return null;
      }

      const candidates = fs.readdirSync(distRoot)
        .filter((name) => /^client(?:-.*)?\.js$/i.test(name))
        .sort();
      if (candidates.length > 0) {
        return path.join(distRoot, candidates[0]);
      }
    } catch {
      // ignore
    }

    return null;
  }

  private ensureGatewayToken(): string {
    try {
      const existing = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      if (existing) {
        return existing;
      }
    } catch {
      // ignore
    }

    const token = crypto.randomBytes(24).toString('hex');
    ensureDir(path.dirname(this.gatewayTokenPath));
    fs.writeFileSync(this.gatewayTokenPath, token, 'utf8');
    return token;
  }

  private readGatewayToken(): string | null {
    try {
      const token = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  private ensureConfigFile(): void {
    ensureDir(path.dirname(this.configPath));
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, '{}\n', 'utf8');
    }
  }

  private writeGatewayPort(port: number): void {
    fs.writeFileSync(this.gatewayPortPath, JSON.stringify({ port, updatedAt: Date.now() }, null, 2), 'utf8');
  }

  private readGatewayPort(): number | null {
    const payload = parseJsonFile<{ port?: number }>(this.gatewayPortPath);
    if (!payload || typeof payload.port !== 'number' || !Number.isInteger(payload.port)) {
      return null;
    }
    if (payload.port <= 0 || payload.port > 65535) {
      return null;
    }
    return payload.port;
  }

  private async resolveGatewayPort(): Promise<number> {
    const candidates: number[] = [];

    if (this.gatewayPort) candidates.push(this.gatewayPort);
    const persisted = this.readGatewayPort();
    if (persisted) candidates.push(persisted);
    candidates.push(DEFAULT_GATEWAY_PORT);

    const uniqCandidates = Array.from(new Set(candidates));
    for (const candidate of uniqCandidates) {
      if (await isPortAvailable(candidate)) {
        return candidate;
      }
    }

    for (let offset = 1; offset <= GATEWAY_PORT_SCAN_LIMIT; offset += 1) {
      const candidate = DEFAULT_GATEWAY_PORT + offset;
      if (await isPortAvailable(candidate)) {
        return candidate;
      }
    }

    throw new Error('No available loopback port for OpenClaw gateway.');
  }

  private async isGatewayHealthy(port: number): Promise<boolean> {
    const probeUrls = [
      `http://127.0.0.1:${port}/health`,
      `http://127.0.0.1:${port}/healthz`,
      `http://127.0.0.1:${port}/ready`,
      `http://127.0.0.1:${port}/`,
    ];

    for (const url of probeUrls) {
      try {
        const response = await fetchWithTimeout(url, 1200);
        if (response.status < 500) {
          return true;
        }
      } catch {
        // try next probe URL
      }
    }

    return await isPortReachable('127.0.0.1', port, 1000);
  }

  private waitForGatewayReady(port: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const tick = async () => {
        if (this.shutdownRequested) {
          resolve(false);
          return;
        }

        if (!this.gatewayProcess) {
          resolve(false);
          return;
        }

        const healthy = await this.isGatewayHealthy(port);
        if (healthy) {
          resolve(true);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }

        setTimeout(() => {
          void tick();
        }, 600);
      };

      void tick();
    });
  }

  private stopGatewayProcess(child: UtilityProcess): void {
    this.expectedGatewayExits.add(child);

    try {
      child.kill();
    } catch {
      // ignore
    }

    setTimeout(() => {
      if (typeof child.pid === 'number') {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    }, 1200);
  }

  private attachGatewayProcessLogs(child: UtilityProcess): void {
    ensureDir(path.dirname(this.gatewayLogPath));
    const appendLog = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
      fs.appendFile(this.gatewayLogPath, line, () => {
        // best-effort log append
      });
    };

    child.stdout?.on('data', (chunk) => appendLog(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => appendLog(chunk, 'stderr'));
  }

  private attachGatewayExitHandlers(child: UtilityProcess): void {
    child.once('error', (type, location) => {
      if (this.expectedGatewayExits.has(child)) {
        this.expectedGatewayExits.delete(child);
        return;
      }
      if (this.shutdownRequested) return;
      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway process error: ${type}${location ? ` (${location})` : ''}`,
        canRetry: true,
      });
      this.scheduleGatewayRestart();
    });

    child.once('exit', (code) => {
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      if (this.expectedGatewayExits.has(child)) {
        this.expectedGatewayExits.delete(child);
        return;
      }
      if (this.shutdownRequested) return;

      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway exited unexpectedly (code=${code ?? 'null'}).`,
        canRetry: true,
      });
      this.scheduleGatewayRestart();
    });
  }

  private scheduleGatewayRestart(): void {
    if (this.shutdownRequested) return;
    if (this.gatewayRestartTimer) return;

    this.gatewayRestartTimer = setTimeout(() => {
      this.gatewayRestartTimer = null;
      if (this.shutdownRequested) return;
      void this.startGateway();
    }, GATEWAY_RESTART_DELAY_MS);
  }

  private setStatus(next: OpenClawEngineStatus): void {
    this.status = {
      ...next,
      message: next.message ? next.message.slice(0, 500) : undefined,
    };
    this.emit('status', this.getStatus());
  }
}
