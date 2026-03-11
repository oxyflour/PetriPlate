import JSZip from "jszip";
import { parseMjcfScene } from "./mjcf-parser";
import {
  SAMPLE_ASSET_NAME,
  SAMPLE_ARM_PATH,
  SAMPLE_ISAAC_ASSET_NAME,
  SAMPLE_MESH_PATH,
  SAMPLE_SCENE_MJCF,
  SAMPLE_SCENE_PATH,
  SAMPLE_MJCF,
  SAMPLE_OBJ,
  SAMPLE_STAGE_PATH,
  SAMPLE_STAGE_USDA
} from "./sample-asset";
import type {
  AssetAnalysis,
  AssetEntryKind,
  AssetFileEntry,
  ParsedMjcfScene,
  RuntimeKind
} from "./types";

const RELEVANT_EXTENSIONS = new Set([
  "xml",
  "mjcf",
  "usda",
  "usd",
  "usdc",
  "urdf",
  "obj",
  "stl",
  "msh"
]);
const ISAAC_STAGE_EXTENSIONS = new Set(["usda", "usd", "usdc"]);
const ISAAC_URDF_EXTENSIONS = new Set(["urdf"]);
const MESH_EXTENSIONS = new Set(["obj", "stl", "msh"]);

export async function createSampleAssetAnalysis(): Promise<AssetAnalysis> {
  const sampleMeshBlob = new Blob([SAMPLE_OBJ], { type: "text/plain" });

  return buildAnalysis({
    sourceName: SAMPLE_ASSET_NAME,
    sourceKind: "sample",
    entries: [
      {
        path: SAMPLE_SCENE_PATH,
        size: new TextEncoder().encode(SAMPLE_SCENE_MJCF).byteLength,
        extension: "xml",
        kind: "mujoco-xml",
        text: SAMPLE_SCENE_MJCF
      },
      {
        path: SAMPLE_ARM_PATH,
        size: new TextEncoder().encode(SAMPLE_MJCF).byteLength,
        extension: "xml",
        kind: "mujoco-xml",
        text: SAMPLE_MJCF
      },
      {
        path: SAMPLE_MESH_PATH,
        size: new TextEncoder().encode(SAMPLE_OBJ).byteLength,
        extension: "obj",
        kind: "mesh",
        blob: sampleMeshBlob,
        objectUrl: createObjectUrl(sampleMeshBlob)
      }
    ]
  });
}

export async function createSampleIsaacAssetAnalysis(): Promise<AssetAnalysis> {
  return buildAnalysis({
    sourceName: SAMPLE_ISAAC_ASSET_NAME,
    sourceKind: "sample",
    entries: [
      {
        path: SAMPLE_STAGE_PATH,
        size: new TextEncoder().encode(SAMPLE_STAGE_USDA).byteLength,
        extension: "usda",
        kind: "isaac-stage",
        text: SAMPLE_STAGE_USDA
      }
    ]
  });
}

export async function createSampleAssetFile(): Promise<File> {
  const archive = new JSZip();
  archive.file(SAMPLE_SCENE_PATH, SAMPLE_SCENE_MJCF);
  archive.file(SAMPLE_ARM_PATH, SAMPLE_MJCF);
  archive.file(SAMPLE_MESH_PATH, SAMPLE_OBJ);

  const blob = await archive.generateAsync({ type: "blob" });
  return new File([blob], "sample-mujoco-bundle.zip", {
    type: "application/zip"
  });
}

export async function createSampleIsaacAssetFile(): Promise<File> {
  return new File([SAMPLE_STAGE_USDA], "sample-factory-cell.usda", {
    type: "text/plain"
  });
}

export async function createAssetAnalysisFromFile(file: File): Promise<AssetAnalysis> {
  const extension = getExtension(file.name);

  if (extension === "zip") {
    const entries = await readRelevantZipEntries(await file.arrayBuffer());
    return buildAnalysis({
      sourceName: file.name,
      sourceKind: "upload",
      entries
    });
  }

  if (MESH_EXTENSIONS.has(extension)) {
    return buildAnalysis({
      sourceName: file.name,
      sourceKind: "upload",
      entries: [
        {
          path: normalizePath(file.name),
          size: file.size,
          extension,
          kind: "mesh",
          blob: file,
          objectUrl: createObjectUrl(file)
        }
      ]
    });
  }

  if (ISAAC_STAGE_EXTENSIONS.has(extension)) {
    const text = await readUsdaTextIfPresent(file);
    return buildAnalysis({
      sourceName: file.name,
      sourceKind: "upload",
      entries: [
        {
          path: normalizePath(file.name),
          size: file.size,
          extension,
          kind: "isaac-stage",
          text,
          blob: file
        }
      ]
    });
  }

  if (ISAAC_URDF_EXTENSIONS.has(extension)) {
    const text = await file.text();
    return buildAnalysis({
      sourceName: file.name,
      sourceKind: "upload",
      entries: [
        {
          path: normalizePath(file.name),
          size: file.size,
          extension,
          kind: "isaac-urdf",
          text,
          blob: file
        }
      ]
    });
  }

  const text = await file.text();
  return buildAnalysis({
    sourceName: file.name,
    sourceKind: "upload",
    entries: [
      {
        path: normalizePath(file.name),
        size: file.size,
        extension,
        kind: classifyEntryKind(file.name, text),
        text
      }
    ]
  });
}

export function revokeAssetObjectUrls(entries: AssetFileEntry[]) {
  for (const entry of entries) {
    if (entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl);
    }
  }
}

export function resolveMujocoEntrySelection(
  entries: AssetFileEntry[],
  selectedEntryPath: string | null | undefined
): {
  entry: AssetFileEntry | null;
  scene: ParsedMjcfScene | null;
  warnings: string[];
} {
  const mujocoCandidates = entries.filter((entry) => entry.kind === "mujoco-xml");
  const fallbackEntry = mujocoCandidates[0] || null;
  const selectedEntry =
    (selectedEntryPath
      ? mujocoCandidates.find((entry) => entry.path === selectedEntryPath) || null
      : null) || fallbackEntry;

  if (!selectedEntry?.text) {
    return {
      entry: selectedEntry,
      scene: null,
      warnings: []
    };
  }

  try {
    const scene = parseMjcfScene(selectedEntry.text, {
      sourcePath: selectedEntry.path,
      assetEntries: entries
    });
    return {
      entry: selectedEntry,
      scene,
      warnings: collectMujocoSceneWarnings(scene)
    };
  } catch (error) {
    return {
      entry: selectedEntry,
      scene: null,
      warnings: [toMessage(error, "MuJoCo scene could not be parsed.")]
    };
  }
}

export function resolveIsaacEntrySelection(
  entries: AssetFileEntry[],
  selectedEntryPath: string | null | undefined
): {
  entry: AssetFileEntry | null;
  preview: string | null;
} {
  const isaacCandidates = [...entries.filter(isIsaacEntry)].sort(compareIsaacEntries);
  const fallbackEntry = isaacCandidates[0] || null;
  const selectedEntry =
    (selectedEntryPath
      ? isaacCandidates.find((entry) => entry.path === selectedEntryPath) || null
      : null) || fallbackEntry;

  return {
    entry: selectedEntry,
    preview: selectedEntry?.text ? createTextPreview(selectedEntry.text) : null
  };
}

async function readRelevantZipEntries(buffer: ArrayBuffer): Promise<AssetFileEntry[]> {
  const zip = await JSZip.loadAsync(buffer);
  const entries: AssetFileEntry[] = [];

  for (const zipEntry of Object.values(zip.files)) {
    if (zipEntry.dir) {
      continue;
    }

    const extension = getExtension(zipEntry.name);
    if (!RELEVANT_EXTENSIONS.has(extension)) {
      continue;
    }

    const path = normalizePath(zipEntry.name);

    if (MESH_EXTENSIONS.has(extension)) {
      const blob = await zipEntry.async("blob");
      entries.push({
        path,
        size: blob.size,
        extension,
        kind: "mesh",
        blob,
        objectUrl: createObjectUrl(blob)
      });
      continue;
    }

    if (ISAAC_STAGE_EXTENSIONS.has(extension)) {
      const blob = await zipEntry.async("blob");
      entries.push({
        path,
        size: blob.size,
        extension,
        kind: "isaac-stage",
        text: await readUsdaTextIfPresent(blob),
        blob
      });
      continue;
    }

    if (ISAAC_URDF_EXTENSIONS.has(extension)) {
      const text = await zipEntry.async("text");
      entries.push({
        path,
        size: new TextEncoder().encode(text).byteLength,
        extension,
        kind: "isaac-urdf",
        text
      });
      continue;
    }

    const text = await zipEntry.async("text");
    entries.push({
      path,
      size: new TextEncoder().encode(text).byteLength,
      extension,
      kind: classifyEntryKind(path, text),
      text
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function buildAnalysis(input: {
  sourceName: string;
  sourceKind: "upload" | "sample";
  entries: AssetFileEntry[];
}): AssetAnalysis {
  const runtimeEntries: Partial<Record<RuntimeKind, AssetFileEntry>> = {};
  const runtimeCandidates: Partial<Record<RuntimeKind, AssetFileEntry[]>> = {};
  const warnings: string[] = [];
  const mujocoCandidates = input.entries.filter((entry) => entry.kind === "mujoco-xml");
  const isaacCandidates = [...input.entries.filter(isIsaacEntry)].sort(compareIsaacEntries);
  const mujocoEntry = mujocoCandidates[0] || null;
  const isaacEntry = isaacCandidates[0] || null;

  if (mujocoEntry) {
    runtimeEntries.mujoco = mujocoEntry;
    runtimeCandidates.mujoco = mujocoCandidates;
  }
  if (isaacEntry) {
    runtimeEntries.isaacsim = isaacEntry;
    runtimeCandidates.isaacsim = isaacCandidates;
  }

  const availableRuntimes: RuntimeKind[] = [];
  if (mujocoEntry) {
    availableRuntimes.push("mujoco");
  }
  if (isaacEntry) {
    availableRuntimes.push("isaacsim");
  }

  const defaultRuntime = mujocoEntry ? "mujoco" : isaacEntry ? "isaacsim" : null;
  if (mujocoEntry && isaacEntry) {
    warnings.push(
      "Archive contains both MJCF and USD assets, so MuJoCo is selected by default."
    );
  }
  if (mujocoCandidates.length > 1) {
    warnings.push(
      `Detected ${mujocoCandidates.length} MuJoCo XML candidates. Pick the desired entry file below.`
    );
  }
  if (isaacCandidates.length > 1) {
    warnings.push(
      `Detected ${isaacCandidates.length} Isaac USD/URDF candidates. Pick the desired asset below.`
    );
  }
  if (!defaultRuntime) {
    warnings.push("No MuJoCo XML, Isaac USD stage, or URDF asset was found in the selected asset.");
  }

  const defaultMujocoSelection = resolveMujocoEntrySelection(input.entries, mujocoEntry?.path || null);

  const isaacPreview = isaacEntry?.text ? createTextPreview(isaacEntry.text) : null;

  return {
    sourceName: input.sourceName,
    sourceKind: input.sourceKind,
    availableRuntimes,
    defaultRuntime,
    runtimeEntries,
    runtimeCandidates,
    entries: input.entries,
    warnings,
    mujocoScene: defaultMujocoSelection.scene,
    isaacPreview
  };
}

function classifyEntryKind(path: string, text?: string): AssetEntryKind {
  const extension = getExtension(path);
  const trimmed = normalizeLeadingText(text);

  if ((extension === "xml" || extension === "mjcf") && /<mujoco[\s>]/i.test(trimmed)) {
    return "mujoco-xml";
  }

  if (ISAAC_STAGE_EXTENSIONS.has(extension) || trimmed.startsWith("#usda")) {
    return "isaac-stage";
  }

  if (ISAAC_URDF_EXTENSIONS.has(extension) || /<robot[\s>]/i.test(trimmed)) {
    return "isaac-urdf";
  }

  if (MESH_EXTENSIONS.has(extension)) {
    return "mesh";
  }

  return "other";
}

function createTextPreview(source: string): string {
  return source
    .split(/\r?\n/)
    .slice(0, 40)
    .join("\n")
    .trim();
}

function isIsaacEntry(entry: AssetFileEntry) {
  return entry.kind === "isaac-stage" || entry.kind === "isaac-urdf";
}

function compareIsaacEntries(left: AssetFileEntry, right: AssetFileEntry) {
  const leftWeight = isaacEntryPriority(left.extension);
  const rightWeight = isaacEntryPriority(right.extension);
  if (leftWeight !== rightWeight) {
    return leftWeight - rightWeight;
  }
  return left.path.localeCompare(right.path);
}

function isaacEntryPriority(extension: string) {
  if (extension === "usda") {
    return 0;
  }
  if (extension === "usd") {
    return 1;
  }
  if (extension === "usdc") {
    return 2;
  }
  if (extension === "urdf") {
    return 3;
  }
  return 4;
}

function createObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function getExtension(path: string): string {
  const normalized = path.toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 ? normalized.slice(dotIndex + 1) : "";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function readUsdaTextIfPresent(blob: Blob): Promise<string | undefined> {
  try {
    const header = normalizeLeadingText(await blob.slice(0, 4096).text());
    if (!header.startsWith("#usda")) {
      return undefined;
    }
    return stripUtf8Bom(await blob.text());
  } catch {
    return undefined;
  }
}

function normalizeLeadingText(text?: string) {
  return stripUtf8Bom(text || "").trimStart();
}

function stripUtf8Bom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function collectMujocoSceneWarnings(scene: ParsedMjcfScene): string[] {
  const warnings: string[] = [];

  if (
    scene.meshGeomCount > 0 &&
    scene.resolvedMeshGeomCount < scene.meshGeomCount
  ) {
    warnings.push(
      `Resolved ${scene.resolvedMeshGeomCount} of ${scene.meshGeomCount} MuJoCo mesh geom(s). Unresolved or unsupported meshes were skipped.`
    );
  }
  if (scene.hiddenGeomCount > 0) {
    warnings.push(
      `Hidden ${scene.hiddenGeomCount} collision geom(s) by default because their MuJoCo group is greater than 2.`
    );
  }
  if (scene.unsupportedGeoms.length > 0) {
    warnings.push(`Skipped ${scene.unsupportedGeoms.length} unsupported MuJoCo geom(s).`);
  }

  return warnings;
}
