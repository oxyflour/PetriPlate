from __future__ import annotations

import argparse
import asyncio
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import mujoco
import websockets
from websockets.exceptions import ConnectionClosed


GEOM_TYPE_LABELS: dict[int, str] = {
    int(mujoco.mjtGeom.mjGEOM_BOX): "box",
    int(mujoco.mjtGeom.mjGEOM_CAPSULE): "capsule",
    int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder",
    int(mujoco.mjtGeom.mjGEOM_ELLIPSOID): "ellipsoid",
    int(mujoco.mjtGeom.mjGEOM_MESH): "mesh",
    int(mujoco.mjtGeom.mjGEOM_PLANE): "plane",
    int(mujoco.mjtGeom.mjGEOM_SPHERE): "sphere",
}


def euler_to_quat(roll: float, pitch: float, yaw: float) -> tuple[float, float, float, float]:
    """Convert Euler angles to quaternion in wxyz order."""
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    return (
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    )


def quat_conjugate(quat: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    return (quat[0], -quat[1], -quat[2], -quat[3])


def quat_multiply(
    lhs: tuple[float, float, float, float],
    rhs: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    lw, lx, ly, lz = lhs
    rw, rx, ry, rz = rhs
    return (
        lw * rw - lx * rx - ly * ry - lz * rz,
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
    )


def quat_normalize(quat: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    norm = math.sqrt(sum(v * v for v in quat))
    if norm <= 1e-12:
        return (1.0, 0.0, 0.0, 0.0)
    return (
        quat[0] / norm,
        quat[1] / norm,
        quat[2] / norm,
        quat[3] / norm,
    )


def rotate_vector_by_quat(
    quat: tuple[float, float, float, float],
    vec: tuple[float, float, float],
) -> tuple[float, float, float]:
    qn = quat_normalize(quat)
    vector_quat = (0.0, vec[0], vec[1], vec[2])
    rotated = quat_multiply(quat_multiply(qn, vector_quat), quat_conjugate(qn))
    return (rotated[1], rotated[2], rotated[3])


def build_relative_pose_from_world(
    root_pos: tuple[float, float, float],
    root_quat: tuple[float, float, float, float],
    node_pos: tuple[float, float, float],
    node_quat: tuple[float, float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float, float]]:
    root_quat_norm = quat_normalize(root_quat)
    root_inv_quat = quat_conjugate(root_quat_norm)
    rel_offset = tuple(node_pos[axis] - root_pos[axis] for axis in range(3))
    rel_pos = rotate_vector_by_quat(root_inv_quat, rel_offset)
    rel_quat = quat_normalize(quat_multiply(root_inv_quat, quat_normalize(node_quat)))
    return rel_pos, rel_quat


def vec3_payload(values: list[float]) -> dict[str, float]:
    return {"x": float(values[0]), "y": float(values[1]), "z": float(values[2])}


def quat_payload(values: list[float]) -> dict[str, float]:
    return {
        "w": float(values[0]),
        "x": float(values[1]),
        "y": float(values[2]),
        "z": float(values[3]),
    }


def decode_c_string(blob: bytes, start: int) -> str:
    end = start
    while end < len(blob) and blob[end] != 0:
        end += 1
    return blob[start:end].decode("utf-8")


def build_file_index(root: Path) -> dict[str, list[Path]]:
    index: dict[str, list[Path]] = defaultdict(list)
    for candidate in root.rglob("*"):
        if candidate.is_file():
            index[candidate.name.lower()].append(candidate)
    return index


def resolve_mesh_file(model_dir: Path, mesh_ref: str, file_index: dict[str, list[Path]]) -> Path | None:
    mesh_path = Path(mesh_ref)
    if mesh_path.is_absolute() and mesh_path.is_file():
        return mesh_path.resolve()

    direct = (model_dir / mesh_path).resolve()
    if direct.is_file():
        return direct

    matches = file_index.get(mesh_path.name.lower(), [])
    if not matches:
        return None

    if mesh_path.parent != Path("."):
        suffix = mesh_path.as_posix().lower()
        for match in matches:
            if match.as_posix().lower().endswith(suffix):
                return match.resolve()

    return matches[0].resolve()


def build_mesh_url(mesh_file: Path, asset_url_prefix: str) -> str:
    prefix = asset_url_prefix.strip() or "/@fs"
    if not prefix.endswith("/"):
        prefix = f"{prefix}/"
    mesh_path = quote(mesh_file.resolve().as_posix(), safe="/:")
    return f"{prefix}{mesh_path}"


def collect_body_subtree(model: mujoco.MjModel, root_body_id: int) -> list[int]:
    children_map: dict[int, list[int]] = defaultdict(list)
    for body_id in range(model.nbody):
        parent_id = int(model.body_parentid[body_id])
        if parent_id >= 0:
            children_map[parent_id].append(body_id)

    stack = [root_body_id]
    subtree: set[int] = set()
    while stack:
        body_id = stack.pop()
        if body_id in subtree:
            continue
        subtree.add(body_id)
        stack.extend(children_map.get(body_id, []))

    return sorted(subtree)


def build_model_manifest(
    model: mujoco.MjModel,
    model_path: Path,
    body_id: int,
    body_name: str,
    asset_url_prefix: str,
) -> dict[str, Any]:
    model_file = model_path.resolve()
    model_dir = model_file.parent
    file_index = build_file_index(model_dir)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    body_subtree_ids = collect_body_subtree(model, body_id)
    body_subtree_set = set(body_subtree_ids)
    root_pos = tuple(float(v) for v in data.xpos[body_id])
    root_quat = tuple(float(v) for v in data.xquat[body_id])

    bodies: list[dict[str, Any]] = []
    for subtree_body_id in body_subtree_ids:
        subtree_body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, subtree_body_id)
        subtree_body_pos = tuple(float(v) for v in data.xpos[subtree_body_id])
        subtree_body_quat = tuple(float(v) for v in data.xquat[subtree_body_id])
        rel_pos, rel_quat = build_relative_pose_from_world(
            root_pos=root_pos,
            root_quat=root_quat,
            node_pos=subtree_body_pos,
            node_quat=subtree_body_quat,
        )
        parent_id = int(model.body_parentid[subtree_body_id])
        bodies.append(
            {
                "id": subtree_body_id,
                "name": subtree_body_name or f"body_{subtree_body_id}",
                "parent_id": parent_id if parent_id in body_subtree_set else -1,
                "position": vec3_payload(list(rel_pos)),
                "quaternion": quat_payload(list(rel_quat)),
            }
        )

    body_geom_ids = [
        geom_id for geom_id in range(model.ngeom) if int(model.geom_bodyid[geom_id]) in body_subtree_set
    ]
    visual_geom_ids = [
        geom_id
        for geom_id in body_geom_ids
        if int(model.geom_contype[geom_id]) == 0 and int(model.geom_conaffinity[geom_id]) == 0
    ]
    selected_geom_ids = visual_geom_ids or body_geom_ids

    geoms: list[dict[str, Any]] = []
    mesh_count = 0

    for geom_id in selected_geom_ids:
        geom_type = int(model.geom_type[geom_id])
        geom_type_label = GEOM_TYPE_LABELS.get(geom_type, "unknown")
        geom_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id)
        geom_body_id = int(model.geom_bodyid[geom_id])
        geom_body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, geom_body_id)

        geom_payload: dict[str, Any] = {
            "id": geom_id,
            "name": geom_name or f"geom_{geom_id}",
            "type": geom_type_label,
            "body_id": geom_body_id,
            "body_name": geom_body_name or f"body_{geom_body_id}",
            "position": vec3_payload([float(v) for v in model.geom_pos[geom_id]]),
            "quaternion": quat_payload([float(v) for v in model.geom_quat[geom_id]]),
            "size": vec3_payload([float(v) for v in model.geom_size[geom_id]]),
            "rgba": {
                "r": float(model.geom_rgba[geom_id][0]),
                "g": float(model.geom_rgba[geom_id][1]),
                "b": float(model.geom_rgba[geom_id][2]),
                "a": float(model.geom_rgba[geom_id][3]),
            },
        }

        if geom_type == int(mujoco.mjtGeom.mjGEOM_MESH):
            mesh_id = int(model.geom_dataid[geom_id])
            if 0 <= mesh_id < model.nmesh:
                mesh_count += 1
                mesh_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mesh_id)
                mesh_path_adr = int(model.mesh_pathadr[mesh_id])
                mesh_ref = decode_c_string(model.paths, mesh_path_adr) if mesh_path_adr >= 0 else ""
                mesh_file = resolve_mesh_file(model_dir, mesh_ref, file_index) if mesh_ref else None
                if mesh_file is None:
                    if mesh_ref:
                        print(f"[model] warning: failed to resolve mesh '{mesh_ref}'")
                    mesh_url = None
                    mesh_format = Path(mesh_ref).suffix.lower().lstrip(".")
                else:
                    mesh_url = build_mesh_url(mesh_file, asset_url_prefix)
                    mesh_format = mesh_file.suffix.lower().lstrip(".")

                geom_payload["mesh"] = {
                    "id": mesh_id,
                    "name": mesh_name or f"mesh_{mesh_id}",
                    "path": mesh_ref,
                    "url": mesh_url,
                    "format": mesh_format,
                    "position": vec3_payload([float(v) for v in model.mesh_pos[mesh_id]]),
                    "quaternion": quat_payload([float(v) for v in model.mesh_quat[mesh_id]]),
                    "scale": vec3_payload([float(v) for v in model.mesh_scale[mesh_id]]),
                }

        geoms.append(geom_payload)

    try:
        model_mtime_ns = model_file.stat().st_mtime_ns
    except FileNotFoundError:
        model_mtime_ns = 0

    return {
        "type": "model_manifest",
        "source": "mujoco",
        "body": body_name,
        "model_path": str(model_file),
        "model_mtime_ns": model_mtime_ns,
        "body_count": len(body_subtree_ids),
        "mesh_count": mesh_count,
        "geom_count": len(geoms),
        "bodies": bodies,
        "geoms": geoms,
    }


class PoseBroadcaster:
    def __init__(self, host: str, port: int, model_manifest: dict[str, Any] | None = None) -> None:
        self.host = host
        self.port = port
        self.model_manifest = model_manifest
        self.clients: set[websockets.ServerConnection] = set()
        self._server: websockets.Server | None = None

    async def _handle_message(self, websocket: websockets.ServerConnection, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return

        if not isinstance(message, dict):
            return

        if message.get("type") != "model_request":
            return

        requested_body = message.get("body")
        if self.model_manifest is None:
            payload: dict[str, Any] = {
                "type": "model_manifest",
                "source": "mujoco",
                "body": requested_body,
                "geom_count": 0,
                "mesh_count": 0,
                "geoms": [],
            }
        elif requested_body and requested_body != self.model_manifest.get("body"):
            payload = {
                "type": "model_manifest_unavailable",
                "source": "mujoco",
                "requested_body": requested_body,
                "available_body": self.model_manifest.get("body"),
            }
        else:
            payload = self.model_manifest

        await websocket.send(json.dumps(payload, separators=(",", ":")))

    async def _handler(self, websocket: websockets.ServerConnection) -> None:
        self.clients.add(websocket)
        print(f"[ws] client connected ({len(self.clients)} online)")
        try:
            async for message in websocket:
                await self._handle_message(websocket, message)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            print(f"[ws] client disconnected ({len(self.clients)} online)")

    async def start(self) -> None:
        self._server = await websockets.serve(self._handler, self.host, self.port)
        print(f"[ws] serving at ws://{self.host}:{self.port}")

    async def stop(self) -> None:
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._server = None
        print("[ws] server stopped")

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self.clients:
            return

        message = json.dumps(payload, separators=(",", ":"))
        stale: list[websockets.ServerConnection] = []

        for client in list(self.clients):
            try:
                await client.send(message)
            except ConnectionClosed:
                stale.append(client)

        for client in stale:
            self.clients.discard(client)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a headless Mujoco simulation and broadcast pose through websocket."
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=Path(__file__).parent / "models" / "free_body.xml",
        help="Path to MJCF XML model.",
    )
    parser.add_argument("--body-name", type=str, default="robot", help="Body name to stream.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Websocket host.")
    parser.add_argument("--port", type=int, default=8765, help="Websocket port.")
    parser.add_argument(
        "--asset-url-prefix",
        type=str,
        default="/@fs",
        help="Mesh URL prefix for browser loading (defaults to Vite /@fs).",
    )
    parser.add_argument("--sim-hz", type=float, default=120.0, help="Simulation step frequency.")
    parser.add_argument("--publish-hz", type=float, default=30.0, help="Pose publish frequency.")
    parser.add_argument(
        "--disable-demo-drive",
        action="store_true",
        help="Disable automatic actuator driving when streamed body has no freejoint.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=0.0,
        help="Run duration in seconds (0 means run forever).",
    )
    return parser.parse_args()


def build_pose_payload(
    seq: int,
    body_name: str,
    sim_time: float,
    position: list[float],
    quaternion: list[float],
) -> dict[str, Any]:
    return {
        "type": "pose",
        "source": "mujoco",
        "seq": seq,
        "body": body_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "sim_time": sim_time,
        "position": {"x": position[0], "y": position[1], "z": position[2]},
        "quaternion": {
            "w": quaternion[0],
            "x": quaternion[1],
            "y": quaternion[2],
            "z": quaternion[3],
        },
    }


def build_pose_frame_payload(
    seq: int,
    body_name: str,
    sim_time: float,
    model: mujoco.MjModel,
    data: mujoco.MjData,
    root_body_id: int,
    subtree_body_ids: list[int],
) -> dict[str, Any]:
    root_pos = tuple(float(v) for v in data.xpos[root_body_id])
    root_quat = tuple(float(v) for v in data.xquat[root_body_id])
    body_entries: list[dict[str, Any]] = []

    for subtree_body_id in subtree_body_ids:
        subtree_body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, subtree_body_id)
        subtree_body_pos = tuple(float(v) for v in data.xpos[subtree_body_id])
        subtree_body_quat = tuple(float(v) for v in data.xquat[subtree_body_id])
        rel_pos, rel_quat = build_relative_pose_from_world(
            root_pos=root_pos,
            root_quat=root_quat,
            node_pos=subtree_body_pos,
            node_quat=subtree_body_quat,
        )
        body_entries.append(
            {
                "id": subtree_body_id,
                "name": subtree_body_name or f"body_{subtree_body_id}",
                "position": vec3_payload(list(rel_pos)),
                "quaternion": quat_payload(list(rel_quat)),
            }
        )

    return {
        "type": "pose_frame",
        "source": "mujoco",
        "seq": seq,
        "body": body_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "sim_time": sim_time,
        "position": vec3_payload([float(v) for v in root_pos]),
        "quaternion": quat_payload([float(v) for v in root_quat]),
        "body_count": len(body_entries),
        "bodies": body_entries,
    }


def set_demo_pose(data: mujoco.MjData, qpos_adr: int, sim_time: float) -> None:
    x = 0.55 * math.cos(sim_time * 0.7)
    y = 0.35 * math.sin(sim_time * 0.9)
    z = 0.4 + 0.12 * math.sin(sim_time * 1.3)
    roll = 0.35 * math.sin(sim_time * 0.6)
    pitch = 0.40 * math.cos(sim_time * 0.8)
    yaw = sim_time * 0.9
    w, qx, qy, qz = euler_to_quat(roll, pitch, yaw)

    data.qpos[qpos_adr + 0] = x
    data.qpos[qpos_adr + 1] = y
    data.qpos[qpos_adr + 2] = z
    data.qpos[qpos_adr + 3] = w
    data.qpos[qpos_adr + 4] = qx
    data.qpos[qpos_adr + 5] = qy
    data.qpos[qpos_adr + 6] = qz


def set_demo_controls(model: mujoco.MjModel, data: mujoco.MjData, sim_time: float) -> None:
    if model.nu <= 0:
        return

    for actuator_id in range(model.nu):
        low = -1.0
        high = 1.0
        limited = bool(model.actuator_ctrllimited[actuator_id])
        if limited:
            low = float(model.actuator_ctrlrange[actuator_id][0])
            high = float(model.actuator_ctrlrange[actuator_id][1])

        center = 0.5 * (low + high)
        half_range = max(0.5 * (high - low), 1e-6)
        amplitude = 0.35 * half_range
        if high - low > 20.0:
            amplitude = 0.12 * half_range
        frequency = 0.65 + 0.09 * (actuator_id % 5)
        phase = 0.7 * actuator_id
        target = center + amplitude * math.sin(sim_time * frequency + phase)
        if limited:
            target = min(max(target, low), high)
        data.ctrl[actuator_id] = target


async def run_bridge(args: argparse.Namespace) -> None:
    if not args.model.exists():
        raise FileNotFoundError(f"Model not found: {args.model}")

    model = mujoco.MjModel.from_xml_path(str(args.model))
    data = mujoco.MjData(model)

    body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, args.body_name)
    if body_id < 0:
        raise ValueError(f"Body '{args.body_name}' not found in model: {args.model}")
    subtree_body_ids = collect_body_subtree(model, body_id)

    model_manifest = build_model_manifest(
        model=model,
        model_path=args.model,
        body_id=body_id,
        body_name=args.body_name,
        asset_url_prefix=args.asset_url_prefix,
    )
    print(
        f"[model] manifest ready for body '{args.body_name}' with "
        f"{model_manifest['geom_count']} geoms ({model_manifest['mesh_count']} meshes)"
    )

    qpos_adr: int | None = None
    joint_id = model.body_jntadr[body_id]
    if joint_id >= 0 and model.jnt_type[joint_id] == mujoco.mjtJoint.mjJNT_FREE:
        qpos_adr = int(model.jnt_qposadr[joint_id])
        print(f"[sim] freejoint detected at qpos[{qpos_adr}] for body '{args.body_name}'")
    else:
        print(
            "[sim] body has no freejoint; running pure physics stepping."
        )

    disable_demo_drive = bool(getattr(args, "disable_demo_drive", False))
    drive_actuators = qpos_adr is None and model.nu > 0 and not disable_demo_drive
    if drive_actuators:
        print(f"[sim] demo actuator driver enabled for {model.nu} actuators")
    elif qpos_adr is None and model.nu > 0:
        print("[sim] demo actuator driver disabled by flag")

    broadcaster = PoseBroadcaster(args.host, args.port, model_manifest=model_manifest)
    await broadcaster.start()

    sim_step = 1.0 / args.sim_hz
    publish_step = 1.0 / args.publish_hz
    next_publish = 0.0
    elapsed = 0.0
    seq = 0

    try:
        while args.duration <= 0.0 or elapsed < args.duration:
            sim_time = elapsed
            if qpos_adr is not None:
                set_demo_pose(data, qpos_adr, elapsed)
                data.time = elapsed
                mujoco.mj_forward(model, data)
            else:
                if drive_actuators:
                    set_demo_controls(model, data, elapsed)
                mujoco.mj_step(model, data)
                sim_time = float(data.time)
                elapsed = sim_time

            if sim_time >= next_publish:
                seq += 1
                payload = build_pose_payload(
                    seq=seq,
                    body_name=args.body_name,
                    sim_time=float(data.time),
                    position=[float(v) for v in data.xpos[body_id]],
                    quaternion=[float(v) for v in data.xquat[body_id]],
                )
                await broadcaster.broadcast(payload)
                frame_payload = build_pose_frame_payload(
                    seq=seq,
                    body_name=args.body_name,
                    sim_time=float(data.time),
                    model=model,
                    data=data,
                    root_body_id=body_id,
                    subtree_body_ids=subtree_body_ids,
                )
                await broadcaster.broadcast(frame_payload)
                next_publish += publish_step

            await asyncio.sleep(sim_step)
            if qpos_adr is not None:
                elapsed += sim_step
    finally:
        await broadcaster.stop()


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(run_bridge(args))
    except KeyboardInterrupt:
        print("\n[sim] stopped by user")


if __name__ == "__main__":
    main()
