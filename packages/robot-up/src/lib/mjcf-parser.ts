import * as THREE from "three";
import type {
  AssetFileEntry,
  ColorRgba,
  ParsedMjcfGeom,
  ParsedMjcfMeshAsset,
  ParsedMjcfScene,
  RenderableMeshFormat,
  SupportedMjcfGeomType,
  Vec3
} from "./types";

type GeomAttributeKey =
  | "type"
  | "size"
  | "rgba"
  | "pos"
  | "quat"
  | "euler"
  | "axisangle"
  | "fromto"
  | "mesh"
  | "group"
  | "material";

type GeomDefaults = Partial<Record<GeomAttributeKey, string>>;

type Transform = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
};

type DefaultCollection = {
  globalGeom: GeomDefaults;
  classes: Map<string, GeomDefaults>;
};

type ParserOptions = {
  sourcePath?: string;
  assetEntries?: AssetFileEntry[];
};

type AssetContext = {
  materials: Map<string, ColorRgba>;
  meshes: Map<string, ParsedMjcfMeshAsset>;
};

type CompilerSettings = {
  sourcePath: string;
  angle: "degree" | "radian";
  meshDir: string;
};

const GEOM_ATTRIBUTE_KEYS: GeomAttributeKey[] = [
  "type",
  "size",
  "rgba",
  "pos",
  "quat",
  "euler",
  "axisangle",
  "fromto",
  "mesh",
  "group",
  "material"
];

const IDENTITY_TRANSFORM: Transform = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion()
};

const SOURCE_PATH_ATTR = "data-mjcf-source-path";

export function parseMjcfScene(source: string, options: ParserOptions = {}): ParsedMjcfScene {
  const normalizedSourcePath = normalizePath(options.sourcePath || "");
  const assetEntries = options.assetEntries || [];
  const root = resolveMjcfRoot(source, normalizedSourcePath, assetEntries);

  const angleUnit = readCompilerAngle(root);
  const defaults = collectDefaults(root);
  const assetContext = collectAssetContext(root, normalizedSourcePath, assetEntries);
  const worldbodies = Array.from(root.children).filter((node) => node.tagName === "worldbody");
  if (worldbodies.length === 0) {
    throw new Error("MJCF document is missing <worldbody>.");
  }

  const renderCandidates: ParsedMjcfGeom[] = [];
  const unsupportedGeoms: string[] = [];
  let bodyCount = 0;
  let geomCount = 0;
  let meshGeomCount = 0;
  let resolvedMeshGeomCount = 0;

  const visitBodyChildren = (
    parent: Element,
    parentTransform: Transform,
    inheritedClass: string | null
  ) => {
    for (const child of Array.from(parent.children)) {
      if (child.tagName === "geom") {
        geomCount += 1;
        const parsedGeom = parseGeomElement(
          child,
          parentTransform,
          inheritedClass,
          defaults,
          assetContext,
          angleUnit,
          renderCandidates.length
        );
        if (parsedGeom.meshGeom) {
          meshGeomCount += 1;
        }
        if (parsedGeom.kind === "unsupported") {
          unsupportedGeoms.push(parsedGeom.label);
          continue;
        }
        if (parsedGeom.geom.type === "mesh") {
          resolvedMeshGeomCount += 1;
        }
        renderCandidates.push(parsedGeom.geom);
        continue;
      }

      if (child.tagName !== "body") {
        continue;
      }

      bodyCount += 1;
      const localTransform = readElementTransform(child, angleUnit);
      const bodyTransform = composeTransforms(parentTransform, localTransform);
      const nextInheritedClass = child.getAttribute("childclass")?.trim() || inheritedClass;
      visitBodyChildren(child, bodyTransform, nextInheritedClass);
    }
  };

  for (const worldbody of worldbodies) {
    visitBodyChildren(worldbody, IDENTITY_TRANSFORM, null);
  }

  const visibleGeoms = selectVisibleGeoms(renderCandidates);

  return {
    modelName: root.getAttribute("model")?.trim() || "unnamed_mujoco_model",
    compilerAngle: angleUnit,
    bodyCount,
    geomCount,
    renderedGeomCount: visibleGeoms.length,
    meshGeomCount,
    resolvedMeshGeomCount,
    hiddenGeomCount: renderCandidates.length - visibleGeoms.length,
    unsupportedGeoms,
    geoms: visibleGeoms
  };
}

function parseGeomElement(
  geomElement: Element,
  parentTransform: Transform,
  inheritedClass: string | null,
  defaults: DefaultCollection,
  assetContext: AssetContext,
  angleUnit: "degree" | "radian",
  index: number
):
  | { kind: "unsupported"; label: string; meshGeom: boolean }
  | { kind: "renderable"; geom: ParsedMjcfGeom; meshGeom: boolean } {
  const geomClass = geomElement.getAttribute("class")?.trim() || inheritedClass;
  const defaultValues = {
    ...defaults.globalGeom,
    ...(geomClass ? defaults.classes.get(geomClass) : undefined)
  };
  const attributes = resolveGeomAttributes(geomElement, defaultValues);
  const geomName = geomElement.getAttribute("name")?.trim() || `geom_${index + 1}`;
  const geomType = normalizeGeomType(attributes.type, Boolean(attributes.mesh));
  const group = readGroupValue(attributes.group);
  const materialName = attributes.material?.trim() || null;
  const color = readGeomColor(attributes.rgba, materialName, assetContext.materials);

  if (geomType === "mesh") {
    const meshName = attributes.mesh?.trim() || "";
    if (!meshName) {
      return {
        kind: "unsupported",
        label: `${geomName} (mesh reference missing)`,
        meshGeom: true
      };
    }

    const meshAsset = assetContext.meshes.get(meshName);
    if (!meshAsset) {
      return {
        kind: "unsupported",
        label: `${geomName} (mesh asset ${meshName} not found)`,
        meshGeom: true
      };
    }

    const localTransform = readGeomTransform(attributes, angleUnit, "mesh");
    const worldTransform = composeTransforms(parentTransform, localTransform);

    return {
      kind: "renderable",
      meshGeom: true,
      geom: {
        id: `geom-${index + 1}`,
        name: geomName,
        type: "mesh",
        position: toVec3(worldTransform.position),
        quaternion: toQuat(worldTransform.quaternion),
        size: meshAsset.scale,
        color,
        group,
        materialName,
        mesh: meshAsset
      }
    };
  }

  if (!isRenderableType(geomType)) {
    return {
      kind: "unsupported",
      label: `${geomName} (${geomType})`,
      meshGeom: false
    };
  }

  const localTransform = readGeomTransform(attributes, angleUnit, geomType);
  const worldTransform = composeTransforms(parentTransform, localTransform);
  const size = readGeomSize(attributes.size, geomType, attributes.fromto);

  return {
    kind: "renderable",
    meshGeom: false,
    geom: {
      id: `geom-${index + 1}`,
      name: geomName,
      type: geomType,
      position: toVec3(worldTransform.position),
      quaternion: toQuat(worldTransform.quaternion),
      size: toVec3(size),
      color,
      group,
      materialName,
      mesh: null
    }
  };
}

function collectDefaults(root: Element): DefaultCollection {
  const classes = new Map<string, GeomDefaults>();
  let globalGeom: GeomDefaults = {};

  const visitDefaultNode = (node: Element, inheritedGeom: GeomDefaults) => {
    const ownGeom = readImmediateGeomDefaults(node);
    const mergedGeom = { ...inheritedGeom, ...ownGeom };
    const className = node.getAttribute("class")?.trim();
    if (className) {
      classes.set(className, mergedGeom);
    } else {
      globalGeom = mergedGeom;
    }

    for (const child of Array.from(node.children)) {
      if (child.tagName === "default") {
        visitDefaultNode(child, mergedGeom);
      }
    }
  };

  for (const child of Array.from(root.children)) {
    if (child.tagName === "default") {
      visitDefaultNode(child, {});
    }
  }

  return {
    globalGeom,
    classes
  };
}

function collectAssetContext(
  root: Element,
  sourcePath: string | undefined,
  assetEntries: AssetFileEntry[]
): AssetContext {
  const materials = new Map<string, ColorRgba>();
  const meshes = new Map<string, ParsedMjcfMeshAsset>();
  const entryLookup = new Map(assetEntries.map((entry) => [normalizePath(entry.path), entry]));
  const normalizedSourcePath = normalizePath(sourcePath || "");
  const compilerSettings = collectCompilerSettings(root, normalizedSourcePath);
  const assetNodes = Array.from(root.children).filter((node) => node.tagName === "asset");

  if (assetNodes.length === 0) {
    return { materials, meshes };
  }

  for (const assetNode of assetNodes) {
    const assetSourcePath = readNodeSourcePath(assetNode, normalizedSourcePath);
    const sourceDir = dirname(assetSourcePath);
    const meshDir = resolveMeshDirForSource(assetSourcePath, compilerSettings);

    for (const child of Array.from(assetNode.children)) {
      if (child.tagName === "material") {
        const materialName = child.getAttribute("name")?.trim();
        if (!materialName) {
          continue;
        }
        materials.set(materialName, readRgbaString(child.getAttribute("rgba")));
        continue;
      }

      if (child.tagName !== "mesh") {
        continue;
      }

      const file = child.getAttribute("file")?.trim();
      if (!file) {
        continue;
      }

      const name = child.getAttribute("name")?.trim() || basenameWithoutExtension(file);
      const resolvedEntry = resolveMeshEntry(file, sourceDir, meshDir, entryLookup);
      const format = toRenderableMeshFormat(getExtension(resolvedEntry.path));
      if (!format || !resolvedEntry.entry?.objectUrl) {
        continue;
      }

      meshes.set(name, {
        name,
        path: resolvedEntry.path,
        format,
        objectUrl: resolvedEntry.entry.objectUrl,
        scale: toVec3(readVec3FromString(child.getAttribute("scale"), 1))
      });
    }
  }

  return {
    materials,
    meshes
  };
}

function readImmediateGeomDefaults(node: Element): GeomDefaults {
  const geomNode = Array.from(node.children).find((child) => child.tagName === "geom");
  if (!geomNode) {
    return {};
  }

  return extractGeomAttributes(geomNode);
}

function resolveGeomAttributes(geomElement: Element, defaults: GeomDefaults): GeomDefaults {
  return {
    ...defaults,
    ...extractGeomAttributes(geomElement)
  };
}

function extractGeomAttributes(node: Element): GeomDefaults {
  const next: GeomDefaults = {};
  for (const key of GEOM_ATTRIBUTE_KEYS) {
    const value = node.getAttribute(key);
    if (value && value.trim().length > 0) {
      next[key] = value.trim();
    }
  }
  return next;
}

function readCompilerAngle(root: Element): "degree" | "radian" {
  const compilerNodes = Array.from(root.children).filter((node) => node.tagName === "compiler");
  const compilerNode = compilerNodes[compilerNodes.length - 1];
  const rawValue = compilerNode?.getAttribute("angle")?.trim().toLowerCase();
  return rawValue === "radian" ? "radian" : "degree";
}

function readElementTransform(element: Element, angleUnit: "degree" | "radian"): Transform {
  return {
    position: readVec3FromString(element.getAttribute("pos"), 0),
    quaternion: readOrientation(element, angleUnit)
  };
}

function readGeomTransform(
  attributes: GeomDefaults,
  angleUnit: "degree" | "radian",
  geomType: SupportedMjcfGeomType | "mesh"
): Transform {
  if (attributes.fromto && (geomType === "capsule" || geomType === "cylinder")) {
    const fromtoValues = readNumberList(attributes.fromto);
    if (fromtoValues.length === 6) {
      const from = new THREE.Vector3(fromtoValues[0], fromtoValues[1], fromtoValues[2]);
      const to = new THREE.Vector3(fromtoValues[3], fromtoValues[4], fromtoValues[5]);
      const direction = to.clone().sub(from);
      const length = direction.length();
      const quaternion =
        length > 1e-6
          ? new THREE.Quaternion().setFromUnitVectors(
              new THREE.Vector3(0, 0, 1),
              direction.normalize()
            )
          : new THREE.Quaternion();

      return {
        position: from.add(to).multiplyScalar(0.5),
        quaternion
      };
    }
  }

  return {
    position: readVec3FromString(attributes.pos, 0),
    quaternion: readOrientationFromAttributes(attributes, angleUnit)
  };
}

function readOrientation(
  element: Element,
  angleUnit: "degree" | "radian"
): THREE.Quaternion {
  return readOrientationFromAttributes(
    {
      quat: element.getAttribute("quat")?.trim(),
      euler: element.getAttribute("euler")?.trim(),
      axisangle: element.getAttribute("axisangle")?.trim()
    },
    angleUnit
  );
}

function readOrientationFromAttributes(
  attributes: Partial<Record<"quat" | "euler" | "axisangle", string | undefined>>,
  angleUnit: "degree" | "radian"
): THREE.Quaternion {
  if (attributes.quat) {
    const quatValues = readNumberList(attributes.quat);
    if (quatValues.length === 4) {
      return new THREE.Quaternion(
        quatValues[1],
        quatValues[2],
        quatValues[3],
        quatValues[0]
      ).normalize();
    }
  }

  if (attributes.axisangle) {
    const axisAngleValues = readNumberList(attributes.axisangle);
    if (axisAngleValues.length === 4) {
      const axis = new THREE.Vector3(
        axisAngleValues[0],
        axisAngleValues[1],
        axisAngleValues[2]
      );
      const angle = toRadians(axisAngleValues[3], angleUnit);
      if (axis.lengthSq() > 1e-6) {
        return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle).normalize();
      }
    }
  }

  if (attributes.euler) {
    const eulerValues = readNumberList(attributes.euler);
    if (eulerValues.length === 3) {
      const euler = new THREE.Euler(
        toRadians(eulerValues[0], angleUnit),
        toRadians(eulerValues[1], angleUnit),
        toRadians(eulerValues[2], angleUnit),
        "XYZ"
      );
      return new THREE.Quaternion().setFromEuler(euler).normalize();
    }
  }

  return new THREE.Quaternion().normalize();
}

function composeTransforms(parent: Transform, local: Transform): Transform {
  return {
    position: local.position
      .clone()
      .applyQuaternion(parent.quaternion)
      .add(parent.position),
    quaternion: parent.quaternion.clone().multiply(local.quaternion).normalize()
  };
}

function readGeomSize(
  sizeValue: string | undefined,
  geomType: SupportedMjcfGeomType,
  fromtoValue: string | undefined
): THREE.Vector3 {
  const values = readNumberList(sizeValue);
  const first = values[0] ?? 0.1;
  const second = values[1] ?? first;
  const third = values[2] ?? second;

  if (geomType === "sphere") {
    return new THREE.Vector3(first, first, first);
  }

  if (geomType === "capsule" || geomType === "cylinder") {
    if (fromtoValue) {
      const fromtoValues = readNumberList(fromtoValue);
      if (fromtoValues.length === 6) {
        const from = new THREE.Vector3(fromtoValues[0], fromtoValues[1], fromtoValues[2]);
        const to = new THREE.Vector3(fromtoValues[3], fromtoValues[4], fromtoValues[5]);
        const length = to.distanceTo(from);
        if (geomType === "capsule") {
          return new THREE.Vector3(first, Math.max(length * 0.5 - first, 0.001), first);
        }
        return new THREE.Vector3(first, Math.max(length * 0.5, 0.001), first);
      }
    }
    return new THREE.Vector3(first, second, first);
  }

  if (geomType === "plane") {
    return new THREE.Vector3(first, second, third);
  }

  return new THREE.Vector3(first, second, third);
}

function readGeomColor(
  rgbaValue: string | undefined,
  materialName: string | null,
  materials: Map<string, ColorRgba>
): ColorRgba {
  const rgba = readRgbaString(rgbaValue);
  if (rgbaValue) {
    return rgba;
  }

  if (materialName) {
    return materials.get(materialName) || rgba;
  }

  return rgba;
}

function readRgbaString(rgbaValue: string | null | undefined): ColorRgba {
  const values = readNumberList(rgbaValue);
  return {
    r: clampColor(values[0] ?? 0.7),
    g: clampColor(values[1] ?? 0.7),
    b: clampColor(values[2] ?? 0.7),
    a: clampColor(values[3] ?? 1)
  };
}

function clampColor(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function readGroupValue(groupValue: string | undefined): number | null {
  if (!groupValue) {
    return null;
  }
  const parsed = Number(groupValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGeomType(rawValue: string | undefined, hasMeshReference: boolean): string {
  if (rawValue?.trim()) {
    return rawValue.trim().toLowerCase();
  }
  return hasMeshReference ? "mesh" : "sphere";
}

function isRenderableType(value: string): value is SupportedMjcfGeomType {
  return (
    value === "box" ||
    value === "sphere" ||
    value === "capsule" ||
    value === "cylinder" ||
    value === "ellipsoid" ||
    value === "plane"
  );
}

function readVec3FromString(rawValue: string | null | undefined, fallback: number): THREE.Vector3 {
  const values = readNumberList(rawValue);
  return new THREE.Vector3(
    values[0] ?? fallback,
    values[1] ?? fallback,
    values[2] ?? fallback
  );
}

function readNumberList(rawValue: string | null | undefined): number[] {
  if (!rawValue) {
    return [];
  }
  return rawValue
    .trim()
    .split(/\s+/)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));
}

function toRadians(value: number, angleUnit: "degree" | "radian"): number {
  return angleUnit === "degree" ? THREE.MathUtils.degToRad(value) : value;
}

function toVec3(vector: THREE.Vector3): Vec3 {
  return {
    x: round(vector.x),
    y: round(vector.y),
    z: round(vector.z)
  };
}

function toQuat(quaternion: THREE.Quaternion) {
  return {
    x: round(quaternion.x),
    y: round(quaternion.y),
    z: round(quaternion.z),
    w: round(quaternion.w)
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function selectVisibleGeoms(geoms: ParsedMjcfGeom[]): ParsedMjcfGeom[] {
  const visibleGeoms = geoms.filter((geom) => geom.group === null || geom.group <= 2);
  return visibleGeoms.length > 0 ? visibleGeoms : geoms;
}

function resolveMeshEntry(
  file: string,
  sourceDir: string,
  meshDir: string,
  entryLookup: Map<string, AssetFileEntry>
): { path: string; entry: AssetFileEntry | null } {
  const normalizedFile = normalizePath(file);
  const candidates = uniquePaths([
    normalizedFile,
    joinPath(sourceDir, normalizedFile),
    meshDir ? joinPath(sourceDir, meshDir, normalizedFile) : "",
    meshDir ? joinPath(meshDir, normalizedFile) : ""
  ]);

  for (const candidate of candidates) {
    const entry = entryLookup.get(candidate);
    if (entry) {
      return { path: candidate, entry };
    }
  }

  return {
    path: candidates[0] || normalizedFile,
    entry: null
  };
}

function joinPath(...parts: string[]): string {
  const result: string[] = [];

  for (const rawPart of parts) {
    if (!rawPart) {
      continue;
    }
    const normalized = normalizePath(rawPart);
    for (const segment of normalized.split("/")) {
      if (!segment || segment === ".") {
        continue;
      }
      if (segment === "..") {
        result.pop();
        continue;
      }
      result.push(segment);
    }
  }

  return result.join("/");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : "";
}

function basenameWithoutExtension(path: string): string {
  const normalized = normalizePath(path);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex >= 0 ? basename.slice(0, dotIndex) : basename;
}

function getExtension(path: string): string {
  const dotIndex = path.lastIndexOf(".");
  return dotIndex >= 0 ? path.slice(dotIndex + 1).toLowerCase() : "";
}

function toRenderableMeshFormat(extension: string): RenderableMeshFormat | null {
  if (extension === "obj" || extension === "stl") {
    return extension;
  }
  return null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean)));
}

function resolveMjcfRoot(
  source: string,
  sourcePath: string,
  assetEntries: AssetFileEntry[]
): Element {
  const entryLookup = new Map(assetEntries.map((entry) => [normalizePath(entry.path), entry]));
  const root = parseMjcfRoot(source);
  if (!root || root.tagName !== "mujoco") {
    throw new Error("XML root is not <mujoco>.");
  }

  stampSourcePath(root, sourcePath);
  resolveIncludes(root, sourcePath, entryLookup, new Set(sourcePath ? [sourcePath] : []));
  return root;
}

function parseMjcfRoot(source: string): Element {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(source, "application/xml");
  const parserError = documentNode.querySelector("parsererror");
  if (parserError) {
    throw new Error("MJCF XML could not be parsed.");
  }

  return documentNode.documentElement;
}

function resolveIncludes(
  root: Element,
  currentPath: string,
  entryLookup: Map<string, AssetFileEntry>,
  visitedPaths: Set<string>
) {
  const includeNodes = Array.from(root.children).filter((node) => node.tagName === "include");

  for (const includeNode of includeNodes) {
    const file = includeNode.getAttribute("file")?.trim();
    if (!file) {
      throw new Error("MJCF <include> is missing a file attribute.");
    }

    const resolvedPath = resolveXmlEntryPath(file, currentPath, entryLookup);
    if (visitedPaths.has(resolvedPath)) {
      throw new Error(`MJCF include cycle detected at ${resolvedPath}.`);
    }

    const includeEntry = entryLookup.get(resolvedPath);
    if (!includeEntry?.text) {
      throw new Error(`Included MJCF file was not found: ${resolvedPath}.`);
    }

    const includedRoot = parseMjcfRoot(includeEntry.text);
    if (!includedRoot || includedRoot.tagName !== "mujoco") {
      throw new Error(`Included XML root is not <mujoco>: ${resolvedPath}.`);
    }

    stampSourcePath(includedRoot, resolvedPath);
    resolveIncludes(
      includedRoot,
      resolvedPath,
      entryLookup,
      new Set([...visitedPaths, resolvedPath])
    );

    const ownerDocument = includeNode.ownerDocument;
    const parentNode = includeNode.parentNode;
    if (!ownerDocument || !parentNode) {
      continue;
    }

    for (const child of Array.from(includedRoot.children)) {
      const importedChild =
        typeof ownerDocument.importNode === "function"
          ? ownerDocument.importNode(child, true)
          : child.cloneNode(true);
      parentNode.insertBefore(importedChild, includeNode);
    }

    parentNode.removeChild(includeNode);
  }
}

function stampSourcePath(root: Element, sourcePath: string) {
  if (!sourcePath) {
    return;
  }

  const visit = (node: Element) => {
    node.setAttribute(SOURCE_PATH_ATTR, sourcePath);
    for (const child of Array.from(node.children)) {
      visit(child);
    }
  };

  visit(root);
}

function resolveXmlEntryPath(
  file: string,
  currentPath: string,
  entryLookup: Map<string, AssetFileEntry>
): string {
  const normalizedFile = normalizePath(file);
  const currentDir = dirname(currentPath);
  const candidates = uniquePaths([
    normalizedFile,
    joinPath(currentDir, normalizedFile)
  ]);

  for (const candidate of candidates) {
    const entry = entryLookup.get(candidate);
    if (entry?.kind === "mujoco-xml" || entry?.extension === "xml" || entry?.extension === "mjcf") {
      return candidate;
    }
  }

  return candidates[0] || normalizedFile;
}

function collectCompilerSettings(root: Element, sourcePath: string): CompilerSettings[] {
  return Array.from(root.children)
    .filter((node) => node.tagName === "compiler")
    .map((node) => ({
      sourcePath: readNodeSourcePath(node, sourcePath),
      angle: node.getAttribute("angle")?.trim().toLowerCase() === "radian" ? "radian" : "degree",
      meshDir: node.getAttribute("meshdir")?.trim() || ""
    }));
}

function resolveMeshDirForSource(
  assetSourcePath: string,
  compilerSettings: CompilerSettings[]
): string {
  for (let index = compilerSettings.length - 1; index >= 0; index -= 1) {
    const candidate = compilerSettings[index];
    if (candidate.sourcePath === assetSourcePath) {
      return candidate.meshDir;
    }
  }

  return "";
}

function readNodeSourcePath(node: Element, fallback: string): string {
  return node.getAttribute(SOURCE_PATH_ATTR)?.trim() || fallback;
}
