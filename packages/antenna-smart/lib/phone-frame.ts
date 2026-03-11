import * as THREE from "three";
import {
  mergeVertices,
  toCreasedNormals
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { countTriangles } from "./defaults";
import type {
  BuildPreviewOptions,
  BuildPreviewResult,
  CrossSectionInstance,
  ManifoldInstance
} from "./types";

export function buildPhoneFramePreview({
  config,
  runtime,
  sourceModel
}: BuildPreviewOptions): BuildPreviewResult {
  const sourceGeometry = sourceModel.geometry.clone();
  sourceGeometry.computeBoundingBox();
  sourceGeometry.computeBoundingSphere();
  sourceGeometry.computeVertexNormals();

  const boundingBox = sourceGeometry.boundingBox;
  if (!boundingBox) {
    throw new Error("Source geometry does not have a bounding box");
  }

  const size = boundingBox.getSize(new THREE.Vector3());
  if (config.frame.thickness >= Math.min(size.x, size.y) / 2) {
    sourceGeometry.dispose();
    throw new Error("frame.thickness is too large for this phone outline");
  }

  const manifoldMesh = new runtime.Mesh(createMeshOptions(sourceGeometry)) as {
    merge?: () => boolean;
  };
  manifoldMesh.merge?.();

  let sourceBody: ManifoldInstance | null = null;
  let projected: CrossSectionInstance | null = null;
  let offsetInner: CrossSectionInstance | null = null;
  let inner: CrossSectionInstance | null = null;
  let frameSection: CrossSectionInstance | null = null;
  let frameRingSection: CrossSectionInstance | null = null;
  let ribClipArea: CrossSectionInstance | null = null;
  let innerBottom: ManifoldInstance | null = null;
  let innerVolume: ManifoldInstance | null = null;
  let frameResult: ManifoldInstance | null = null;
  const warnings: string[] = [];

  try {
    sourceBody = new runtime.Manifold(manifoldMesh);
    projected = sourceBody.project();
    offsetInner = projected.offset(-config.frame.thickness);
    inner = offsetInner.simplify(Math.max(config.frame.thickness / 18, 1e-4));

    if (inner.isEmpty()) {
      throw new Error("Inner outline collapsed. Reduce frame.thickness.");
    }

    frameSection = projected.subtract(inner);

    if (frameSection.isEmpty()) {
      throw new Error("Inner outline removed the entire frame.");
    }

    const booleanOvershoot = getBooleanOvershoot(size, config.frame.thickness);
    const booleanHeight = size.z + booleanOvershoot * 2;

    innerVolume = inner.extrude(booleanHeight, 0, 0);
    innerBottom = innerVolume.translate(0, 0, boundingBox.min.z-booleanOvershoot);
    frameResult = sourceBody.subtract(innerBottom);

    if (frameResult.isEmpty()) {
      throw new Error("Frame boolean result is empty.");
    }

    const seamCutDepth = getSeamCutDepth(size, config.frame.thickness);
    let currentFrameSection = frameSection;
    let currentFrameResult = frameResult;

    for (const seam of config.frame.seams) {
      const seamSection = createSeamCutter(
        runtime,
        seam.position,
        seam.distance,
        seam.width,
        size,
        seamCutDepth
      );
      const nextFrameSection = currentFrameSection.subtract(seamSection);
      const seamVolume = seamSection.extrude(booleanHeight, 0, 0, [1, 1], true);
      const nextFrameResult = currentFrameResult.subtract(seamVolume);
      const simplifiedFrameSection = nextFrameSection.simplify(Math.max(seam.width / 64, 1e-4));

      tryDelete(seamSection);
      tryDelete(seamVolume);
      if (currentFrameSection !== simplifiedFrameSection) {
        tryDelete(currentFrameSection);
      }
      if (currentFrameResult !== nextFrameResult) {
        tryDelete(currentFrameResult);
      }
      if (nextFrameSection !== simplifiedFrameSection) {
        tryDelete(nextFrameSection);
      }
      currentFrameSection = simplifiedFrameSection;
      currentFrameResult = nextFrameResult;

      if (currentFrameSection.isEmpty() || currentFrameResult.isEmpty()) {
        throw new Error("All frame material was removed by seam cuts.");
      }
    }

    frameRingSection = currentFrameSection;
    frameSection = currentFrameSection;
    frameResult = currentFrameResult;

    if (config.frame.seams.length === 0) {
      warnings.push("No seam cuts configured");
    }

    if (config.frame.ribs.length > 0) {
      const ribDepth = getRibDepth(size, config.frame.thickness);
      const ribJoinOverlap = getRibJoinOverlap(config.frame.thickness);
      const ribSimplifyEpsilon = 1e-4;
      const innerBounds = inner.bounds();
      ribClipArea = frameRingSection.add(inner);
      let currentFootprintSection = frameSection;
      let currentFrameResultWithRibs = frameResult;

      for (const [index, rib] of config.frame.ribs.entries()) {
        let ribRectangle: CrossSectionInstance | null = null;
        let ribSection: CrossSectionInstance | null = null;
        let ribAnchor: CrossSectionInstance | null = null;
        let ribVolumeBase: ManifoldInstance | null = null;
        let ribVolume: ManifoldInstance | null = null;

        try {
          ribRectangle = createRibSection(
            runtime,
            rib.position,
            rib.distance,
            rib.width,
            innerBounds,
            ribDepth,
            ribJoinOverlap
          );
          ribSection = ribRectangle.intersect(ribClipArea);

          if (ribSection.isEmpty()) {
            warnings.push(`Ignored rib ${index + 1}: outside the phone outline.`);
            continue;
          }

          const simplifiedRibSection = ribSection.simplify(
            Math.max(rib.width / 64, ribSimplifyEpsilon)
          );
          if (ribSection !== simplifiedRibSection) {
            tryDelete(ribSection);
            ribSection = simplifiedRibSection;
          }

          ribAnchor = ribSection.intersect(frameRingSection);
          if (ribAnchor.isEmpty()) {
            warnings.push(`Ignored rib ${index + 1}: does not touch the remaining frame.`);
            continue;
          }

          const ribHeight = normalizeRibHeight(rib.thickness, size.z);
          if (ribHeight !== rib.thickness) {
            warnings.push(
              `Clamped rib ${index + 1} thickness from ${formatScalar(rib.thickness)} to ${formatScalar(ribHeight)}.`
            );
          }

          const ribOffset = clampRibOffset(rib.offset, ribHeight, size.z);
          if (ribOffset !== rib.offset) {
            warnings.push(
              `Clamped rib ${index + 1} offset from ${formatScalar(rib.offset)} to ${formatScalar(ribOffset)}.`
            );
          }

          ribVolumeBase = ribSection.extrude(ribHeight, 0, 0, [1, 1], true);
          ribVolume =
            ribOffset === 0 ? ribVolumeBase : ribVolumeBase.translate(0, 0, ribOffset);
          const nextFrameResult = runtime.Manifold.union([
            currentFrameResultWithRibs,
            ribVolume
          ]);
          const nextFootprintSection = currentFootprintSection.add(ribSection);
          const simplifiedFootprintSection = nextFootprintSection.simplify(
            Math.max(rib.width / 64, ribSimplifyEpsilon)
          );

          if (currentFrameResultWithRibs !== nextFrameResult) {
            tryDelete(currentFrameResultWithRibs);
          }
          if (
            currentFootprintSection !== frameRingSection &&
            currentFootprintSection !== simplifiedFootprintSection
          ) {
            tryDelete(currentFootprintSection);
          }
          if (nextFootprintSection !== simplifiedFootprintSection) {
            tryDelete(nextFootprintSection);
          }

          currentFrameResultWithRibs = nextFrameResult;
          currentFootprintSection = simplifiedFootprintSection;
        } finally {
          tryDelete(ribRectangle);
          tryDelete(ribSection);
          tryDelete(ribAnchor);
          if (ribVolumeBase !== ribVolume) {
            tryDelete(ribVolumeBase);
          }
          tryDelete(ribVolume);
        }
      }

      frameResult = currentFrameResultWithRibs;
      frameSection = currentFootprintSection;
    }

    const frameGeometry = manifoldToBufferGeometry(frameResult);
    frameGeometry.computeBoundingBox();
    frameGeometry.computeBoundingSphere();
    frameGeometry.computeVertexNormals();

    const contourCount = frameSection.numContour();

    return {
      sourceGeometry,
      frameGeometry,
      warnings,
      metrics: {
        originalTriangles: countTriangles(sourceGeometry),
        frameTriangles: countTriangles(frameGeometry),
        contours: contourCount
      }
    };
  } catch (error) {
    sourceGeometry.dispose();
    throw error;
  } finally {
    tryDelete(frameResult);
    tryDelete(innerVolume);
    tryDelete(innerBottom);
    tryDelete(ribClipArea);
    if (frameRingSection !== frameSection) {
      tryDelete(frameRingSection);
    }
    tryDelete(frameSection);
    tryDelete(inner);
    tryDelete(offsetInner);
    tryDelete(projected);
    tryDelete(sourceBody);
  }
}

function getSeamCutDepth(size: THREE.Vector3, thickness: number) {
  return Math.max(thickness * 1.35, Math.min(size.x, size.y) * 0.03);
}

function getRibDepth(size: THREE.Vector3, thickness: number) {
  return Math.max(thickness * 2.25, Math.min(size.x, size.y) * 0.08, 1);
}

function normalizeRibHeight(thickness: number, sourceThickness: number) {
  return Math.min(thickness, sourceThickness);
}

function clampRibOffset(offset: number, ribHeight: number, sourceThickness: number) {
  const maxOffset = Math.max((sourceThickness - ribHeight) / 2, 0);
  return THREE.MathUtils.clamp(offset, -maxOffset, maxOffset);
}

function getRibJoinOverlap(thickness: number) {
  return Math.max(thickness * 0.24, 0.3);
}

function getBooleanOvershoot(size: THREE.Vector3, thickness: number) {
  return Math.max(thickness * 0.5, size.z * 0.05, 0.1);
}

function createSeamCutter(
  runtime: BuildPreviewOptions["runtime"],
  position: BuildPreviewOptions["config"]["frame"]["seams"][number]["position"],
  distance: number,
  width: number,
  size: THREE.Vector3,
  depth: number
) {
  if (position === "top") {
    return runtime.CrossSection.square([width, depth], true).translate(
      distance,
      size.y / 2 - depth / 2
    );
  }
  if (position === "bottom") {
    return runtime.CrossSection.square([width, depth], true).translate(
      distance,
      -size.y / 2 + depth / 2
    );
  }
  if (position === "left") {
    return runtime.CrossSection.square([depth, width], true).translate(
      -size.x / 2 + depth / 2,
      distance
    );
  }
  return runtime.CrossSection.square([depth, width], true).translate(
    size.x / 2 - depth / 2,
    distance
  );
}

function createRibSection(
  runtime: BuildPreviewOptions["runtime"],
  position: BuildPreviewOptions["config"]["frame"]["ribs"][number]["position"],
  distance: number,
  width: number,
  bounds: {
    min: [number, number];
    max: [number, number];
  },
  depth: number,
  joinOverlap: number
) {
  const span = depth + joinOverlap;

  if (position === "top") {
    return runtime.CrossSection.square([width, span], true).translate(
      distance,
      bounds.max[1] + (joinOverlap - depth) / 2
    );
  }
  if (position === "bottom") {
    return runtime.CrossSection.square([width, span], true).translate(
      distance,
      bounds.min[1] + (depth - joinOverlap) / 2
    );
  }
  if (position === "left") {
    return runtime.CrossSection.square([span, width], true).translate(
      bounds.min[0] + (depth - joinOverlap) / 2,
      distance
    );
  }
  return runtime.CrossSection.square([span, width], true).translate(
    bounds.max[0] + (joinOverlap - depth) / 2,
    distance
  );
}

function createMeshOptions(geometry: THREE.BufferGeometry) {
  const indexed = geometry.index ? geometry.clone() : mergeVertices(geometry.clone(), 1e-4);
  const position = indexed.getAttribute("position");
  const index = indexed.getIndex();

  if (!position || !index) {
    indexed.dispose();
    throw new Error("Failed to index source geometry for manifold conversion");
  }

  const vertProperties = new Float32Array(position.count * 3);
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    vertProperties[vertexIndex * 3 + 0] = position.getX(vertexIndex);
    vertProperties[vertexIndex * 3 + 1] = position.getY(vertexIndex);
    vertProperties[vertexIndex * 3 + 2] = position.getZ(vertexIndex);
  }

  const triVerts = new Uint32Array(index.count);
  for (let indexOffset = 0; indexOffset < index.count; indexOffset += 1) {
    triVerts[indexOffset] = Number(index.getX(indexOffset));
  }

  indexed.dispose();

  return {
    numProp: 3,
    triVerts,
    vertProperties
  };
}

function manifoldToBufferGeometry(manifold: ManifoldInstance) {
  const mesh = manifold.getMesh();
  const vertexCount = mesh.vertProperties.length / mesh.numProp;
  const position = new Float32Array(vertexCount * 3);

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const sourceOffset = vertexIndex * mesh.numProp;
    const targetOffset = vertexIndex * 3;
    position[targetOffset + 0] = mesh.vertProperties[sourceOffset + 0];
    position[targetOffset + 1] = mesh.vertProperties[sourceOffset + 1];
    position[targetOffset + 2] = mesh.vertProperties[sourceOffset + 2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));

  // Preserve hard edges on the boolean result so the frame does not get
  // smoothed into visually broken diagonal highlights.
  const creased = toCreasedNormals(geometry, Math.PI / 3);
  geometry.dispose();
  return creased;
}

function tryDelete(candidate: { delete?: () => void } | null) {
  try {
    candidate?.delete?.();
  } catch {
    // Ignore WASM cleanup failures during teardown.
  }
}

function formatScalar(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}
