export type ComponentKind = "resistor" | "inductor" | "capacitor";
export type ComponentTopology = "series" | "shunt";
export type NodeKind = ComponentKind | "port" | "ground";
export type PortRole = "input" | "output";
export type ComponentUnit =
  | "mohm"
  | "ohm"
  | "kohm"
  | "pH"
  | "nH"
  | "uH"
  | "fF"
  | "pF"
  | "nF";
export type ComponentTerminalKey = "left" | "right";
export type NodeTerminalKey = ComponentTerminalKey | "port";

export type Point = {
  x: number;
  y: number;
};

type BaseNode = {
  id: string;
  label: string;
  position: Point;
};

export type ComponentNode = BaseNode & {
  kind: ComponentKind;
  value: number;
  unit: ComponentUnit;
};

export type PortNode = BaseNode & {
  kind: "port";
  role: PortRole;
};

export type GroundNode = BaseNode & {
  kind: "ground";
};

export type SchematicNode = ComponentNode | PortNode | GroundNode;

export type TerminalRef = {
  nodeId: string;
  terminal: NodeTerminalKey;
};

export type SchematicEdge = {
  id: string;
  from: TerminalRef;
  to: TerminalRef;
};

export type SweepSettings = {
  startGhz: number;
  stopGhz: number;
  points: number;
  portImpedanceOhm: number;
};

export type SchematicModel = {
  name: string;
  sweep: SweepSettings;
  nodes: SchematicNode[];
  edges: SchematicEdge[];
};

export type SchematicSolveNode = Omit<SchematicNode, "position">;

export type SchematicSolveModel = {
  name: string;
  sweep: SweepSettings;
  nodes: SchematicSolveNode[];
  edges: SchematicEdge[];
};

export type SolvePoint = {
  frequencyHz: number;
  s11Db: number;
  s21Db: number;
  s11PhaseDeg: number;
  s21PhaseDeg: number;
};

export type SolveSummary = {
  bestMatchHz: number | null;
  midbandS11Db: number;
  midbandS21Db: number;
  componentCount: number;
  nodeCount: number;
  edgeCount: number;
  topologyLabel: string;
};

export type SolveResponse = {
  points: SolvePoint[];
  summary: SolveSummary;
  warnings: string[];
};
