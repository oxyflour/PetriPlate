import * as THREE from "three";
import {
  mergeVertices,
  toCreasedNormals
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { countTriangles } from "./defaults";
import { GeometryDag, GeometryScope } from "./geometry-dag";
import type {
  BuildPreviewOptions,
  BuildPreviewResult,
  CrossSectionInstance,
  ManifoldInstance
} from "./types";

type PhoneFrameDagNodes = {
  sourceBody: ManifoldInstance;
  projected: CrossSectionInstance;
  offsetInner: CrossSectionInstance;
  inner: CrossSectionInstance;
  frameSection: CrossSectionInstance;
  innerVolume: ManifoldInstance;
  innerBottom: ManifoldInstance;
  frameShell: ManifoldInstance;
  offsetMidFrame: CrossSectionInstance;
  midFrameSection: CrossSectionInstance;
};

type FrameState = {
  frameSection: CrossSectionInstance;
  frameResult: ManifoldInstance;
};

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

  const geometryScope = new GeometryScope();
  const warnings: string[] = [];

  try {
    const booleanOvershoot = getBooleanOvershoot(size, config.frame.thickness);
    const booleanHeight = size.z + booleanOvershoot * 2;
    const frameDag = createPhoneFrameDag({
      scope: geometryScope,
      sourceBody: new runtime.Manifold(manifoldMesh),
      thickness: config.frame.thickness,
      midFrameGap: config.frame.midFrame.gap,
      booleanHeight,
      booleanOvershoot,
      boundingBox
    });
    const inner = frameDag.get("inner");

    if (inner.isEmpty()) {
      throw new Error("Inner outline collapsed. Reduce frame.thickness.");
    }

    const baseFrameSection = frameDag.get("frameSection");
    if (baseFrameSection.isEmpty()) {
      throw new Error("Inner outline removed the entire frame.");
    }

    const midFrameSection = frameDag.get("midFrameSection");
    if (midFrameSection.isEmpty()) {
      throw new Error("midFrame.gap is too large for this phone outline.");
    }

    const baseFrameResult = frameDag.get("frameShell");
    if (baseFrameResult.isEmpty()) {
      throw new Error("Frame boolean result is empty.");
    }

    let frameState = applySeamCuts({
      config,
      runtime,
      scope: geometryScope,
      size,
      booleanHeight,
      state: {
        frameSection: baseFrameSection,
        frameResult: baseFrameResult
      }
    });
    const frameRingSection = frameState.frameSection;

    if (config.frame.seams.length === 0) {
      warnings.push("No seam cuts configured");
    }

    if (config.frame.ribs.length > 0) {
      frameState = applyRibs({
        config,
        runtime,
        scope: geometryScope,
        size,
        inner,
        frameRingSection,
        midFrameSection,
        state: frameState,
        warnings
      });
    }

    frameState = applyMidFrame({
      config,
      runtime,
      scope: geometryScope,
      size,
      booleanOvershoot,
      midFrameSection,
      state: frameState,
      warnings
    });

    const frameGeometry = manifoldToBufferGeometry(frameState.frameResult);
    frameGeometry.computeBoundingBox();
    frameGeometry.computeBoundingSphere();
    frameGeometry.computeVertexNormals();

    const contourCount = frameState.frameSection.numContour();

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
    geometryScope.disposeAll();
  }
}

function createPhoneFrameDag({
  scope,
  sourceBody,
  thickness,
  midFrameGap,
  booleanHeight,
  booleanOvershoot,
  boundingBox
}: {
  scope: GeometryScope;
  sourceBody: ManifoldInstance;
  thickness: number;
  midFrameGap: number;
  booleanHeight: number;
  booleanOvershoot: number;
  boundingBox: THREE.Box3;
}) {
  return new GeometryDag<PhoneFrameDagNodes>(scope)
    .input("sourceBody", sourceBody)
    .node("projected", ["sourceBody"], ({ sourceBody: currentSourceBody }) =>
      currentSourceBody.project()
    )
    .node("offsetInner", ["projected"], ({ projected }) =>
      projected.offset(-thickness)
    )
    .node("inner", ["offsetInner"], ({ offsetInner }) =>
      offsetInner.simplify(Math.max(thickness / 18, 1e-4))
    )
    .node("frameSection", ["projected", "inner"], ({ projected, inner }) =>
      projected.subtract(inner)
    )
    .node("innerVolume", ["inner"], ({ inner }) =>
      inner.extrude(booleanHeight, 0, 0)
    )
    .node("innerBottom", ["innerVolume"], ({ innerVolume }) =>
      innerVolume.translate(0, 0, boundingBox.min.z - booleanOvershoot)
    )
    .node("frameShell", ["sourceBody", "innerBottom"], ({ sourceBody, innerBottom }) =>
      sourceBody.subtract(innerBottom)
    )
    .node("offsetMidFrame", ["inner"], ({ inner }) =>
      inner.offset(-midFrameGap)
    )
    .node("midFrameSection", ["offsetMidFrame"], ({ offsetMidFrame }) =>
      offsetMidFrame.simplify(Math.max(midFrameGap / 18, 1e-4))
    );
}

function applySeamCuts({
  config,
  runtime,
  scope,
  size,
  booleanHeight,
  state
}: {
  config: BuildPreviewOptions["config"];
  runtime: BuildPreviewOptions["runtime"];
  scope: GeometryScope;
  size: THREE.Vector3;
  booleanHeight: number;
  state: FrameState;
}): FrameState {
  const seamCutDepth = getSeamCutDepth(size, config.frame.thickness);
  let currentFrameSection = state.frameSection;
  let currentFrameResult = state.frameResult;

  for (const seam of config.frame.seams) {
    const iterationScope = new GeometryScope();

    try {
      const seamSection = iterationScope.create(() =>
        createSeamCutter(
          runtime,
          seam.position,
          seam.distance,
          seam.width,
          size,
          seamCutDepth
        )
      );
      const nextFrameSection = iterationScope.create(() =>
        currentFrameSection.subtract(seamSection)
      );
      const seamVolume = iterationScope.create(() =>
        seamSection.extrude(booleanHeight, 0, 0, [1, 1], true)
      );
      const nextFrameResult = iterationScope.create(() =>
        currentFrameResult.subtract(seamVolume)
      );
      const simplifiedFrameSection = iterationScope.create(() =>
        nextFrameSection.simplify(Math.max(seam.width / 64, 1e-4))
      );

      currentFrameSection = scope.replace(
        currentFrameSection,
        scope.adopt(iterationScope, simplifiedFrameSection)
      );
      currentFrameResult = scope.replace(
        currentFrameResult,
        scope.adopt(iterationScope, nextFrameResult)
      );

      if (currentFrameSection.isEmpty() || currentFrameResult.isEmpty()) {
        throw new Error("All frame material was removed by seam cuts.");
      }
    } finally {
      iterationScope.disposeAll();
    }
  }

  return {
    frameSection: currentFrameSection,
    frameResult: currentFrameResult
  };
}

function applyMidFrame({
  config,
  runtime,
  scope,
  size,
  booleanOvershoot,
  midFrameSection,
  state,
  warnings
}: {
  config: BuildPreviewOptions["config"];
  runtime: BuildPreviewOptions["runtime"];
  scope: GeometryScope;
  size: THREE.Vector3;
  booleanOvershoot: number;
  midFrameSection: CrossSectionInstance;
  state: FrameState;
  warnings: string[];
}): FrameState {
  const midFrameScope = new GeometryScope();
  let currentMidFrameResult = midFrameScope.create(() =>
    midFrameSection.extrude(size.z, 0, 0, [1, 1], true)
  );

  try {
    if (config.frame.midFrame.pockets.length === 0) {
      warnings.push("No mid-frame CNC pockets configured");
    }

    for (const [index, pocket] of config.frame.midFrame.pockets.entries()) {
      const iterationScope = new GeometryScope();

      try {
        const insetSection =
          pocket.inset === 0
            ? midFrameSection
            : iterationScope.create(() => midFrameSection.offset(-pocket.inset));

        if (insetSection.isEmpty()) {
          warnings.push(
            `Ignored mid-frame pocket ${index + 1} (${pocket.label}): inset collapsed the section.`
          );
          continue;
        }

        const pocketBand = iterationScope.create(() =>
          createMidFramePocketBand(runtime, pocket.offset, pocket.height, size.x * 2)
        );
        const pocketSection = iterationScope.create(() =>
          insetSection.intersect(pocketBand)
        );

        if (pocketSection.isEmpty()) {
          warnings.push(
            `Ignored mid-frame pocket ${index + 1} (${pocket.label}): outside the mid-frame footprint.`
          );
          continue;
        }

        const pocketDepth = clampPocketDepth(pocket.depth, size.z);
        if (pocketDepth !== pocket.depth) {
          warnings.push(
            `Clamped mid-frame pocket ${index + 1} (${pocket.label}) depth from ${formatScalar(pocket.depth)} to ${formatScalar(pocketDepth)}.`
          );
        }

        const pocketVolume = iterationScope.create(() =>
          createScreenSidePocketVolume(
            pocketSection,
            pocketDepth,
            size.z,
            booleanOvershoot
          )
        );
        const nextMidFrameResult = iterationScope.create(() =>
          currentMidFrameResult.subtract(pocketVolume)
        );

        if (nextMidFrameResult.isEmpty()) {
          throw new Error("Mid-frame was fully removed by CNC pockets.");
        }

        currentMidFrameResult = midFrameScope.replace(
          currentMidFrameResult,
          midFrameScope.adopt(iterationScope, nextMidFrameResult)
        );
      } finally {
        iterationScope.disposeAll();
      }
    }

    const nextFrameResult = midFrameScope.create(() =>
      runtime.Manifold.union([state.frameResult, currentMidFrameResult])
    );
    const nextFootprintSection = midFrameScope.create(() =>
      state.frameSection.add(midFrameSection)
    );
    const simplifiedFootprintSection = midFrameScope.create(() =>
      nextFootprintSection.simplify(1e-4)
    );

    return {
      frameSection: scope.replace(
        state.frameSection,
        scope.adopt(midFrameScope, simplifiedFootprintSection)
      ),
      frameResult: scope.replace(
        state.frameResult,
        scope.adopt(midFrameScope, nextFrameResult)
      )
    };
  } finally {
    midFrameScope.disposeAll();
  }
}

function applyRibs({
  config,
  runtime,
  scope,
  size,
  inner,
  frameRingSection,
  midFrameSection,
  state,
  warnings
}: {
  config: BuildPreviewOptions["config"];
  runtime: BuildPreviewOptions["runtime"];
  scope: GeometryScope;
  size: THREE.Vector3;
  inner: CrossSectionInstance;
  frameRingSection: CrossSectionInstance;
  midFrameSection: CrossSectionInstance;
  state: FrameState;
  warnings: string[];
}): FrameState {
  const ribJoinOverlap = getRibJoinOverlap(config.frame.thickness);
  const ribSimplifyEpsilon = 1e-4;
  const innerBounds = inner.bounds();
  const midFrameBounds = midFrameSection.bounds();
  const ribScope = new GeometryScope();
  const initialFootprintSection = state.frameSection;
  let currentFootprintSection = state.frameSection;
  let currentFrameResult = state.frameResult;

  try {
    const ribClipArea = ribScope.create(() => frameRingSection.add(inner));

    for (const [index, rib] of config.frame.ribs.entries()) {
      const iterationScope = new GeometryScope();

      try {
        const ribRectangle = iterationScope.create(() =>
          createRibSection(
            runtime,
            rib.position,
            rib.distance,
            rib.width,
            innerBounds,
            midFrameBounds,
            ribJoinOverlap
          )
        );
        let ribSection = iterationScope.create(() =>
          ribRectangle.intersect(ribClipArea)
        );

        if (ribSection.isEmpty()) {
          warnings.push(`Ignored rib ${index + 1}: outside the phone outline.`);
          continue;
        }

        ribSection = iterationScope.replace(
          ribSection,
          iterationScope.create(() =>
            ribSection.simplify(Math.max(rib.width / 64, ribSimplifyEpsilon))
          )
        );

        const frameAnchor = iterationScope.create(() =>
          ribSection.intersect(frameRingSection)
        );
        if (frameAnchor.isEmpty()) {
          warnings.push(`Ignored rib ${index + 1}: does not touch the remaining frame.`);
          continue;
        }

        const midFrameAnchor = iterationScope.create(() =>
          ribSection.intersect(midFrameSection)
        );
        if (midFrameAnchor.isEmpty()) {
          warnings.push(`Ignored rib ${index + 1}: does not reach the mid-frame.`);
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

        const ribVolumeBase = iterationScope.create(() =>
          ribSection.extrude(ribHeight, 0, 0, [1, 1], true)
        );
        const ribVolume =
          ribOffset === 0
            ? ribVolumeBase
            : iterationScope.create(() => ribVolumeBase.translate(0, 0, ribOffset));
        const nextFrameResult = iterationScope.create(() =>
          runtime.Manifold.union([currentFrameResult, ribVolume])
        );
        const nextFootprintSection = iterationScope.create(() =>
          currentFootprintSection.add(ribSection)
        );
        const simplifiedFootprintSection = iterationScope.create(() =>
          nextFootprintSection.simplify(Math.max(rib.width / 64, ribSimplifyEpsilon))
        );

        currentFrameResult = scope.replace(
          currentFrameResult,
          scope.adopt(iterationScope, nextFrameResult)
        );

        const retainedFootprintSection = scope.adopt(
          iterationScope,
          simplifiedFootprintSection
        );
        if (
          currentFootprintSection !== initialFootprintSection &&
          currentFootprintSection !== retainedFootprintSection
        ) {
          scope.dispose(currentFootprintSection);
        }
        currentFootprintSection = retainedFootprintSection;
      } finally {
        iterationScope.disposeAll();
      }
    }
  } finally {
    ribScope.disposeAll();
  }

  return {
    frameSection: currentFootprintSection,
    frameResult: currentFrameResult
  };
}

function getSeamCutDepth(size: THREE.Vector3, thickness: number) {
  return Math.max(thickness * 1.35, Math.min(size.x, size.y) * 0.03);
}

function normalizeRibHeight(thickness: number, sourceThickness: number) {
  return Math.min(thickness, sourceThickness);
}

function clampRibOffset(offset: number, ribHeight: number, sourceThickness: number) {
  const maxOffset = Math.max((sourceThickness - ribHeight) / 2, 0);
  return THREE.MathUtils.clamp(offset, -maxOffset, maxOffset);
}

function clampPocketDepth(depth: number, sourceThickness: number) {
  return THREE.MathUtils.clamp(depth, 0, sourceThickness);
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

function createMidFramePocketBand(
  runtime: BuildPreviewOptions["runtime"],
  offset: number,
  height: number,
  width: number
) {
  return runtime.CrossSection.square([width, height], true).translate(0, offset);
}

function createScreenSidePocketVolume(
  pocketSection: CrossSectionInstance,
  depth: number,
  sourceThickness: number,
  overshoot: number
) {
  const cutHeight = depth + overshoot;
  return pocketSection
    .extrude(cutHeight, 0, 0, [1, 1], true)
    .translate(0, 0, sourceThickness / 2 - depth / 2 + overshoot / 2);
}

function createRibSection(
  runtime: BuildPreviewOptions["runtime"],
  position: BuildPreviewOptions["config"]["frame"]["ribs"][number]["position"],
  distance: number,
  width: number,
  innerBounds: {
    min: [number, number];
    max: [number, number];
  },
  midFrameBounds: {
    min: [number, number];
    max: [number, number];
  },
  joinOverlap: number
) {
  if (position === "top") {
    const span = innerBounds.max[1] - midFrameBounds.max[1] + joinOverlap * 2;
    return runtime.CrossSection.square([width, span], true).translate(
      distance,
      (innerBounds.max[1] + midFrameBounds.max[1]) / 2
    );
  }
  if (position === "bottom") {
    const span = midFrameBounds.min[1] - innerBounds.min[1] + joinOverlap * 2;
    return runtime.CrossSection.square([width, span], true).translate(
      distance,
      (innerBounds.min[1] + midFrameBounds.min[1]) / 2
    );
  }
  if (position === "left") {
    const span = midFrameBounds.min[0] - innerBounds.min[0] + joinOverlap * 2;
    return runtime.CrossSection.square([span, width], true).translate(
      (innerBounds.min[0] + midFrameBounds.min[0]) / 2,
      distance
    );
  }
  const span = innerBounds.max[0] - midFrameBounds.max[0] + joinOverlap * 2;
  return runtime.CrossSection.square([span, width], true).translate(
    (innerBounds.max[0] + midFrameBounds.max[0]) / 2,
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

function formatScalar(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}
