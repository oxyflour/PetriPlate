"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent
} from "react";
import {
  DEFAULT_HEIGHT_WGSL,
  HEIGHT_PRESETS
} from "../src/renderer/defaultHeight";
import {
  DEBUG_VIEWS,
  SHADING_MODES,
  type DebugViewId,
  type ShadingModeId
} from "../src/renderer/presets";
import {
  DEFAULT_CAMERA_DISTANCE_MM,
  DEFAULT_ENVIRONMENT_NAME,
  MAX_CAMERA_DISTANCE_MM,
  MIN_CAMERA_DISTANCE_MM,
  MetalPlateRenderer,
  type CompileMessage,
  type MetalPlateSnapshot
} from "../src/renderer/MetalPlateRenderer";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false
});

type RuntimeState = "booting" | "ready" | "unsupported" | "error";
type CompileState = "idle" | "compiling" | "ok" | "error";
type LogLevel = "info" | "warning" | "error";

type DragState = {
  active: boolean;
  x: number;
  y: number;
};

type LogEntry = {
  id: number;
  level: LogLevel;
  text: string;
  time: string;
};

const EMPTY_SNAPSHOT: MetalPlateSnapshot = {
  centerFootprintMm: 0,
  centerFootprintCells: 0,
  centerRoughness: 0.06,
  centerAspect: 1,
  cameraDistanceMm: DEFAULT_CAMERA_DISTANCE_MM
};

function nowLabel(): string {
  const date = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatCompileMessage(message: CompileMessage): string {
  const lineSuffix =
    typeof message.line === "number" && typeof message.column === "number"
      ? ` (${message.line}:${message.column})`
      : "";
  return `${message.source}${lineSuffix} ${message.text}`;
}

export default function PlateLab() {
  const defaultPreset = HEIGHT_PRESETS[0];
  const [source, setSource] = useState<string>(defaultPreset?.source ?? DEFAULT_HEIGHT_WGSL);
  const [presetId, setPresetId] = useState<string>(defaultPreset?.id ?? "");
  const [runtimeState, setRuntimeState] = useState<RuntimeState>("booting");
  const [runtimeMessage, setRuntimeMessage] = useState<string>("Initializing WebGPU.");
  const [compileState, setCompileState] = useState<CompileState>("idle");
  const [shadingMode, setShadingMode] = useState<ShadingModeId>("glint");
  const [debugView, setDebugView] = useState<DebugViewId>("beauty");
  const [snapshot, setSnapshot] = useState<MetalPlateSnapshot>(EMPTY_SNAPSHOT);
  const [zoomDistance, setZoomDistance] = useState<number>(DEFAULT_CAMERA_DISTANCE_MM);
  const [environmentLabel, setEnvironmentLabel] = useState<string>(
    DEFAULT_ENVIRONMENT_NAME
  );
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hdriInputRef = useRef<HTMLInputElement | null>(null);
  const rendererRef = useRef<MetalPlateRenderer | null>(null);
  const frameRef = useRef<number | null>(null);
  const compileTicketRef = useRef(0);
  const dragRef = useRef<DragState>({ active: false, x: 0, y: 0 });

  const addLog = useCallback((level: LogLevel, text: string) => {
    setLogs((prev) => {
      const next: LogEntry = {
        id: (prev.at(-1)?.id ?? 0) + 1,
        level,
        text,
        time: nowLabel()
      };
      return [...prev, next].slice(-120);
    });
  }, []);

  const presetById = useMemo(
    () => new Map(HEIGHT_PRESETS.map((preset) => [preset.id, preset])),
    []
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const renderer = new MetalPlateRenderer((message) => {
      setRuntimeState("error");
      setRuntimeMessage(message);
      addLog("error", `GPU runtime: ${message}`);
    });
    rendererRef.current = renderer;
    setZoomDistance(renderer.getDistance());

    let disposed = false;
    (async () => {
      const ok = await renderer.initialize(canvas);
      if (disposed) {
        return;
      }

      if (!ok) {
        setRuntimeState("unsupported");
        setRuntimeMessage("WebGPU is unavailable in this browser.");
        addLog("error", "WebGPU is unavailable in this browser.");
        return;
      }

      setRuntimeState("ready");
      setRuntimeMessage("Edit WGSL and rebuild macro moments plus the glint histogram in real time.");
      addLog("info", "WebGPU initialized.");

      const loop = (now: number) => {
        renderer.render(now * 0.001);
        frameRef.current = window.requestAnimationFrame(loop);
      };
      frameRef.current = window.requestAnimationFrame(loop);
    })().catch((error) => {
      if (disposed) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Failed to initialize renderer.";
      setRuntimeState("error");
      setRuntimeMessage(message);
      addLog("error", message);
    });

    const timer = window.setInterval(() => {
      const current = rendererRef.current?.getSnapshot();
      if (current) {
        setSnapshot(current);
        setZoomDistance(current.cameraDistanceMm);
      }
    }, 160);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [addLog]);

  useEffect(() => {
    rendererRef.current?.setDebugView(debugView);
  }, [debugView]);

  useEffect(() => {
    rendererRef.current?.setShadingMode(shadingMode);
  }, [shadingMode]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || runtimeState !== "ready") {
      return;
    }

    const ticket = ++compileTicketRef.current;
    setCompileState("compiling");
    const timer = window.setTimeout(async () => {
      const result = await renderer.compileHeightFunction(source);
      if (ticket !== compileTicketRef.current) {
        return;
      }

      if (!result.ok) {
        setCompileState("error");
        addLog("error", "WGSL compile failed. Keeping previous statistics.");
      } else {
        setCompileState("ok");
        addLog("info", "WGSL compiled. Rebuilt slope moments and glint histogram.");
      }

      for (const message of result.messages) {
        addLog(message.level, formatCompileMessage(message));
      }
    }, 260);

    return () => {
      window.clearTimeout(timer);
    };
  }, [addLog, runtimeState, source]);

  const applyPreset = useCallback(
    (nextId: string) => {
      const preset = presetById.get(nextId);
      if (!preset) {
        return;
      }
      setPresetId(nextId);
      setSource(preset.source);
      addLog("info", `Loaded preset: ${preset.label}`);
    },
    [addLog, presetById]
  );

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { active: true, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.active) {
      return;
    }

    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }

    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    dragRef.current = { active: true, x: event.clientX, y: event.clientY };
    renderer.orbit(dx, dy);
  };

  const endDrag = () => {
    dragRef.current.active = false;
  };

  const onZoomChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextDistance = Number(event.target.value);
    setZoomDistance(nextDistance);
    rendererRef.current?.setDistance(nextDistance);
  };

  const openHdriPicker = useCallback(() => {
    hdriInputRef.current?.click();
  }, []);

  const onHdriUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      const file = input.files?.[0];
      input.value = "";
      if (!file || runtimeState !== "ready") {
        return;
      }

      const renderer = rendererRef.current;
      if (!renderer) {
        return;
      }

      try {
        setEnvironmentBusy(true);
        addLog("info", `Loading HDRI: ${file.name}`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await renderer.loadEnvironmentBytes(bytes);
        setEnvironmentLabel(file.name);
        addLog("info", `Loaded HDRI: ${file.name}`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load uploaded HDRI.";
        addLog("error", message);
      } finally {
        setEnvironmentBusy(false);
      }
    },
    [addLog, runtimeState]
  );

  const resetEnvironment = useCallback(async () => {
    if (runtimeState !== "ready") {
      return;
    }

    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }

    try {
      setEnvironmentBusy(true);
      addLog("info", `Restoring default HDRI: ${DEFAULT_ENVIRONMENT_NAME}`);
      await renderer.loadDefaultEnvironment();
      setEnvironmentLabel(DEFAULT_ENVIRONMENT_NAME);
      addLog("info", `Loaded HDRI: ${DEFAULT_ENVIRONMENT_NAME}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to restore default HDRI.";
      addLog("error", message);
    } finally {
      if (hdriInputRef.current) {
        hdriInputRef.current.value = "";
      }
      setEnvironmentBusy(false);
    }
  }, [addLog, runtimeState]);

  const activePreset = useMemo(
    () => HEIGHT_PRESETS.find((preset) => preset.id === presetId),
    [presetId]
  );
  const activeShadingMode = useMemo(
    () => SHADING_MODES.find((mode) => mode.id === shadingMode),
    [shadingMode]
  );

  const statusLabel = useMemo(() => {
    if (runtimeState === "booting") {
      return "Booting WebGPU";
    }
    if (runtimeState === "unsupported") {
      return "WebGPU Unsupported";
    }
    if (runtimeState === "error") {
      return "Runtime Error";
    }
    if (compileState === "compiling") {
      return "Compiling WGSL";
    }
    if (compileState === "error") {
      return "Compile Error";
    }
    if (compileState === "ok") {
      return "Render Active";
    }
    return "Idle";
  }, [compileState, runtimeState]);

  const isErrorState =
    runtimeState === "unsupported" ||
    runtimeState === "error" ||
    compileState === "error";
  const canEditEnvironment = runtimeState === "ready" && !environmentBusy;

  return (
    <main className="shell shell-editor">
      <header className="topbar">
        <div>
          <div className="eyebrow">mega-gpu / wgsl micro-height lab</div>
          <h1>WGSL Height Field Authoring</h1>
          <p className="topbar-copy">
            Edit <code>fn height(p: vec2&lt;f32&gt;) -&gt; f32</code> in millimeters.
            The right viewport rebuilds the macro SAT baseline plus the v0 glint
            histogram path, so you can A/B the two shading modes against the same
            procedural height field.
          </p>
        </div>
        <div className={`status-pill ${isErrorState ? "error" : ""}`}>{statusLabel}</div>
      </header>

      <section className="workspace workspace-editor">
        <article className="panel editor-panel">
          <header className="panel-toolbar panel-toolbar-editor">
            <div className="toolbar-group">
              <label htmlFor="preset-select" className="panel-label">
                Preset
              </label>
              <select
                id="preset-select"
                className="preset-select"
                value={presetId}
                onChange={(event) => applyPreset(event.target.value)}
              >
                {HEIGHT_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="toolbar-note">
              <strong>{activePreset?.label ?? "Custom Source"}</strong>
              <span>{activePreset?.description ?? runtimeMessage}</span>
            </div>
          </header>

          <div className="editor-wrap editor-wrap-monaco">
            <MonacoEditor
              height="100%"
              defaultLanguage="wgsl"
              theme="vs-dark"
              value={source}
              onChange={(value) => setSource(value ?? "")}
              options={{
                minimap: { enabled: false },
                smoothScrolling: true,
                automaticLayout: true,
                lineNumbersMinChars: 3,
                padding: { top: 12 },
                fontSize: 13,
                tabSize: 2,
                fontFamily: "IBM Plex Mono, Consolas, monospace",
                scrollBeyondLastLine: false
              }}
            />
          </div>

          <section className="log-panel">
            {logs.length === 0 ? (
              <p className="empty-log">No compiler or runtime messages yet.</p>
            ) : (
              logs.map((entry) => (
                <p key={entry.id} className="log-row">
                  <span className="log-time">{entry.time}</span>
                  <span className={`log-level ${entry.level}`}>{entry.level}</span>
                  <span>{entry.text}</span>
                </p>
              ))
            )}
          </section>
        </article>

        <section className="panel viewport-panel">
          <header className="panel-toolbar panel-toolbar-viewport">
            <div className="toolbar-group">
              <span className="panel-label">HDRI</span>
              <div className="toolbar-actions">
                <button
                  type="button"
                  className="toolbar-button"
                  onClick={openHdriPicker}
                  disabled={!canEditEnvironment}
                >
                  Upload .hdr
                </button>
                <button
                  type="button"
                  className="toolbar-button secondary"
                  onClick={resetEnvironment}
                  disabled={!canEditEnvironment}
                >
                  Default
                </button>
                <span className="toolbar-value">
                  {environmentBusy ? "Loading HDRI..." : environmentLabel}
                </span>
                <input
                  ref={hdriInputRef}
                  className="file-input-hidden"
                  type="file"
                  accept=".hdr"
                  onChange={onHdriUpload}
                />
              </div>
            </div>

            <div className="toolbar-group">
              <span className="panel-label">Shading</span>
              <div className="segmented">
                {SHADING_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={mode.id === shadingMode ? "selected" : ""}
                    onClick={() => setShadingMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <div className="toolbar-note toolbar-note-compact">
                <strong>{activeShadingMode?.label ?? "Glint"}</strong>
                <span>{activeShadingMode?.description ?? runtimeMessage}</span>
              </div>
            </div>

            <div className="toolbar-group">
              <span className="panel-label">Debug View</span>
              <div className="segmented">
                {DEBUG_VIEWS.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    className={view.id === debugView ? "selected" : ""}
                    onClick={() => setDebugView(view.id)}
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="toolbar-group zoom-group">
              <label htmlFor="zoom-slider" className="panel-label">
                Zoom
              </label>
              <div className="zoom-inline">
                <span>{zoomDistance.toFixed(1)} mm</span>
                <input
                  id="zoom-slider"
                  className="zoom-slider"
                  type="range"
                  min={MIN_CAMERA_DISTANCE_MM}
                  max={MAX_CAMERA_DISTANCE_MM}
                  step={0.5}
                  value={zoomDistance}
                  onChange={onZoomChange}
                />
              </div>
            </div>
          </header>

          <div className="viewport-wrap">
            <canvas
              ref={canvasRef}
              className="viewport"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerLeave={endDrag}
            />

            <div className="viewport-stats">
              <article>
                <span>Footprint</span>
                <strong>{snapshot.centerFootprintMm.toFixed(3)} mm</strong>
              </article>
              <article>
                <span>Coverage</span>
                <strong>{snapshot.centerFootprintCells.toFixed(2)} x</strong>
              </article>
              <article>
                <span>Roughness</span>
                <strong>{snapshot.centerRoughness.toFixed(3)}</strong>
              </article>
              <article>
                <span>Footprint Aspect</span>
                <strong>{snapshot.centerAspect.toFixed(2)}</strong>
              </article>
            </div>

            <div className="viewport-overlay">
              <span>Plate: 50 mm x 50 mm</span>
              <span>Input: WGSL height field</span>
              <span>Mode: {activeShadingMode?.label ?? "Glint"}</span>
              <span>HDRI: {environmentLabel}</span>
              <span>Drag in viewport to orbit</span>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
