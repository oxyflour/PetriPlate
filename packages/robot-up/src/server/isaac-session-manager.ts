import "server-only";

import crypto from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Readable } from "node:stream";
import JSZip from "jszip";
import type {
  IsaacSessionInfo,
  IsaacSessionPhase,
  IsaacSessionStatus
} from "../lib/types";

const PACKAGE_ROOT = process.cwd();
const SESSION_ROOT = path.join(PACKAGE_ROOT, ".runtime", "isaac-sessions");
const SESSION_ASSET_DIRNAME = "assets";
const DEFAULT_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 15_000;
const BRIDGE_READY_TIMEOUT_MS = 90_000;
const BRIDGE_READY_POLL_MS = 300;
const MAX_LOG_LINES = 240;
const RECENT_LOG_LIMIT = 12;
const CONDA_ENV_NAME = process.env.ROBOT_UP2_ISAAC_CONDA_ENV || "env_isaaclab";
const CONDA_ENV_VAR_CANDIDATES = ["ROBOT_UP2_ISAAC_CONDA_EXE", "CONDA_EXE"] as const;
const USD_STAGE_EXTENSIONS = [".usda", ".usd", ".usdc"] as const;
const URDF_EXTENSIONS = [".urdf"] as const;
const CONDA_PATH_CANDIDATES = [
  path.join(process.env.USERPROFILE || "", "anaconda3", "Scripts", "conda.exe"),
  path.join(process.env.USERPROFILE || "", "miniconda3", "Scripts", "conda.exe"),
  path.join(process.env.LOCALAPPDATA || "", "anaconda3", "Scripts", "conda.exe"),
  path.join(process.env.LOCALAPPDATA || "", "miniconda3", "Scripts", "conda.exe"),
  path.join("C:\\ProgramData", "anaconda3", "Scripts", "conda.exe"),
  path.join("C:\\ProgramData", "miniconda3", "Scripts", "conda.exe")
];

type ManagedSession = {
  id: string;
  workdir: string;
  assetDir: string;
  selectedEntryPath: string;
  assetPath: string;
  wsUrl: string;
  assetBaseUrl: string;
  port: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  readyAt: number | null;
  status: IsaacSessionStatus;
  phase: IsaacSessionPhase;
  statusMessage: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  logs: string[];
  startupPromise: Promise<void> | null;
  destroyPromise: Promise<void> | null;
  spawnError: Error | null;
};

type CreateSessionParams = {
  file: File;
  entryPath?: string | null;
  origin: string;
  requestHostname: string;
};

export class IsaacSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredSessions();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    registerProcessCleanup(() => this.shutdown());
  }

  async createSession(params: CreateSessionParams): Promise<IsaacSessionInfo> {
    await fs.mkdir(SESSION_ROOT, { recursive: true });

    const sessionId = crypto.randomUUID();
    const workdir = path.join(SESSION_ROOT, sessionId);
    const assetDir = path.join(workdir, SESSION_ASSET_DIRNAME);

    await fs.mkdir(assetDir, { recursive: true });

    try {
      await writeUploadedAssetToDirectory(params.file, assetDir);
      const selectedEntryPath = await resolveIsaacEntryPath(assetDir, params.entryPath);
      const assetPath = path.join(assetDir, ...selectedEntryPath.split("/"));
      const port = await allocatePort();
      const wsUrl = buildBrowserWsUrl(params.requestHostname, port);
      const assetBaseUrl = `${params.origin}/api/isaac/sessions/${sessionId}/assets`;
      const condaExecutable = await resolveCondaExecutable();
      const child = spawnBridgeProcess({
        condaExecutable,
        port,
        assetPath
      });

      const session: ManagedSession = {
        id: sessionId,
        workdir,
        assetDir,
        selectedEntryPath,
        assetPath,
        wsUrl,
        assetBaseUrl,
        port,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + DEFAULT_TTL_MS,
        readyAt: null,
        status: "starting",
        phase: "launching",
        statusMessage: buildInitialStatusMessage(selectedEntryPath),
        process: child,
        logs: [],
        startupPromise: null,
        destroyPromise: null,
        spawnError: null
      };

      this.sessions.set(sessionId, session);
      bindSessionLogging(session);
      bindSessionExitHandling(this, session);
      session.startupPromise = this.startSession(session);

      return toSessionInfo(session);
    } catch (error) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw error;
    }
  }

  getSessionInfo(sessionId: string): IsaacSessionInfo | null {
    const session = this.sessions.get(sessionId);
    return session ? toSessionInfo(session) : null;
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

  private async startSession(session: ManagedSession): Promise<void> {
    updateSessionProgress(
      session,
      "waiting_runtime",
      buildRuntimeWaitMessage(session.selectedEntryPath)
    );

    try {
      await waitForBridgeReady(session);
      if (!this.sessions.has(session.id) || session.destroyPromise) {
        return;
      }
      markSessionReady(session);
    } catch (error) {
      if (!this.sessions.has(session.id) || session.destroyPromise) {
        return;
      }
      markSessionError(
        session,
        getErrorHeadline(error, "Isaac bridge could not be started.")
      );
    }
  }
}

function spawnBridgeProcess(input: {
  condaExecutable: string;
  port: number;
  assetPath: string;
}) {
  return spawn(
    input.condaExecutable,
    [
      "run",
      "--no-capture-output",
      "-n",
      CONDA_ENV_NAME,
      "python",
      "-u",
      "sim/isaac_stage_bridge.py",
      "--asset",
      input.assetPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--publish-hz",
      "12"
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
    const lines = appendLogLines(session.logs, chunk, "stdout");
    for (const line of lines) {
      updateSessionFromBridgeLog(session, line);
    }
  });
  session.process.stderr.on("data", (chunk: string) => {
    appendLogLines(session.logs, chunk, "stderr");
  });
  session.process.on("error", (error) => {
    session.spawnError = error instanceof Error ? error : new Error(String(error));
    appendLogLines(session.logs, session.spawnError.message, "spawn");
    markSessionError(session, session.spawnError.message);
  });
}

function bindSessionExitHandling(manager: IsaacSessionManager, session: ManagedSession) {
  session.process.once("exit", (code, signal) => {
    if (session.destroyPromise || !manager.getSessionInfo(session.id)) {
      return;
    }

    const detail =
      code !== null ? `code ${code}` : signal ? `signal ${signal}` : "an unknown reason";
    markSessionError(session, `Isaac bridge exited with ${detail}.`);
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
          `Isaac bridge exited with code ${session.process.exitCode}.`
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
      `Isaac bridge did not become ready within ${BRIDGE_READY_TIMEOUT_MS}ms.`
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

async function resolveIsaacEntryPath(
  assetDir: string,
  requestedEntryPath: string | null | undefined
): Promise<string> {
  if (requestedEntryPath) {
    const normalizedRequestedPath = normalizeRelativePath(requestedEntryPath);
    if (!normalizedRequestedPath) {
      throw new Error("Selected Isaac asset path is invalid.");
    }
    const requestedAbsolutePath = path.resolve(assetDir, ...normalizedRequestedPath.split("/"));
    if (!isPathInside(assetDir, requestedAbsolutePath)) {
      throw new Error("Selected Isaac asset path is invalid.");
    }
    if (!(await looksLikeIsaacEntry(requestedAbsolutePath, normalizedRequestedPath))) {
      throw new Error("Selected Isaac entry is not a valid USDA/USD stage or URDF asset.");
    }
    return normalizedRequestedPath;
  }

  const files = await listFilesRecursive(assetDir);
  const assetCandidates: string[] = [];

  for (const filePath of files) {
    const relativePath = toPosixRelativePath(assetDir, filePath);
    if (!relativePath) {
      continue;
    }
    if (await looksLikeIsaacEntry(filePath, relativePath)) {
      assetCandidates.push(relativePath);
    }
  }

  assetCandidates.sort(compareIsaacCandidates);
  const candidate = assetCandidates[0];
  if (!candidate) {
    throw new Error("Uploaded asset does not contain a USDA/USD stage or URDF asset.");
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

async function looksLikeIsaacEntry(absolutePath: string, relativePath: string): Promise<boolean> {
  return (
    (await looksLikeUsdStage(absolutePath, relativePath)) ||
    (await looksLikeUrdfAsset(absolutePath, relativePath))
  );
}

async function looksLikeUsdStage(absolutePath: string, relativePath: string): Promise<boolean> {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (!USD_STAGE_EXTENSIONS.includes(extension as (typeof USD_STAGE_EXTENSIONS)[number])) {
    return false;
  }

  if (extension === ".usd" || extension === ".usdc") {
    return true;
  }

  try {
    const source = await fs.readFile(absolutePath, "utf8");
    return source.trimStart().startsWith("#usda");
  } catch {
    return false;
  }
}

async function looksLikeUrdfAsset(absolutePath: string, relativePath: string): Promise<boolean> {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (URDF_EXTENSIONS.includes(extension as (typeof URDF_EXTENSIONS)[number])) {
    return true;
  }
  if (extension !== ".xml") {
    return false;
  }

  try {
    const source = await fs.readFile(absolutePath, "utf8");
    return source.trimStart().startsWith("<robot") || source.includes("<robot ");
  } catch {
    return false;
  }
}

async function resolveCondaExecutable(): Promise<string> {
  for (const envVarName of CONDA_ENV_VAR_CANDIDATES) {
    const envValue = process.env[envVarName];
    if (envValue && (await pathExists(envValue))) {
      return envValue;
    }
  }

  for (const candidate of CONDA_PATH_CANDIDATES) {
    if (candidate && (await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error(
    "Could not locate conda.exe for Isaac bridge startup. " +
      "Set ROBOT_UP2_ISAAC_CONDA_EXE or CONDA_EXE to the correct path."
  );
}

async function pathExists(candidatePath: string) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function compareIsaacCandidates(left: string, right: string) {
  const leftWeight = isaacExtensionPriority(path.posix.extname(left).toLowerCase());
  const rightWeight = isaacExtensionPriority(path.posix.extname(right).toLowerCase());
  if (leftWeight !== rightWeight) {
    return leftWeight - rightWeight;
  }
  const leftRoleWeight = isaacStageRolePriority(left);
  const rightRoleWeight = isaacStageRolePriority(right);
  if (leftRoleWeight !== rightRoleWeight) {
    return leftRoleWeight - rightRoleWeight;
  }
  return left.localeCompare(right);
}

function isaacExtensionPriority(extension: string) {
  if (extension === ".usda") {
    return 0;
  }
  if (extension === ".usd") {
    return 1;
  }
  if (extension === ".usdc") {
    return 2;
  }
  if (extension === ".urdf") {
    return 3;
  }
  return 4;
}

function isaacStageRolePriority(candidatePath: string) {
  const normalizedPath = candidatePath.replace(/\\/g, "/").toLowerCase();
  const fileName = path.posix.basename(normalizedPath);
  const isCompanionStage =
    fileName.includes("_base.") ||
    fileName.includes("_physics.") ||
    fileName.includes("_sensor.") ||
    fileName.includes("_robot.");
  if (!isCompanionStage && !normalizedPath.includes("/configuration/")) {
    return 0;
  }
  if (!isCompanionStage) {
    return 1;
  }
  if (fileName.includes("_base.")) {
    return 3;
  }
  return 2;
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

function toSessionInfo(session: ManagedSession): IsaacSessionInfo {
  return {
    sessionId: session.id,
    wsUrl: session.wsUrl,
    assetBaseUrl: session.assetBaseUrl,
    selectedEntryPath: session.selectedEntryPath,
    expiresAt: new Date(session.expiresAt).toISOString(),
    status: session.status,
    phase: session.phase,
    statusMessage: session.statusMessage,
    recentLogs: session.logs.slice(-RECENT_LOG_LIMIT),
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    readyAt: session.readyAt ? new Date(session.readyAt).toISOString() : null
  };
}

function appendLogLines(target: string[], chunk: string, source: string): string[] {
  const appendedLines: string[] = [];

  for (const line of chunk.split(/\r?\n/)) {
    const normalized = line.trimEnd();
    if (!normalized) {
      continue;
    }
    appendedLines.push(normalized);
    target.push(`[${source}] ${normalized}`);
  }

  if (target.length > MAX_LOG_LINES) {
    target.splice(0, target.length - MAX_LOG_LINES);
  }

  return appendedLines;
}

function buildInitialStatusMessage(selectedEntryPath: string) {
  if (looksLikeUrdfPath(selectedEntryPath)) {
    return "Launching Isaac Sim to import the URDF and build a renderable USD stage.";
  }
  return "Launching Isaac Sim bridge for the selected USD stage.";
}

function buildRuntimeWaitMessage(selectedEntryPath: string) {
  if (looksLikeUrdfPath(selectedEntryPath)) {
    return "Isaac Sim is starting and importing the URDF. This can take a while.";
  }
  return "Isaac Sim is starting and loading the USD stage. This can take a while.";
}

function looksLikeUrdfPath(selectedEntryPath: string) {
  const extension = path.posix.extname(selectedEntryPath).toLowerCase();
  return extension === ".urdf" || extension === ".xml";
}

function updateSessionProgress(
  session: ManagedSession,
  phase: Exclude<IsaacSessionPhase, "ready" | "error">,
  message: string
) {
  if (session.destroyPromise || session.status === "error" || session.status === "ready") {
    return;
  }

  session.phase = phase;
  session.status = "starting";
  session.statusMessage = message;
  session.updatedAt = Date.now();
}

function markSessionReady(session: ManagedSession) {
  if (session.destroyPromise) {
    return;
  }

  const now = Date.now();
  session.status = "ready";
  session.phase = "ready";
  session.statusMessage = "Isaac websocket bridge is ready.";
  session.updatedAt = now;
  session.readyAt = now;
}

function markSessionError(session: ManagedSession, message: string) {
  if (session.destroyPromise) {
    return;
  }

  session.status = "error";
  session.phase = "error";
  session.statusMessage = message;
  session.updatedAt = Date.now();
}

function updateSessionFromBridgeLog(session: ManagedSession, line: string) {
  if (session.destroyPromise || session.status !== "starting") {
    return;
  }

  if (line.startsWith("[isaac] starting bridge")) {
    updateSessionProgress(
      session,
      "loading_stage",
      buildRuntimeWaitMessage(session.selectedEntryPath)
    );
    return;
  }

  if (line.startsWith("[stage] manifest ready")) {
    updateSessionProgress(
      session,
      "starting_websocket",
      "Stage manifest is ready. Waiting for the websocket bridge to accept connections."
    );
    return;
  }

  if (line.startsWith("[ws] serving at")) {
    updateSessionProgress(
      session,
      "starting_websocket",
      "Websocket bridge is up. Finalizing Isaac session startup."
    );
  }
}

function getErrorHeadline(error: unknown, fallback: string) {
  if (!(error instanceof Error) || !error.message) {
    return fallback;
  }

  const [headline] = error.message.split(/\r?\n/, 1);
  return headline || fallback;
}

function formatBridgeStartupError(session: ManagedSession, message: string): string {
  const detail = session.logs.length ? `\n${session.logs.slice(-40).join("\n")}` : "";
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
  var __robotUp2IsaacSessionManager: IsaacSessionManager | undefined;
}

export function getIsaacSessionManager() {
  if (!globalThis.__robotUp2IsaacSessionManager) {
    globalThis.__robotUp2IsaacSessionManager = new IsaacSessionManager();
  }
  return globalThis.__robotUp2IsaacSessionManager;
}
