"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BuildPreviewResult, SourceModel } from "../lib/types";

export default function PhonePreview({
  preview,
  sourceModel
}: {
  preview: BuildPreviewResult | null;
  sourceModel: SourceModel;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sourceMeshRef = useRef<THREE.Mesh | null>(null);
  const frameMeshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#060814");

    const camera = new THREE.PerspectiveCamera(
      42,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.1,
      1200
    );
    camera.position.set(120, -160, 110);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);
    controls.update();
    controlsRef.current = controls;

    const ambient = new THREE.HemisphereLight("#dae5ff", "#0c1323", 0.94);
    const key = new THREE.DirectionalLight("#ffe6bd", 1.28);
    key.position.set(140, -100, 160);
    const fill = new THREE.DirectionalLight("#76b9ff", 0.82);
    fill.position.set(-150, 130, 90);
    scene.add(ambient, key, fill);

    const grid = new THREE.GridHelper(280, 20, "#3a5478", "#172236");
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -10;
    scene.add(grid);

    const sourceMaterial = new THREE.MeshPhysicalMaterial({
      color: "#e5eefc",
      metalness: 0.08,
      roughness: 0.34,
      transmission: 0.02,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide
    });
    const frameMaterial = new THREE.MeshPhysicalMaterial({
      color: "#ff9b57",
      metalness: 0.12,
      roughness: 0.18,
      clearcoat: 0.88,
      clearcoatRoughness: 0.14,
      emissive: "#4d1900",
      emissiveIntensity: 0.28
    });

    const sourceMesh = new THREE.Mesh(new THREE.BufferGeometry(), sourceMaterial);
    const frameMesh = new THREE.Mesh(new THREE.BufferGeometry(), frameMaterial);
    sourceMesh.castShadow = true;
    sourceMesh.receiveShadow = true;
    frameMesh.castShadow = true;
    frameMesh.receiveShadow = true;
    sourceMesh.renderOrder = 1;
    frameMesh.renderOrder = 2;
    scene.add(sourceMesh, frameMesh);
    sourceMeshRef.current = sourceMesh;
    frameMeshRef.current = frameMesh;

    let frameId = 0;
    const renderLoop = () => {
      frameId = window.requestAnimationFrame(renderLoop);
      controls.update();
      renderer.render(scene, camera);
    };
    renderLoop();

    const handleResize = () => {
      const currentMount = mountRef.current;
      const currentCamera = cameraRef.current;
      if (!currentMount || !currentCamera) {
        return;
      }
      renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
      currentCamera.aspect = currentMount.clientWidth / Math.max(currentMount.clientHeight, 1);
      currentCamera.updateProjectionMatrix();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      sourceMesh.geometry.dispose();
      frameMesh.geometry.dispose();
      sourceMaterial.dispose();
      frameMaterial.dispose();
      grid.geometry.dispose();
      if (Array.isArray(grid.material)) {
        for (const material of grid.material) {
          material.dispose();
        }
      } else {
        grid.material.dispose();
      }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      cameraRef.current = null;
      controlsRef.current = null;
      sourceMeshRef.current = null;
      frameMeshRef.current = null;
    };
  }, []);

  useEffect(() => {
    const sourceMesh = sourceMeshRef.current;
    const frameMesh = frameMeshRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!sourceMesh || !frameMesh || !camera || !controls) {
      return;
    }

    const nextSource =
      preview?.sourceGeometry ?? preparePreviewGeometry(sourceModel.geometry.clone());
    const nextFrame = preview?.frameGeometry ?? new THREE.BufferGeometry();
    const previousSource = sourceMesh.geometry;
    const previousFrame = frameMesh.geometry;

    sourceMesh.geometry = nextSource;
    frameMesh.geometry = nextFrame;

    if (previousSource !== nextSource) {
      previousSource.dispose();
    }
    if (previousFrame !== nextFrame) {
      previousFrame.dispose();
    }

    fitCamera(camera, controls, [sourceMesh, frameMesh]);
  }, [preview, sourceModel]);

  return <div className="viewport" ref={mountRef} />;
}

function fitCamera(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  nodes: THREE.Object3D[]
) {
  const box = new THREE.Box3();
  for (const node of nodes) {
    box.expandByObject(node);
  }

  if (box.isEmpty()) {
    camera.position.set(120, -160, 110);
    controls.target.set(0, 0, 0);
    controls.update();
    camera.updateProjectionMatrix();
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 24);
  const distance = maxDimension * 1.85;
  const direction = new THREE.Vector3(0.9, -1.16, 0.7).normalize();
  const position = center.clone().add(direction.multiplyScalar(distance));

  camera.position.copy(position);
  camera.near = Math.max(maxDimension / 500, 0.1);
  camera.far = Math.max(distance * 10, 800);
  controls.target.copy(center);
  controls.update();
  camera.updateProjectionMatrix();
}

function preparePreviewGeometry(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.computeVertexNormals();
  return geometry;
}
