import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { ColorRgba } from "./types";

type RenderableObjectKind = "surface-mesh" | "point-cloud" | "gaussian-splat";

export type RenderableMeshTemplate = {
  kind: RenderableObjectKind;
  object: THREE.Object3D;
};

export const GAUSSIAN_SPLAT_LAYER = 1;

const SH_C0 = 0.28209479177387814;
const MAX_GAUSSIAN_SPLATS = 120_000;
const DEFAULT_SURFACE_COLOR = new THREE.Color("#d4dde5");
const DEFAULT_POINT_COLOR = new THREE.Color("#dce5ec");
const renderSize = new THREE.Vector2();

const objLoader = new OBJLoader();
const stlLoader = new STLLoader();
const plyLoader = new PLYLoader();
const meshAssetCache = new Map<string, Promise<RenderableMeshTemplate | null>>();

plyLoader.setCustomPropertyNameMapping({
  fDc: ["f_dc_0", "f_dc_1", "f_dc_2"],
  splatOpacity: ["opacity"],
  splatScale: ["scale_0", "scale_1", "scale_2"],
  splatRotation: ["rot_0", "rot_1", "rot_2", "rot_3"]
});

export async function loadRenderableMeshTemplate(
  format: string,
  url: string
): Promise<RenderableMeshTemplate | null> {
  const normalizedFormat = format.toLowerCase();
  const cacheKey = `${normalizedFormat}:${url}`;

  if (!meshAssetCache.has(cacheKey)) {
    let promise: Promise<RenderableMeshTemplate | null>;
    if (normalizedFormat === "obj") {
      promise = objLoader.loadAsync(url).then((object) => ({
        kind: "surface-mesh",
        object: object
      }));
    } else if (normalizedFormat === "stl") {
      promise = stlLoader.loadAsync(url).then((geometry) => {
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return {
          kind: "surface-mesh" as const,
          object: createSurfaceMeshObject(geometry)
        };
      });
    } else if (normalizedFormat === "ply") {
      promise = plyLoader.loadAsync(url).then((geometry) => createPlyTemplate(geometry));
    } else {
      promise = Promise.resolve(null);
    }
    meshAssetCache.set(cacheKey, promise);
  }

  return meshAssetCache.get(cacheKey) || null;
}

export function instantiateRenderableMesh(
  template: RenderableMeshTemplate,
  color: ColorRgba
) {
  const clone = template.object.clone(true);

  clone.traverse((node: THREE.Object3D) => {
    const candidate = node as THREE.Mesh | THREE.Points;
    const kind = readRenderableKind(node);

    if ("geometry" in candidate && candidate.geometry) {
      candidate.geometry = candidate.geometry.clone();
      candidate.geometry.computeBoundingSphere();
    }

    if ((candidate as THREE.Mesh).isMesh) {
      const mesh = candidate as THREE.Mesh;
      const hasVertexColors = Boolean(mesh.geometry.getAttribute("color"));
      mesh.material = createStandardMaterial(color, hasVertexColors);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      node.userData.renderableKind = "surface-mesh";
      return;
    }

    if (!(candidate as THREE.Points).isPoints) {
      return;
    }

    const points = candidate as THREE.Points;
    if (kind === "gaussian-splat") {
      const material = points.material as THREE.ShaderMaterial;
      points.material = material.clone();
      points.layers.set(GAUSSIAN_SPLAT_LAYER);
      points.frustumCulled = false;
      points.renderOrder = -2;
      points.onBeforeRender = syncGaussianViewportUniform;
      node.userData.renderableKind = "gaussian-splat";
      return;
    }

    const hasVertexColors = Boolean(points.geometry.getAttribute("color"));
    points.material = createPointCloudMaterial(
      color,
      hasVertexColors,
      resolvePointCloudSize(points.geometry)
    );
    points.frustumCulled = false;
    points.renderOrder = 1;
    node.userData.renderableKind = "point-cloud";
  });

  return clone;
}

export function isGaussianSplatObject(object: THREE.Object3D) {
  return readRenderableKind(object) === "gaussian-splat";
}

function createPlyTemplate(geometry: THREE.BufferGeometry): RenderableMeshTemplate | null {
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  if (isGaussianSplatGeometry(geometry)) {
    return {
      kind: "gaussian-splat",
      object: createGaussianSplatObject(geometry)
    };
  }

  if (geometry.index) {
    if (!geometry.getAttribute("normal")) {
      geometry.computeVertexNormals();
    }
    return {
      kind: "surface-mesh",
      object: createSurfaceMeshObject(geometry)
    };
  }

  if (!geometry.getAttribute("position")) {
    return null;
  }

  return {
    kind: "point-cloud",
    object: createPointCloudObject(geometry)
  };
}

function createSurfaceMeshObject(geometry: THREE.BufferGeometry) {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: DEFAULT_SURFACE_COLOR,
      vertexColors: Boolean(geometry.getAttribute("color")),
      roughness: 0.46,
      metalness: 0.18
    })
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.userData.renderableKind = "surface-mesh";
  return mesh;
}

function createPointCloudObject(geometry: THREE.BufferGeometry) {
  const points = new THREE.Points(
    geometry,
    createPointCloudMaterial(
      {
        r: DEFAULT_POINT_COLOR.r,
        g: DEFAULT_POINT_COLOR.g,
        b: DEFAULT_POINT_COLOR.b,
        a: 1
      },
      Boolean(geometry.getAttribute("color")),
      resolvePointCloudSize(geometry)
    )
  );
  points.frustumCulled = false;
  points.userData.renderableKind = "point-cloud";
  return points;
}

function createGaussianSplatObject(sourceGeometry: THREE.BufferGeometry) {
  const position = sourceGeometry.getAttribute("position");
  const fDc = sourceGeometry.getAttribute("fDc");
  const splatOpacity = sourceGeometry.getAttribute("splatOpacity");
  const splatScale = sourceGeometry.getAttribute("splatScale");

  if (!position || !fDc || !splatOpacity || !splatScale) {
    return createPointCloudObject(sourceGeometry);
  }

  const step = Math.max(1, Math.ceil(position.count / MAX_GAUSSIAN_SPLATS));
  const positions: number[] = [];
  const colors: number[] = [];
  const sizes: number[] = [];
  const opacities: number[] = [];

  for (let index = 0; index < position.count; index += step) {
    const opacity = sigmoid(splatOpacity.getX(index));
    if (opacity < 0.02) {
      continue;
    }

    const maxScale = Math.max(
      Math.exp(splatScale.getX(index)),
      Math.exp(splatScale.getY(index)),
      Math.exp(splatScale.getZ(index))
    );
    const splatSize = THREE.MathUtils.clamp(maxScale * 6, 0.003, 3);

    positions.push(position.getX(index), position.getY(index), position.getZ(index));
    colors.push(
      clampColor(0.5 + SH_C0 * fDc.getX(index)),
      clampColor(0.5 + SH_C0 * fDc.getY(index)),
      clampColor(0.5 + SH_C0 * fDc.getZ(index))
    );
    sizes.push(splatSize);
    opacities.push(opacity);
  }

  if (positions.length === 0) {
    return createPointCloudObject(sourceGeometry);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("splatSize", new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute("splatOpacity", new THREE.Float32BufferAttribute(opacities, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      viewportHeight: { value: 1 }
    },
    vertexShader: `
      attribute float splatOpacity;
      attribute float splatSize;
      varying vec3 vColor;
      varying float vOpacity;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float viewZ = max(-mvPosition.z, 0.001);
        gl_PointSize = clamp(
          splatSize * viewportHeight * projectionMatrix[1][1] / (2.0 * viewZ),
          1.5,
          220.0
        );
        gl_Position = projectionMatrix * mvPosition;
        vColor = color;
        vOpacity = splatOpacity;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vOpacity;

      void main() {
        vec2 centered = (gl_PointCoord * 2.0) - 1.0;
        float radiusSq = dot(centered, centered);
        if (radiusSq > 1.0) {
          discard;
        }

        float falloff = exp(-radiusSq * 4.5);
        float alpha = clamp(vOpacity * falloff, 0.0, 1.0);
        if (alpha < 0.01) {
          discard;
        }

        gl_FragColor = vec4(vColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: true
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.layers.set(GAUSSIAN_SPLAT_LAYER);
  points.renderOrder = -2;
  points.onBeforeRender = syncGaussianViewportUniform;
  points.userData.renderableKind = "gaussian-splat";
  points.userData.sourceVertexCount = position.count;
  points.userData.renderedVertexCount = geometry.getAttribute("position").count;
  return points;
}

function createStandardMaterial(color: ColorRgba, vertexColors: boolean) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color.r, color.g, color.b),
    vertexColors,
    transparent: color.a < 0.999,
    opacity: color.a,
    roughness: 0.46,
    metalness: 0.18
  });
}

function createPointCloudMaterial(
  color: ColorRgba,
  vertexColors: boolean,
  pointSize: number
) {
  return new THREE.PointsMaterial({
    color: new THREE.Color(color.r, color.g, color.b),
    vertexColors,
    transparent: color.a < 0.999,
    opacity: color.a,
    size: pointSize,
    sizeAttenuation: true
  });
}

function resolvePointCloudSize(geometry: THREE.BufferGeometry) {
  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }

  const size = geometry.boundingBox?.getSize(new THREE.Vector3());
  const maxDimension = size ? Math.max(size.x, size.y, size.z) : 0;
  return THREE.MathUtils.clamp(maxDimension / 220, 0.01, 0.06);
}

function isGaussianSplatGeometry(geometry: THREE.BufferGeometry) {
  return Boolean(
    geometry.getAttribute("position") &&
      geometry.getAttribute("fDc") &&
      geometry.getAttribute("splatOpacity") &&
      geometry.getAttribute("splatScale")
  );
}

function readRenderableKind(object: THREE.Object3D): RenderableObjectKind | null {
  const rawKind = object.userData.renderableKind;
  return rawKind === "surface-mesh" || rawKind === "point-cloud" || rawKind === "gaussian-splat"
    ? rawKind
    : null;
}

function syncGaussianViewportUniform(
  renderer: THREE.WebGLRenderer,
  _scene: THREE.Scene,
  _camera: THREE.Camera,
  _geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[]
) {
  if (Array.isArray(material)) {
    return;
  }
  const shaderMaterial = material as THREE.ShaderMaterial;
  if (!shaderMaterial.uniforms.viewportHeight) {
    return;
  }
  renderer.getDrawingBufferSize(renderSize);
  shaderMaterial.uniforms.viewportHeight.value = Math.max(renderSize.y, 1);
}

function sigmoid(value: number) {
  if (value >= 0) {
    const denominator = 1 + Math.exp(-value);
    return 1 / denominator;
  }
  const expValue = Math.exp(value);
  return expValue / (1 + expValue);
}

function clampColor(value: number) {
  return THREE.MathUtils.clamp(value, 0, 1);
}
