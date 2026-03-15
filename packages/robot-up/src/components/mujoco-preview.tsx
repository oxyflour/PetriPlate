"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  GAUSSIAN_SPLAT_LAYER,
  instantiateRenderableMesh,
  isGaussianSplatObject,
  loadRenderableMeshTemplate
} from "../lib/renderable-mesh";
import type {
  ColorRgba,
  MujocoManifestGeom,
  MujocoModelManifestMessage,
  MujocoPoseFrameMessage,
  MujocoPoseMessage,
  ParsedMjcfGeom,
  ParsedMjcfScene,
  Quat,
  SupportedMjcfGeomType,
  Vec3
} from "../lib/types";

type MujocoPreviewProps = {
  scene: ParsedMjcfScene | null;
  manifest?: MujocoModelManifestMessage | null;
  pose?: MujocoPoseMessage | null;
  frame?: MujocoPoseFrameMessage | null;
};

export default function MujocoPreview({
  scene,
  manifest = null,
  pose = null,
  frame = null
}: MujocoPreviewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const pmremGeneratorRef = useRef<THREE.PMREMGenerator | null>(null);
  const environmentTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const runtimeRootRef = useRef<THREE.Group | null>(null);
  const modelRootRef = useRef<THREE.Group | null>(null);
  const bodyNodesRef = useRef<Map<number, THREE.Group>>(new Map());

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }

    const scene3d = new THREE.Scene();
    scene3d.background = new THREE.Color("#0b1015");
    scene3d.fog = new THREE.Fog("#0b1015", 8, 18);
    sceneRef.current = scene3d;

    const camera = new THREE.PerspectiveCamera(
      48,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.01,
      100
    );
    camera.position.set(2.8, 1.9, 1.55);
    camera.lookAt(0, 0, 0.35);
    camera.layers.enable(GAUSSIAN_SPLAT_LAYER);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendererRef.current = renderer;
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileCubemapShader();
    pmremGeneratorRef.current = pmremGenerator;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0.4);
    controls.update();
    controlsRef.current = controls;

    const hemiLight = new THREE.HemisphereLight("#dbf6ff", "#1b232a", 0.95);
    const keyLight = new THREE.DirectionalLight("#fff9ef", 1.55);
    keyLight.position.set(4, 5, 6);
    const rimLight = new THREE.DirectionalLight("#8ad3ff", 0.65);
    rimLight.position.set(-5, -2, 4);
    scene3d.add(hemiLight, keyLight, rimLight);

    const grid = new THREE.GridHelper(8, 16, "#f09a39", "#28414f");
    grid.position.z = 0.001;
    const axes = new THREE.AxesHelper(1.35);
    scene3d.add(grid, axes);

    const runtimeRoot = new THREE.Group();
    const modelRoot = new THREE.Group();
    runtimeRoot.add(modelRoot);
    scene3d.add(runtimeRoot);
    runtimeRootRef.current = runtimeRoot;
    modelRootRef.current = modelRoot;

    let frameId = 0;
    const renderLoop = () => {
      frameId = requestAnimationFrame(renderLoop);
      controls.update();
      renderer.render(scene3d, camera);
    };
    renderLoop();

    const handleResize = () => {
      if (!mountRef.current || !cameraRef.current) {
        return;
      }
      const width = mountRef.current.clientWidth;
      const height = mountRef.current.clientHeight;
      renderer.setSize(width, height);
      cameraRef.current.aspect = width / Math.max(height, 1);
      cameraRef.current.updateProjectionMatrix();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      controlsRef.current = null;
      bodyNodesRef.current = new Map();
      clearEnvironmentMap();
      clearGroup(runtimeRoot);
      runtimeRootRef.current = null;
      modelRootRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      mount.removeChild(renderer.domElement);
      pmremGenerator.dispose();
      pmremGeneratorRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtimeRoot = runtimeRootRef.current;
    const rootPose = frame || pose;
    if (!runtimeRoot || !rootPose) {
      return;
    }

    applyTransform(runtimeRoot, rootPose.position, rootPose.quaternion);
  }, [pose, frame]);

  useEffect(() => {
    if (!frame?.bodies.length) {
      return;
    }

    const bodyNodes = bodyNodesRef.current;
    if (!bodyNodes.size) {
      return;
    }

    for (const body of frame.bodies) {
      const node = bodyNodes.get(body.id);
      if (!node) {
        continue;
      }
      applyTransform(node, body.position, body.quaternion);
    }
  }, [frame]);

  useEffect(() => {
    const modelRoot = modelRootRef.current;
    const runtimeRoot = runtimeRootRef.current;
    if (!modelRoot || !runtimeRoot) {
      return undefined;
    }

    let cancelled = false;
    bodyNodesRef.current = new Map();
    runtimeRoot.position.set(0, 0, 0);
    runtimeRoot.quaternion.identity();

    const buildModel = async () => {
      clearEnvironmentMap();
      clearGroup(modelRoot);

      if (manifest?.geoms.length) {
        const topLevelNodes = await buildRuntimeManifestModel(manifest);
        if (cancelled) {
          topLevelNodes.forEach((node) => disposeObject(node));
          return;
        }
        if (topLevelNodes.length === 0) {
          modelRoot.add(createFallbackModel());
          fitCamera(cameraRef.current, controlsRef.current, [modelRoot]);
          applyGaussianEnvironmentMap([modelRoot]);
          return;
        }
        topLevelNodes.forEach((node) => modelRoot.add(node));
        fitCamera(cameraRef.current, controlsRef.current, [modelRoot]);
        applyGaussianEnvironmentMap([modelRoot]);
        return;
      }

      if (scene?.geoms.length) {
        const builtNodes: Array<{ node: THREE.Object3D; geom: ParsedMjcfGeom }> = [];
        for (const geom of scene.geoms) {
          const geomNode = await createSceneGeomNode(geom);
          if (geomNode) {
            builtNodes.push({ node: geomNode, geom });
          }
        }

        if (cancelled) {
          builtNodes.forEach(({ node }) => disposeObject(node));
          return;
        }

        if (builtNodes.length === 0) {
          modelRoot.add(createFallbackModel());
          fitCamera(cameraRef.current, controlsRef.current, [modelRoot]);
          applyGaussianEnvironmentMap([modelRoot]);
          return;
        }

        builtNodes.forEach(({ node }) => modelRoot.add(node));
        const preferredFitNodes = builtNodes
          .filter(({ geom }) => geom.type !== "plane")
          .map(({ node }) => node);
        fitCamera(
          cameraRef.current,
          controlsRef.current,
          preferredFitNodes.length > 0 ? preferredFitNodes : [...modelRoot.children]
        );
        applyGaussianEnvironmentMap(
          preferredFitNodes.length > 0 ? preferredFitNodes : [...modelRoot.children]
        );
        return;
      }

      modelRoot.add(createFallbackModel());
      fitCamera(cameraRef.current, controlsRef.current, [modelRoot]);
      applyGaussianEnvironmentMap([modelRoot]);
    };

    buildModel().catch((error) => {
      console.error("Failed to build MuJoCo preview:", error);
      if (cancelled) {
        return;
      }
      clearGroup(modelRoot);
      modelRoot.add(createFallbackModel());
      fitCamera(cameraRef.current, controlsRef.current, [modelRoot]);
      applyGaussianEnvironmentMap([modelRoot]);
    });

    return () => {
      cancelled = true;
      bodyNodesRef.current = new Map();
      clearEnvironmentMap();
      clearGroup(modelRoot);
    };
  }, [scene, manifest]);

  return <div className="preview-canvas" ref={mountRef} />;

  async function buildRuntimeManifestModel(nextManifest: MujocoModelManifestMessage) {
    const bodyNodes = new Map<number, THREE.Group>();
    const topLevelNodes: THREE.Object3D[] = [];

    for (const body of nextManifest.bodies) {
      const bodyNode = new THREE.Group();
      bodyNode.name = body.name || `body_${body.id}`;
      applyTransform(bodyNode, body.position, body.quaternion);
      bodyNodes.set(body.id, bodyNode);
    }

    for (const body of nextManifest.bodies) {
      const bodyNode = bodyNodes.get(body.id);
      if (!bodyNode) {
        continue;
      }
      const parentNode = bodyNodes.get(body.parent_id);
      if (parentNode && parentNode !== bodyNode) {
        parentNode.add(bodyNode);
      } else {
        topLevelNodes.push(bodyNode);
      }
    }

    for (const geom of nextManifest.geoms) {
      const geomNode = await createRuntimeGeomNode(geom);
      if (!geomNode) {
        continue;
      }
      const parentNode = bodyNodes.get(geom.body_id);
      if (parentNode) {
        parentNode.add(geomNode);
      } else {
        topLevelNodes.push(geomNode);
      }
    }

    bodyNodesRef.current = bodyNodes;
    return topLevelNodes;
  }

  function clearEnvironmentMap() {
    const previewScene = sceneRef.current;
    if (previewScene) {
      previewScene.environment = null;
    }
    if (environmentTargetRef.current) {
      environmentTargetRef.current.dispose();
      environmentTargetRef.current = null;
    }
    markEnvironmentConsumers(modelRootRef.current);
  }

  function applyGaussianEnvironmentMap(fitTargets: THREE.Object3D[]) {
    const previewScene = sceneRef.current;
    const renderer = rendererRef.current;
    const pmremGenerator = pmremGeneratorRef.current;
    const modelRoot = modelRootRef.current;
    if (!previewScene || !renderer || !pmremGenerator || !modelRoot) {
      return;
    }

    clearEnvironmentMap();

    const gaussianNodes = collectGaussianNodes(modelRoot);
    if (gaussianNodes.length === 0) {
      return;
    }

    modelRoot.updateMatrixWorld(true);
    previewScene.updateMatrixWorld(true);

    const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256);
    const cubeCamera = new THREE.CubeCamera(0.01, 80, cubeRenderTarget);
    cubeCamera.layers.disableAll();
    cubeCamera.layers.enable(GAUSSIAN_SPLAT_LAYER);
    cubeCamera.position.copy(resolveEnvironmentCapturePoint(gaussianNodes, fitTargets));

    const previousBackground = previewScene.background;
    const previousFog = previewScene.fog;
    previewScene.background = null;
    previewScene.fog = null;
    previewScene.add(cubeCamera);

    cubeCamera.update(renderer, previewScene);

    previewScene.remove(cubeCamera);
    previewScene.background = previousBackground;
    previewScene.fog = previousFog;

    const nextEnvironmentTarget = pmremGenerator.fromCubemap(cubeRenderTarget.texture);
    cubeRenderTarget.dispose();
    environmentTargetRef.current = nextEnvironmentTarget;
    previewScene.environment = nextEnvironmentTarget.texture;
    markEnvironmentConsumers(modelRoot);
  }
}

async function createSceneGeomNode(geom: ParsedMjcfGeom): Promise<THREE.Object3D | null> {
  if (geom.type === "mesh") {
    return createSceneMeshNode(geom);
  }

  const primitive = createPrimitiveNode(geom.type, geom.size, geom.color, geom.name);
  if (!primitive) {
    return null;
  }

  const root = new THREE.Group();
  applyTransform(root, geom.position, geom.quaternion);
  root.add(primitive);
  return root;
}

async function createRuntimeGeomNode(geom: MujocoManifestGeom): Promise<THREE.Object3D | null> {
  if (geom.type === "mesh") {
    return createRuntimeMeshNode(geom);
  }

  if (!isSupportedPrimitiveGeom(geom.type)) {
    return null;
  }

  const primitive = createPrimitiveNode(geom.type, geom.size, geom.rgba, geom.name);
  if (!primitive) {
    return null;
  }

  const root = new THREE.Group();
  applyTransform(root, geom.position, geom.quaternion);
  root.add(primitive);
  return root;
}

function createPrimitiveNode(
  type: SupportedMjcfGeomType,
  size: Vec3,
  color: ColorRgba,
  name: string
): THREE.Mesh | null {
  const material = createStandardMaterial(color, type);
  let mesh: THREE.Mesh;

  if (type === "box") {
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        Math.max(size.x * 2, 0.001),
        Math.max(size.y * 2, 0.001),
        Math.max(size.z * 2, 0.001)
      ),
      material
    );
  } else if (type === "sphere") {
    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(size.x, 0.001), 28, 20),
      material
    );
  } else if (type === "capsule") {
    mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(
        Math.max(size.x, 0.001),
        Math.max(size.y * 2, 0.001),
        12,
        24
      ),
      material
    );
    mesh.rotation.x = Math.PI / 2;
  } else if (type === "cylinder") {
    mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(
        Math.max(size.x, 0.001),
        Math.max(size.x, 0.001),
        Math.max(size.y * 2, 0.001),
        28
      ),
      material
    );
    mesh.rotation.x = Math.PI / 2;
  } else if (type === "ellipsoid") {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), material);
    mesh.scale.set(
      Math.max(size.x, 0.001),
      Math.max(size.y, 0.001),
      Math.max(size.z, 0.001)
    );
  } else if (type === "plane") {
    mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(size.x * 2, 0.001), Math.max(size.y * 2, 0.001)),
      material
    );
  } else {
    material.dispose();
    return null;
  }

  mesh.name = name;
  mesh.castShadow = type !== "plane";
  mesh.receiveShadow = true;
  mesh.userData.renderableKind = type === "plane" ? "primitive-plane" : "primitive";
  return mesh;
}

async function createSceneMeshNode(geom: ParsedMjcfGeom): Promise<THREE.Object3D | null> {
  const meshAsset = geom.mesh;
  if (!meshAsset?.objectUrl) {
    return null;
  }

  const template = await loadRenderableMeshTemplate(meshAsset.format, meshAsset.objectUrl);
  if (!template) {
    return null;
  }

  const clone = instantiateRenderableMesh(template, geom.color);
  clone.scale.set(
    normalizeScaleComponent(meshAsset.scale.x),
    normalizeScaleComponent(meshAsset.scale.y),
    normalizeScaleComponent(meshAsset.scale.z)
  );

  const root = new THREE.Group();
  applyTransform(root, geom.position, geom.quaternion);
  root.add(clone);
  return root;
}

async function createRuntimeMeshNode(geom: MujocoManifestGeom): Promise<THREE.Object3D | null> {
  if (!geom.mesh?.url || !geom.mesh.format) {
    return null;
  }

  const template = await loadRenderableMeshTemplate(geom.mesh.format, geom.mesh.url);
  if (!template) {
    return null;
  }

  const clone = instantiateRenderableMesh(template, geom.rgba);
  const geomPosition = readVec3(geom.position, 0);
  const geomQuaternion = readQuat(geom.quaternion);
  const meshPosition = readVec3(geom.mesh.position, 0);
  const meshQuaternion = readQuat(geom.mesh.quaternion);
  const meshScale = readVec3(geom.mesh.scale, 1);
  const inverseScale = new THREE.Vector3(
    1 / Math.max(Math.abs(meshScale.x), 1e-6),
    1 / Math.max(Math.abs(meshScale.y), 1e-6),
    1 / Math.max(Math.abs(meshScale.z), 1e-6)
  );

  const correctionMatrix = new THREE.Matrix4()
    .makeTranslation(geomPosition.x, geomPosition.y, geomPosition.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(geomQuaternion))
    .multiply(
      new THREE.Matrix4().makeRotationFromQuaternion(meshQuaternion.clone().invert())
    )
    .multiply(
      new THREE.Matrix4().makeScale(inverseScale.x, inverseScale.y, inverseScale.z)
    )
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -meshPosition.x,
        -meshPosition.y,
        -meshPosition.z
      )
    );

  const root = new THREE.Group();
  root.add(clone);
  root.applyMatrix4(correctionMatrix);
  root.updateMatrixWorld(true);
  return root;
}

function createStandardMaterial(
  color: ColorRgba,
  type: SupportedMjcfGeomType | "mesh"
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color.r, color.g, color.b),
    transparent: color.a < 0.999,
    opacity: color.a,
    roughness: type === "plane" ? 0.95 : 0.52,
    metalness: type === "plane" ? 0.05 : 0.18
  });
}

function createFallbackModel(): THREE.Object3D {
  const root = new THREE.Group();

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.16, 28),
    new THREE.MeshStandardMaterial({
      color: "#f09a39",
      roughness: 0.42,
      metalness: 0.18
    })
  );
  base.rotation.x = Math.PI / 2;

  const arm = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.05, 0.58, 12, 24),
    new THREE.MeshStandardMaterial({
      color: "#55c2ee",
      roughness: 0.48,
      metalness: 0.12
    })
  );
  arm.position.set(0.4, 0, 0.36);
  arm.rotation.set(0, Math.PI / 5, Math.PI / 2);

  const tool = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 24, 20),
    new THREE.MeshStandardMaterial({
      color: "#f3d36a",
      roughness: 0.3,
      metalness: 0.15
    })
  );
  tool.position.set(0.74, 0, 0.5);

  root.add(base, arm, tool);
  return root;
}

function applyTransform(target: THREE.Object3D, position: Vec3, quaternion: Quat) {
  target.position.set(position.x, position.y, position.z);
  target.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
}

function readVec3(source: Vec3, fallback: number) {
  return new THREE.Vector3(
    Number.isFinite(source.x) ? source.x : fallback,
    Number.isFinite(source.y) ? source.y : fallback,
    Number.isFinite(source.z) ? source.z : fallback
  );
}

function readQuat(source: Quat) {
  return new THREE.Quaternion(
    Number.isFinite(source.x) ? source.x : 0,
    Number.isFinite(source.y) ? source.y : 0,
    Number.isFinite(source.z) ? source.z : 0,
    Number.isFinite(source.w) ? source.w : 1
  );
}

function fitCamera(
  camera: THREE.PerspectiveCamera | null,
  controls: OrbitControls | null,
  targets: THREE.Object3D[]
) {
  if (!camera || targets.length === 0) {
    return;
  }

  const box = new THREE.Box3();
  for (const target of targets) {
    box.expandByObject(target);
  }

  if (box.isEmpty()) {
    resetCamera(camera, controls);
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.3);

  if (
    !Number.isFinite(maxDimension) ||
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(center.z) ||
    maxDimension > 40
  ) {
    resetCamera(camera, controls);
    return;
  }

  const distance = maxDimension * 2.2;

  camera.position.set(
    center.x + distance,
    center.y + distance * 0.72,
    center.z + distance * 0.5
  );
  camera.near = 0.01;
  camera.far = Math.max(distance * 20, 40);
  if (controls) {
    controls.target.copy(center);
    controls.update();
  } else {
    camera.lookAt(center);
  }
  camera.updateProjectionMatrix();
}

function collectGaussianNodes(root: THREE.Object3D) {
  const gaussianNodes: THREE.Object3D[] = [];
  root.traverse((node: THREE.Object3D) => {
    if (isGaussianSplatObject(node)) {
      gaussianNodes.push(node);
    }
  });
  return gaussianNodes;
}

function resolveEnvironmentCapturePoint(
  gaussianNodes: THREE.Object3D[],
  fitTargets: THREE.Object3D[]
) {
  const box = new THREE.Box3();
  const targets = fitTargets.length > 0 ? fitTargets : gaussianNodes;
  for (const target of targets) {
    box.expandByObject(target);
  }
  if (box.isEmpty()) {
    return new THREE.Vector3();
  }
  return box.getCenter(new THREE.Vector3());
}

function markEnvironmentConsumers(root: THREE.Object3D | null) {
  if (!root) {
    return;
  }

  root.traverse((node: THREE.Object3D) => {
    const candidate = node as THREE.Mesh;
    if (!candidate.isMesh || !candidate.material) {
      return;
    }

    const materialList = Array.isArray(candidate.material)
      ? candidate.material
      : [candidate.material];
    const renderableKind = typeof node.userData.renderableKind === "string"
      ? node.userData.renderableKind
      : "";

    for (const material of materialList) {
      if (!(material instanceof THREE.MeshStandardMaterial)) {
        continue;
      }
      material.envMapIntensity =
        renderableKind === "surface-mesh"
          ? 1.2
          : renderableKind === "primitive-plane"
            ? 0.08
            : 0.3;
      material.needsUpdate = true;
    }
  });
}

function clearGroup(group: THREE.Group) {
  const children = [...group.children];
  for (const child of children) {
    group.remove(child);
    disposeObject(child);
  }
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((node: THREE.Object3D) => {
    const candidate = node as THREE.Mesh;
    if (candidate.geometry) {
      candidate.geometry.dispose();
    }
    if (candidate.material) {
      if (Array.isArray(candidate.material)) {
        candidate.material.forEach((material: THREE.Material) => material.dispose());
      } else {
        candidate.material.dispose();
      }
    }
  });
}

function normalizeScaleComponent(value: number): number {
  if (Math.abs(value) >= 0.0001) {
    return value;
  }
  return value < 0 ? -0.0001 : 0.0001;
}

function isSupportedPrimitiveGeom(
  type: MujocoManifestGeom["type"]
): type is SupportedMjcfGeomType {
  return (
    type === "box" ||
    type === "sphere" ||
    type === "capsule" ||
    type === "cylinder" ||
    type === "ellipsoid" ||
    type === "plane"
  );
}

function resetCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls | null) {
  camera.position.set(2.8, 1.9, 1.55);
  camera.near = 0.01;
  camera.far = 100;
  if (controls) {
    controls.target.set(0, 0, 0.35);
    controls.update();
  } else {
    camera.lookAt(0, 0, 0.35);
  }
  camera.updateProjectionMatrix();
}
