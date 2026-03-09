import * as THREE from "three";
import type { PhoneConfig, SourceModel } from "./types";

export const DEFAULT_PHONE_CONFIG: PhoneConfig = {
  frame: {
    thickness: 3.2,
    seams: [
      { position: "top", width: 2, distance: 0 },
      { position: "left", width: 2, distance: 30 },
      { position: "right", width: 2, distance: -22 }
    ]
  }
};

export function formatPhoneConfig(config: PhoneConfig) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function createPlaceholderModel(): SourceModel {
  const geometry = new THREE.BoxGeometry(74, 156, 8, 2, 4, 1);
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();

  return {
    geometry,
    label: "Placeholder body",
    metrics: {
      size: readSize(geometry),
      triangles: countTriangles(geometry)
    }
  };
}

export function readSize(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    return { x: 0, y: 0, z: 0 };
  }
  const size = box.getSize(new THREE.Vector3());
  return { x: size.x, y: size.y, z: size.z };
}

export function countTriangles(geometry: THREE.BufferGeometry) {
  if (geometry.index) {
    return geometry.index.count / 3;
  }
  const position = geometry.getAttribute("position");
  return position ? position.count / 3 : 0;
}
