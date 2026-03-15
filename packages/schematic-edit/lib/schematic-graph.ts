import type {
  ComponentKind,
  ComponentNode,
  NodeKind,
  NodeTerminalKey,
  Point,
  PortNode,
  PortRole,
  SchematicEdge,
  SchematicModel,
  SchematicNode,
  SchematicSolveModel,
  TerminalRef
} from "./types";
import { getDefaultUnit, getDefaultValue } from "./units";

export const FIXED_NODE_IDS = {
  input: "node-port-in",
  output: "node-port-out",
  ground: "node-ground"
} as const;

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isComponentNode(node: SchematicNode): node is ComponentNode {
  return node.kind === "resistor" || node.kind === "inductor" || node.kind === "capacitor";
}

export function isPortNode(node: SchematicNode): node is PortNode {
  return node.kind === "port";
}

export function isGroundNode(node: SchematicNode): boolean {
  return node.kind === "ground";
}

export function canRemoveNode(node: SchematicNode) {
  return isComponentNode(node);
}

export function createPortNode(role: PortRole, position: Point): PortNode {
  return {
    id: role === "input" ? FIXED_NODE_IDS.input : FIXED_NODE_IDS.output,
    kind: "port",
    label: role === "input" ? "P1" : "P2",
    role,
    position
  };
}

export function createGroundNode(position: Point): SchematicNode {
  return {
    id: FIXED_NODE_IDS.ground,
    kind: "ground",
    label: "GND",
    position
  };
}

export function createComponentNode(kind: ComponentKind, position: Point): ComponentNode {
  const title = kind[0].toUpperCase() + kind.slice(1);

  return {
    id: createId("node"),
    kind,
    label: title,
    value: getDefaultValue(kind, "series"),
    unit: getDefaultUnit(kind),
    position
  };
}

export function createEdge(from: TerminalRef, to: TerminalRef): SchematicEdge {
  return {
    id: createId("edge"),
    from: { ...from },
    to: { ...to }
  };
}

export function cloneSchematic(schematic: SchematicModel): SchematicModel {
  return {
    name: schematic.name,
    sweep: { ...schematic.sweep },
    nodes: schematic.nodes.map((node) => ({
      ...node,
      position: { ...node.position }
    })),
    edges: schematic.edges.map((edge) => ({
      ...edge,
      from: { ...edge.from },
      to: { ...edge.to }
    }))
  };
}

export function createSolvePayload(schematic: SchematicModel): SchematicSolveModel {
  return {
    name: schematic.name,
    sweep: { ...schematic.sweep },
    nodes: schematic.nodes.map(({ position: _position, ...node }) => ({ ...node })),
    edges: schematic.edges.map((edge) => ({
      ...edge,
      from: { ...edge.from },
      to: { ...edge.to }
    }))
  };
}

export function getComponentCount(nodes: SchematicNode[]) {
  return nodes.filter(isComponentNode).length;
}

export function getNodeColor(kind: NodeKind) {
  if (kind === "resistor") {
    return "#ff8c69";
  }

  if (kind === "inductor") {
    return "#7be0d2";
  }

  if (kind === "capacitor") {
    return "#f3de7c";
  }

  if (kind === "port") {
    return "#91c7ff";
  }

  return "#c9d1da";
}

export function getNodeTerminalKeys(node: SchematicNode): NodeTerminalKey[] {
  return isComponentNode(node) ? ["left", "right"] : ["port"];
}

export function terminalKey(ref: TerminalRef) {
  return `${ref.nodeId}:${ref.terminal}`;
}

export function edgeSignature(from: TerminalRef, to: TerminalRef) {
  const [left, right] = [terminalKey(from), terminalKey(to)].sort();
  return `${left}|${right}`;
}

export function getTerminalName(node: SchematicNode, terminal: NodeTerminalKey) {
  if (terminal === "port") {
    if (isPortNode(node)) {
      return node.role === "input" ? "port out" : "port in";
    }

    return "port";
  }

  return terminal;
}
