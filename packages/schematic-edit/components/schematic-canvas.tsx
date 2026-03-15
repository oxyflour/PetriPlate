"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  edgeSignature,
  getComponentCount,
  getNodeColor,
  getTerminalName,
  isComponentNode,
  isGroundNode,
  isPortNode,
  terminalKey
} from "../lib/schematic-graph";
import type {
  ComponentKind,
  NodeTerminalKey,
  Point,
  SchematicEdge,
  SchematicNode,
  TerminalRef
} from "../lib/types";
import { formatComponentValue, formatEngineering } from "../lib/units";

type SchematicCanvasProps = {
  nodes: SchematicNode[];
  edges: SchematicEdge[];
  portImpedance: number;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  layoutVersion: number;
  componentLimitReached: boolean;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onCreateComponent: (kind: ComponentKind, position: Point) => void;
  onMoveNode: (nodeId: string, position: Point) => void;
  onCreateEdge: (from: TerminalRef, to: TerminalRef) => void;
  onDeleteEdge: (edgeId: string) => void;
};

type CanvasViewport = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

type DragState =
  | {
      type: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      origin: CanvasViewport;
    }
  | {
      type: "node";
      pointerId: number;
      nodeId: string;
      pointerOffsetX: number;
      pointerOffsetY: number;
    }
  | {
      type: "wire";
      pointerId: number;
      from: TerminalRef;
    };

type WireDraft = {
  from: TerminalRef;
  currentPoint: Point;
  snapTo: TerminalRef | null;
};

type PaletteDefinition = {
  kind: ComponentKind;
  label: string;
  hint: string;
};

const VIEWPORT_WIDTH = 1240;
const VIEWPORT_HEIGHT = 680;
const WORLD_WIDTH = 1800;
const WORLD_HEIGHT = 1100;
const PAN_MARGIN = 120;
const MIN_SCALE = 0.44;
const MAX_SCALE = 1.96;
const SNAP_DISTANCE = 40;
const PALETTE_MIME = "application/x-petriplate-schematic-kind";
const PALETTE_ITEMS: PaletteDefinition[] = [
  {
    kind: "resistor",
    label: "Resistor",
    hint: "Broadband loss or termination"
  },
  {
    kind: "inductor",
    label: "Inductor",
    hint: "Series or shunt L"
  },
  {
    kind: "capacitor",
    label: "Capacitor",
    hint: "Series or shunt C"
  }
];

export default function SchematicCanvas({
  nodes,
  edges,
  portImpedance,
  selectedNodeId,
  selectedEdgeId,
  layoutVersion,
  componentLimitReached,
  onSelectNode,
  onSelectEdge,
  onCreateComponent,
  onMoveNode,
  onCreateEdge,
  onDeleteEdge
}: SchematicCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(() =>
    createFitViewport(WORLD_WIDTH, WORLD_HEIGHT)
  );
  const [interactionTone, setInteractionTone] = useState<
    "idle" | "panning" | "dragging" | "wiring"
  >("idle");
  const [wireDraft, setWireDraft] = useState<WireDraft | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const componentCount = getComponentCount(nodes);
  const portLabel = `${formatEngineering(portImpedance, 0)} Ohm`;
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) ?? null : null;

  useEffect(() => {
    setViewport(createFitViewport(WORLD_WIDTH, WORLD_HEIGHT));
  }, [layoutVersion]);

  const edgePaths = useMemo(
    () =>
      edges
        .map((edge) => {
          const fromNode = nodeMap.get(edge.from.nodeId);
          const toNode = nodeMap.get(edge.to.nodeId);

          if (!fromNode || !toNode) {
            return null;
          }

          const from = getTerminalWorldPosition(fromNode, edge.from.terminal);
          const to = getTerminalWorldPosition(toNode, edge.to.terminal);

          return {
            edge,
            d: buildWirePath(from, to),
            from,
            to
          };
        })
        .filter((path): path is NonNullable<typeof path> => Boolean(path)),
    [edges, nodeMap]
  );

  const selectedLabel = selectedNode
    ? describeNode(selectedNode)
    : selectedEdge
      ? describeEdge(selectedEdge, nodeMap)
      : `${componentCount} components · ${edges.length} wires · ${portLabel}`;
  const snapTerminalKey = wireDraft?.snapTo ? terminalKey(wireDraft.snapTo) : null;
  const draftPath =
    wireDraft && nodeMap.get(wireDraft.from.nodeId)
      ? buildWirePath(
          getTerminalWorldPosition(
            nodeMap.get(wireDraft.from.nodeId) as SchematicNode,
            wireDraft.from.terminal
          ),
          wireDraft.currentPoint
        )
      : null;

  function beginPan(event: ReactPointerEvent<SVGRectElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectNode(null);
    onSelectEdge(null);
    dragRef.current = {
      type: "pan",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origin: viewport
    };
    setInteractionTone("panning");
  }

  function beginNodeDrag(event: ReactPointerEvent<SVGGElement>, nodeId: string) {
    if (event.button !== 0) {
      return;
    }

    const node = nodeMap.get(nodeId);
    const pointer = clientPointToWorld(svgRef.current, event.clientX, event.clientY, viewport);

    if (!node || !pointer) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectEdge(null);
    onSelectNode(nodeId);
    dragRef.current = {
      type: "node",
      pointerId: event.pointerId,
      nodeId,
      pointerOffsetX: pointer.x - node.position.x,
      pointerOffsetY: pointer.y - node.position.y
    };
    setInteractionTone("dragging");
  }

  function beginWire(event: ReactPointerEvent<SVGCircleElement>, from: TerminalRef) {
    if (event.button !== 0) {
      return;
    }

    const node = nodeMap.get(from.nodeId);
    if (!node) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectEdge(null);
    onSelectNode(from.nodeId);
    dragRef.current = {
      type: "wire",
      pointerId: event.pointerId,
      from
    };
    setWireDraft({
      from,
      currentPoint: getTerminalWorldPosition(node, from.terminal),
      snapTo: null
    });
    setInteractionTone("wiring");
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const activeDrag = dragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
      return;
    }

    if (activeDrag.type === "pan") {
      setViewport(
        clampViewport(
          {
            ...activeDrag.origin,
            offsetX: activeDrag.origin.offsetX + (event.clientX - activeDrag.startClientX),
            offsetY: activeDrag.origin.offsetY + (event.clientY - activeDrag.startClientY)
          },
          WORLD_WIDTH,
          WORLD_HEIGHT
        )
      );
      return;
    }

    const pointer = clientPointToWorld(svgRef.current, event.clientX, event.clientY, viewport);
    if (!pointer) {
      return;
    }

    if (activeDrag.type === "node") {
      const node = nodeMap.get(activeDrag.nodeId);
      if (!node) {
        return;
      }

      onMoveNode(
        activeDrag.nodeId,
        clampNodePosition(
          {
            x: pointer.x - activeDrag.pointerOffsetX,
            y: pointer.y - activeDrag.pointerOffsetY
          },
          node
        )
      );
      return;
    }

    const snapTo = findNearestTerminal(pointer, nodes, activeDrag.from);
    setWireDraft({
      from: activeDrag.from,
      currentPoint: snapTo
        ? getTerminalWorldPosition(nodeMap.get(snapTo.nodeId) as SchematicNode, snapTo.terminal)
        : pointer,
      snapTo
    });
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const activeDrag = dragRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
      return;
    }

    if (activeDrag.type === "wire" && wireDraft?.snapTo) {
      const nextSignature = edgeSignature(activeDrag.from, wireDraft.snapTo);
      const edgeExists = edges.some((edge) => edgeSignature(edge.from, edge.to) === nextSignature);

      if (
        !edgeExists &&
        terminalKey(activeDrag.from) !== terminalKey(wireDraft.snapTo)
      ) {
        onCreateEdge(activeDrag.from, wireDraft.snapTo);
      }
    }

    dragRef.current = null;
    setWireDraft(null);
    setInteractionTone("idle");
  }

  function handlePointerLeave(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId === event.pointerId && dragRef.current.type !== "wire") {
      dragRef.current = null;
      setInteractionTone("idle");
    }
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const pointer = clientPointToView(svgRef.current, event.clientX, event.clientY);

    if (!pointer) {
      return;
    }

    setViewport((current) => {
      const zoomFactor = event.deltaY > 0 ? 0.92 : 1.08;
      const nextScale = clampScale(current.scale * zoomFactor);
      const worldPoint = {
        x: (pointer.x - current.offsetX) / current.scale,
        y: (pointer.y - current.offsetY) / current.scale
      };

      return clampViewport(
        {
          scale: nextScale,
          offsetX: pointer.x - worldPoint.x * nextScale,
          offsetY: pointer.y - worldPoint.y * nextScale
        },
        WORLD_WIDTH,
        WORLD_HEIGHT
      );
    });
  }

  function setZoom(nextScale: number) {
    setViewport((current) => {
      const center = {
        x: VIEWPORT_WIDTH / 2,
        y: VIEWPORT_HEIGHT / 2
      };
      const worldPoint = {
        x: (center.x - current.offsetX) / current.scale,
        y: (center.y - current.offsetY) / current.scale
      };
      const scale = clampScale(nextScale);

      return clampViewport(
        {
          scale,
          offsetX: center.x - worldPoint.x * scale,
          offsetY: center.y - worldPoint.y * scale
        },
        WORLD_WIDTH,
        WORLD_HEIGHT
      );
    });
  }

  function resetViewport(mode: "fit" | "actual") {
    if (mode === "fit") {
      setViewport(createFitViewport(WORLD_WIDTH, WORLD_HEIGHT));
      return;
    }

    setViewport(
      clampViewport(
        {
          scale: 1,
          offsetX: VIEWPORT_WIDTH / 2 - WORLD_WIDTH / 2,
          offsetY: VIEWPORT_HEIGHT / 2 - WORLD_HEIGHT / 2
        },
        WORLD_WIDTH,
        WORLD_HEIGHT
      )
    );
  }

  function createAtViewportCenter(kind: ComponentKind) {
    if (componentLimitReached) {
      return;
    }

    const worldPoint = {
      x: (VIEWPORT_WIDTH / 2 - viewport.offsetX) / viewport.scale,
      y: (VIEWPORT_HEIGHT / 2 - viewport.offsetY) / viewport.scale
    };
    onCreateComponent(kind, clampNodePosition(worldPoint, { kind } as SchematicNode));
  }

  function handlePaletteDragStart(event: ReactDragEvent<HTMLButtonElement>, kind: ComponentKind) {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(PALETTE_MIME, kind);
    event.dataTransfer.setData("text/plain", kind);
  }

  function handleCanvasDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (componentLimitReached) {
      return;
    }

    if (Array.from(event.dataTransfer.types).includes(PALETTE_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    }
  }

  function handleCanvasDragLeave() {
    setDropActive(false);
  }

  function handleCanvasDrop(event: ReactDragEvent<HTMLDivElement>) {
    const kind = event.dataTransfer.getData(PALETTE_MIME) as ComponentKind;
    setDropActive(false);

    if (componentLimitReached || !kind) {
      return;
    }

    event.preventDefault();
    const position = clientPointToWorld(svgRef.current, event.clientX, event.clientY, viewport);
    if (!position) {
      return;
    }

    onCreateComponent(kind, clampNodePosition(position, { kind } as SchematicNode));
  }

  const transform = `matrix(${viewport.scale} 0 0 ${viewport.scale} ${viewport.offsetX} ${viewport.offsetY})`;

  return (
    <section className="canvas-panel">
      <div className="canvas-head">
        <div>
          <strong>Graph canvas</strong>
          <span>拖入 R / L / C 节点，拖动端点拉线，点击导线后可删除。滚轮缩放，拖拽空白区平移。</span>
        </div>
        <div className="canvas-selection">
          <strong>{selectedNode || selectedEdge ? "Selected" : "Canvas"}</strong>
          <span>{selectedLabel}</span>
        </div>
      </div>

      <div className="canvas-toolbar">
        <div className="toolbar-group">
          <button className="tool-button" onClick={() => setZoom(viewport.scale * 0.85)} type="button">
            -
          </button>
          <button className="tool-button wide" onClick={() => resetViewport("actual")} type="button">
            {Math.round(viewport.scale * 100)}%
          </button>
          <button className="tool-button" onClick={() => setZoom(viewport.scale * 1.15)} type="button">
            +
          </button>
          <button className="tool-button wide" onClick={() => resetViewport("fit")} type="button">
            Fit
          </button>
          <button
            className="tool-button wide"
            onClick={() => {
              onSelectNode(null);
              onSelectEdge(null);
            }}
            type="button"
          >
            Clear
          </button>
          {selectedEdge ? (
            <button className="tool-button wide danger" onClick={() => onDeleteEdge(selectedEdge.id)} type="button">
              Delete wire
            </button>
          ) : null}
        </div>

        <div className="palette-group">
          {PALETTE_ITEMS.map((item) => (
            <button
              className="palette-chip"
              disabled={componentLimitReached}
              draggable={!componentLimitReached}
              key={item.kind}
              onClick={() => createAtViewportCenter(item.kind)}
              onDragStart={(event) => handlePaletteDragStart(event, item.kind)}
              type="button"
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        className={`canvas-drop-zone ${dropActive ? "active" : ""}`}
        onDragLeave={handleCanvasDragLeave}
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
      >
        {dropActive ? <div className="canvas-drop-hint">Drop to place a new component</div> : null}

        <svg
          className={`schematic-canvas ${interactionTone}`}
          onPointerLeave={handlePointerLeave}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          ref={svgRef}
          viewBox={`0 0 ${VIEWPORT_WIDTH} ${VIEWPORT_HEIGHT}`}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <pattern height="40" id="canvas-grid" patternUnits="userSpaceOnUse" width="40">
              <path
                d="M 40 0 L 0 0 0 40"
                fill="none"
                stroke="rgba(122, 170, 183, 0.12)"
                strokeWidth="1"
              />
            </pattern>
            <filter height="160%" id="canvas-glow" width="160%" x="-30%" y="-30%">
              <feDropShadow dx="0" dy="14" floodColor="rgba(0, 0, 0, 0.38)" stdDeviation="16" />
            </filter>
          </defs>

          <rect className="canvas-hit-area" fill="rgba(4, 10, 18, 0.96)" height={VIEWPORT_HEIGHT} rx="26" width={VIEWPORT_WIDTH} />

          <g transform={transform}>
            <rect
              className="canvas-world"
              fill="rgba(5, 12, 23, 0.94)"
              filter="url(#canvas-glow)"
              height={WORLD_HEIGHT}
              onPointerDown={beginPan}
              rx="34"
              width={WORLD_WIDTH}
            />
            <rect fill="url(#canvas-grid)" height={WORLD_HEIGHT} rx="34" width={WORLD_WIDTH} />

            <circle cx="240" cy="170" fill="rgba(123, 224, 210, 0.08)" r="156" />
            <circle cx="1540" cy="860" fill="rgba(255, 176, 103, 0.08)" r="190" />

            {edgePaths.map(({ edge, d }) => {
              const isSelected = edge.id === selectedEdgeId;
              return (
                <g key={edge.id}>
                  <path className={`wire-path ${isSelected ? "selected" : ""}`} d={d} fill="none" />
                  <path
                    className="wire-hit"
                    d={d}
                    fill="none"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectNode(null);
                      onSelectEdge(edge.id);
                    }}
                  />
                </g>
              );
            })}

            {draftPath ? <path className="wire-preview" d={draftPath} fill="none" /> : null}

            {nodes.map((node) => {
              const selected = node.id === selectedNodeId;

              if (isComponentNode(node)) {
                return (
                  <ComponentNodeView
                    isSelected={selected}
                    key={node.id}
                    node={node}
                    onNodePointerDown={beginNodeDrag}
                    onTerminalPointerDown={beginWire}
                    snapTerminalKey={snapTerminalKey}
                  />
                );
              }

              if (isPortNode(node)) {
                return (
                  <PortNodeView
                    isSelected={selected}
                    key={node.id}
                    node={node}
                    portImpedance={portLabel}
                    onNodePointerDown={beginNodeDrag}
                    onTerminalPointerDown={beginWire}
                    snapTerminalKey={snapTerminalKey}
                  />
                );
              }

              return (
                <GroundNodeView
                  isSelected={selected}
                  key={node.id}
                  node={node}
                  onNodePointerDown={beginNodeDrag}
                  onTerminalPointerDown={beginWire}
                  snapTerminalKey={snapTerminalKey}
                />
              );
            })}
          </g>
        </svg>
      </div>
    </section>
  );
}

function ComponentNodeView({
  node,
  isSelected,
  snapTerminalKey,
  onNodePointerDown,
  onTerminalPointerDown
}: {
  node: Extract<SchematicNode, { kind: ComponentKind }>;
  isSelected: boolean;
  snapTerminalKey: string | null;
  onNodePointerDown: (event: ReactPointerEvent<SVGGElement>, nodeId: string) => void;
  onTerminalPointerDown: (event: ReactPointerEvent<SVGCircleElement>, from: TerminalRef) => void;
}) {
  const color = getNodeColor(node.kind);
  const left = getTerminalOffset(node, "left");
  const right = getTerminalOffset(node, "right");

  return (
    <g
      className={`canvas-node ${isSelected ? "selected" : ""}`}
      onPointerDown={(event) => onNodePointerDown(event, node.id)}
      transform={`translate(${node.position.x}, ${node.position.y})`}
    >
      {isSelected ? <rect className="selection-ring" height="110" rx="28" width="220" x="-110" y="-55" /> : null}
      <line className="node-lead" x1={left.x} x2="-58" y1={left.y} y2="0" />
      <line className="node-lead" x1="58" x2={right.x} y1="0" y2={right.y} />
      <TerminalHandle
        active={snapTerminalKey === terminalKey({ nodeId: node.id, terminal: "left" })}
        point={left}
        title={getTerminalName(node, "left")}
        onPointerDown={(event) => onTerminalPointerDown(event, { nodeId: node.id, terminal: "left" })}
      />
      <TerminalHandle
        active={snapTerminalKey === terminalKey({ nodeId: node.id, terminal: "right" })}
        point={right}
        title={getTerminalName(node, "right")}
        onPointerDown={(event) => onTerminalPointerDown(event, { nodeId: node.id, terminal: "right" })}
      />
      <rect className="node-body component" fill="rgba(5, 12, 23, 0.96)" height="72" rx="22" stroke={color} width="128" x="-64" y="-36" />
      <ComponentSymbol color={color} kind={node.kind} />
      <text className="node-label" x="0" y="62">
        {node.label}
      </text>
      <text className="node-meta" x="0" y="82">
        {formatComponentValue(node.value, node.unit)}
      </text>
    </g>
  );
}

function PortNodeView({
  node,
  portImpedance,
  isSelected,
  snapTerminalKey,
  onNodePointerDown,
  onTerminalPointerDown
}: {
  node: Extract<SchematicNode, { kind: "port" }>;
  portImpedance: string;
  isSelected: boolean;
  snapTerminalKey: string | null;
  onNodePointerDown: (event: ReactPointerEvent<SVGGElement>, nodeId: string) => void;
  onTerminalPointerDown: (event: ReactPointerEvent<SVGCircleElement>, from: TerminalRef) => void;
}) {
  const color = getNodeColor(node.kind);
  const terminal = getTerminalOffset(node, "port");
  const arrowDirection = node.role === "input" ? 1 : -1;

  return (
    <g
      className={`canvas-node ${isSelected ? "selected" : ""}`}
      onPointerDown={(event) => onNodePointerDown(event, node.id)}
      transform={`translate(${node.position.x}, ${node.position.y})`}
    >
      {isSelected ? <rect className="selection-ring" height="96" rx="24" width="182" x="-91" y="-48" /> : null}
      <line className="node-lead port" x1="0" x2={terminal.x} y1="0" y2={terminal.y} />
      <TerminalHandle
        active={snapTerminalKey === terminalKey({ nodeId: node.id, terminal: "port" })}
        point={terminal}
        title={node.role}
        onPointerDown={(event) => onTerminalPointerDown(event, { nodeId: node.id, terminal: "port" })}
      />
      <rect className="node-body port" fill="rgba(7, 14, 26, 0.98)" height="62" rx="18" stroke={color} width="96" x="-48" y="-31" />
      <path
        d={`M ${arrowDirection * -12} -10 L ${arrowDirection * 12} 0 L ${arrowDirection * -12} 10`}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3"
      />
      <text className="node-label" x="0" y="58">
        {node.label}
      </text>
      <text className="node-meta" x="0" y="78">
        {node.role} · {portImpedance}
      </text>
    </g>
  );
}

function GroundNodeView({
  node,
  isSelected,
  snapTerminalKey,
  onNodePointerDown,
  onTerminalPointerDown
}: {
  node: Extract<SchematicNode, { kind: "ground" }>;
  isSelected: boolean;
  snapTerminalKey: string | null;
  onNodePointerDown: (event: ReactPointerEvent<SVGGElement>, nodeId: string) => void;
  onTerminalPointerDown: (event: ReactPointerEvent<SVGCircleElement>, from: TerminalRef) => void;
}) {
  const color = getNodeColor(node.kind);
  const terminal = getTerminalOffset(node, "port");

  return (
    <g
      className={`canvas-node ${isSelected ? "selected" : ""}`}
      onPointerDown={(event) => onNodePointerDown(event, node.id)}
      transform={`translate(${node.position.x}, ${node.position.y})`}
    >
      {isSelected ? <rect className="selection-ring" height="120" rx="24" width="150" x="-75" y="-60" /> : null}
      <line className="node-lead ground" x1="0" x2={terminal.x} y1="-6" y2={terminal.y} />
      <TerminalHandle
        active={snapTerminalKey === terminalKey({ nodeId: node.id, terminal: "port" })}
        point={terminal}
        title="ground"
        onPointerDown={(event) => onTerminalPointerDown(event, { nodeId: node.id, terminal: "port" })}
      />
      <GroundSymbol color={color} />
      <text className="node-label" x="0" y="62">
        {node.label}
      </text>
    </g>
  );
}

function TerminalHandle({
  point,
  title,
  active,
  onPointerDown
}: {
  point: Point;
  title: string;
  active: boolean;
  onPointerDown: (event: ReactPointerEvent<SVGCircleElement>) => void;
}) {
  return (
    <>
      {active ? <circle className="terminal-snap-ring" cx={point.x} cy={point.y} r="16" /> : null}
      <circle className={`terminal-dot ${active ? "active" : ""}`} cx={point.x} cy={point.y} onPointerDown={onPointerDown} r="7" role="button">
        <title>{title}</title>
      </circle>
    </>
  );
}

function ComponentSymbol({
  kind,
  color
}: {
  kind: ComponentKind;
  color: string;
}) {
  if (kind === "resistor") {
    return (
      <g stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3">
        <path d="M -26 0 L -18 -11 L -10 11 L -2 -11 L 6 11 L 14 -11 L 22 11 L 30 0" fill="none" />
      </g>
    );
  }

  if (kind === "capacitor") {
    return (
      <g stroke={color} strokeLinecap="round" strokeWidth="3">
        <line x1="-24" x2="-8" y1="0" y2="0" />
        <line x1="-8" x2="-8" y1="-18" y2="18" />
        <line x1="8" x2="8" y1="-18" y2="18" />
        <line x1="8" x2="24" y1="0" y2="0" />
      </g>
    );
  }

  return (
    <g stroke={color} strokeLinecap="round" strokeWidth="3">
      <line x1="-26" x2="-18" y1="0" y2="0" />
      <path d="M -18 0 A 8 8 0 0 1 -2 0" fill="none" />
      <path d="M -2 0 A 8 8 0 0 1 14 0" fill="none" />
      <line x1="14" x2="26" y1="0" y2="0" />
    </g>
  );
}

function GroundSymbol({ color }: { color: string }) {
  return (
    <g stroke={color} strokeLinecap="round" strokeWidth="3">
      <line x1="0" x2="0" y1="-12" y2="12" />
      <line x1="-22" x2="22" y1="14" y2="14" />
      <line x1="-14" x2="14" y1="24" y2="24" />
      <line x1="-7" x2="7" y1="33" y2="33" />
    </g>
  );
}

function describeNode(node: SchematicNode) {
  if (isComponentNode(node)) {
    return `${node.label} · ${node.kind} · ${formatComponentValue(node.value, node.unit)}`;
  }

  if (isPortNode(node)) {
    return `${node.label} · ${node.role} port`;
  }

  return `${node.label} · reference ground`;
}

function describeEdge(edge: SchematicEdge, nodeMap: Map<string, SchematicNode>) {
  const fromNode = nodeMap.get(edge.from.nodeId);
  const toNode = nodeMap.get(edge.to.nodeId);

  if (!fromNode || !toNode) {
    return "wire";
  }

  return `${fromNode.label}.${getTerminalName(fromNode, edge.from.terminal)} -> ${toNode.label}.${getTerminalName(toNode, edge.to.terminal)}`;
}

function getTerminalWorldPosition(node: SchematicNode, terminal: NodeTerminalKey): Point {
  const offset = getTerminalOffset(node, terminal);
  return {
    x: node.position.x + offset.x,
    y: node.position.y + offset.y
  };
}

function getTerminalOffset(node: SchematicNode, terminal: NodeTerminalKey): Point {
  if (isComponentNode(node)) {
    return terminal === "left" ? { x: -88, y: 0 } : { x: 88, y: 0 };
  }

  if (isPortNode(node)) {
    return {
      x: node.role === "input" ? 66 : -66,
      y: 0
    };
  }

  return { x: 0, y: -46 };
}

function findNearestTerminal(
  point: Point,
  nodes: SchematicNode[],
  exclude: TerminalRef
): TerminalRef | null {
  let best: { distance: number; terminal: TerminalRef } | null = null;

  for (const node of nodes) {
    const terminals: NodeTerminalKey[] = isComponentNode(node) ? ["left", "right"] : ["port"];

    for (const terminal of terminals) {
      const ref = { nodeId: node.id, terminal };
      if (terminalKey(ref) === terminalKey(exclude)) {
        continue;
      }

      const terminalPoint = getTerminalWorldPosition(node, terminal);
      const distance = Math.hypot(point.x - terminalPoint.x, point.y - terminalPoint.y);

      if (distance > SNAP_DISTANCE) {
        continue;
      }

      if (!best || distance < best.distance) {
        best = {
          distance,
          terminal: ref
        };
      }
    }
  }

  return best?.terminal ?? null;
}

function buildWirePath(from: Point, to: Point) {
  if (Math.abs(from.x - to.x) < 1 || Math.abs(from.y - to.y) < 1) {
    return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} L ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
  }

  const midX = from.x + (to.x - from.x) / 2;
  return [
    `M ${from.x.toFixed(2)} ${from.y.toFixed(2)}`,
    `L ${midX.toFixed(2)} ${from.y.toFixed(2)}`,
    `L ${midX.toFixed(2)} ${to.y.toFixed(2)}`,
    `L ${to.x.toFixed(2)} ${to.y.toFixed(2)}`
  ].join(" ");
}

function clampNodePosition(position: Point, node: Pick<SchematicNode, "kind">): Point {
  const margin = node.kind === "ground" ? 86 : 110;
  return {
    x: clamp(position.x, margin, WORLD_WIDTH - margin),
    y: clamp(position.y, margin, WORLD_HEIGHT - margin)
  };
}

function createFitViewport(worldWidth: number, worldHeight: number): CanvasViewport {
  const scale = clampScale(
    Math.min((VIEWPORT_WIDTH - 120) / worldWidth, (VIEWPORT_HEIGHT - 96) / worldHeight)
  );
  return clampViewport(
    {
      scale,
      offsetX: (VIEWPORT_WIDTH - worldWidth * scale) / 2,
      offsetY: (VIEWPORT_HEIGHT - worldHeight * scale) / 2
    },
    worldWidth,
    worldHeight
  );
}

function clampViewport(viewport: CanvasViewport, worldWidth: number, worldHeight: number): CanvasViewport {
  const scale = clampScale(viewport.scale);
  const scaledWidth = worldWidth * scale;
  const scaledHeight = worldHeight * scale;

  const offsetX =
    scaledWidth <= VIEWPORT_WIDTH
      ? (VIEWPORT_WIDTH - scaledWidth) / 2
      : clamp(viewport.offsetX, VIEWPORT_WIDTH - scaledWidth - PAN_MARGIN, PAN_MARGIN);
  const offsetY =
    scaledHeight <= VIEWPORT_HEIGHT
      ? (VIEWPORT_HEIGHT - scaledHeight) / 2
      : clamp(viewport.offsetY, VIEWPORT_HEIGHT - scaledHeight - PAN_MARGIN, PAN_MARGIN);

  return {
    scale,
    offsetX,
    offsetY
  };
}

function clientPointToView(svg: SVGSVGElement | null, clientX: number, clientY: number): Point | null {
  if (!svg) {
    return null;
  }

  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  return {
    x: ((clientX - rect.left) / rect.width) * VIEWPORT_WIDTH,
    y: ((clientY - rect.top) / rect.height) * VIEWPORT_HEIGHT
  };
}

function clientPointToWorld(
  svg: SVGSVGElement | null,
  clientX: number,
  clientY: number,
  viewport: CanvasViewport
): Point | null {
  const point = clientPointToView(svg, clientX, clientY);
  if (!point) {
    return null;
  }

  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (point.y - viewport.offsetY) / viewport.scale
  };
}

function clampScale(scale: number) {
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
