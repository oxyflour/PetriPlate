"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent
} from "react";
import { HEIGHT_PRESETS } from "../src/renderer/defaultHeight";
import {
  TerrainRenderer,
  type CompileMessage
} from "../src/renderer/TerrainRenderer";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false
});

type RuntimeStatus = "booting" | "ready" | "unsupported" | "error";
type CompileStatus = "idle" | "compiling" | "ok" | "error";
type LogLevel = "info" | "warning" | "error";

type LogEntry = {
  id: number;
  level: LogLevel;
  time: string;
  text: string;
};

type DragState = {
  active: boolean;
  x: number;
  y: number;
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

export default function TerrainEditor() {
  const defaultPreset = HEIGHT_PRESETS[0];
  const [source, setSource] = useState<string>(defaultPreset?.source ?? "");
  const [presetId, setPresetId] = useState<string>(defaultPreset?.id ?? "");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>("booting");
  const [compileStatus, setCompileStatus] = useState<CompileStatus>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<TerrainRenderer | null>(null);
  const frameRef = useRef<number | null>(null);
  const compileTicketRef = useRef(0);
  const dragRef = useRef<DragState>({ active: false, x: 0, y: 0 });

  const addLog = useCallback((level: LogLevel, text: string) => {
    setLogs((prev) => {
      const next: LogEntry = {
        id: (prev.at(-1)?.id ?? 0) + 1,
        level,
        time: nowLabel(),
        text
      };
      const merged = [...prev, next];
      return merged.slice(-180);
    });
  }, []);

  const presetById = useMemo(
    () => new Map(HEIGHT_PRESETS.map((preset) => [preset.id, preset])),
    []
  );

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const renderer = new TerrainRenderer((message) => {
      addLog("error", `GPU runtime: ${message}`);
    });
    rendererRef.current = renderer;

    let disposed = false;
    (async () => {
      const ok = await renderer.initialize(canvas);
      if (disposed) {
        return;
      }

      if (!ok) {
        setRuntimeStatus("unsupported");
        addLog("error", "WebGPU is unavailable in this browser/device.");
        return;
      }

      setRuntimeStatus("ready");
      addLog("info", "WebGPU initialized. Quadtree hierarchy path is active.");

      const loop = (now: number) => {
        renderer.render(now * 0.001);
        frameRef.current = window.requestAnimationFrame(loop);
      };
      frameRef.current = window.requestAnimationFrame(loop);
    })().catch((error) => {
      if (disposed) {
        return;
      }
      setRuntimeStatus("error");
      addLog(
        "error",
        error instanceof Error ? error.message : "Failed to initialize renderer."
      );
    });

    return () => {
      disposed = true;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [addLog]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || runtimeStatus !== "ready") {
      return;
    }

    const ticket = ++compileTicketRef.current;
    setCompileStatus("compiling");

    const timer = window.setTimeout(async () => {
      const result = await renderer.compileHeightFunction(source);
      if (ticket !== compileTicketRef.current) {
        return;
      }

      if (!result.ok) {
        setCompileStatus("error");
        addLog("error", "WGSL compile failed. Keep rendering last successful frame.");
      } else {
        setCompileStatus("ok");
        addLog("info", "WGSL compiled. Rebuilt min/max hierarchy.");
      }

      for (const message of result.messages) {
        addLog(message.level, formatCompileMessage(message));
      }
    }, 360);

    return () => {
      window.clearTimeout(timer);
    };
  }, [addLog, runtimeStatus, source]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { active: true, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag.active) {
      return;
    }
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    dragRef.current = { active: true, x: event.clientX, y: event.clientY };
    renderer.orbit(dx, dy);
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current.active = false;
  }, []);

  const onWheel = useCallback((event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    rendererRef.current?.zoom(event.deltaY);
  }, []);

  const statusText = useMemo(() => {
    if (runtimeStatus === "booting") {
      return "Booting WebGPU";
    }
    if (runtimeStatus === "unsupported") {
      return "WebGPU Unsupported";
    }
    if (runtimeStatus === "error") {
      return "Runtime Error";
    }
    if (compileStatus === "compiling") {
      return "Compiling WGSL";
    }
    if (compileStatus === "error") {
      return "Compile Error (using previous frame)";
    }
    if (compileStatus === "ok") {
      return "Render Active (hierarchy rebuilt)";
    }
    return "Render Idle";
  }, [compileStatus, runtimeStatus]);

  const errorState =
    runtimeStatus === "unsupported" ||
    runtimeStatus === "error" ||
    compileStatus === "error";

  return (
    <main className="shell">
      <header className="header">
        <div>
          <h1>mega-brdf</h1>
          <p>
            Edit <code>fn height(p: vec2&lt;f32&gt;) -&gt; f32</code> and preview
            it with WebGPU quadtree acceleration and HDRI IBL.
          </p>
        </div>
        <div className="status-pill">
          <span className={`status-dot ${errorState ? "error" : ""}`} />
          {statusText}
        </div>
      </header>

      <section className="workspace">
        <article className="panel">
          <h2 className="panel-title">WGSL Height Function</h2>
          <div className="panel-toolbar">
            <label htmlFor="preset-select">Builtin Example</label>
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
          <div className="editor-wrap">
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
                padding: { top: 10 },
                fontSize: 13,
                tabSize: 2,
                fontFamily: "IBM Plex Mono, Consolas, monospace",
                scrollBeyondLastLine: false
              }}
            />
          </div>
        </article>

        <article className="panel">
          <h2 className="panel-title">WebGPU Viewport</h2>
          <div className="viewport-wrap">
            <canvas
              ref={canvasRef}
              className="viewport"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerLeave={endDrag}
              onWheel={onWheel}
            />
            <p className="hint">Drag: orbit | Wheel: zoom</p>
          </div>
        </article>
      </section>

      <section className="log-panel">
        {logs.length === 0 ? (
          <p className="empty-log">No logs yet.</p>
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
    </main>
  );
}
