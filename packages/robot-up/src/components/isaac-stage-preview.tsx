"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  IsaacStageFrameMessage,
  IsaacStageManifestMessage,
  IsaacStagePrim,
  Quat,
  Vec3
} from "../lib/types";

type IsaacStagePreviewProps = {
  manifest: IsaacStageManifestMessage | null;
  frame: IsaacStageFrameMessage | null;
};

export default function IsaacStagePreview({
  manifest,
  frame
}: IsaacStagePreviewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const stageRootRef = useRef<THREE.Group | null>(null);
  const primNodesRef = useRef<Map<string, THREE.Group>>(new Map());

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }

    const scene3d = new THREE.Scene();
    scene3d.background = new THREE.Color("#081017");
    scene3d.fog = new THREE.Fog("#081017", 10, 30);

    const camera = new THREE.PerspectiveCamera(
      48,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.01,
      250
    );
    camera.position.set(4.5, 3.1, 2.6);
    camera.lookAt(0, 0, 0.5);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0.5);
    controls.update();
    controlsRef.current = controls;

    const hemiLight = new THREE.HemisphereLight("#eef7ff", "#0f1720", 1.0);
    const keyLight = new THREE.DirectionalLight("#fff1de", 1.25);
    keyLight.position.set(5, 7, 8);
    const fillLight = new THREE.DirectionalLight("#73c6ff", 0.6);
    fillLight.position.set(-4, -2, 5);
    scene3d.add(hemiLight, keyLight, fillLight);

    const grid = new THREE.GridHelper(14, 28, "#ec8c2f", "#203645");
    grid.position.z = 0.001;
    const axes = new THREE.AxesHelper(1.5);
    scene3d.add(grid, axes);

    const stageRoot = new THREE.Group();
    scene3d.add(stageRoot);
    stageRootRef.current = stageRoot;

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
      primNodesRef.current = new Map();
      if (stageRootRef.current) {
        clearGroup(stageRootRef.current);
      }
      stageRootRef.current = null;
      cameraRef.current = null;
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    const stageRoot = stageRootRef.current;
    if (!stageRoot) {
      return undefined;
    }

    let cancelled = false;
    primNodesRef.current = new Map();
    clearGroup(stageRoot);

    if (!manifest?.prims.length) {
      stageRoot.add(createFallbackStage());
      fitCamera(cameraRef.current, controlsRef.current, [stageRoot]);
      return undefined;
    }

    const primNodes = new Map<string, THREE.Group>();
    const fitTargets: THREE.Object3D[] = [];

    for (const prim of manifest.prims) {
      const node = new THREE.Group();
      node.name = prim.path;
      applyTransform(node, prim.position, prim.quaternion, prim.scale);
      node.visible = prim.visible;

      const placeholder = createPrimPlaceholder(prim);
      if (placeholder) {
        node.add(placeholder);
        fitTargets.push(node);
      }

      primNodes.set(prim.path, node);
    }

    for (const prim of manifest.prims) {
      const node = primNodes.get(prim.path);
      if (!node) {
        continue;
      }
      const parent = prim.parentPath ? primNodes.get(prim.parentPath) : null;
      if (parent) {
        parent.add(node);
      } else {
        stageRoot.add(node);
      }
    }

    if (!cancelled) {
      primNodesRef.current = primNodes;
      fitCamera(
        cameraRef.current,
        controlsRef.current,
        fitTargets.length ? fitTargets : [...stageRoot.children]
      );
    }

    return () => {
      cancelled = true;
      primNodesRef.current = new Map();
      clearGroup(stageRoot);
    };
  }, [manifest]);

  useEffect(() => {
    if (!frame?.prims.length) {
      return;
    }

    const primNodes = primNodesRef.current;
    if (!primNodes.size) {
      return;
    }

    for (const prim of frame.prims) {
      const node = primNodes.get(prim.path);
      if (!node) {
        continue;
      }
      applyTransform(node, prim.position, prim.quaternion, prim.scale);
      node.visible = prim.visible;
    }
  }, [frame]);

  return <div className="preview-canvas" ref={mountRef} />;
}

function createPrimPlaceholder(prim: IsaacStagePrim) {
  if (!prim.hasGeometry) {
    return null;
  }

  const min = new THREE.Vector3(prim.bboxMin.x, prim.bboxMin.y, prim.bboxMin.z);
  const max = new THREE.Vector3(prim.bboxMax.x, prim.bboxMax.y, prim.bboxMax.z);
  const size = max.clone().sub(min);
  const center = max.clone().add(min).multiplyScalar(0.5);

  if (size.lengthSq() < 1e-8) {
    size.setScalar(0.12);
  } else {
    size.x = Math.max(Math.abs(size.x), 0.02);
    size.y = Math.max(Math.abs(size.y), 0.02);
    size.z = Math.max(Math.abs(size.z), 0.02);
  }

  const color = pickPrimColor(prim.type);
  const root = new THREE.Group();
  root.position.copy(center);

  const solid = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      roughness: 0.56,
      metalness: 0.08
    })
  );
  solid.castShadow = true;
  solid.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
    new THREE.LineBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(1.12)
    })
  );

  root.add(solid, edges);
  return root;
}

function pickPrimColor(type: string) {
  const normalizedType = type.toLowerCase();
  if (normalizedType.includes("mesh")) {
    return "#62bff5";
  }
  if (normalizedType.includes("sphere")) {
    return "#f3d36a";
  }
  if (normalizedType.includes("capsule") || normalizedType.includes("cylinder")) {
    return "#59c3a0";
  }
  if (normalizedType.includes("cube") || normalizedType.includes("box")) {
    return "#ef8c35";
  }
  if (normalizedType.includes("camera")) {
    return "#fb8d76";
  }
  if (normalizedType.includes("light")) {
    return "#f0efc4";
  }
  return "#a5b8c9";
}

function createFallbackStage() {
  const root = new THREE.Group();

  const anchor = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.9, 0.12),
    new THREE.MeshStandardMaterial({
      color: "#ec8c2f",
      roughness: 0.44,
      metalness: 0.08
    })
  );

  const tower = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.28, 0.9),
    new THREE.MeshStandardMaterial({
      color: "#62bff5",
      roughness: 0.38,
      metalness: 0.12
    })
  );
  tower.position.set(0, 0, 0.5);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.32, 0.2),
    new THREE.MeshStandardMaterial({
      color: "#f3d36a",
      roughness: 0.36,
      metalness: 0.1
    })
  );
  head.position.set(0.32, 0, 0.95);
  head.rotation.z = Math.PI / 10;

  root.add(anchor, tower, head);
  return root;
}

function applyTransform(
  target: THREE.Object3D,
  position: Vec3,
  quaternion: Quat,
  scale: Vec3
) {
  target.position.set(position.x, position.y, position.z);
  target.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  target.scale.set(
    normalizeScale(scale.x),
    normalizeScale(scale.y),
    normalizeScale(scale.z)
  );
}

function normalizeScale(value: number) {
  if (Math.abs(value) >= 0.0001) {
    return value;
  }
  return value < 0 ? -0.0001 : 0.0001;
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
  const maxDimension = Math.max(size.x, size.y, size.z, 0.4);

  if (
    !Number.isFinite(maxDimension) ||
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(center.z) ||
    maxDimension > 200
  ) {
    resetCamera(camera, controls);
    return;
  }

  const distance = maxDimension * 2.4;

  camera.position.set(
    center.x + distance,
    center.y + distance * 0.78,
    center.z + distance * 0.56
  );
  camera.near = 0.01;
  camera.far = Math.max(distance * 40, 80);
  if (controls) {
    controls.target.copy(center);
    controls.update();
  } else {
    camera.lookAt(center);
  }
  camera.updateProjectionMatrix();
}

function resetCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls | null) {
  camera.position.set(4.5, 3.1, 2.6);
  camera.near = 0.01;
  camera.far = 250;
  if (controls) {
    controls.target.set(0, 0, 0.5);
    controls.update();
  } else {
    camera.lookAt(0, 0, 0.5);
  }
  camera.updateProjectionMatrix();
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
