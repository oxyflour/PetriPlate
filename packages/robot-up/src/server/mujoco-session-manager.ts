import "server-only";

import crypto from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Readable } from "node:stream";
import JSZip from "jszip";
import type { MujocoSessionInfo } from "../lib/types";

const PACKAGE_ROOT = process.cwd();
const SESSION_ROOT = path.join(PACKAGE_ROOT, ".runtime", "sessions");
const SESSION_ASSET_DIRNAME = "assets";
const DEFAULT_TTL_MS = 45_000;
const SWEEP_INTERVAL_MS = 15_000;
const BRIDGE_READY_TIMEOUT_MS = 12_000;
const BRIDGE_READY_POLL_MS = 150;
const MAX_LOG_LINES = 120;

type ManagedSession = {
  id: string;
  workdir: string;
  assetDir: string;
  selectedEntryPath: string;
  modelPath: string;
  port: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  process: ChildProcessByStdio<null, Readable, Readable>;
  logs: string[];
  destroyPromise: Promise<void> | null;
  spawnError: Error | null;
};

type CreateSessionParams = {
  file: File;
  entryPath?: string | null;
  origin: string;
  requestHostname: string;
};

export class MujocoSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredSessions();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    registerProcessCleanup(() => this.shutdown());
  }

  async createSession(params: CreateSessionParams): Promise<MujocoSessionInfo> {
    await fs.mkdir(SESSION_ROOT, { recursive: true });

    const sessionId = crypto.randomUUID();
    const workdir = path.join(SESSION_ROOT, sessionId);
    const assetDir = path.join(workdir, SESSION_ASSET_DIRNAME);

    await fs.mkdir(assetDir, { recursive: true });

    try {
      await writeUploadedAssetToDirectory(params.file, assetDir);
      const selectedEntryPath = await resolveSessionEntryPath(assetDir, params.entryPath);
      const modelPath = path.join(assetDir, ...selectedEntryPath.split("/"));
      const port = await allocatePort();
      const assetBaseUrl = `${params.origin}/api/mujoco/sessions/${sessionId}/assets`;
      const child = spawnBridgeProcess({
        assetDir,
        assetBaseUrl,
        modelPath,
        port
      });

      const session: ManagedSession = {
        id: sessionId,
        workdir,
        assetDir,
        selectedEntryPath,
        modelPath,
        port,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + DEFAULT_TTL_MS,
        process: child,
        logs: [],
        destroyPromise: null,
        spawnError: null
      };

      this.sessions.set(sessionId, session);
      bindSessionLogging(session);
      bindSessionExitHandling(this, session);

      await waitForBridgeReady(session);

      return {
        sessionId,
        wsUrl: buildBrowserWsUrl(params.requestHostname, port),
        assetBaseUrl,
        selectedEntryPath,
        expiresAt: new Date(session.expiresAt).toISOString()
      };
    } catch (error) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw error;
    }
  }

  touchSession(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const now = Date.now();
    session.lastSeenAt = now;
    session.expiresAt = now + DEFAULT_TTL_MS;
    return new Date(session.expiresAt).toISOString();
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.destroyPromise) {
      return session.destroyPromise;
    }

    session.destroyPromise = (async () => {
      this.sessions.delete(sessionId);
      await terminateChildProcess(session.process);
      await fs.rm(session.workdir, { recursive: true, force: true });
    })();

    return session.destroyPromise;
  }

  async resolveAssetFile(sessionId: string, relativeAssetPath: string): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const normalizedPath = normalizeRelativePath(relativeAssetPath);
    if (!normalizedPath) {
      return null;
    }

    const candidate = path.resolve(session.assetDir, ...normalizedPath.split("/"));
    if (!isPathInside(session.assetDir, candidate)) {
      return null;
    }

    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  }

  private async sweepExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredIds = [...this.sessions.values()]
      .filter((session) => session.expiresAt <= now)
      .map((session) => session.id);

    await Promise.all(expiredIds.map((sessionId) => this.destroySession(sessionId)));
  }

  private async shutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.destroySession(sessionId)));
  }
}

function spawnBridgeProcess(input: {
  assetDir: string;
  assetBaseUrl: string;
  modelPath: string;
  port: number;
}) {
  return spawn(
    "uv",
    [
      "run",
      "python",
      "sim/mujoco_ws_bridge.py",
      "--model",
      input.modelPath,
      "--asset-root",
      input.assetDir,
      "--asset-url-prefix",
      input.assetBaseUrl,
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port)
    ],
    {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
}

function bindSessionLogging(session: ManagedSession) {
  session.process.stdout.setEncoding("utf8");
  session.process.stderr.setEncoding("utf8");

  session.process.stdout.on("data", (chunk: string) => {
    appendLogLines(session.logs, `[stdout] ${chunk}`);
  });
  session.process.stderr.on("data", (chunk: string) => {
    appendLogLines(session.logs, `[stderr] ${chunk}`);
  });
  session.process.on("error", (error) => {
    session.spawnError = error instanceof Error ? error : new Error(String(error));
    appendLogLines(session.logs, `[spawn] ${session.spawnError.message}`);
  });
}

function bindSessionExitHandling(manager: MujocoSessionManager, session: ManagedSession) {
  session.process.once("exit", () => {
    if (!session.destroyPromise) {
      void manager.destroySession(session.id);
    }
  });
}

async function waitForBridgeReady(session: ManagedSession): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < BRIDGE_READY_TIMEOUT_MS) {
    if (session.spawnError) {
      throw new Error(formatBridgeStartupError(session, session.spawnError.message));
    }
    if (session.process.exitCode !== null) {
      throw new Error(
        formatBridgeStartupError(
          session,
          `MuJoCo bridge exited with code ${session.process.exitCode}.`
        )
      );
    }
    if (await canConnect("127.0.0.1", session.port)) {
      return;
    }
    await delay(BRIDGE_READY_POLL_MS);
  }

  throw new Error(
    formatBridgeStartupError(
      session,
      `MuJoCo bridge did not become ready within ${BRIDGE_READY_TIMEOUT_MS}ms.`
    )
  );
}

async function terminateChildProcess(
  child: ChildProcessByStdio<null, Readable, Readable>
): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    delay(2_000).then(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        return;
      }
    })
  ]);
}

async function writeUploadedAssetToDirectory(file: File, assetDir: string): Promise<void> {
  const normalizedName = normalizeRelativePath(file.name || "upload.bin");
  if (!normalizedName) {
    throw new Error("Uploaded file name is invalid.");
  }

  const extension = path.posix.extname(normalizedName).toLowerCase();
  if (extension === ".zip") {
    await extractZipToDirectory(Buffer.from(await file.arrayBuffer()), assetDir);
    return;
  }

  const targetPath = path.resolve(assetDir, ...normalizedName.split("/"));
  if (!isPathInside(assetDir, targetPath)) {
    throw new Error("Uploaded file path is invalid.");
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(await file.arrayBuffer()));
}

async function extractZipToDirectory(buffer: Buffer, assetDir: string): Promise<void> {
  const archive = await JSZip.loadAsync(buffer);

  for (const zipEntry of Object.values(archive.files)) {
    if (zipEntry.dir) {
      continue;
    }

    const relativePath = normalizeRelativePath(zipEntry.name);
    if (!relativePath) {
      continue;
    }

    const targetPath = path.resolve(assetDir, ...relativePath.split("/"));
    if (!isPathInside(assetDir, targetPath)) {
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, await zipEntry.async("nodebuffer"));
  }
}

async function resolveSessionEntryPath(
  assetDir: string,
  requestedEntryPath: string | null | undefined
): Promise<string> {
  if (requestedEntryPath) {
    const normalizedRequestedPath = normalizeRelativePath(requestedEntryPath);
    if (!normalizedRequestedPath) {
      throw new Error("Selected MuJoCo entry path is invalid.");
    }
    const requestedAbsolutePath = path.resolve(assetDir, ...normalizedRequestedPath.split("/"));
    if (!isPathInside(assetDir, requestedAbsolutePath)) {
      throw new Error("Selected MuJoCo entry path is invalid.");
    }
    const requestedText = await fs.readFile(requestedAbsolutePath, "utf8");
    if (!looksLikeMujocoXml(normalizedRequestedPath, requestedText)) {
      throw new Error("Selected MuJoCo entry is not a valid MJCF XML file.");
    }
    return normalizedRequestedPath;
  }

  const files = await listFilesRecursive(assetDir);
  const mjcfCandidates: string[] = [];

  for (const filePath of files) {
    const relativePath = toPosixRelativePath(assetDir, filePath);
    if (!relativePath) {
      continue;
    }

    const extension = path.posix.extname(relativePath).toLowerCase();
    if (extension !== ".xml" && extension !== ".mjcf") {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");
    if (looksLikeMujocoXml(relativePath, source)) {
      mjcfCandidates.push(relativePath);
    }
  }

  mjcfCandidates.sort((left, right) => left.localeCompare(right));
  const candidate = mjcfCandidates[0];
  if (!candidate) {
    throw new Error("Uploaded asset does not contain a MuJoCo XML entry.");
  }
  return candidate;
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function looksLikeMujocoXml(filePath: string, source: string): boolean {
  const extension = path.posix.extname(filePath).toLowerCase();
  return (extension === ".xml" || extension === ".mjcf") && /<mujoco[\s>]/i.test(source);
}

async function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate a websocket port."));
          return;
        }
        resolve(port);
      });
    });
    server.once("error", reject);
  });
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });

    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function normalizeRelativePath(input: string): string | null {
  const trimmed = input.replace(/\\/g, "/").trim();
  if (!trimmed) {
    return null;
  }

  const normalized = path.posix.normalize(trimmed).replace(/^\/+/, "").replace(/^(\.\/)+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return null;
  }

  return normalized;
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function toPosixRelativePath(rootDir: string, filePath: string): string | null {
  const relativePath = path.relative(rootDir, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.replace(/\\/g, "/");
}

function buildBrowserWsUrl(requestHostname: string, port: number): string {
  const normalizedHost =
    requestHostname && requestHostname !== "0.0.0.0" && requestHostname !== "::"
      ? requestHostname
      : "127.0.0.1";
  return `ws://${normalizedHost}:${port}`;
}

function appendLogLines(target: string[], chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    const normalized = line.trimEnd();
    if (!normalized) {
      continue;
    }
    target.push(normalized);
  }

  if (target.length > MAX_LOG_LINES) {
    target.splice(0, target.length - MAX_LOG_LINES);
  }
}

function formatBridgeStartupError(session: ManagedSession, message: string): string {
  const detail = session.logs.length ? `\n${session.logs.slice(-20).join("\n")}` : "";
  return `${message}${detail}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

let cleanupRegistered = false;

function registerProcessCleanup(cleanup: () => Promise<void>) {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;

  const runCleanup = () => {
    void cleanup();
  };

  process.once("SIGINT", runCleanup);
  process.once("SIGTERM", runCleanup);
  process.once("exit", runCleanup);
}

declare global {
  // eslint-disable-next-line no-var
  var __robotUp2MujocoSessionManager: MujocoSessionManager | undefined;
}

export function getMujocoSessionManager() {
  if (!globalThis.__robotUp2MujocoSessionManager) {
    globalThis.__robotUp2MujocoSessionManager = new MujocoSessionManager();
  }
  return globalThis.__robotUp2MujocoSessionManager;
}
