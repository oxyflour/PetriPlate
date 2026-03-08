import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import {
  mergeGeometries,
  mergeVertices
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { countTriangles, readSize } from "./defaults";
import type { SourceModel } from "./types";

const objLoader = new OBJLoader();

export function pickObjFileFromFolder(files: File[]) {
  const objFiles = files
    .filter((file) => file.name.toLowerCase().endsWith(".obj"))
    .sort((left, right) => right.size - left.size);

  return objFiles[0] ?? null;
}

export async function readObjFile(file: File): Promise<SourceModel> {
  const text = await file.text();
  const geometry = parseObjText(text);
  return {
    geometry,
    label: file.webkitRelativePath || file.name,
    metrics: {
      size: readSize(geometry),
      triangles: countTriangles(geometry)
    }
  };
}

function parseObjText(text: string) {
  const root = objLoader.parse(text);
  root.updateMatrixWorld(true);

  const geometries: THREE.BufferGeometry[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) {
      return;
    }
    geometries.push(extractPositionGeometry(mesh));
  });

  if (geometries.length === 0) {
    throw new Error("OBJ file does not contain any mesh geometry");
  }

  const merged = mergeGeometries(geometries, false);
  if (!merged) {
    throw new Error("Failed to merge OBJ meshes");
  }

  const welded = mergeVertices(merged, 1e-4);
  const aligned = alignPhoneGeometry(welded);
  aligned.computeVertexNormals();
  aligned.computeBoundingBox();
  aligned.computeBoundingSphere();

  for (const geometry of geometries) {
    geometry.dispose();
  }
  merged.dispose();
  welded.dispose();

  return aligned;
}

function extractPositionGeometry(mesh: THREE.Mesh) {
  const input = mesh.geometry.clone();
  const transformed = input.index ? input.toNonIndexed() : input;
  transformed.applyMatrix4(mesh.matrixWorld);

  const position = transformed.getAttribute("position");
  if (!position) {
    throw new Error("OBJ mesh is missing position data");
  }

  const clean = new THREE.BufferGeometry();
  clean.setAttribute("position", position.clone());

  if (transformed !== input) {
    transformed.dispose();
  }
  input.dispose();
  return clean;
}

function alignPhoneGeometry(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    return geometry.clone();
  }

  const aligned = geometry.clone();
  const size = box.getSize(new THREE.Vector3());
  const axes = [
    { axis: "x", value: size.x },
    { axis: "y", value: size.y },
    { axis: "z", value: size.z }
  ].sort((left, right) => left.value - right.value);

  const thicknessAxis = axes[0]?.axis;
  if (thicknessAxis === "x") {
    aligned.rotateY(Math.PI / 2);
  } else if (thicknessAxis === "y") {
    aligned.rotateX(-Math.PI / 2);
  }

  aligned.computeBoundingBox();
  const rotatedBox = aligned.boundingBox;
  if (rotatedBox) {
    const rotatedSize = rotatedBox.getSize(new THREE.Vector3());
    if (rotatedSize.x > rotatedSize.y) {
      aligned.rotateZ(Math.PI / 2);
      aligned.computeBoundingBox();
    }
  }

  const centeredBox = aligned.boundingBox;
  if (centeredBox) {
    const center = centeredBox.getCenter(new THREE.Vector3());
    aligned.translate(-center.x, -center.y, -center.z);
  }

  aligned.computeBoundingBox();
  aligned.computeBoundingSphere();
  return aligned;
}
