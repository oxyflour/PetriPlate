import type * as THREE from "three";

export type PhoneSeamPosition = "top" | "left" | "right" | "bottom";

export type PhoneConfig = {
  frame: {
    thickness: number;
    seams: Array<{
      width: number;
      position: PhoneSeamPosition;
      distance: number;
    }>;
  };
};

export type ParsedPhoneConfig =
  | { ok: true; value: PhoneConfig }
  | { ok: false; error: string };

export type ModelMetrics = {
  size: { x: number; y: number; z: number };
  triangles: number;
};

export type SourceModel = {
  geometry: THREE.BufferGeometry;
  label: string;
  metrics: ModelMetrics;
};

export type BuildPreviewResult = {
  sourceGeometry: THREE.BufferGeometry;
  frameGeometry: THREE.BufferGeometry;
  warnings: string[];
  metrics: {
    originalTriangles: number;
    frameTriangles: number;
    contours: number;
  };
};

export type LogEntry = {
  id: string;
  time: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type ManifoldRuntime = {
  setup: () => void;
  Mesh: new (options: {
    numProp: number;
    triVerts: Uint32Array;
    vertProperties: Float32Array;
  }) => unknown;
  Manifold: new (mesh: unknown) => ManifoldInstance;
  CrossSection: CrossSectionStatic;
};

export type ManifoldInstance = {
  delete?: () => void;
  getMesh: () => {
    numProp: number;
    triVerts: Uint32Array;
    vertProperties: Float32Array;
  };
  isEmpty: () => boolean;
  intersect: (other: ManifoldInstance) => ManifoldInstance;
  project: () => CrossSectionInstance;
  subtract: (other: ManifoldInstance) => ManifoldInstance;
  translate: (x: number, y?: number, z?: number) => ManifoldInstance;
};

export type CrossSectionStatic = {
  square: (
    size?: number | readonly [number, number],
    center?: boolean
  ) => CrossSectionInstance;
};

export type CrossSectionInstance = {
  add: (other: CrossSectionInstance) => CrossSectionInstance;
  delete?: () => void;
  extrude: (
    height: number,
    nDivisions?: number,
    twistDegrees?: number,
    scaleTop?: readonly [number, number],
    center?: boolean
  ) => ManifoldInstance;
  isEmpty: () => boolean;
  numContour: () => number;
  offset: (delta: number) => CrossSectionInstance;
  simplify: (epsilon?: number) => CrossSectionInstance;
  subtract: (other: CrossSectionInstance) => CrossSectionInstance;
  translate: (x: number, y?: number) => CrossSectionInstance;
};

export type BuildPreviewOptions = {
  config: PhoneConfig;
  runtime: ManifoldRuntime;
  sourceModel: SourceModel;
};
