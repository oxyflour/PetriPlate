export type RuntimeKind = "mujoco" | "isaacsim";

export type AssetEntryKind =
  | "mujoco-xml"
  | "isaac-stage"
  | "isaac-urdf"
  | "mesh"
  | "other";

export type AssetFileEntry = {
  path: string;
  size: number;
  extension: string;
  kind: AssetEntryKind;
  text?: string;
  blob?: Blob;
  objectUrl?: string;
};

export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type Quat = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type ColorRgba = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type SupportedMjcfGeomType =
  | "box"
  | "sphere"
  | "capsule"
  | "cylinder"
  | "ellipsoid"
  | "plane";

export type RenderableMeshFormat = "obj" | "stl";

export type ParsedMjcfMeshAsset = {
  name: string;
  path: string;
  format: RenderableMeshFormat;
  objectUrl: string | null;
  scale: Vec3;
};

export type ParsedMjcfGeom = {
  id: string;
  name: string;
  type: SupportedMjcfGeomType | "mesh";
  position: Vec3;
  quaternion: Quat;
  size: Vec3;
  color: ColorRgba;
  group: number | null;
  materialName: string | null;
  mesh: ParsedMjcfMeshAsset | null;
};

export type ParsedMjcfScene = {
  modelName: string;
  compilerAngle: "degree" | "radian";
  bodyCount: number;
  geomCount: number;
  renderedGeomCount: number;
  meshGeomCount: number;
  resolvedMeshGeomCount: number;
  hiddenGeomCount: number;
  unsupportedGeoms: string[];
  geoms: ParsedMjcfGeom[];
};

export type AssetAnalysis = {
  sourceName: string;
  sourceKind: "upload" | "sample";
  availableRuntimes: RuntimeKind[];
  defaultRuntime: RuntimeKind | null;
  runtimeEntries: Partial<Record<RuntimeKind, AssetFileEntry>>;
  runtimeCandidates: Partial<Record<RuntimeKind, AssetFileEntry[]>>;
  entries: AssetFileEntry[];
  warnings: string[];
  mujocoScene: ParsedMjcfScene | null;
  isaacPreview: string | null;
};

export type IsaacStagePrim = {
  path: string;
  name: string;
  parentPath: string | null;
  type: string;
  purpose: string | null;
  visible: boolean;
  hasGeometry: boolean;
  childCount: number;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  bboxMin: Vec3;
  bboxMax: Vec3;
  renderable: IsaacStageRenderable | null;
};

export type IsaacStageRenderableAxis = "X" | "Y" | "Z";

export type IsaacStageMeshRenderable = {
  kind: "mesh";
  positions: number[];
  indices: number[];
  doubleSided: boolean;
};

export type IsaacStageAssetMeshFormat = "dae" | "stl" | "obj";

export type IsaacStageAssetMeshRenderable = {
  kind: "asset_mesh";
  assetPath: string;
  format: IsaacStageAssetMeshFormat;
};

export type IsaacStageBoxRenderable = {
  kind: "box";
  size: Vec3;
};

export type IsaacStageCubeRenderable = {
  kind: "cube";
  size: number;
};

export type IsaacStageSphereRenderable = {
  kind: "sphere";
  radius: number;
};

export type IsaacStageCapsuleRenderable = {
  kind: "capsule";
  radius: number;
  height: number;
  axis: IsaacStageRenderableAxis;
};

export type IsaacStageCylinderRenderable = {
  kind: "cylinder";
  radius: number;
  height: number;
  axis: IsaacStageRenderableAxis;
};

export type IsaacStageConeRenderable = {
  kind: "cone";
  radius: number;
  height: number;
  axis: IsaacStageRenderableAxis;
};

export type IsaacStageRenderable =
  | IsaacStageMeshRenderable
  | IsaacStageAssetMeshRenderable
  | IsaacStageBoxRenderable
  | IsaacStageCubeRenderable
  | IsaacStageSphereRenderable
  | IsaacStageCapsuleRenderable
  | IsaacStageCylinderRenderable
  | IsaacStageConeRenderable;

export type IsaacStageFramePrim = {
  path: string;
  visible: boolean;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
};

export type IsaacStageManifestMessage = {
  type: "stage_manifest";
  source: "isaacsim";
  stage_path: string;
  stage_mtime_ns: number;
  default_prim: string | null;
  up_axis: string | null;
  meters_per_unit: number | null;
  start_time_code: number;
  end_time_code: number;
  time_codes_per_second: number;
  active_time_code: number;
  prim_count: number;
  geometry_count: number;
  renderable_count: number;
  mesh_prim_count: number;
  prims: IsaacStagePrim[];
};

export type IsaacStageFrameMessage = {
  type: "stage_frame";
  source: "isaacsim";
  seq: number;
  timestamp: string;
  time_code: number;
  prim_count: number;
  prims: IsaacStageFramePrim[];
};

export type IsaacStageErrorMessage = {
  type: "stage_error";
  source: "isaacsim";
  message: string;
};

export type IsaacBridgeMessage =
  | IsaacStageManifestMessage
  | IsaacStageFrameMessage
  | IsaacStageErrorMessage;

export type IsaacSessionStatus = "starting" | "ready" | "error";

export type IsaacSessionPhase =
  | "launching"
  | "waiting_runtime"
  | "loading_stage"
  | "starting_websocket"
  | "ready"
  | "error";

export type IsaacSessionInfo = {
  sessionId: string;
  wsUrl: string;
  assetBaseUrl: string;
  selectedEntryPath: string;
  expiresAt: string;
  status: IsaacSessionStatus;
  phase: IsaacSessionPhase;
  statusMessage: string;
  recentLogs: string[];
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
};

export type MujocoManifestBody = {
  id: number;
  name: string;
  parent_id: number;
  position: Vec3;
  quaternion: Quat;
};

export type MujocoRuntimeMeshAsset = {
  id: number;
  name: string;
  path: string;
  url: string | null;
  format: string;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
};

export type MujocoManifestGeom = {
  id: number;
  name: string;
  type: SupportedMjcfGeomType | "mesh" | "unknown";
  body_id: number;
  body_name: string;
  position: Vec3;
  quaternion: Quat;
  size: Vec3;
  rgba: ColorRgba;
  mesh?: MujocoRuntimeMeshAsset;
};

export type MujocoModelManifestMessage = {
  type: "model_manifest";
  source: "mujoco";
  body: string;
  model_path: string;
  model_mtime_ns: number;
  body_count: number;
  mesh_count: number;
  geom_count: number;
  bodies: MujocoManifestBody[];
  geoms: MujocoManifestGeom[];
};

export type MujocoPoseMessage = {
  type: "pose";
  source: "mujoco";
  seq: number;
  body: string;
  timestamp: string;
  sim_time: number;
  position: Vec3;
  quaternion: Quat;
};

export type MujocoPoseFrameBody = {
  id: number;
  name: string;
  position: Vec3;
  quaternion: Quat;
};

export type MujocoPoseFrameMessage = {
  type: "pose_frame";
  source: "mujoco";
  seq: number;
  body: string;
  timestamp: string;
  sim_time: number;
  position: Vec3;
  quaternion: Quat;
  body_count: number;
  bodies: MujocoPoseFrameBody[];
};

export type MujocoModelManifestUnavailableMessage = {
  type: "model_manifest_unavailable";
  source: "mujoco";
  requested_body: string | null;
  available_body: string | null;
};

export type MujocoBridgeMessage =
  | MujocoModelManifestMessage
  | MujocoPoseMessage
  | MujocoPoseFrameMessage
  | MujocoModelManifestUnavailableMessage;

export type MujocoSessionInfo = {
  sessionId: string;
  wsUrl: string;
  assetBaseUrl: string;
  selectedEntryPath: string;
  expiresAt: string;
};
