"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import { DEFAULT_PHONE_CONFIG, createPlaceholderModel, formatPhoneConfig } from "../lib/defaults";
import { ensureManifoldRuntime } from "../lib/manifold-runtime";
import { buildPhoneFramePreview } from "../lib/phone-frame";
import { pickObjFileFromFolder, readObjFile } from "../lib/obj-loader";
import type {
  BuildPreviewResult,
  LogEntry,
  ParsedPhoneConfig,
  PhoneConfig,
  PhoneFrameFeature,
  PhoneFrameFeaturePosition,
  PhoneRibFeature,
  SourceModel
} from "../lib/types";
import PhonePreview from "../components/phone-preview";

const MAX_LOGS = 14;
const INITIAL_LOGS: LogEntry[] = [
  {
    id: "boot-placeholder",
    level: "info",
    message: "Loaded placeholder phone body. Upload a folder to replace it.",
    time: "--:--:--"
  }
];

type StatusTone = "idle" | "ready" | "warning" | "error" | "loading";

export default function AntennaStudio() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [editorValue, setEditorValue] = useState(() => formatPhoneConfig(DEFAULT_PHONE_CONFIG));
  const deferredEditorValue = useDeferredValue(editorValue);
  const [sourceModel, setSourceModel] = useState<SourceModel>(() => createPlaceholderModel());
  const [preview, setPreview] = useState<BuildPreviewResult | null>(null);
  const [status, setStatus] = useState<{ tone: StatusTone; text: string }>({
    tone: "idle",
    text: "Using bundled placeholder phone body"
  });
  const [logs, setLogs] = useState<LogEntry[]>(() => INITIAL_LOGS);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) {
      return;
    }
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const parsed = parsePhoneConfig(deferredEditorValue);
      if (!parsed.ok) {
        setStatus({ tone: "error", text: parsed.error });
        return;
      }

      setStatus({ tone: "loading", text: "Rebuilding preview" });

      try {
        const runtime = await ensureManifoldRuntime();
        const nextPreview = buildPhoneFramePreview({
          config: parsed.value,
          runtime,
          sourceModel
        });

        if (cancelled) {
          disposePreview(nextPreview);
          return;
        }

        startTransition(() => {
          setPreview(nextPreview);
          setStatus({
            tone: nextPreview.warnings.length > 0 ? "warning" : "ready",
            text: nextPreview.warnings[0] ?? "Preview ready"
          });
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "Preview build failed";
        setStatus({ tone: "error", text: message });
        pushLog(setLogs, "error", message);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [deferredEditorValue, sourceModel]);

  const metrics = useMemo(() => {
    const sourceStats = sourceModel.metrics;
    const previewStats = preview?.metrics;

    return [
      { label: "Source", value: sourceModel.label },
      {
        label: "Dims",
        value: `${formatNumber(sourceStats.size.x)} × ${formatNumber(sourceStats.size.y)} × ${formatNumber(sourceStats.size.z)}`
      },
      {
        label: "Triangles",
        value: previewStats
          ? `${previewStats.originalTriangles} / ${previewStats.frameTriangles}`
          : `${sourceStats.triangles}`
      },
      { label: "Contours", value: previewStats ? `${previewStats.contours}` : "0" }
    ];
  }, [preview, sourceModel]);

  const frameFeatureHint = useMemo(() => {
    const parsed = parsePhoneConfig(deferredEditorValue);
    if (!parsed.ok) {
      return "distance is measured from the midpoint of the selected edge. rib.thickness controls z thickness and rib.offset shifts it along z.";
    }
    return describeFrameFeatures(parsed.value.frame.seams, parsed.value.frame.ribs);
  }, [deferredEditorValue]);

  return (
    <main className="shell">
      <section className="hero panel">
        <div>
          <p className="eyebrow">antenna-smart</p>
          <h1>Phone Frame Studio</h1>
          <p className="hero-copy">
            Left side edits the JSON contract. Right side renders the original
            body and the derived frame built from OBJ input plus manifold
            booleans.
          </p>
        </div>
        <div className={`status-pill ${status.tone}`}>{status.text}</div>
      </section>

      <section className="workspace">
        <section className="panel editor-panel">
          <header className="panel-toolbar">
            <div className="toolbar-copy">
              <p className="panel-label">Input</p>
              <strong>JSON + folder upload</strong>
              <span>{frameFeatureHint}</span>
            </div>
            <div className="toolbar-actions">
              <button
                className="toolbar-button"
                onClick={() => {
                  setEditorValue(formatPhoneConfig(DEFAULT_PHONE_CONFIG));
                  pushLog(setLogs, "info", "Reset JSON to the default preset.");
                }}
                type="button"
              >
                Reset JSON
              </button>
              <button
                className="toolbar-button secondary"
                onClick={() => {
                  setSourceModel(createPlaceholderModel());
                  pushLog(setLogs, "warning", "Switched back to the placeholder phone body.");
                }}
                type="button"
              >
                Use sample body
              </button>
              <button
                className="toolbar-button secondary"
                onClick={() => folderInputRef.current?.click()}
                type="button"
              >
                Upload folder
              </button>
              <input
                className="hidden-input"
                multiple
                onChange={(event) => void handleFolderChange(event.currentTarget.files)}
                ref={folderInputRef}
                type="file"
              />
            </div>
          </header>

          <div className="editor-wrap">
            <textarea
              aria-label="Phone JSON"
              className="json-editor"
              onChange={(event) => setEditorValue(event.currentTarget.value)}
              spellCheck={false}
              value={editorValue}
            />
          </div>

          <aside className="log-panel">
            <div className="log-header">
              <p className="panel-label">Activity</p>
              <span>{sourceModel.label}</span>
            </div>
            {logs.map((entry) => (
              <div className="log-row" key={entry.id}>
                <span className="log-time">{entry.time}</span>
                <span className={`log-level ${entry.level}`}>{entry.level}</span>
                <span className="log-message">{entry.message}</span>
              </div>
            ))}
          </aside>
        </section>

        <section className="panel viewport-panel">
          <header className="panel-toolbar">
            <div className="toolbar-copy">
              <p className="panel-label">Preview</p>
              <strong>OBJ body + generated frame</strong>
              <span>
                The preview assumes the smallest source axis is thickness and
                aligns it to <code>Z</code> before projecting to <code>XY</code>.
              </span>
            </div>
          </header>

          <div className="viewport-wrap">
            <PhonePreview preview={preview} sourceModel={sourceModel} />
            <div className="metric-grid">
              {metrics.map((metric) => (
                <article key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                </article>
              ))}
            </div>
            <div className="legend">
              <span>
                <i className="legend-chip original" />
                Original body
              </span>
              <span>
                <i className="legend-chip frame" />
                Frame result
              </span>
              <span>
                <i className="legend-chip seam" />
                Seam cuts baked into the shell
              </span>
              <span>
                <i className="legend-chip rib" />
                Ribs are unioned into the frame shell
              </span>
            </div>
          </div>
        </section>
      </section>
    </main>
  );

  async function handleFolderChange(fileList: FileList | null) {
    if (!fileList?.length) {
      return;
    }

    const objFile = pickObjFileFromFolder(Array.from(fileList));
    if (!objFile) {
      setStatus({ tone: "error", text: "No OBJ file found in the uploaded folder" });
      pushLog(setLogs, "error", "Folder upload did not include any .obj files.");
      return;
    }

    try {
      setStatus({ tone: "loading", text: `Reading ${objFile.name}` });
      const nextSource = await readObjFile(objFile);
      startTransition(() => {
        setSourceModel(nextSource);
        pushLog(
          setLogs,
          "info",
          `Loaded ${nextSource.label} with ${nextSource.metrics.triangles} triangles.`
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "OBJ import failed";
      setStatus({ tone: "error", text: message });
      pushLog(setLogs, "error", message);
    } finally {
      if (folderInputRef.current) {
        folderInputRef.current.value = "";
      }
    }
  }
}

function parsePhoneConfig(source: string): ParsedPhoneConfig {
  try {
    const raw = JSON.parse(source) as Partial<PhoneConfig>;
    const thickness = raw.frame?.thickness;
    if (!Number.isFinite(thickness) || (thickness ?? 0) <= 0) {
      return { ok: false, error: "frame.thickness must be a positive number" };
    }

    const seams = raw.frame?.seams;
    if (!Array.isArray(seams)) {
      return { ok: false, error: "frame.seams must be an array" };
    }

    const normalizedSeams = normalizeSeams(seams);

    const ribs = raw.frame?.ribs;
    if (ribs !== undefined && !Array.isArray(ribs)) {
      return { ok: false, error: "frame.ribs must be an array when provided" };
    }

    const normalizedRibs = normalizeRibs(ribs ?? []);

    const normalizedThickness = Number(thickness);

    return {
      ok: true,
      value: {
        frame: {
          thickness: normalizedThickness,
          seams: normalizedSeams,
          ribs: normalizedRibs
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON"
    };
  }
}

function normalizeSeams(candidates: unknown[]): PhoneFrameFeature[] {
  return candidates.map((candidate, index) => {
    const feature = candidate as Partial<PhoneFrameFeature> | null;
    const width = feature?.width;
    const distance = feature?.distance;
    const position = feature?.position;
    if (
      !feature ||
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof distance !== "number" ||
      !Number.isFinite(distance) ||
      !isPhoneFrameFeaturePosition(position)
    ) {
      throw new Error(`Invalid seam at index ${index}`);
    }

    return {
      width: Number(width),
      distance: Number(distance),
      position
    };
  });
}

function normalizeRibs(candidates: unknown[]): PhoneRibFeature[] {
  return candidates.map((candidate, index) => {
    const feature = candidate as (Partial<PhoneRibFeature> & {
      thickeness?: unknown;
    }) | null;
    const width = feature?.width;
    const distance = feature?.distance;
    const position = feature?.position;
    const thickness =
      typeof feature?.thickness === "number"
        ? feature.thickness
        : typeof feature?.thickeness === "number"
          ? feature.thickeness
          : undefined;
    const offset = typeof feature?.offset === "number" ? feature.offset : 0;

    if (
      !feature ||
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof distance !== "number" ||
      !Number.isFinite(distance) ||
      !isPhoneFrameFeaturePosition(position) ||
      typeof thickness !== "number" ||
      !Number.isFinite(thickness) ||
      thickness <= 0 ||
      !Number.isFinite(offset)
    ) {
      throw new Error(`Invalid rib at index ${index}`);
    }

    return {
      width: Number(width),
      distance: Number(distance),
      position,
      thickness: Number(thickness),
      offset: Number(offset)
    };
  });
}

function isPhoneFrameFeaturePosition(value: unknown): value is PhoneFrameFeaturePosition {
  return value === "top" || value === "left" || value === "right" || value === "bottom";
}

function createLog(level: LogEntry["level"], message: string): LogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    level,
    message,
    time: formatLogTime(new Date())
  };
}

function pushLog(
  setLogs: Dispatch<SetStateAction<LogEntry[]>>,
  level: LogEntry["level"],
  message: string
) {
  setLogs((current) => [createLog(level, message), ...current].slice(0, MAX_LOGS));
}

function describeFrameFeatures(
  seams: PhoneConfig["frame"]["seams"],
  ribs: PhoneConfig["frame"]["ribs"]
) {
  if (seams.length === 0 && ribs.length === 0) {
    return "No seams or ribs configured. distance is measured from the edge midpoint. rib.thickness controls z thickness and rib.offset shifts it along z.";
  }
  return `Configured ${seams.length} seam cuts and ${ribs.length} ribs. distance is measured from the edge midpoint. rib.thickness controls z thickness and rib.offset shifts it along z.`;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(value >= 10 ? 1 : 2) : "0";
}

function formatLogTime(value: Date) {
  return [value.getHours(), value.getMinutes(), value.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function disposePreview(preview: BuildPreviewResult | null) {
  preview?.sourceGeometry.dispose();
  preview?.frameGeometry.dispose();
}
