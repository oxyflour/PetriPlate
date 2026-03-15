"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import { DEFAULT_SCHEMATIC, PRESET_SCHEMATICS, cloneSchematic } from "../lib/default-schematic";
import {
  canRemoveNode,
  createComponentNode,
  createEdge,
  createSolvePayload,
  edgeSignature,
  getComponentCount,
  getTerminalName,
  isComponentNode,
  isGroundNode,
  isPortNode
} from "../lib/schematic-graph";
import type {
  ComponentKind,
  ComponentUnit,
  Point,
  SchematicEdge,
  SchematicModel,
  SchematicNode,
  SchematicSolveModel,
  SolvePoint,
  SolveResponse,
  TerminalRef
} from "../lib/types";
import {
  formatComponentValue,
  formatDb,
  formatEngineering,
  formatFrequency,
  getDefaultUnit,
  getDefaultValue,
  getUnitOptions
} from "../lib/units";
import SchematicCanvas from "./schematic-canvas";

type StatusTone = "idle" | "loading" | "ready" | "warning" | "error";
type EditorView = "schematic" | "setup" | "properties";

type TraceDefinition = {
  id: string;
  label: string;
  color: string;
  valueAt: (point: SolvePoint) => number;
};

const MAX_COMPONENTS = 24;
const MAGNITUDE_TRACES: TraceDefinition[] = [
  {
    id: "s21",
    label: "S21 magnitude",
    color: "#ffb067",
    valueAt: (point) => point.s21Db
  },
  {
    id: "s11",
    label: "S11 magnitude",
    color: "#7be0d2",
    valueAt: (point) => point.s11Db
  }
];
const PHASE_TRACES: TraceDefinition[] = [
  {
    id: "s21-phase",
    label: "S21 phase",
    color: "#f8f4bf",
    valueAt: (point) => point.s21PhaseDeg
  },
  {
    id: "s11-phase",
    label: "S11 phase",
    color: "#7be0d2",
    valueAt: (point) => point.s11PhaseDeg
  }
];
const DEFAULT_PRESET_ID = PRESET_SCHEMATICS[0]?.id ?? "default";

export default function SchematicStudio() {
  const [schematic, setSchematic] = useState<SchematicModel>(() => cloneSchematic(DEFAULT_SCHEMATIC));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() =>
    findDefaultSelectedNodeId(DEFAULT_SCHEMATIC)
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const solvePayloadJson = useMemo(() => JSON.stringify(createSolvePayload(schematic)), [schematic]);
  const deferredSolvePayloadJson = useDeferredValue(solvePayloadJson);
  const deferredSolvePayload = useMemo(
    () => JSON.parse(deferredSolvePayloadJson) as SchematicSolveModel,
    [deferredSolvePayloadJson]
  );
  const [solution, setSolution] = useState<SolveResponse | null>(null);
  const [status, setStatus] = useState<{ tone: StatusTone; text: string }>({
    tone: "idle",
    text: "Ready to solve graph-connected RLC networks"
  });
  const [solverError, setSolverError] = useState<string | null>(null);
  const [editorView, setEditorView] = useState<EditorView>("schematic");
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_PRESET_ID);
  const [resultsView, setResultsView] = useState<"magnitude" | "phase" | "samples">("magnitude");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void solveCurrentSchematic(controller);
    }, 220);

    setStatus({
      tone: "loading",
      text: `Solving ${countSolveComponents(deferredSolvePayload)} components across ${deferredSolvePayload.edges.length} wires`
    });
    setSolverError(null);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [deferredSolvePayload, deferredSolvePayloadJson]);

  useEffect(() => {
    if (selectedNodeId && !schematic.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }

    if (selectedEdgeId && !schematic.edges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [schematic.edges, schematic.nodes, selectedEdgeId, selectedNodeId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      ) {
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      if (selectedEdgeId) {
        event.preventDefault();
        removeEdge(setSchematic, selectedEdgeId);
        setSelectedEdgeId(null);
        return;
      }

      const selectedNode = schematic.nodes.find((node) => node.id === selectedNodeId) ?? null;
      if (selectedNode && canRemoveNode(selectedNode)) {
        event.preventDefault();
        removeNode(setSchematic, selectedNode.id);
        setSelectedNodeId(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [schematic.nodes, selectedEdgeId, selectedNodeId]);

  const summary = solution?.summary;
  const points = solution?.points ?? [];
  const warnings = solution?.warnings ?? [];
  const sampledRows = sampleRows(points, 12);
  const componentCount = getComponentCount(schematic.nodes);
  const componentLimitReached = componentCount >= MAX_COMPONENTS;
  const selectedNode = selectedNodeId
    ? schematic.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const selectedEdge = selectedEdgeId
    ? schematic.edges.find((edge) => edge.id === selectedEdgeId) ?? null
    : null;
  const nodeMap = useMemo(() => new Map(schematic.nodes.map((node) => [node.id, node])), [schematic.nodes]);
  const sweepSummary = formatSweepSummary(schematic);
  const selectionSummary = describeWorkspaceSelection(selectedNode, selectedEdge, nodeMap);
  const solverMode = solverError
    ? "Fault"
    : warnings.length > 0
      ? "Warning"
      : solution
        ? "Nominal"
        : "Idle";
  const activePreset = PRESET_SCHEMATICS.find((preset) => preset.id === selectedPresetId) ?? PRESET_SCHEMATICS[0];
  const editorViewCopy = getEditorViewCopy(editorView);
  const appTitleHint = `${schematic.name} · ${sweepSummary} · ${componentCount} comps · ${schematic.edges.length} wires · ${selectionSummary}`;
  const resultsTitleHint = `Solved against the active graph topology. ${points.length} samples. ${warnings.length} warnings.`;
  const inspectorPanel = selectedNode ? (
    <NodeInspector
      connectionCount={countNodeConnections(selectedNode.id, schematic.edges)}
      node={selectedNode}
      onRemoveNode={() => {
        removeNode(setSchematic, selectedNode.id);
        setSelectedNodeId(null);
      }}
      onUpdateNode={(patch) => updateNode(setSchematic, selectedNode.id, patch)}
    />
  ) : selectedEdge ? (
    <EdgeInspector
      edge={selectedEdge}
      nodeMap={nodeMap}
      onDelete={() => {
        removeEdge(setSchematic, selectedEdge.id);
        setSelectedEdgeId(null);
      }}
    />
  ) : componentCount === 0 ? (
    <div className="empty-state">
      <strong>Empty graph</strong>
      <span>Drag a component into the canvas, then wire it between P1, P2, and ground.</span>
    </div>
  ) : (
    <div className="empty-state">
      <strong>No selection</strong>
      <span>Select a node or a wire on the canvas to edit or remove it.</span>
    </div>
  );

  function replaceSchematic(nextSchematic: SchematicModel) {
    const resolved = cloneSchematic(nextSchematic);
    setSchematic(resolved);
    setSelectedNodeId(findDefaultSelectedNodeId(resolved));
    setSelectedEdgeId(null);
    setCanvasRevision((current) => current + 1);
  }

  return (
    <main className="studio-shell">
      <header className="app-chrome panel">
        <div className="app-titlebar" title={appTitleHint}>
          <div className="app-brand">
            <span className="app-badge">PetriPlate</span>
            <div className="app-title-copy">
              <strong>RF Network Workbench</strong>
              <span title={appTitleHint}>{schematic.name}</span>
            </div>
          </div>
          <div className="app-title-meta">
            <span className="title-meta-chip" title={summary?.topologyLabel ?? "Topology pending"}>
              {summary?.topologyLabel ?? "Pending"}
            </span>
            <div className={`status-pill ${status.tone}`} title={status.text}>
              {solverMode}
            </div>
          </div>
        </div>
      </header>

      <section className="workspace">
        <section className="panel editor-panel">
          <header className="section-head" title={editorViewCopy.title}>
            <div className="section-tabs" aria-label="Editor panels">
              <button
                className={`section-tab ${editorView === "schematic" ? "active" : ""}`}
                onClick={() => setEditorView("schematic")}
                type="button"
              >
                Schematic Editor
              </button>
              <button
                className={`section-tab ${editorView === "setup" ? "active" : ""}`}
                onClick={() => setEditorView("setup")}
                type="button"
              >
                Network Setup
              </button>
              <button
                className={`section-tab ${editorView === "properties" ? "active" : ""}`}
                onClick={() => setEditorView("properties")}
                type="button"
              >
                Properties
              </button>
            </div>
            <button
              className="ghost-button"
              onClick={() => {
                setSelectedPresetId(DEFAULT_PRESET_ID);
                replaceSchematic(DEFAULT_SCHEMATIC);
              }}
              type="button"
            >
              Reset Workspace
            </button>
          </header>

          {editorView === "setup" ? (
            <div className="editor-mode-panel scroll-panel">
              <div className="editor-grid">
                <label className="field">
                  <span>Name</span>
                  <input
                    onChange={(event) => {
                      const nextName = event.currentTarget.value;
                      setSchematic((current) => ({ ...current, name: nextName }));
                    }}
                    type="text"
                    value={schematic.name}
                  />
                </label>
                <label className="field">
                  <span>Port Z0</span>
                  <input
                    min="1"
                    onChange={(event) =>
                      updateSweepField(setSchematic, "portImpedanceOhm", event.currentTarget.value, 50)
                    }
                    step="1"
                    type="number"
                    value={schematic.sweep.portImpedanceOhm}
                  />
                </label>
                <label className="field">
                  <span>Start GHz</span>
                  <input
                    min="0.01"
                    onChange={(event) =>
                      updateSweepField(setSchematic, "startGhz", event.currentTarget.value, 0.1)
                    }
                    step="0.01"
                    type="number"
                    value={schematic.sweep.startGhz}
                  />
                </label>
                <label className="field">
                  <span>Stop GHz</span>
                  <input
                    min="0.02"
                    onChange={(event) =>
                      updateSweepField(setSchematic, "stopGhz", event.currentTarget.value, 12)
                    }
                    step="0.01"
                    type="number"
                    value={schematic.sweep.stopGhz}
                  />
                </label>
                <label className="field">
                  <span>Points</span>
                  <input
                    min="11"
                    onChange={(event) =>
                      updateSweepField(setSchematic, "points", event.currentTarget.value, 241)
                    }
                    step="10"
                    type="number"
                    value={schematic.sweep.points}
                  />
                </label>
              </div>

              <div className="button-strip preset-rack">
                <span className="rack-label">Presets</span>
                <div className="preset-selector" role="tablist" aria-label="Preset schematics">
                  {PRESET_SCHEMATICS.map((preset) => (
                    <button
                      aria-selected={preset.id === activePreset?.id}
                      className={`preset-button compact ${preset.id === activePreset?.id ? "active" : ""}`}
                      key={preset.id}
                      onClick={() => {
                        setSelectedPresetId(preset.id);
                        replaceSchematic(preset.schematic);
                      }}
                      role="tab"
                      title={preset.description}
                      type="button"
                    >
                      <strong>{preset.label}</strong>
                    </button>
                  ))}
                </div>
                <span className="preset-summary">{activePreset?.description}</span>
              </div>
            </div>
          ) : null}

          {editorView === "schematic" ? (
            <div className="editor-mode-panel">
              <SchematicCanvas
                componentLimitReached={componentLimitReached}
                edges={schematic.edges}
                layoutVersion={canvasRevision}
                nodes={schematic.nodes}
                onCreateComponent={(kind, position) =>
                  addComponentNode(
                    setSchematic,
                    setSelectedNodeId,
                    setSelectedEdgeId,
                    kind,
                    position
                  )
                }
                onCreateEdge={(from, to) =>
                  addEdge(setSchematic, setSelectedNodeId, setSelectedEdgeId, from, to)
                }
                onDeleteEdge={(edgeId) => {
                  removeEdge(setSchematic, edgeId);
                  setSelectedEdgeId((current) => (current === edgeId ? null : current));
                }}
                onMoveNode={(nodeId, position) => updateNodePosition(setSchematic, nodeId, position)}
                onSelectEdge={(edgeId) => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(edgeId);
                }}
                onSelectNode={(nodeId) => {
                  setSelectedEdgeId(null);
                  setSelectedNodeId(nodeId);
                }}
                portImpedance={schematic.sweep.portImpedanceOhm}
                selectedEdgeId={selectedEdgeId}
                selectedNodeId={selectedNodeId}
              />
            </div>
          ) : null}

          {editorView === "properties" ? (
            <div className="editor-mode-panel scroll-panel">
              <div className="selected-component-panel properties-panel">{inspectorPanel}</div>
            </div>
          ) : null}
        </section>

        <section className="panel results-panel">
          <header className="section-head" title={resultsTitleHint}>
            <div className="section-tabs" aria-label="Result panels">
              <button
                className={`section-tab ${resultsView === "magnitude" ? "active" : ""}`}
                onClick={() => setResultsView("magnitude")}
                type="button"
              >
                Magnitude
              </button>
              <button
                className={`section-tab ${resultsView === "phase" ? "active" : ""}`}
                onClick={() => setResultsView("phase")}
                type="button"
              >
                Phase
              </button>
              <button
                className={`section-tab ${resultsView === "samples" ? "active" : ""}`}
                onClick={() => setResultsView("samples")}
                type="button"
              >
                Samples
              </button>
            </div>
            <div className="result-badge" title={resultsTitleHint}>
              <strong>{summary ? `${summary.componentCount} comps` : "--"}</strong>
              <span>{schematic.name}</span>
            </div>
          </header>

          <div className="summary-grid">
            <article>
              <span>Best match</span>
              <strong>{formatFrequency(summary?.bestMatchHz ?? null)}</strong>
            </article>
            <article>
              <span>Midband S11</span>
              <strong>{summary ? formatDb(summary.midbandS11Db) : "--"}</strong>
            </article>
            <article>
              <span>Midband S21</span>
              <strong>{summary ? formatDb(summary.midbandS21Db) : "--"}</strong>
            </article>
            <article>
              <span>Topology</span>
              <strong>{summary?.topologyLabel ?? "Awaiting solve"}</strong>
            </article>
          </div>

          <div className="results-main">
            {resultsView === "samples" ? (
              <div className="sample-table-wrap primary">
                <table>
                  <thead>
                    <tr>
                      <th>Freq</th>
                      <th>S11</th>
                      <th>S21</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sampledRows.map((point) => (
                      <tr key={point.frequencyHz}>
                        <td>{formatFrequency(point.frequencyHz)}</td>
                        <td>{formatDb(point.s11Db)}</td>
                        <td>{formatDb(point.s21Db)}</td>
                      </tr>
                    ))}
                    {sampledRows.length === 0 ? (
                      <tr>
                        <td colSpan={3}>Awaiting solver data.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ) : (
              <ResponseChart
                points={points}
                subtitle={resultsView === "magnitude" ? "Magnitude in dB" : "Phase in degrees"}
                title={resultsView === "magnitude" ? "S11 / S21 magnitude" : "S11 / S21 phase"}
                traces={resultsView === "magnitude" ? MAGNITUDE_TRACES : PHASE_TRACES}
              />
            )}
          </div>

          <div className="result-footer">
            <div className="warning-list">
              <strong>Solver notes</strong>
              {solverError ? <span className="error-text">{solverError}</span> : null}
              {warnings.length === 0 && !solverError ? <span>No warnings from the current solve.</span> : null}
              {warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
          </div>
        </section>
      </section>
    </main>
  );

  async function solveCurrentSchematic(controller: AbortController) {
    try {
      const response = await fetch("/api/solve", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: deferredSolvePayloadJson,
        signal: controller.signal
      });
      const payload = (await response.json()) as SolveResponse | { error?: string };

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error ?? "Solver failed" : "Solver failed");
      }

      startTransition(() => {
        const solveResponse = payload as SolveResponse;
        setSolution(solveResponse);
        setStatus({
          tone: solveResponse.warnings.length > 0 ? "warning" : "ready",
          text: `Solved ${solveResponse.summary.componentCount} components across ${solveResponse.summary.edgeCount} wires`
        });
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : "Unable to compute S-parameters";
      setStatus({ tone: "error", text: message });
      setSolverError(message);
      setSolution(null);
    }
  }
}

function NodeInspector({
  node,
  connectionCount,
  onUpdateNode,
  onRemoveNode
}: {
  node: SchematicNode;
  connectionCount: number;
  onUpdateNode: (patch: Partial<SchematicNode>) => void;
  onRemoveNode: () => void;
}) {
  const removable = canRemoveNode(node);

  return (
    <article className="component-card selected inspector-card">
      <div className="component-head">
        <div>
          <p className="component-index">Selected node</p>
          <strong>{node.label}</strong>
        </div>
        <div className="chip-row">
          <span className={`kind-chip ${node.kind}`}>{node.kind}</span>
          {isPortNode(node) ? <span className="topology-chip series">{node.role}</span> : null}
          {isGroundNode(node) ? <span className="topology-chip shunt">reference</span> : null}
        </div>
      </div>

      <div className="inspector-summary">
        <article>
          <span>Connections</span>
          <strong>{connectionCount}</strong>
        </article>
        <article>
          <span>Electrical</span>
          <strong>
            {isComponentNode(node)
              ? formatComponentValue(node.value, node.unit)
              : isPortNode(node)
                ? `${node.role} port`
                : "ground reference"}
          </strong>
        </article>
      </div>

      <div className="component-grid">
        <label className="field">
          <span>Label</span>
          <input
            onChange={(event) => onUpdateNode({ label: event.currentTarget.value })}
            type="text"
            value={node.label}
          />
        </label>

        {isComponentNode(node) ? (
          <>
            <label className="field">
              <span>Kind</span>
              <select
                onChange={(event) => {
                  const nextKind = event.currentTarget.value as ComponentKind;
                  onUpdateNode({
                    kind: nextKind,
                    unit: getDefaultUnit(nextKind),
                    value: getDefaultValue(nextKind, "series")
                  });
                }}
                value={node.kind}
              >
                <option value="resistor">Resistor</option>
                <option value="inductor">Inductor</option>
                <option value="capacitor">Capacitor</option>
              </select>
            </label>
            <label className="field">
              <span>Value</span>
              <input
                min="0.0001"
                onChange={(event) =>
                  onUpdateNode({ value: parsePositiveNumber(event.currentTarget.value, node.value) })
                }
                step="0.01"
                type="number"
                value={node.value}
              />
            </label>
            <label className="field">
              <span>Unit</span>
              <select
                onChange={(event) => onUpdateNode({ unit: event.currentTarget.value as ComponentUnit })}
                value={node.unit}
              >
                {getUnitOptions(node.kind).map((unit) => (
                  <option key={unit.value} value={unit.value}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="field read-only">
            <span>Role</span>
            <div>{isPortNode(node) ? node.role : "ground"}</div>
          </label>
        )}
      </div>

      <div className="component-actions">
        <span className="inspector-note">
          {removable ? "Delete removes the part and every wire attached to it." : "Ports and ground stay in the graph; move or relabel them as needed."}
        </span>
        {removable ? (
          <button className="danger-button" onClick={onRemoveNode} type="button">
            Remove node
          </button>
        ) : null}
      </div>
    </article>
  );
}

function EdgeInspector({
  edge,
  nodeMap,
  onDelete
}: {
  edge: SchematicEdge;
  nodeMap: Map<string, SchematicNode>;
  onDelete: () => void;
}) {
  const fromNode = nodeMap.get(edge.from.nodeId) ?? null;
  const toNode = nodeMap.get(edge.to.nodeId) ?? null;

  return (
    <article className="component-card selected inspector-card">
      <div className="component-head">
        <div>
          <p className="component-index">Selected wire</p>
          <strong>{edge.id}</strong>
        </div>
        <div className="chip-row">
          <span className="topology-chip shunt">wire</span>
        </div>
      </div>

      <div className="inspector-summary">
        <article>
          <span>From</span>
          <strong>
            {fromNode ? `${fromNode.label}.${getTerminalName(fromNode, edge.from.terminal)}` : edge.from.nodeId}
          </strong>
        </article>
        <article>
          <span>To</span>
          <strong>
            {toNode ? `${toNode.label}.${getTerminalName(toNode, edge.to.terminal)}` : edge.to.nodeId}
          </strong>
        </article>
      </div>

      <div className="component-actions">
        <span className="inspector-note">Deleting a wire only changes graph connectivity; node placement remains untouched.</span>
        <button className="danger-button" onClick={onDelete} type="button">
          Delete wire
        </button>
      </div>
    </article>
  );
}

function ResponseChart({
  points,
  title,
  subtitle,
  traces
}: {
  points: SolvePoint[];
  title: string;
  subtitle: string;
  traces: TraceDefinition[];
}) {
  const width = 760;
  const height = 180;
  const padding = { top: 14, right: 16, bottom: 24, left: 42 };
  const values = points.flatMap((point) => traces.map((trace) => trace.valueAt(point)));
  const domain = createDomain(values);
  const minX = points[0]?.frequencyHz ?? 0;
  const maxX = points[points.length - 1]?.frequencyHz ?? 1;
  const xTicks = createTicks(minX, maxX, 4);
  const yTicks = createTicks(domain.min, domain.max, 4);

  return (
    <section className="chart-panel">
      <div className="chart-head">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="legend">
          {traces.map((trace) => (
            <span key={trace.id}>
              <i style={{ background: trace.color }} />
              {trace.label}
            </span>
          ))}
        </div>
      </div>

      {points.length === 0 ? (
        <div className="chart-empty">No curve data yet.</div>
      ) : (
        <svg className="chart" viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg">
          <rect
            fill="rgba(5, 12, 23, 0.88)"
            height={height - padding.top - padding.bottom}
            rx="18"
            width={width - padding.left - padding.right}
            x={padding.left}
            y={padding.top}
          />

          {yTicks.map((tick) => {
            const y = scaleValue(tick, domain.min, domain.max, height - padding.bottom, padding.top);
            return (
              <g key={tick}>
                <line className="grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} />
                <text className="axis-label" x={padding.left - 12} y={y + 4}>
                  {formatEngineering(tick, 1)}
                </text>
              </g>
            );
          })}

          {xTicks.map((tick) => {
            const x = scaleValue(tick, minX, maxX, padding.left, width - padding.right);
            return (
              <g key={tick}>
                <line className="grid-line" x1={x} x2={x} y1={padding.top} y2={height - padding.bottom} />
                <text className="axis-label axis-label-bottom" x={x} y={height - 10}>
                  {(tick / 1e9).toFixed(2)} GHz
                </text>
              </g>
            );
          })}

          {traces.map((trace) => (
            <path
              d={buildPath({
                points,
                getX: (point) =>
                  scaleValue(point.frequencyHz, minX, maxX, padding.left, width - padding.right),
                getY: (point) =>
                  scaleValue(
                    trace.valueAt(point),
                    domain.min,
                    domain.max,
                    height - padding.bottom,
                    padding.top
                  )
              })}
              fill="none"
              key={trace.id}
              stroke={trace.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="3"
            />
          ))}
        </svg>
      )}
    </section>
  );
}

function updateSweepField(
  setSchematic: Dispatch<SetStateAction<SchematicModel>>,
  field: keyof SchematicModel["sweep"],
  rawValue: string,
  fallback: number
) {
  const value = parsePositiveNumber(rawValue, fallback);
  setSchematic((current) => ({
    ...current,
    sweep: {
      ...current.sweep,
      [field]: field === "points" ? Math.max(11, Math.round(value)) : value
    }
  }));
}

function updateNode(
  setSchematic: Dispatch<SetStateAction<SchematicModel>>,
  nodeId: string,
  patch: Partial<SchematicNode>
) {
  setSchematic((current) => ({
    ...current,
    nodes: current.nodes.map((node): SchematicNode =>
      node.id === nodeId ? ({ ...node, ...patch } as SchematicNode) : node
    )
  }));
}

function updateNodePosition(
  setSchematic: Dispatch<SetStateAction<SchematicModel>>,
  nodeId: string,
  position: Point
) {
  setSchematic((current) => ({
    ...current,
    nodes: current.nodes.map((node): SchematicNode =>
      node.id === nodeId
        ? {
            ...node,
            position
          } as SchematicNode
        : node
    )
  }));
}

function addComponentNode(
  setSchematic: Dispatch<SetStateAction<SchematicModel>>,
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>,
  setSelectedEdgeId: Dispatch<SetStateAction<string | null>>,
  kind: ComponentKind,
  position: Point
) {
  let nextNodeId: string | null = null;

  setSchematic((current) => {
    if (getComponentCount(current.nodes) >= MAX_COMPONENTS) {
      return current;
    }

    const nextNode = createComponentNode(kind, position);
    const kindIndex =
      current.nodes.filter((node) => isComponentNode(node) && node.kind === kind).length + 1;
    nextNode.label = `${nextNode.label} ${kindIndex}`;
    nextNodeId = nextNode.id;

    return {
      ...current,
      nodes: [...current.nodes, nextNode]
    };
  });

  if (nextNodeId) {
    setSelectedNodeId(nextNodeId);
    setSelectedEdgeId(null);
  }
}

function addEdge(
  setSchematic: Dispatch<SetStateAction<SchematicModel>>,
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>,
  setSelectedEdgeId: Dispatch<SetStateAction<string | null>>,
  from: TerminalRef,
  to: TerminalRef
) {
  if (from.nodeId === to.nodeId && from.terminal === to.terminal) {
    return;
  }

  let nextEdgeId: string | null = null;

  setSchematic((current) => {
    const exists = current.edges.some((edge) => edgeSignature(edge.from, edge.to) === edgeSignature(from, to));
    if (exists) {
      return current;
    }

    const nextEdge = createEdge(from, to);
    nextEdgeId = nextEdge.id;

    return {
      ...current,
      edges: [...current.edges, nextEdge]
    };
  });

  if (nextEdgeId) {
    setSelectedNodeId(null);
    setSelectedEdgeId(nextEdgeId);
  }
}

function removeNode(
  setSchematic: Dispatch<SetStateAction<SchematicModel>>,
  nodeId: string
) {
  setSchematic((current) => ({
    ...current,
    nodes: current.nodes.filter((node) => node.id !== nodeId),
    edges: current.edges.filter((edge) => edge.from.nodeId !== nodeId && edge.to.nodeId !== nodeId)
  }));
}

function removeEdge(
  setSchematic: Dispatch<SetStateAction<SchematicModel>>,
  edgeId: string
) {
  setSchematic((current) => ({
    ...current,
    edges: current.edges.filter((edge) => edge.id !== edgeId)
  }));
}

function parsePositiveNumber(rawValue: string, fallback: number) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sampleRows(points: SolvePoint[], targetRows: number) {
  if (points.length <= targetRows) {
    return points;
  }

  const step = Math.max(1, Math.floor(points.length / targetRows));
  const sampled = points.filter((_, index) => index % step === 0);
  const lastPoint = points[points.length - 1];

  if (sampled[sampled.length - 1]?.frequencyHz !== lastPoint.frequencyHz) {
    sampled.push(lastPoint);
  }

  return sampled;
}

function createDomain(values: number[]) {
  if (values.length === 0) {
    return { min: -1, max: 1 };
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (Math.abs(max - min) < 1e-6) {
    min -= 1;
    max += 1;
  }

  const padding = (max - min) * 0.12;
  return {
    min: min - padding,
    max: max + padding
  };
}

function createTicks(min: number, max: number, count: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }

  if (Math.abs(max - min) < 1e-9) {
    return [min];
  }

  return Array.from({ length: count + 1 }, (_, index) => min + ((max - min) * index) / count);
}

function scaleValue(value: number, domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  if (Math.abs(domainMax - domainMin) < 1e-9) {
    return (rangeMin + rangeMax) / 2;
  }

  return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
}

function buildPath({
  points,
  getX,
  getY
}: {
  points: SolvePoint[];
  getX: (point: SolvePoint) => number;
  getY: (point: SolvePoint) => number;
}) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${getX(point).toFixed(2)} ${getY(point).toFixed(2)}`)
    .join(" ");
}

function countNodeConnections(nodeId: string, edges: SchematicEdge[]) {
  return edges.filter((edge) => edge.from.nodeId === nodeId || edge.to.nodeId === nodeId).length;
}

function findDefaultSelectedNodeId(schematic: SchematicModel) {
  return schematic.nodes.find(isComponentNode)?.id ?? schematic.nodes[0]?.id ?? null;
}

function countSolveComponents(schematic: SchematicSolveModel) {
  return schematic.nodes.filter(
    (node) => node.kind === "resistor" || node.kind === "inductor" || node.kind === "capacitor"
  ).length;
}

function formatSweepSummary(schematic: SchematicModel) {
  return `${schematic.sweep.startGhz.toFixed(2)}-${schematic.sweep.stopGhz.toFixed(2)} GHz · ${schematic.sweep.points} pts · Z0 ${formatEngineering(schematic.sweep.portImpedanceOhm, 0)} Ohm`;
}

function describeWorkspaceSelection(
  selectedNode: SchematicNode | null,
  selectedEdge: SchematicEdge | null,
  nodeMap: Map<string, SchematicNode>
) {
  if (selectedNode) {
    return selectedNode.label;
  }

  if (!selectedEdge) {
    return "No selection";
  }

  const fromNode = nodeMap.get(selectedEdge.from.nodeId);
  const toNode = nodeMap.get(selectedEdge.to.nodeId);

  if (!fromNode || !toNode) {
    return selectedEdge.id;
  }

  return `${fromNode.label} -> ${toNode.label}`;
}

function getEditorViewCopy(editorView: EditorView) {
  if (editorView === "setup") {
    return {
      kicker: "Network Setup",
      title: "Adjust sweep bounds, port impedance, and load a preset topology into the workspace.",
      chips: ["Sweep controls", "Preset loader", "Project naming"]
    };
  }

  if (editorView === "properties") {
    return {
      kicker: "Selection Properties",
      title: "Inspect and edit the currently selected node or wire without crowding the canvas.",
      chips: ["Node inspector", "Wire inspector", "Delete selection"]
    };
  }

  return {
    kicker: "Editing Surface",
    title: "Place ports, ground, and R / L / C parts, then wire the exact graph you want to solve.",
    chips: ["Blank drag pans canvas", "Wheel zoom", "Delete removes selection"]
  };
}
