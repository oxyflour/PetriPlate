import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

const MAX_HISTORY = 120;
const objLoader = new OBJLoader();
const stlLoader = new STLLoader();
const meshAssetCache = new Map();

function buildDefaultWsUrl() {
  const host = window.location.hostname || "127.0.0.1";
  return `ws://${host}:8765`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "--";
}

function createStandardMaterial(rgba) {
  const r = Number.isFinite(rgba?.r) ? rgba.r : 0.7;
  const g = Number.isFinite(rgba?.g) ? rgba.g : 0.7;
  const b = Number.isFinite(rgba?.b) ? rgba.b : 0.7;
  const a = Number.isFinite(rgba?.a) ? rgba.a : 1;

  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b),
    metalness: 0.2,
    roughness: 0.55,
    transparent: a < 0.999,
    opacity: a
  });
}

function readVec3(source, fallback = 0) {
  return new THREE.Vector3(
    Number.isFinite(source?.x) ? source.x : fallback,
    Number.isFinite(source?.y) ? source.y : fallback,
    Number.isFinite(source?.z) ? source.z : fallback
  );
}

function readQuat(source) {
  return new THREE.Quaternion(
    Number.isFinite(source?.x) ? source.x : 0,
    Number.isFinite(source?.y) ? source.y : 0,
    Number.isFinite(source?.z) ? source.z : 0,
    Number.isFinite(source?.w) ? source.w : 1
  );
}

function applyGeomTransform(target, geom) {
  const position = geom?.position ?? {};
  const quaternion = geom?.quaternion ?? {};

  target.position.set(position.x ?? 0, position.y ?? 0, position.z ?? 0);
  target.quaternion.set(
    quaternion.x ?? 0,
    quaternion.y ?? 0,
    quaternion.z ?? 0,
    quaternion.w ?? 1
  );
}

function createPrimitiveNode(geom) {
  const type = geom?.type;
  const size = geom?.size ?? {};
  let geometry = null;
  let needsZAxisAlignment = false;

  if (type === "box") {
    geometry = new THREE.BoxGeometry(
      Math.max((size.x ?? 0.1) * 2, 0.001),
      Math.max((size.y ?? 0.1) * 2, 0.001),
      Math.max((size.z ?? 0.1) * 2, 0.001)
    );
  } else if (type === "sphere") {
    geometry = new THREE.SphereGeometry(Math.max(size.x ?? 0.1, 0.001), 28, 20);
  } else if (type === "capsule") {
    geometry = new THREE.CapsuleGeometry(
      Math.max(size.x ?? 0.06, 0.001),
      Math.max((size.y ?? 0.1) * 2, 0.001),
      12,
      24
    );
    needsZAxisAlignment = true;
  } else if (type === "cylinder") {
    geometry = new THREE.CylinderGeometry(
      Math.max(size.x ?? 0.06, 0.001),
      Math.max(size.x ?? 0.06, 0.001),
      Math.max((size.y ?? 0.1) * 2, 0.001),
      24
    );
    needsZAxisAlignment = true;
  } else if (type === "ellipsoid") {
    geometry = new THREE.SphereGeometry(1, 28, 20);
  } else if (type === "plane") {
    geometry = new THREE.PlaneGeometry(
      Math.max((size.x ?? 1) * 2, 0.001),
      Math.max((size.y ?? 1) * 2, 0.001)
    );
  } else {
    return null;
  }

  const mesh = new THREE.Mesh(geometry, createStandardMaterial(geom.rgba));
  if (needsZAxisAlignment) {
    mesh.rotation.x = Math.PI / 2;
  }
  if (type === "ellipsoid") {
    mesh.scale.set(
      Math.max(size.x ?? 1, 0.001),
      Math.max(size.y ?? 1, 0.001),
      Math.max(size.z ?? 1, 0.001)
    );
  }
  return mesh;
}

function disposeObject3D(object) {
  object.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      if (Array.isArray(node.material)) {
        node.material.forEach((material) => material.dispose());
      } else {
        node.material.dispose();
      }
    }
  });
}

function clearGroup(group) {
  const children = [...group.children];
  for (const child of children) {
    group.remove(child);
    disposeObject3D(child);
  }
}

async function loadMeshTemplate(mesh) {
  const format = String(mesh?.format || "").toLowerCase();
  if (!mesh?.url || !format) {
    return null;
  }

  const cacheKey = `${format}:${mesh.url}`;
  if (!meshAssetCache.has(cacheKey)) {
    let promise;
    if (format === "obj") {
      promise = objLoader.loadAsync(mesh.url);
    } else if (format === "stl") {
      promise = stlLoader.loadAsync(mesh.url).then((geometry) => {
        geometry.computeVertexNormals();
        return new THREE.Mesh(geometry);
      });
    } else {
      promise = Promise.resolve(null);
    }
    meshAssetCache.set(cacheKey, promise);
  }

  return meshAssetCache.get(cacheKey);
}

async function createMeshNode(geom) {
  const template = await loadMeshTemplate(geom.mesh);
  if (!template) {
    return null;
  }

  const clone = template.clone(true);
  clone.traverse((node) => {
    if (!node.isMesh) {
      return;
    }
    if (node.geometry) {
      node.geometry = node.geometry.clone();
    }
    node.material = createStandardMaterial(geom.rgba);
  });

  const geomPosition = readVec3(geom?.position, 0);
  const geomQuaternion = readQuat(geom?.quaternion);
  const meshPosition = readVec3(geom?.mesh?.position, 0);
  const meshQuaternion = readQuat(geom?.mesh?.quaternion);
  const meshScale = readVec3(geom?.mesh?.scale, 1);
  const inverseScale = new THREE.Vector3(
    1 / Math.max(Math.abs(meshScale.x), 1e-6),
    1 / Math.max(Math.abs(meshScale.y), 1e-6),
    1 / Math.max(Math.abs(meshScale.z), 1e-6)
  );

  // Source OBJ/STL is in external mesh frame; MuJoCo geom pose expects internal mesh frame.
  // Apply compensation: T_geom * R_geom * inv(R_mesh) * inv(S_mesh) * T(-P_mesh)
  const correctionMatrix = new THREE.Matrix4()
    .makeTranslation(geomPosition.x, geomPosition.y, geomPosition.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(geomQuaternion))
    .multiply(
      new THREE.Matrix4().makeRotationFromQuaternion(
        meshQuaternion.clone().invert()
      )
    )
    .multiply(
      new THREE.Matrix4().makeScale(
        inverseScale.x,
        inverseScale.y,
        inverseScale.z
      )
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

  root.traverse((node) => {
    if (!node.isMesh) {
      return;
    }
    node.frustumCulled = false;
  });

  return root;
}

function createFallbackModel() {
  const root = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.2, 0.14),
    new THREE.MeshStandardMaterial({
      color: "#58dd93",
      metalness: 0.25,
      roughness: 0.4
    })
  );
  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 20, 20),
    new THREE.MeshStandardMaterial({ color: "#f48d71" })
  );
  nose.position.set(0.21, 0, 0);
  body.add(nose);
  root.add(body);

  return root;
}

function fitCameraToObject(camera, object) {
  if (!camera || !object) {
    return;
  }

  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.2);
  const fov = (camera.fov * Math.PI) / 180;
  const fitDistance = (maxDim * 1.1) / Math.tan(fov / 2);
  const distance = fitDistance * 1.25;

  camera.position.set(
    center.x + distance,
    center.y + distance * 0.6,
    center.z + distance * 0.5
  );
  camera.near = Math.max(distance / 200, 0.01);
  camera.far = Math.max(distance * 40, 200);
  camera.updateProjectionMatrix();
  camera.lookAt(center);
}

async function createGeomNode(geom) {
  if (geom.type === "mesh") {
    const meshNode = await createMeshNode(geom);
    if (meshNode) {
      return meshNode;
    }
  }

  const geomRoot = new THREE.Group();
  applyGeomTransform(geomRoot, geom);

  const primitive = createPrimitiveNode(geom);
  if (primitive) {
    geomRoot.add(primitive);
    return geomRoot;
  }

  disposeObject3D(geomRoot);
  return null;
}

function ThreeView({ pose, frame, modelManifest }) {
  const mountRef = useRef(null);
  const robotRef = useRef(null);
  const modelRootRef = useRef(null);
  const bodyNodesRef = useRef(new Map());
  const cameraRef = useRef(null);

  useEffect(() => {
    if (!mountRef.current) {
      return undefined;
    }

    const mount = mountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0a1318");

    const width = mount.clientWidth;
    const height = mount.clientHeight;
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
    camera.position.set(2.3, 2.1, 1.9);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight("#c2f5ff", 0.55);
    const key = new THREE.DirectionalLight("#ffffff", 1.1);
    key.position.set(4, 4, 6);
    scene.add(ambient, key);

    const grid = new THREE.GridHelper(6, 16, "#53a6ff", "#27404d");
    const axes = new THREE.AxesHelper(1.3);
    scene.add(grid, axes);

    const robot = new THREE.Group();
    robot.position.set(0, 0, 0.25);
    const modelRoot = new THREE.Group();
    robot.add(modelRoot);
    scene.add(robot);
    robotRef.current = robot;
    modelRootRef.current = modelRoot;
    modelRoot.add(createFallbackModel());

    let animationId = 0;
    const renderLoop = () => {
      animationId = requestAnimationFrame(renderLoop);
      renderer.render(scene, camera);
    };
    renderLoop();

    const handleResize = () => {
      const nextWidth = mount.clientWidth;
      const nextHeight = mount.clientHeight;
      renderer.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", handleResize);
      clearGroup(robot);
      modelRootRef.current = null;
      bodyNodesRef.current = new Map();
      cameraRef.current = null;
      mount.removeChild(renderer.domElement);
      renderer.dispose();
      robotRef.current = null;
    };
  }, []);

  useEffect(() => {
    const robot = robotRef.current;
    const rootPose = frame || pose;
    if (!robot || !rootPose) {
      return;
    }

    robot.position.set(rootPose.position.x, rootPose.position.y, rootPose.position.z);
    robot.quaternion.set(
      rootPose.quaternion.x,
      rootPose.quaternion.y,
      rootPose.quaternion.z,
      rootPose.quaternion.w
    );
  }, [pose, frame]);

  useEffect(() => {
    if (!frame?.bodies?.length) {
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
      node.position.set(
        body.position?.x ?? 0,
        body.position?.y ?? 0,
        body.position?.z ?? 0
      );
      node.quaternion.set(
        body.quaternion?.x ?? 0,
        body.quaternion?.y ?? 0,
        body.quaternion?.z ?? 0,
        body.quaternion?.w ?? 1
      );
    }
  }, [frame]);

  useEffect(() => {
    const modelRoot = modelRootRef.current;
    if (!modelRoot) {
      return undefined;
    }

    let cancelled = false;
    clearGroup(modelRoot);
    bodyNodesRef.current = new Map();

    if (!modelManifest?.geoms?.length) {
      modelRoot.add(createFallbackModel());
      fitCameraToObject(cameraRef.current, modelRoot);
      return undefined;
    }

    const buildModel = async () => {
      const nextBodyNodes = new Map();
      const topLevelNodes = [];
      const bodies = Array.isArray(modelManifest.bodies) ? modelManifest.bodies : [];
      for (const body of bodies) {
        const bodyNode = new THREE.Group();
        bodyNode.name = body.name || `body_${body.id}`;
        bodyNode.position.set(
          body.position?.x ?? 0,
          body.position?.y ?? 0,
          body.position?.z ?? 0
        );
        bodyNode.quaternion.set(
          body.quaternion?.x ?? 0,
          body.quaternion?.y ?? 0,
          body.quaternion?.z ?? 0,
          body.quaternion?.w ?? 1
        );
        nextBodyNodes.set(body.id, bodyNode);
      }

      for (const body of bodies) {
        const bodyNode = nextBodyNodes.get(body.id);
        if (!bodyNode) {
          continue;
        }
        const parentNode = nextBodyNodes.get(body.parent_id);
        if (parentNode) {
          parentNode.add(bodyNode);
        } else {
          topLevelNodes.push(bodyNode);
        }
      }

      for (const geom of modelManifest.geoms) {
        const geomNode = await createGeomNode(geom);
        if (geomNode) {
          const parentNode = nextBodyNodes.get(geom.body_id);
          if (parentNode) {
            parentNode.add(geomNode);
          } else {
            topLevelNodes.push(geomNode);
          }
        }
      }

      if (cancelled) {
        topLevelNodes.forEach((node) => disposeObject3D(node));
        return;
      }

      if (topLevelNodes.length === 0) {
        modelRoot.add(createFallbackModel());
        fitCameraToObject(cameraRef.current, modelRoot);
        return;
      }

      topLevelNodes.forEach((node) => modelRoot.add(node));
      bodyNodesRef.current = nextBodyNodes;
      fitCameraToObject(cameraRef.current, modelRoot);
    };

    buildModel().catch((error) => {
      console.error("Failed to build model from manifest:", error);
      if (cancelled) {
        return;
      }
      clearGroup(modelRoot);
      modelRoot.add(createFallbackModel());
      fitCameraToObject(cameraRef.current, modelRoot);
    });

    return () => {
      cancelled = true;
      clearGroup(modelRoot);
      bodyNodesRef.current = new Map();
    };
  }, [modelManifest]);

  return <div className="three-view" ref={mountRef} />;
}

function SparkPanel({ history }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0a1318";
    ctx.fillRect(0, 0, width, height);

    if (history.length < 2) {
      return;
    }

    const values = history.flatMap((entry) => [
      entry.position.x,
      entry.position.y,
      entry.position.z
    ]);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const span = Math.max(maxValue - minValue, 0.001);

    const toY = (value) =>
      height - ((value - minValue) / span) * (height - 10) - 5;

    const drawSeries = (selector, color) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      history.forEach((entry, index) => {
        const x = (index / (history.length - 1)) * width;
        const y = toY(selector(entry));
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    };

    drawSeries((entry) => entry.position.x, "#71b6ff");
    drawSeries((entry) => entry.position.y, "#f4ad67");
    drawSeries((entry) => entry.position.z, "#6ce2b3");
  }, [history]);

  return (
    <section className="panel">
      <header>
        <h3>Trajectory Sparkline</h3>
        <p>x/y/z position history</p>
      </header>
      <canvas ref={canvasRef} className="spark-canvas" />
    </section>
  );
}

function App() {
  const wsUrl = useMemo(
    () => import.meta.env.VITE_POSE_WS_URL || buildDefaultWsUrl(),
    []
  );

  const [connection, setConnection] = useState("connecting");
  const [latestPose, setLatestPose] = useState(null);
  const [latestFrame, setLatestFrame] = useState(null);
  const [history, setHistory] = useState([]);
  const [modelManifest, setModelManifest] = useState(null);
  const [modelStatus, setModelStatus] = useState("idle");

  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    setConnection("connecting");
    setModelStatus("idle");
    setLatestFrame(null);

    socket.onopen = () => {
      setConnection("open");
      setModelStatus("loading");
      socket.send(JSON.stringify({ type: "model_request" }));
    };
    socket.onerror = () => setConnection("error");
    socket.onclose = () => setConnection("closed");

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "pose") {
          setLatestPose(message);
          setHistory((previous) => {
            const next = [...previous, message];
            return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
          });
          return;
        }

        if (message.type === "pose_frame") {
          setLatestFrame(message);
          return;
        }

        if (message.type === "model_manifest") {
          setModelManifest(message);
          setModelStatus("ready");
          return;
        }

        if (message.type === "model_manifest_unavailable") {
          setModelStatus("unavailable");
        }
      } catch (error) {
        console.error("Invalid websocket message:", error);
      }
    };

    return () => {
      socket.close();
    };
  }, [wsUrl]);

  return (
    <main className="app-shell">
      <section className="panel scene-panel">
        <header>
          <h1>Robot Pose Stream</h1>
          <p>WebSocket: {wsUrl}</p>
        </header>
        <ThreeView pose={latestPose} frame={latestFrame} modelManifest={modelManifest} />
      </section>

      <section className="panel status-panel">
        <header>
          <h3>Latest Message</h3>
          <p>Connection: {connection}</p>
        </header>

        <dl className="stats">
          <div>
            <dt>Seq</dt>
            <dd>{latestPose?.seq ?? "--"}</dd>
          </div>
          <div>
            <dt>Body</dt>
            <dd>{latestPose?.body ?? "--"}</dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd>
              {formatNumber(latestPose?.position?.x)},{" "}
              {formatNumber(latestPose?.position?.y)},{" "}
              {formatNumber(latestPose?.position?.z)}
            </dd>
          </div>
          <div>
            <dt>Quaternion (wxyz)</dt>
            <dd>
              {formatNumber(latestPose?.quaternion?.w)},{" "}
              {formatNumber(latestPose?.quaternion?.x)},{" "}
              {formatNumber(latestPose?.quaternion?.y)},{" "}
              {formatNumber(latestPose?.quaternion?.z)}
            </dd>
          </div>
          <div>
            <dt>Sim Time</dt>
            <dd>{formatNumber(latestPose?.sim_time)}</dd>
          </div>
          <div>
            <dt>Frame Bodies</dt>
            <dd>{latestFrame?.body_count ?? "--"}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{modelStatus}</dd>
          </div>
          <div>
            <dt>Manifest Geoms</dt>
            <dd>{modelManifest?.geom_count ?? "--"}</dd>
          </div>
          <div>
            <dt>Manifest Bodies</dt>
            <dd>{modelManifest?.body_count ?? "--"}</dd>
          </div>
          <div>
            <dt>Manifest Meshes</dt>
            <dd>{modelManifest?.mesh_count ?? "--"}</dd>
          </div>
          <div>
            <dt>Model Path</dt>
            <dd>{modelManifest?.model_path ?? "--"}</dd>
          </div>
        </dl>
      </section>

      <SparkPanel history={history} />
    </main>
  );
}

export default App;
