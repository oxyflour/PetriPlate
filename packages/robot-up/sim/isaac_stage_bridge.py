from __future__ import annotations

import argparse
import asyncio
import json
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed


def emit_log(message: str, *, stream: Any = sys.stdout) -> None:
    print(message, file=stream, flush=True)


def build_stage_error_message(message: str) -> dict[str, str]:
    return {
        "type": "stage_error",
        "source": "isaacsim",
        "message": message,
    }


def vec3_payload(values: Any) -> dict[str, float]:
    return {
        "x": float(values[0]),
        "y": float(values[1]),
        "z": float(values[2]),
    }


def quat_payload(quaternion: Any) -> dict[str, float]:
    imaginary = quaternion.GetImaginary()
    return {
        "w": float(quaternion.GetReal()),
        "x": float(imaginary[0]),
        "y": float(imaginary[1]),
        "z": float(imaginary[2]),
    }


def zero_vec3() -> dict[str, float]:
    return {"x": 0.0, "y": 0.0, "z": 0.0}


def load_isaac_runtime() -> tuple[Any, dict[str, Any]]:
    from isaacsim import SimulationApp

    app = SimulationApp({"headless": True})
    from pxr import Gf, Usd, UsdGeom

    return app, {"Gf": Gf, "Usd": Usd, "UsdGeom": UsdGeom}


def to_time_code(Usd: Any, value: float) -> Any:
    return Usd.TimeCode(float(value))


def is_geometry_prim(prim: Any, UsdGeom: Any) -> bool:
    return bool(
        prim.IsA(UsdGeom.Gprim)
        or prim.IsA(UsdGeom.PointInstancer)
        or prim.IsA(UsdGeom.BasisCurves)
        or prim.IsA(UsdGeom.Points)
    )


def compute_visible(prim: Any, time_code: Any, UsdGeom: Any) -> bool:
    if not prim.IsA(UsdGeom.Imageable):
        return True

    visibility = UsdGeom.Imageable(prim).ComputeVisibility(time_code)
    return visibility != UsdGeom.Tokens.invisible


def compute_purpose(prim: Any, UsdGeom: Any) -> str | None:
    if not prim.IsA(UsdGeom.Imageable):
        return None

    purpose = UsdGeom.Imageable(prim).GetPurposeAttr().Get()
    return str(purpose) if purpose else None


def compute_local_matrix(prim: Any, time_code: Any, Gf: Any, UsdGeom: Any) -> Any:
    if not prim.IsA(UsdGeom.Xformable):
        return Gf.Matrix4d(1.0)

    xformable = UsdGeom.Xformable(prim)
    try:
        local_matrix, _resets_xform_stack = xformable.GetLocalTransformation(time_code)
        return local_matrix
    except Exception:
        return Gf.Matrix4d(1.0)


def matrix_to_pose(matrix: Any, Gf: Any) -> tuple[dict[str, float], dict[str, float], dict[str, float]]:
    transform = Gf.Transform(matrix)
    translation = transform.GetTranslation()
    rotation = transform.GetRotation().GetQuat()
    scale = transform.GetScale()
    return vec3_payload(translation), quat_payload(rotation), vec3_payload(scale)


def compute_bbox(
    prim: Any,
    time_code: Any,
    UsdGeom: Any,
    bbox_cache: Any,
) -> tuple[dict[str, float], dict[str, float]]:
    if not is_geometry_prim(prim, UsdGeom):
        return zero_vec3(), zero_vec3()

    try:
        aligned_range = bbox_cache.ComputeLocalBound(prim).ComputeAlignedRange()
    except Exception:
        return zero_vec3(), zero_vec3()

    if aligned_range.IsEmpty():
        return zero_vec3(), zero_vec3()

    return vec3_payload(aligned_range.GetMin()), vec3_payload(aligned_range.GetMax())


def build_stage_manifest(
    stage: Any,
    stage_path: Path,
    active_time_code: float,
    modules: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    Usd = modules["Usd"]
    UsdGeom = modules["UsdGeom"]
    Gf = modules["Gf"]
    time_code = to_time_code(Usd, active_time_code)
    bbox_cache = UsdGeom.BBoxCache(
        time_code,
        [UsdGeom.Tokens.default_, UsdGeom.Tokens.render, UsdGeom.Tokens.proxy],
    )

    prim_payloads: list[dict[str, Any]] = []
    tracked_paths: list[str] = []
    geometry_count = 0

    for prim in stage.Traverse():
        if not prim.IsActive():
            continue

        path = prim.GetPath().pathString
        tracked_paths.append(path)

        local_matrix = compute_local_matrix(prim, time_code, Gf, UsdGeom)
        position, quaternion, scale = matrix_to_pose(local_matrix, Gf)
        bbox_min, bbox_max = compute_bbox(prim, time_code, UsdGeom, bbox_cache)
        has_geometry = is_geometry_prim(prim, UsdGeom)
        if has_geometry:
            geometry_count += 1

        parent = prim.GetParent()
        parent_path = None
        if parent and parent.IsValid() and not parent.IsPseudoRoot():
            parent_path = parent.GetPath().pathString

        prim_payloads.append(
            {
                "path": path,
                "name": prim.GetName() or path,
                "parentPath": parent_path,
                "type": prim.GetTypeName() or "Xform",
                "purpose": compute_purpose(prim, UsdGeom),
                "visible": compute_visible(prim, time_code, UsdGeom),
                "hasGeometry": has_geometry,
                "childCount": len(list(prim.GetChildren())),
                "position": position,
                "quaternion": quaternion,
                "scale": scale,
                "bboxMin": bbox_min,
                "bboxMax": bbox_max,
            }
        )

    default_prim = stage.GetDefaultPrim()
    try:
        stage_mtime_ns = stage_path.stat().st_mtime_ns
    except FileNotFoundError:
        stage_mtime_ns = 0

    return (
        {
            "type": "stage_manifest",
            "source": "isaacsim",
            "stage_path": str(stage_path.resolve()),
            "stage_mtime_ns": stage_mtime_ns,
            "default_prim": (
                default_prim.GetPath().pathString
                if default_prim and default_prim.IsValid()
                else None
            ),
            "up_axis": str(UsdGeom.GetStageUpAxis(stage)),
            "meters_per_unit": float(UsdGeom.GetStageMetersPerUnit(stage)),
            "start_time_code": float(stage.GetStartTimeCode()),
            "end_time_code": float(stage.GetEndTimeCode()),
            "time_codes_per_second": float(
                stage.GetTimeCodesPerSecond() or stage.GetFramesPerSecond() or 24.0
            ),
            "active_time_code": float(active_time_code),
            "prim_count": len(prim_payloads),
            "geometry_count": geometry_count,
            "prims": prim_payloads,
        },
        tracked_paths,
    )


def build_stage_frame(
    stage: Any,
    tracked_paths: list[str],
    seq: int,
    active_time_code: float,
    modules: dict[str, Any],
) -> dict[str, Any]:
    Usd = modules["Usd"]
    UsdGeom = modules["UsdGeom"]
    Gf = modules["Gf"]
    time_code = to_time_code(Usd, active_time_code)
    prim_entries: list[dict[str, Any]] = []

    for path in tracked_paths:
        prim = stage.GetPrimAtPath(path)
        if not prim or not prim.IsValid() or not prim.IsActive():
            continue

        local_matrix = compute_local_matrix(prim, time_code, Gf, UsdGeom)
        position, quaternion, scale = matrix_to_pose(local_matrix, Gf)
        prim_entries.append(
            {
                "path": path,
                "visible": compute_visible(prim, time_code, UsdGeom),
                "position": position,
                "quaternion": quaternion,
                "scale": scale,
            }
        )

    return {
        "type": "stage_frame",
        "source": "isaacsim",
        "seq": seq,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "time_code": float(active_time_code),
        "prim_count": len(prim_entries),
        "prims": prim_entries,
    }


class StageBroadcaster:
    def __init__(self, host: str, port: int, stage_manifest: dict[str, Any]) -> None:
        self.host = host
        self.port = port
        self.stage_manifest = stage_manifest
        self.clients: set[websockets.ServerConnection] = set()
        self._server: websockets.Server | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._start_error: BaseException | None = None

    async def _handle_message(self, websocket: websockets.ServerConnection, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return

        if not isinstance(message, dict):
            return

        if message.get("type") not in {"stage_request", "model_request"}:
            return

        await websocket.send(json.dumps(self.stage_manifest, separators=(",", ":")))

    async def _handler(self, websocket: websockets.ServerConnection) -> None:
        self.clients.add(websocket)
        emit_log(f"[ws] client connected ({len(self.clients)} online)")
        try:
            async for message in websocket:
                await self._handle_message(websocket, message)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            emit_log(f"[ws] client disconnected ({len(self.clients)} online)")

    async def _start_server(self) -> None:
        self._server = await websockets.serve(self._handler, self.host, self.port)
        emit_log(f"[ws] serving at ws://{self.host}:{self.port}")

    async def _stop_server(self) -> None:
        if self._server is None:
            return

        stale_clients = list(self.clients)
        self.clients.clear()
        for client in stale_clients:
            try:
                await client.close()
            except Exception:
                continue

        self._server.close()
        await self._server.wait_closed()
        self._server = None
        emit_log("[ws] server stopped")

    async def _broadcast(self, payload: dict[str, Any]) -> None:
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

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)

        try:
            loop.run_until_complete(self._start_server())
            self._ready.set()
            loop.run_forever()
        except BaseException as error:
            self._start_error = error
            self._ready.set()
        finally:
            try:
                loop.run_until_complete(self._stop_server())
            except Exception:
                pass
            loop.close()

    def start(self, timeout: float = 30.0) -> None:
        if self._thread is not None:
            return

        self._thread = threading.Thread(target=self._run_loop, name="isaac-stage-ws", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            raise TimeoutError("Isaac websocket server did not start in time.")
        if self._start_error is not None:
            raise RuntimeError(f"Isaac websocket server failed to start: {self._start_error}")

    def stop(self, timeout: float = 10.0) -> None:
        if self._loop is None:
            return

        loop = self._loop
        future = asyncio.run_coroutine_threadsafe(self._stop_server(), loop)
        try:
            future.result(timeout=timeout)
        finally:
            loop.call_soon_threadsafe(loop.stop)
            if self._thread is not None:
                self._thread.join(timeout=timeout)
            self._thread = None
            self._loop = None

    def broadcast(self, payload: dict[str, Any], timeout: float = 5.0) -> None:
        if self._loop is None:
            return

        future = asyncio.run_coroutine_threadsafe(self._broadcast(payload), self._loop)
        future.result(timeout=timeout)


def resolve_initial_time_code(stage: Any) -> tuple[float, float, float, float, bool]:
    start_time_code = float(stage.GetStartTimeCode())
    end_time_code = float(stage.GetEndTimeCode())
    time_codes_per_second = float(stage.GetTimeCodesPerSecond() or stage.GetFramesPerSecond() or 24.0)
    has_animation = end_time_code > start_time_code + 1e-6
    initial_time_code = start_time_code
    return initial_time_code, start_time_code, end_time_code, time_codes_per_second, has_animation


def advance_time_code(
    current_time_code: float,
    start_time_code: float,
    end_time_code: float,
    step_size: float,
) -> float:
    next_time_code = current_time_code + step_size
    if next_time_code > end_time_code:
        return start_time_code
    return next_time_code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a headless Isaac Sim stage bridge and broadcast USD transforms over websocket."
    )
    parser.add_argument("--stage", type=Path, required=True, help="Path to USDA/USD stage.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Websocket host.")
    parser.add_argument("--port", type=int, default=8766, help="Websocket port.")
    parser.add_argument("--publish-hz", type=float, default=6.0, help="Frame publish frequency.")
    parser.add_argument(
        "--time-step",
        type=float,
        default=1.0,
        help="Time-code increment applied between published frames when the stage is animated.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=0.0,
        help="Run duration in seconds (0 means run forever).",
    )
    return parser.parse_args()


def run_bridge(args: argparse.Namespace) -> None:
    if not args.stage.exists():
        raise FileNotFoundError(f"Stage not found: {args.stage}")

    app = None
    broadcaster: StageBroadcaster | None = None

    try:
        emit_log(f"[isaac] starting bridge for {args.stage.resolve()}")
        app, modules = load_isaac_runtime()
        Usd = modules["Usd"]

        stage = Usd.Stage.Open(str(args.stage.resolve()))
        if stage is None:
            raise RuntimeError(f"Failed to open USD stage: {args.stage}")

        (
            active_time_code,
            start_time_code,
            end_time_code,
            time_codes_per_second,
            has_animation,
        ) = resolve_initial_time_code(stage)
        stage_manifest, tracked_paths = build_stage_manifest(
            stage=stage,
            stage_path=args.stage,
            active_time_code=active_time_code,
            modules=modules,
        )
        emit_log(
            "[stage] manifest ready with "
            f"{stage_manifest['prim_count']} prims "
            f"({stage_manifest['geometry_count']} geometry prims)"
        )

        broadcaster = StageBroadcaster(args.host, args.port, stage_manifest=stage_manifest)
        broadcaster.start()

        publish_step = 1.0 / max(args.publish_hz, 0.1)
        step_size = max(args.time_step, 0.001)
        elapsed = 0.0
        seq = 0

        while args.duration <= 0.0 or elapsed < args.duration:
            app.update()
            seq += 1
            broadcaster.broadcast(
                build_stage_frame(
                    stage=stage,
                    tracked_paths=tracked_paths,
                    seq=seq,
                    active_time_code=active_time_code,
                    modules=modules,
                )
            )
            time.sleep(publish_step)
            elapsed += publish_step

            if has_animation:
                active_time_code = advance_time_code(
                    current_time_code=active_time_code,
                    start_time_code=start_time_code,
                    end_time_code=end_time_code,
                    step_size=step_size,
                )
            else:
                active_time_code = start_time_code

            if has_animation and time_codes_per_second > 0:
                active_time_code = min(
                    max(active_time_code, start_time_code),
                    end_time_code,
                )
    except BaseException as error:
        if not isinstance(error, KeyboardInterrupt):
            emit_log(f"[isaac] bridge failed: {error}", stream=sys.stderr)
            emit_log(traceback.format_exc().rstrip(), stream=sys.stderr)
            if broadcaster is not None:
                try:
                    broadcaster.broadcast(build_stage_error_message(str(error)))
                except Exception as broadcast_error:
                    emit_log(
                        f"[isaac] stage_error broadcast failed: {broadcast_error}",
                        stream=sys.stderr,
                    )
        raise
    finally:
        if broadcaster is not None:
            broadcaster.stop()
        if app is not None:
            app.close()


def main() -> None:
    args = parse_args()
    try:
        run_bridge(args)
    except KeyboardInterrupt:
        emit_log("[isaac] stopped by user")


if __name__ == "__main__":
    main()
