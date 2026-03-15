"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import IsaacStagePreview from "../src/components/isaac-stage-preview";
import MujocoPreview from "../src/components/mujoco-preview";
import {
  createAssetAnalysisFromFile,
  createSampleAssetAnalysis,
  createSampleAssetFile,
  createSampleFrankaAssetAnalysis,
  createSampleFrankaAssetFile,
  createSampleIsaacAssetAnalysis,
  createSampleIsaacAssetFile,
  resolveIsaacEntrySelection,
  resolveMujocoEntrySelection,
  revokeAssetObjectUrls
} from "../src/lib/asset-analysis";
import type {
  AssetAnalysis,
  AssetFileEntry,
  IsaacBridgeMessage,
  IsaacSessionInfo,
  IsaacStageFrameMessage,
  IsaacStageManifestMessage,
  MujocoBridgeMessage,
  MujocoModelManifestMessage,
  MujocoPoseFrameMessage,
  MujocoPoseMessage,
  MujocoSessionInfo,
  RuntimeKind
} from "../src/lib/types";

const RUNTIME_LABELS: Record<RuntimeKind, string> = {
  mujoco: "MuJoCo",
  isaacsim: "Isaac Sim"
};

const ACCEPT_ATTR = ".xml,.mjcf,.zip,.urdf,.usda,.usd,.usdc,.obj,.stl,.msh";
const COLLAPSED_ENTRY_COUNT = 6;
const HEARTBEAT_INTERVAL_MS = 10_000;
const ISAAC_STATUS_POLL_INTERVAL_MS = 1_000;

type SessionStatus = "idle" | "starting" | "ready" | "error";
type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

export default function RobotLab() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [analysis, setAnalysis] = useState<AssetAnalysis | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [activeRuntime, setActiveRuntime] = useState<RuntimeKind | null>(null);
  const [selectedMujocoEntryPath, setSelectedMujocoEntryPath] = useState<string | null>(null);
  const [selectedIsaacEntryPath, setSelectedIsaacEntryPath] = useState<string | null>(null);
  const [showAllEntries, setShowAllEntries] = useState(false);
  const [isBusy, setIsBusy] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mujocoSession, setMujocoSession] = useState<MujocoSessionInfo | null>(null);
  const [mujocoSessionStatus, setMujocoSessionStatus] = useState<SessionStatus>("idle");
  const [mujocoConnectionStatus, setMujocoConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [mujocoSessionError, setMujocoSessionError] = useState<string | null>(null);
  const [mujocoManifest, setMujocoManifest] = useState<MujocoModelManifestMessage | null>(null);
  const [mujocoPose, setMujocoPose] = useState<MujocoPoseMessage | null>(null);
  const [mujocoFrame, setMujocoFrame] = useState<MujocoPoseFrameMessage | null>(null);
  const [isaacSession, setIsaacSession] = useState<IsaacSessionInfo | null>(null);
  const [isaacSessionStatus, setIsaacSessionStatus] = useState<SessionStatus>("idle");
  const [isaacConnectionStatus, setIsaacConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [isaacSessionError, setIsaacSessionError] = useState<string | null>(null);
  const [isaacManifest, setIsaacManifest] = useState<IsaacStageManifestMessage | null>(null);
  const [isaacFrame, setIsaacFrame] = useState<IsaacStageFrameMessage | null>(null);

  useEffect(() => {
    void loadMujocoSample();
  }, []);

  useEffect(() => {
    const currentAnalysis = analysis;
    return () => {
      if (currentAnalysis) {
        revokeAssetObjectUrls(currentAnalysis.entries);
      }
    };
  }, [analysis]);

  const currentRuntime = useMemo(() => {
    if (!analysis) {
      return null;
    }
    if (activeRuntime && analysis.availableRuntimes.includes(activeRuntime)) {
      return activeRuntime;
    }
    return analysis.defaultRuntime;
  }, [activeRuntime, analysis]);

  const currentMujocoSelection = useMemo(() => {
    if (!analysis || currentRuntime !== "mujoco") {
      return null;
    }
    return resolveMujocoEntrySelection(analysis.entries, selectedMujocoEntryPath);
  }, [analysis, currentRuntime, selectedMujocoEntryPath]);

  const currentMujocoEntryPath = currentMujocoSelection?.entry?.path || null;
  const currentMujocoScene = currentMujocoSelection?.scene || analysis?.mujocoScene || null;
  const currentIsaacSelection = useMemo(() => {
    if (!analysis || currentRuntime !== "isaacsim") {
      return null;
    }
    return resolveIsaacEntrySelection(analysis.entries, selectedIsaacEntryPath);
  }, [analysis, currentRuntime, selectedIsaacEntryPath]);
  const currentIsaacEntryPath = currentIsaacSelection?.entry?.path || null;
  const currentIsaacPreview =
    currentIsaacSelection?.preview || analysis?.isaacPreview || null;

  const currentEntry =
    currentRuntime === "mujoco"
      ? currentMujocoSelection?.entry || null
      : currentRuntime === "isaacsim"
        ? currentIsaacSelection?.entry || null
      : currentRuntime
        ? analysis?.runtimeEntries[currentRuntime] || null
        : null;

  const currentWarnings = useMemo(() => {
    const baseWarnings = analysis?.warnings || [];
    if (currentRuntime !== "mujoco" || !currentMujocoSelection) {
      return baseWarnings;
    }
    return [...baseWarnings, ...currentMujocoSelection.warnings];
  }, [analysis, currentRuntime, currentMujocoSelection]);

  const visibleEntries = useMemo(() => {
    const entries = analysis?.entries || [];
    return showAllEntries ? entries : entries.slice(0, COLLAPSED_ENTRY_COUNT);
  }, [analysis, showAllEntries]);

  useEffect(() => {
    if (currentRuntime !== "mujoco" || !sourceFile || !currentMujocoEntryPath) {
      setMujocoSession(null);
      setMujocoSessionStatus("idle");
      setMujocoConnectionStatus("idle");
      setMujocoSessionError(null);
      setMujocoManifest(null);
      setMujocoPose(null);
      setMujocoFrame(null);
      return;
    }

    let active = true;
    let createdSessionId: string | null = null;
    const controller = new AbortController();

    setMujocoSession(null);
    setMujocoSessionStatus("starting");
    setMujocoConnectionStatus("idle");
    setMujocoSessionError(null);
    setMujocoManifest(null);
    setMujocoPose(null);
    setMujocoFrame(null);

    const formData = new FormData();
    formData.set("file", sourceFile);
    formData.set("entryPath", currentMujocoEntryPath);

    fetch("/api/mujoco/sessions", {
      method: "POST",
      body: formData,
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = await readJson(response);
        if (!response.ok) {
          throw new Error(readApiError(payload, "MuJoCo session could not be created."));
        }
        return payload as MujocoSessionInfo;
      })
      .then(async (session) => {
        createdSessionId = session.sessionId;
        if (!active) {
          await deleteMujocoSession(session.sessionId);
          return;
        }
        setMujocoSession(session);
        setMujocoSessionStatus("ready");
      })
      .catch((nextError) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        setMujocoSession(null);
        setMujocoSessionStatus("error");
        setMujocoConnectionStatus("idle");
        setMujocoSessionError(toMessage(nextError, "MuJoCo session could not be created."));
      });

    return () => {
      active = false;
      controller.abort();
      if (createdSessionId) {
        void deleteMujocoSession(createdSessionId);
      }
    };
  }, [currentRuntime, currentMujocoEntryPath, sourceFile]);

  useEffect(() => {
    if (!mujocoSession?.sessionId) {
      return undefined;
    }

    let active = true;

    const postHeartbeat = async () => {
      try {
        const response = await fetch(
          `/api/mujoco/sessions/${mujocoSession.sessionId}/heartbeat`,
          { method: "POST" }
        );
        if (!response.ok) {
          throw new Error("MuJoCo session heartbeat failed.");
        }
        const payload = await readJson(response);
        if (!active) {
          return;
        }
        if (typeof payload?.expiresAt === "string") {
          setMujocoSession((current) =>
            current && current.sessionId === mujocoSession.sessionId
              ? { ...current, expiresAt: payload.expiresAt }
              : current
          );
        }
      } catch (nextError) {
        if (!active) {
          return;
        }
        setMujocoSessionError(toMessage(nextError, "MuJoCo session heartbeat failed."));
      }
    };

    void postHeartbeat();
    const timerId = window.setInterval(() => {
      void postHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timerId);
    };
  }, [mujocoSession?.sessionId]);

  useEffect(() => {
    if (!mujocoSession?.wsUrl) {
      return undefined;
    }

    let active = true;
    const socket = new WebSocket(mujocoSession.wsUrl);
    setMujocoConnectionStatus("connecting");

    socket.onopen = () => {
      if (!active) {
        return;
      }
      setMujocoConnectionStatus("open");
      socket.send(JSON.stringify({ type: "model_request" }));
    };

    socket.onerror = () => {
      if (!active) {
        return;
      }
      setMujocoConnectionStatus("error");
    };

    socket.onclose = () => {
      if (!active) {
        return;
      }
      setMujocoConnectionStatus("closed");
    };

    socket.onmessage = (event) => {
      if (!active) {
        return;
      }

      try {
        const message = JSON.parse(event.data) as MujocoBridgeMessage;
        if (message.type === "pose") {
          setMujocoPose(message);
          return;
        }
        if (message.type === "pose_frame") {
          setMujocoFrame(message);
          return;
        }
        if (message.type === "model_manifest") {
          setMujocoManifest(message);
          return;
        }
        if (message.type === "model_manifest_unavailable") {
          setMujocoSessionError("MuJoCo bridge rejected the requested body manifest.");
        }
      } catch (nextError) {
        setMujocoSessionError(toMessage(nextError, "Invalid MuJoCo websocket payload."));
      }
    };

    return () => {
      active = false;
      socket.close();
    };
  }, [mujocoSession?.wsUrl]);

  useEffect(() => {
    if (currentRuntime !== "isaacsim" || !sourceFile || !currentIsaacEntryPath) {
      setIsaacSession(null);
      setIsaacSessionStatus("idle");
      setIsaacConnectionStatus("idle");
      setIsaacSessionError(null);
      setIsaacManifest(null);
      setIsaacFrame(null);
      return;
    }

    let active = true;
    let createdSessionId: string | null = null;
    const controller = new AbortController();

    setIsaacSession(null);
    setIsaacSessionStatus("starting");
    setIsaacConnectionStatus("idle");
    setIsaacSessionError(null);
    setIsaacManifest(null);
    setIsaacFrame(null);

    const formData = new FormData();
    formData.set("file", sourceFile);
    formData.set("entryPath", currentIsaacEntryPath);

    fetch("/api/isaac/sessions", {
      method: "POST",
      body: formData,
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = await readJson(response);
        if (!response.ok) {
          throw new Error(readApiError(payload, "Isaac session could not be created."));
        }
        return payload as IsaacSessionInfo;
      })
      .then(async (session) => {
        createdSessionId = session.sessionId;
        if (!active) {
          await deleteIsaacSession(session.sessionId);
          return;
        }
        setIsaacSession(session);
        setIsaacSessionStatus(resolveIsaacSessionStatus(session));
        if (session.status === "error") {
          setIsaacSessionError(session.statusMessage);
        } else {
          setIsaacSessionError(null);
        }
      })
      .catch((nextError) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        setIsaacSession(null);
        setIsaacSessionStatus("error");
        setIsaacConnectionStatus("idle");
        setIsaacSessionError(toMessage(nextError, "Isaac session could not be created."));
      });

    return () => {
      active = false;
      controller.abort();
      if (createdSessionId) {
        void deleteIsaacSession(createdSessionId);
      }
    };
  }, [currentIsaacEntryPath, currentRuntime, sourceFile]);

  useEffect(() => {
    if (!isaacSession?.sessionId || isaacSession.status !== "starting") {
      return undefined;
    }

    let active = true;
    const controller = new AbortController();

    const syncSession = async () => {
      try {
        const response = await fetch(`/api/isaac/sessions/${isaacSession.sessionId}`, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store"
        });
        const payload = await readJson(response);
        if (!response.ok) {
          throw new Error(readApiError(payload, "Isaac session status could not be loaded."));
        }

        const session = payload as IsaacSessionInfo;
        if (!active) {
          return;
        }

        setIsaacSession(session);
        setIsaacSessionStatus(resolveIsaacSessionStatus(session));
        if (session.status === "error") {
          setIsaacSessionError(session.statusMessage);
        } else {
          setIsaacSessionError(null);
        }
      } catch (nextError) {
        if (!active || controller.signal.aborted) {
          return;
        }
        setIsaacSessionStatus("error");
        setIsaacSessionError(toMessage(nextError, "Isaac session status could not be loaded."));
      }
    };

    void syncSession();
    const timerId = window.setInterval(() => {
      void syncSession();
    }, ISAAC_STATUS_POLL_INTERVAL_MS);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timerId);
    };
  }, [isaacSession?.sessionId, isaacSession?.status]);

  useEffect(() => {
    if (!isaacSession?.sessionId) {
      return undefined;
    }

    let active = true;

    const postHeartbeat = async () => {
      try {
        const response = await fetch(
          `/api/isaac/sessions/${isaacSession.sessionId}/heartbeat`,
          { method: "POST" }
        );
        if (!response.ok) {
          throw new Error("Isaac session heartbeat failed.");
        }
        const payload = await readJson(response);
        if (!active) {
          return;
        }
        if (typeof payload?.expiresAt === "string") {
          setIsaacSession((current) =>
            current && current.sessionId === isaacSession.sessionId
              ? { ...current, expiresAt: payload.expiresAt }
              : current
          );
        }
      } catch (nextError) {
        if (!active) {
          return;
        }
        setIsaacSessionError(toMessage(nextError, "Isaac session heartbeat failed."));
      }
    };

    void postHeartbeat();
    const timerId = window.setInterval(() => {
      void postHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timerId);
    };
  }, [isaacSession?.sessionId]);

  useEffect(() => {
    if (!isaacSession?.wsUrl || isaacSession.status !== "ready") {
      return undefined;
    }

    let active = true;
    const socket = new WebSocket(isaacSession.wsUrl);
    setIsaacConnectionStatus("connecting");

    socket.onopen = () => {
      if (!active) {
        return;
      }
      setIsaacConnectionStatus("open");
      socket.send(JSON.stringify({ type: "stage_request" }));
    };

    socket.onerror = () => {
      if (!active) {
        return;
      }
      setIsaacConnectionStatus("error");
    };

    socket.onclose = () => {
      if (!active) {
        return;
      }
      setIsaacConnectionStatus("closed");
    };

    socket.onmessage = (event) => {
      if (!active) {
        return;
      }

      try {
        const message = JSON.parse(event.data) as IsaacBridgeMessage;
        if (message.type === "stage_manifest") {
          setIsaacManifest(message);
          return;
        }
        if (message.type === "stage_frame") {
          setIsaacFrame(message);
          return;
        }
        if (message.type === "stage_error") {
          setIsaacSessionStatus("error");
          setIsaacSession((current) =>
            current
              ? {
                  ...current,
                  status: "error",
                  phase: "error",
                  statusMessage: message.message,
                  updatedAt: new Date().toISOString()
                }
              : current
          );
          setIsaacConnectionStatus("error");
          setIsaacSessionError(message.message);
        }
      } catch (nextError) {
        setIsaacSessionError(toMessage(nextError, "Invalid Isaac websocket payload."));
      }
    };

    return () => {
      active = false;
      socket.close();
    };
  }, [isaacSession?.status, isaacSession?.wsUrl]);

  async function loadMujocoSample() {
    setIsBusy(true);
    setError(null);
    try {
      const [nextAnalysis, nextSourceFile] = await Promise.all([
        createSampleAssetAnalysis(),
        createSampleAssetFile()
      ]);
      setAnalysis(nextAnalysis);
      setSourceFile(nextSourceFile);
      setActiveRuntime(nextAnalysis.defaultRuntime);
      setSelectedMujocoEntryPath(nextAnalysis.runtimeEntries.mujoco?.path || null);
      setSelectedIsaacEntryPath(nextAnalysis.runtimeEntries.isaacsim?.path || null);
      setShowAllEntries(false);
    } catch (nextError) {
      setError(toMessage(nextError, "Sample asset could not be loaded."));
    } finally {
      setIsBusy(false);
    }
  }

  async function loadIsaacSample() {
    setIsBusy(true);
    setError(null);
    try {
      const [nextAnalysis, nextSourceFile] = await Promise.all([
        createSampleIsaacAssetAnalysis(),
        createSampleIsaacAssetFile()
      ]);
      setAnalysis(nextAnalysis);
      setSourceFile(nextSourceFile);
      setActiveRuntime(nextAnalysis.defaultRuntime);
      setSelectedMujocoEntryPath(nextAnalysis.runtimeEntries.mujoco?.path || null);
      setSelectedIsaacEntryPath(nextAnalysis.runtimeEntries.isaacsim?.path || null);
      setShowAllEntries(false);
    } catch (nextError) {
      setError(toMessage(nextError, "Isaac sample asset could not be loaded."));
    } finally {
      setIsBusy(false);
    }
  }

  async function loadFrankaSample() {
    setIsBusy(true);
    setError(null);
    try {
      const [nextAnalysis, nextSourceFile] = await Promise.all([
        createSampleFrankaAssetAnalysis(),
        createSampleFrankaAssetFile()
      ]);
      setAnalysis(nextAnalysis);
      setSourceFile(nextSourceFile);
      setActiveRuntime(nextAnalysis.defaultRuntime);
      setSelectedMujocoEntryPath(nextAnalysis.runtimeEntries.mujoco?.path || null);
      setSelectedIsaacEntryPath(nextAnalysis.runtimeEntries.isaacsim?.path || null);
      setShowAllEntries(false);
    } catch (nextError) {
      setError(toMessage(nextError, "Official Franka USD sample could not be loaded."));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSelectedFile(file: File) {
    setIsBusy(true);
    setError(null);
    try {
      const nextAnalysis = await createAssetAnalysisFromFile(file);
      setAnalysis(nextAnalysis);
      setSourceFile(file);
      setActiveRuntime(nextAnalysis.defaultRuntime);
      setSelectedMujocoEntryPath(nextAnalysis.runtimeEntries.mujoco?.path || null);
      setSelectedIsaacEntryPath(nextAnalysis.runtimeEntries.isaacsim?.path || null);
      setShowAllEntries(false);
    } catch (nextError) {
      setError(toMessage(nextError, "Asset could not be inspected."));
    } finally {
      setIsBusy(false);
      setDragActive(false);
    }
  }

  return (
    <main className="lab-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">robot-up2 / task 03</p>
          <h1>Dual Runtime Router</h1>
          <p className="hero-inline-note">MuJoCo + Isaac live runtime preview.</p>
        </div>

        <div className="hero-actions">
          <button className="solid-button" onClick={() => void loadMujocoSample()} type="button">
            Load Sample MJCF
          </button>
          <button className="ghost-button" onClick={() => void loadIsaacSample()} type="button">
            Load Sample USD
          </button>
          <button className="ghost-button" onClick={() => void loadFrankaSample()} type="button">
            Load Franka USD
          </button>
          <button
            className="ghost-button"
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            Upload Asset
          </button>
          <input
            ref={inputRef}
            className="hidden-input"
            type="file"
            accept={ACCEPT_ATTR}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleSelectedFile(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </div>
      </section>

      <section
        className={`dropzone ${dragActive ? "dropzone-active" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files?.[0];
          if (file) {
            void handleSelectedFile(file);
          } else {
            setDragActive(false);
          }
        }}
      >
        <div>
          <p className="dropzone-title">Drop `.xml`, `.mjcf`, `.urdf`, `.usda`, `.usd`, `.usdc`, or `.zip` here</p>
          <p className="dropzone-text">
            MuJoCo assets stream live pose frames; Isaac assets stream stage
            hierarchy, renderable geometry, and transform updates from a
            headless `env_isaaclab` session.
          </p>
        </div>
        <button
          className="dropzone-button"
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          Choose File
        </button>
      </section>

      <section className="dashboard">
        <article className="panel preview-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Live Preview</p>
              <h2>{currentRuntime ? RUNTIME_LABELS[currentRuntime] : "No Runtime"}</h2>
            </div>
            {analysis?.availableRuntimes.length ? (
              <div className="runtime-switch">
                {analysis.availableRuntimes.map((runtime) => (
                  <button
                    key={runtime}
                    className={runtime === currentRuntime ? "runtime-pill active" : "runtime-pill"}
                    onClick={() => setActiveRuntime(runtime)}
                    type="button"
                  >
                    {RUNTIME_LABELS[runtime]}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {currentRuntime === "mujoco" ? (
            <MujocoPreview
              scene={currentMujocoScene}
              manifest={mujocoManifest}
              pose={mujocoPose}
              frame={mujocoFrame}
            />
          ) : currentRuntime === "isaacsim" ? (
            isaacManifest ? (
              <IsaacStagePreview
                manifest={isaacManifest}
                frame={isaacFrame}
                assetBaseUrl={isaacSession?.assetBaseUrl || null}
              />
            ) : (
              <IsaacPreviewState
                session={isaacSession}
                sessionStatus={isaacSessionStatus}
                error={isaacSessionError}
              />
            )
          ) : (
            <EmptyPreviewState />
          )}
        </article>

        <article className="panel decision-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Runtime Decision</p>
              <h2>Inspector</h2>
            </div>
            <StatusBadge isBusy={isBusy} />
          </div>

          <dl className="stats-grid">
            <Stat label="Source" value={analysis?.sourceName || "--"} />
            <Stat label="Kind" value={analysis?.sourceKind || "--"} />
            <Stat
              label="Default Runtime"
              value={analysis?.defaultRuntime ? RUNTIME_LABELS[analysis.defaultRuntime] : "--"}
            />
            <Stat label="Entries Scanned" value={String(analysis?.entries.length ?? 0)} />
          </dl>

          {error ? <p className="error-callout">{error}</p> : null}

          {currentRuntime === "mujoco" ? (
            <MujocoRuntimeCard
              session={mujocoSession}
              sessionStatus={mujocoSessionStatus}
              connectionStatus={mujocoConnectionStatus}
              manifest={mujocoManifest}
              error={mujocoSessionError}
            />
          ) : currentRuntime === "isaacsim" ? (
            <IsaacRuntimeCard
              session={isaacSession}
              sessionStatus={isaacSessionStatus}
              connectionStatus={isaacConnectionStatus}
              manifest={isaacManifest}
              error={isaacSessionError}
            />
          ) : null}

          {currentRuntime === "mujoco" &&
          analysis?.runtimeCandidates.mujoco &&
          analysis.runtimeCandidates.mujoco.length > 1 ? (
            <div className="entry-selector">
              <label className="entry-selector-label" htmlFor="mujoco-entry-select">
                MuJoCo Entry XML
              </label>
              <select
                id="mujoco-entry-select"
                className="entry-select"
                value={selectedMujocoEntryPath || ""}
                onChange={(event) => setSelectedMujocoEntryPath(event.target.value || null)}
              >
                {analysis.runtimeCandidates.mujoco.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.path}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {currentRuntime === "isaacsim" &&
          analysis?.runtimeCandidates.isaacsim &&
          analysis.runtimeCandidates.isaacsim.length > 1 ? (
            <div className="entry-selector">
              <label className="entry-selector-label" htmlFor="isaac-entry-select">
                Isaac Asset
              </label>
              <select
                id="isaac-entry-select"
                className="entry-select"
                value={selectedIsaacEntryPath || ""}
                onChange={(event) => setSelectedIsaacEntryPath(event.target.value || null)}
              >
                {analysis.runtimeCandidates.isaacsim.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.path}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {currentWarnings.length ? (
            <div className="callout-list">
              {currentWarnings.map((warning) => (
                <p key={warning} className="warning-callout">
                  {warning}
                </p>
              ))}
            </div>
          ) : (
            <p className="muted-line">No routing warnings for the current asset.</p>
          )}

          {analysis && analysis.entries.length > COLLAPSED_ENTRY_COUNT ? (
            <div className="entry-list-header">
              <p className="muted-line">
                Showing {visibleEntries.length} of {analysis.entries.length} files
              </p>
              <button
                className="entry-toggle-button"
                onClick={() => setShowAllEntries((value) => !value)}
                type="button"
              >
                {showAllEntries ? "Collapse" : "Show All"}
              </button>
            </div>
          ) : null}

          <div className="entry-list">
            {visibleEntries.map((entry) => (
              <EntryRow key={entry.path} entry={entry} />
            ))}
          </div>
        </article>

        <article className="panel details-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Details</p>
              <h2>{currentRuntime === "mujoco" ? "MJCF Summary" : "Isaac Asset Summary"}</h2>
            </div>
          </div>

          {currentRuntime === "mujoco" ? (
            <MjcfSummary
              scene={currentMujocoScene}
              entry={currentEntry}
              manifest={mujocoManifest}
              connectionStatus={mujocoConnectionStatus}
            />
          ) : currentRuntime === "isaacsim" ? (
            <IsaacStageSummary
              preview={currentIsaacPreview}
              entry={currentEntry}
              session={isaacSession}
              manifest={isaacManifest}
              connectionStatus={isaacConnectionStatus}
            />
          ) : (
            <p className="muted-line">
              Upload a MuJoCo or Isaac Sim asset to populate the detail panel.
            </p>
          )}
        </article>
      </section>
    </main>
  );
}

function EntryRow({ entry }: { entry: AssetFileEntry }) {
  return (
    <div className="entry-row">
      <div>
        <p className="entry-path">{entry.path}</p>
        <p className="entry-size">{formatBytes(entry.size)}</p>
      </div>
      <span className={`entry-kind entry-kind-${entry.kind.replace(/[^a-z]/g, "")}`}>
        {entry.kind}
      </span>
    </div>
  );
}

function MjcfSummary({
  scene,
  entry,
  manifest,
  connectionStatus
}: {
  scene: AssetAnalysis["mujocoScene"];
  entry: AssetFileEntry | null;
  manifest: MujocoModelManifestMessage | null;
  connectionStatus: ConnectionStatus;
}) {
  if (!scene) {
    return (
      <p className="muted-line">
        MJCF route is selected, but the XML parser did not produce a renderable
        scene.
      </p>
    );
  }

  return (
    <>
      <dl className="stats-grid">
        <Stat label="Model" value={scene.modelName} />
        <Stat label="Bodies" value={String(scene.bodyCount)} />
        <Stat label="Geoms" value={String(scene.geomCount)} />
        <Stat label="Visible" value={String(scene.renderedGeomCount)} />
        <Stat label="Mesh Geoms" value={String(scene.meshGeomCount)} />
        <Stat label="Mesh Ready" value={String(scene.resolvedMeshGeomCount)} />
        <Stat label="WS Bodies" value={String(manifest?.body_count ?? 0)} />
        <Stat label="WS Geoms" value={String(manifest?.geom_count ?? 0)} />
      </dl>

      <p className="muted-line">Source entry: {entry?.path || "--"}</p>
      <p className="muted-line">WebSocket state: {connectionStatus}</p>

      {scene.unsupportedGeoms.length ? (
        <div className="code-card">
          <p className="code-card-title">Skipped Geoms</p>
          <pre>{scene.unsupportedGeoms.slice(0, 12).join("\n")}</pre>
        </div>
      ) : (
        <p className="muted-line">All detected MuJoCo geoms are renderable in this pass.</p>
      )}
    </>
  );
}

function IsaacStageSummary({
  preview,
  entry,
  session,
  manifest,
  connectionStatus
}: {
  preview: string | null;
  entry: AssetFileEntry | null;
  session: IsaacSessionInfo | null;
  manifest: IsaacStageManifestMessage | null;
  connectionStatus: ConnectionStatus;
}) {
  return (
    <>
      <dl className="stats-grid">
        <Stat label="Asset" value={entry?.path || "--"} />
        <Stat label="Prims" value={String(manifest?.prim_count ?? 0)} />
        <Stat label="Geometry" value={String(manifest?.geometry_count ?? 0)} />
        <Stat label="Renderable" value={String(manifest?.renderable_count ?? 0)} />
        <Stat label="Mesh Prims" value={String(manifest?.mesh_prim_count ?? 0)} />
        <Stat label="Up Axis" value={manifest?.up_axis || "--"} />
        <Stat
          label="Meters / Unit"
          value={
            typeof manifest?.meters_per_unit === "number"
              ? String(manifest.meters_per_unit)
              : "--"
          }
        />
        <Stat label="WS State" value={connectionStatus} />
      </dl>

      <p className="muted-line">Source entry: {entry?.path || "--"}</p>
      {session ? <p className="muted-line">Bridge status: {session.statusMessage}</p> : null}
      {manifest?.default_prim ? (
        <p className="muted-line">Default prim: {manifest.default_prim}</p>
      ) : null}
      {session?.recentLogs.length ? (
        <div className="code-card">
          <p className="code-card-title">Recent Bridge Logs</p>
          <pre>{session.recentLogs.join("\n")}</pre>
        </div>
      ) : null}
      <div className="code-card">
        <p className="code-card-title">Asset Preview</p>
        <pre>{preview || "Text preview unavailable for this Isaac asset."}</pre>
      </div>
    </>
  );
}

function IsaacRuntimeCard({
  session,
  sessionStatus,
  connectionStatus,
  manifest,
  error
}: {
  session: IsaacSessionInfo | null;
  sessionStatus: SessionStatus;
  connectionStatus: ConnectionStatus;
  manifest: IsaacStageManifestMessage | null;
  error: string | null;
}) {
  return (
    <div className="runtime-card isaac-card">
      <div className="runtime-card-header">
        <div>
          <p className="panel-kicker">Bridge Session</p>
          <h3>Isaac Stage Bridge</h3>
        </div>
        <span className={`session-pill session-pill-${sessionStatus}`}>{sessionStatus}</span>
      </div>

      <dl className="runtime-meta">
        <div>
          <dt>Socket</dt>
          <dd>{connectionStatus}</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd>{session?.phase || "--"}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{session?.sessionId || "--"}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{session?.expiresAt || "--"}</dd>
        </div>
        <div>
          <dt>Stage Prims</dt>
          <dd>{manifest?.prim_count ?? "--"}</dd>
        </div>
      </dl>

      {session ? <p className="muted-line">{session.statusMessage}</p> : null}
      {session?.wsUrl ? <p className="muted-line">WS: {session.wsUrl}</p> : null}
      {session?.readyAt ? <p className="muted-line">Ready at: {session.readyAt}</p> : null}
      {manifest ? (
        <p className="muted-line">
          Default prim: {manifest.default_prim || "--"} / geometry: {manifest.geometry_count} /
          renderable: {manifest.renderable_count} / meshes: {manifest.mesh_prim_count}
        </p>
      ) : null}
      {session?.recentLogs.length ? (
        <div className="code-card">
          <p className="code-card-title">Recent Bridge Logs</p>
          <pre>{session.recentLogs.join("\n")}</pre>
        </div>
      ) : null}
      {error ? <p className="error-callout runtime-error">{error}</p> : null}
    </div>
  );
}

function MujocoRuntimeCard({
  session,
  sessionStatus,
  connectionStatus,
  manifest,
  error
}: {
  session: MujocoSessionInfo | null;
  sessionStatus: SessionStatus;
  connectionStatus: ConnectionStatus;
  manifest: MujocoModelManifestMessage | null;
  error: string | null;
}) {
  return (
    <div className="runtime-card">
      <div className="runtime-card-header">
        <div>
          <p className="panel-kicker">Bridge Session</p>
          <h3>MuJoCo Backend</h3>
        </div>
        <span className={`session-pill session-pill-${sessionStatus}`}>{sessionStatus}</span>
      </div>

      <dl className="runtime-meta">
        <div>
          <dt>Socket</dt>
          <dd>{connectionStatus}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{session?.sessionId || "--"}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{session?.expiresAt || "--"}</dd>
        </div>
        <div>
          <dt>Live Geoms</dt>
          <dd>{manifest?.geom_count ?? "--"}</dd>
        </div>
      </dl>

      {session?.wsUrl ? <p className="muted-line">WS: {session.wsUrl}</p> : null}
      {error ? <p className="error-callout runtime-error">{error}</p> : null}
    </div>
  );
}

function IsaacPreviewState({
  session,
  sessionStatus,
  error
}: {
  session: IsaacSessionInfo | null;
  sessionStatus: SessionStatus;
  error: string | null;
}) {
  const title =
    sessionStatus === "starting"
      ? "Isaac Sim is booting"
      : sessionStatus === "error"
        ? "Isaac Sim startup failed"
        : "Awaiting Isaac stage manifest";
  const message =
    error ||
    session?.statusMessage ||
    "The Isaac session has been created and is waiting for the bridge to report progress.";

  return (
    <div className="empty-preview">
      <p className="panel-kicker">Isaac Startup</p>
      <h3>{title}</h3>
      <p className="hero-text">{message}</p>
      {session?.selectedEntryPath ? (
        <p className="hero-text">Asset: {session.selectedEntryPath}</p>
      ) : null}
      {session?.recentLogs.length ? (
        <div className="code-card">
          <p className="code-card-title">Recent Bridge Logs</p>
          <pre>{session.recentLogs.join("\n")}</pre>
        </div>
      ) : null}
    </div>
  );
}

function EmptyPreviewState() {
  return (
    <div className="empty-preview">
      <p className="panel-kicker">Awaiting supported asset</p>
      <h3>No MuJoCo or USD entry was resolved</h3>
      <p className="hero-text">
        Upload a compatible XML, MJCF, USD stage, or zip archive to activate the
        corresponding simulator branch.
      </p>
    </div>
  );
}

function StatusBadge({ isBusy }: { isBusy: boolean }) {
  return (
    <span className={isBusy ? "status-badge pending" : "status-badge ready"}>
      {isBusy ? "Inspecting" : "Ready"}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function resolveIsaacSessionStatus(session: IsaacSessionInfo): SessionStatus {
  if (session.status === "ready") {
    return "ready";
  }
  if (session.status === "error") {
    return "error";
  }
  return "starting";
}

function readApiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = payload.error;
    if (typeof error === "string" && error) {
      return error;
    }
  }
  return fallback;
}

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

async function deleteMujocoSession(sessionId: string) {
  try {
    await fetch(`/api/mujoco/sessions/${sessionId}`, { method: "DELETE" });
  } catch {
    return;
  }
}

async function deleteIsaacSession(sessionId: string) {
  try {
    await fetch(`/api/isaac/sessions/${sessionId}`, { method: "DELETE" });
  } catch {
    return;
  }
}
