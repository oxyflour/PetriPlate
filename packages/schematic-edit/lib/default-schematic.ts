import type { SchematicModel } from "./types";
import {
  FIXED_NODE_IDS,
  cloneSchematic,
  createGroundNode,
  createPortNode
} from "./schematic-graph";

type PresetDefinition = {
  id: string;
  label: string;
  description: string;
  schematic: SchematicModel;
};

function createBaseNodes() {
  return [
    createPortNode("input", { x: 180, y: 250 }),
    createPortNode("output", { x: 1340, y: 250 }),
    createGroundNode({ x: 760, y: 610 })
  ];
}

export { cloneSchematic };

export const DEFAULT_SCHEMATIC: SchematicModel = {
  name: "Two-section low-pass",
  sweep: {
    startGhz: 0.1,
    stopGhz: 12,
    points: 241,
    portImpedanceOhm: 50
  },
  nodes: [
    ...createBaseNodes(),
    {
      id: "node-l1",
      kind: "inductor",
      label: "Input L",
      value: 4.7,
      unit: "nH",
      position: { x: 420, y: 250 }
    },
    {
      id: "node-c1",
      kind: "capacitor",
      label: "Shunt C",
      value: 1.6,
      unit: "pF",
      position: { x: 760, y: 430 }
    },
    {
      id: "node-l2",
      kind: "inductor",
      label: "Output L",
      value: 4.7,
      unit: "nH",
      position: { x: 1080, y: 250 }
    }
  ],
  edges: [
    {
      id: "edge-p1-l1",
      from: { nodeId: FIXED_NODE_IDS.input, terminal: "port" },
      to: { nodeId: "node-l1", terminal: "left" }
    },
    {
      id: "edge-l1-mid",
      from: { nodeId: "node-l1", terminal: "right" },
      to: { nodeId: "node-c1", terminal: "left" }
    },
    {
      id: "edge-mid-l2",
      from: { nodeId: "node-l1", terminal: "right" },
      to: { nodeId: "node-l2", terminal: "left" }
    },
    {
      id: "edge-c1-gnd",
      from: { nodeId: "node-c1", terminal: "right" },
      to: { nodeId: FIXED_NODE_IDS.ground, terminal: "port" }
    },
    {
      id: "edge-l2-p2",
      from: { nodeId: "node-l2", terminal: "right" },
      to: { nodeId: FIXED_NODE_IDS.output, terminal: "port" }
    }
  ]
};

export const PRESET_SCHEMATICS: PresetDefinition[] = [
  {
    id: "low-pass",
    label: "Low-pass",
    description: "Two-pole LC ladder around 5 to 6 GHz.",
    schematic: DEFAULT_SCHEMATIC
  },
  {
    id: "l-match",
    label: "L-match",
    description: "Series capacitor with a shunt inductor tied to ground.",
    schematic: {
      name: "L-match",
      sweep: {
        startGhz: 0.4,
        stopGhz: 8,
        points: 221,
        portImpedanceOhm: 50
      },
      nodes: [
        ...createBaseNodes(),
        {
          id: "node-cs",
          kind: "capacitor",
          label: "Series C",
          value: 0.85,
          unit: "pF",
          position: { x: 520, y: 250 }
        },
        {
          id: "node-lp",
          kind: "inductor",
          label: "Shunt L",
          value: 10,
          unit: "nH",
          position: { x: 900, y: 430 }
        }
      ],
      edges: [
        {
          id: "edge-p1-cs",
          from: { nodeId: FIXED_NODE_IDS.input, terminal: "port" },
          to: { nodeId: "node-cs", terminal: "left" }
        },
        {
          id: "edge-cs-lp",
          from: { nodeId: "node-cs", terminal: "right" },
          to: { nodeId: "node-lp", terminal: "left" }
        },
        {
          id: "edge-cs-p2",
          from: { nodeId: "node-cs", terminal: "right" },
          to: { nodeId: FIXED_NODE_IDS.output, terminal: "port" }
        },
        {
          id: "edge-lp-gnd",
          from: { nodeId: "node-lp", terminal: "right" },
          to: { nodeId: FIXED_NODE_IDS.ground, terminal: "port" }
        }
      ]
    }
  },
  {
    id: "resistive-pad",
    label: "Attenuator",
    description: "Series / shunt resistor graph for a broadband sanity check.",
    schematic: {
      name: "Resistive pad",
      sweep: {
        startGhz: 0.1,
        stopGhz: 18,
        points: 181,
        portImpedanceOhm: 50
      },
      nodes: [
        ...createBaseNodes(),
        {
          id: "node-r1",
          kind: "resistor",
          label: "Series R1",
          value: 18,
          unit: "ohm",
          position: { x: 420, y: 250 }
        },
        {
          id: "node-r2",
          kind: "resistor",
          label: "Shunt R",
          value: 180,
          unit: "ohm",
          position: { x: 760, y: 430 }
        },
        {
          id: "node-r3",
          kind: "resistor",
          label: "Series R2",
          value: 18,
          unit: "ohm",
          position: { x: 1080, y: 250 }
        }
      ],
      edges: [
        {
          id: "edge-p1-r1",
          from: { nodeId: FIXED_NODE_IDS.input, terminal: "port" },
          to: { nodeId: "node-r1", terminal: "left" }
        },
        {
          id: "edge-r1-r2",
          from: { nodeId: "node-r1", terminal: "right" },
          to: { nodeId: "node-r2", terminal: "left" }
        },
        {
          id: "edge-r1-r3",
          from: { nodeId: "node-r1", terminal: "right" },
          to: { nodeId: "node-r3", terminal: "left" }
        },
        {
          id: "edge-r2-gnd",
          from: { nodeId: "node-r2", terminal: "right" },
          to: { nodeId: FIXED_NODE_IDS.ground, terminal: "port" }
        },
        {
          id: "edge-r3-p2",
          from: { nodeId: "node-r3", terminal: "right" },
          to: { nodeId: FIXED_NODE_IDS.output, terminal: "port" }
        }
      ]
    }
  }
];
