import type * as THREE from "three";

export type PhoneFrameFeaturePosition = "top" | "left" | "right" | "bottom";

export type PhoneSeamPosition = PhoneFrameFeaturePosition;
export type PhoneRibPosition = PhoneFrameFeaturePosition;

export type PhoneFrameFeature = {
  width: number;
  position: PhoneFrameFeaturePosition;
  distance: number;
};

export type PhoneRibFeature = PhoneFrameFeature & {
  thickness: number;
  offset: number;
};

export type PhoneConfig = {
  frame: {
    thickness: number;
    seams: PhoneFrameFeature[];
    ribs: PhoneRibFeature[];
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
  Manifold: ManifoldStatic;
  CrossSection: CrossSectionStatic;
};

export type ManifoldStatic = {
  new (mesh: unknown): ManifoldInstance;
  union: (manifolds: ManifoldInstance[]) => ManifoldInstance;
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
  bounds: () => {
    min: [number, number];
    max: [number, number];
  };
  delete?: () => void;
  extrude: (
    height: number,
    nDivisions?: number,
    twistDegrees?: number,
    scaleTop?: readonly [number, number],
    center?: boolean
  ) => ManifoldInstance;
  isEmpty: () => boolean;
  intersect: (other: CrossSectionInstance) => CrossSectionInstance;
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
