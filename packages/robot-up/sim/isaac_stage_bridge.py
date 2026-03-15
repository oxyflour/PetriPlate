from __future__ import annotations

import argparse
import asyncio
import json
import math
import numpy as np
import sys
import threading
import time
import traceback
import xml.etree.ElementTree as ET
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


def unit_vec3() -> dict[str, float]:
    return {"x": 1.0, "y": 1.0, "z": 1.0}


def normalize_axis_token(value: Any) -> str:
    axis = str(value or "Z").upper()
    if axis in {"X", "Y", "Z"}:
        return axis
    return "Z"


def flatten_points(points: Any) -> list[float]:
    flattened: list[float] = []
    for point in points or []:
        flattened.extend([float(point[0]), float(point[1]), float(point[2])])
    return flattened


def triangulate_faces(face_vertex_counts: Any, face_vertex_indices: Any) -> list[int]:
    triangles: list[int] = []
    cursor = 0
    indices = list(face_vertex_indices or [])

    for raw_count in face_vertex_counts or []:
        face_count = int(raw_count)
        if face_count <= 0:
            continue

        face = indices[cursor : cursor + face_count]
        cursor += face_count
        if len(face) < 3:
            continue

        anchor = int(face[0])
        for offset in range(1, len(face) - 1):
            triangles.extend([anchor, int(face[offset]), int(face[offset + 1])])

    return triangles


def load_isaac_runtime() -> tuple[Any, dict[str, Any]]:
    from isaacsim import SimulationApp

    app = SimulationApp({"headless": True})
    import omni.usd
    from isaacsim.core.api import World
    from isaacsim.core.prims import SingleArticulation
    from isaacsim.core.utils.xforms import get_local_pose
    from isaacsim.core.utils.types import ArticulationAction
    from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics

    return app, {
        "ArticulationAction": ArticulationAction,
        "Gf": Gf,
        "Sdf": Sdf,
        "SingleArticulation": SingleArticulation,
        "Usd": Usd,
        "UsdGeom": UsdGeom,
        "UsdPhysics": UsdPhysics,
        "World": World,
        "get_local_pose": get_local_pose,
        "omni_usd": omni.usd,
    }


def resolve_runtime_stage_assets(app: Any, asset_path: Path) -> list[Path]:
    if asset_path.suffix.lower() in {".urdf", ".xml"}:
        return import_urdf_as_stage(app, asset_path)
    return collect_stage_candidate_paths(asset_path)


def append_stage_candidate(
    candidate_paths: list[Path],
    seen_paths: set[Path],
    candidate_path: Path,
) -> None:
    resolved_path = candidate_path.resolve()
    if not candidate_path.exists() or resolved_path in seen_paths:
        return
    seen_paths.add(resolved_path)
    candidate_paths.append(candidate_path)


def collect_stage_candidate_paths(asset_path: Path) -> list[Path]:
    candidate_paths: list[Path] = []
    seen_paths: set[Path] = set()

    append_stage_candidate(candidate_paths, seen_paths, asset_path)

    if asset_path.suffix.lower() not in {".usd", ".usda", ".usdc"}:
        return candidate_paths

    for extension in (".usd", ".usda", ".usdc"):
        append_stage_candidate(
            candidate_paths,
            seen_paths,
            asset_path.with_name(f"{asset_path.stem}_base{extension}"),
        )
        append_stage_candidate(
            candidate_paths,
            seen_paths,
            asset_path.parent / "configuration" / f"{asset_path.stem}_base{extension}",
        )

    primary_stem = derive_primary_stage_stem(asset_path)
    if primary_stem:
        search_roots = [asset_path.parent]
        if asset_path.parent.name.lower() == "configuration" and asset_path.parent.parent.exists():
            search_roots.insert(0, asset_path.parent.parent)
        for search_root in search_roots:
            for extension in (".usda", ".usd", ".usdc"):
                append_stage_candidate(
                    candidate_paths,
                    seen_paths,
                    search_root / f"{primary_stem}{extension}",
                )

    return candidate_paths


def derive_primary_stage_stem(asset_path: Path) -> str | None:
    suffixes = ("_base", "_physics", "_sensor", "_robot")
    stem = asset_path.stem
    for suffix in suffixes:
        if stem.endswith(suffix) and len(stem) > len(suffix):
            return stem[: -len(suffix)]
    return None


def import_urdf_as_stage(app: Any, asset_path: Path) -> list[Path]:
    try:
        import omni.kit.commands
        import omni.usd
    except Exception as error:
        raise RuntimeError(
            "Isaac URDF importer is unavailable in the current environment."
        ) from error

    imported_stage_path = asset_path.with_suffix(".imported.usda")
    usd_context = omni.usd.get_context()
    usd_context.new_stage()
    app.update()

    result, import_config = omni.kit.commands.execute("URDFCreateImportConfig")
    if not result:
        raise RuntimeError("Isaac URDF importer could not create an import config.")

    if hasattr(import_config, "set_merge_fixed_joints"):
        import_config.set_merge_fixed_joints(False)
    if hasattr(import_config, "set_fix_base"):
        import_config.set_fix_base(False)
    if hasattr(import_config, "set_make_default_prim"):
        import_config.set_make_default_prim(True)
    if hasattr(import_config, "set_create_physics_scene"):
        import_config.set_create_physics_scene(False)
    if hasattr(import_config, "set_make_instanceable"):
        import_config.set_make_instanceable(False)
    elif hasattr(import_config, "make_instanceable"):
        import_config.make_instanceable = False

    result, imported_path = omni.kit.commands.execute(
        "URDFParseAndImportFile",
        urdf_path=str(asset_path.resolve()),
        import_config=import_config,
        dest_path=str(imported_stage_path.resolve()),
        get_articulation_root=True,
    )
    app.update()
    if not result:
        raise RuntimeError(f"Isaac URDF importer failed for {asset_path.name}.")

    if not imported_stage_path.exists():
        raise RuntimeError(
            "Isaac URDF importer did not produce a USD stage file."
            f" Command returned path: {imported_path!r}"
        )

    candidate_paths = collect_stage_candidate_paths(imported_stage_path)
    seen_paths = {candidate_path.resolve() for candidate_path in candidate_paths}
    append_stage_candidate(
        candidate_paths,
        seen_paths,
        imported_stage_path.parent / "configuration" / f"{asset_path.stem}_base.usd",
    )

    return candidate_paths


def to_time_code(Usd: Any, value: float) -> Any:
    return Usd.TimeCode(float(value))


def is_urdf_asset(asset_path: Path) -> bool:
    return asset_path.suffix.lower() in {".urdf", ".xml"}


def iter_stage_prims(stage: Any, Usd: Any) -> Any:
    try:
        return stage.Traverse(Usd.TraverseInstanceProxies())
    except Exception:
        return stage.Traverse()


def count_child_prims(prim: Any, Usd: Any) -> int:
    try:
        return len(list(prim.GetFilteredChildren(Usd.TraverseInstanceProxies())))
    except Exception:
        return len(list(prim.GetChildren()))


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


def compute_runtime_local_pose(
    prim: Any,
    modules: dict[str, Any],
) -> tuple[dict[str, float] | None, dict[str, float] | None]:
    get_local_pose = modules.get("get_local_pose")
    UsdGeom = modules["UsdGeom"]

    if get_local_pose is None or not prim.IsA(UsdGeom.Xformable):
        return None, None

    try:
        live_position, live_orientation = get_local_pose(prim.GetPath().pathString)
    except Exception:
        return None, None

    return vec3_payload(live_position), {
        "w": float(live_orientation[0]),
        "x": float(live_orientation[1]),
        "y": float(live_orientation[2]),
        "z": float(live_orientation[3]),
    }


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


def build_renderable_payload(prim: Any, time_code: Any, UsdGeom: Any) -> dict[str, Any] | None:
    if prim.IsA(UsdGeom.Mesh):
        mesh = UsdGeom.Mesh(prim)
        positions = flatten_points(mesh.GetPointsAttr().Get(time_code))
        indices = triangulate_faces(
            mesh.GetFaceVertexCountsAttr().Get(time_code),
            mesh.GetFaceVertexIndicesAttr().Get(time_code),
        )
        if len(positions) < 9 or len(indices) < 3:
            return None
        return {
            "kind": "mesh",
            "positions": positions,
            "indices": indices,
            "doubleSided": bool(mesh.GetDoubleSidedAttr().Get(time_code)),
        }

    if prim.IsA(UsdGeom.Cube):
        cube = UsdGeom.Cube(prim)
        size = cube.GetSizeAttr().Get(time_code)
        return {"kind": "cube", "size": float(size) if size is not None else 2.0}

    if prim.IsA(UsdGeom.Sphere):
        sphere = UsdGeom.Sphere(prim)
        radius = sphere.GetRadiusAttr().Get(time_code)
        return {"kind": "sphere", "radius": float(radius) if radius is not None else 1.0}

    if prim.IsA(UsdGeom.Capsule):
        capsule = UsdGeom.Capsule(prim)
        radius = capsule.GetRadiusAttr().Get(time_code)
        height = capsule.GetHeightAttr().Get(time_code)
        axis = capsule.GetAxisAttr().Get(time_code)
        return {
            "kind": "capsule",
            "radius": float(radius) if radius is not None else 1.0,
            "height": float(height) if height is not None else 2.0,
            "axis": normalize_axis_token(axis),
        }

    if prim.IsA(UsdGeom.Cylinder):
        cylinder = UsdGeom.Cylinder(prim)
        radius = cylinder.GetRadiusAttr().Get(time_code)
        height = cylinder.GetHeightAttr().Get(time_code)
        axis = cylinder.GetAxisAttr().Get(time_code)
        return {
            "kind": "cylinder",
            "radius": float(radius) if radius is not None else 1.0,
            "height": float(height) if height is not None else 2.0,
            "axis": normalize_axis_token(axis),
        }

    if prim.IsA(UsdGeom.Cone):
        cone = UsdGeom.Cone(prim)
        radius = cone.GetRadiusAttr().Get(time_code)
        height = cone.GetHeightAttr().Get(time_code)
        axis = cone.GetAxisAttr().Get(time_code)
        return {
            "kind": "cone",
            "radius": float(radius) if radius is not None else 1.0,
            "height": float(height) if height is not None else 2.0,
            "axis": normalize_axis_token(axis),
        }

    return None


def build_stage_manifest(
    stage: Any,
    stage_path: Path,
    active_time_code: float,
    modules: dict[str, Any],
    *,
    prefer_runtime_pose: bool = False,
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
    renderable_count = 0
    mesh_prim_count = 0

    for prim in iter_stage_prims(stage, Usd):
        if not prim.IsActive():
            continue

        path = prim.GetPath().pathString
        tracked_paths.append(path)

        runtime_position, runtime_quaternion = (
            compute_runtime_local_pose(prim, modules) if prefer_runtime_pose else (None, None)
        )
        local_matrix = compute_local_matrix(prim, time_code, Gf, UsdGeom)
        fallback_position, fallback_quaternion, scale = matrix_to_pose(local_matrix, Gf)
        position = runtime_position or fallback_position
        quaternion = runtime_quaternion or fallback_quaternion
        bbox_min, bbox_max = compute_bbox(prim, time_code, UsdGeom, bbox_cache)
        has_geometry = is_geometry_prim(prim, UsdGeom)
        renderable = build_renderable_payload(prim, time_code, UsdGeom) if has_geometry else None
        if has_geometry:
            geometry_count += 1
        if renderable is not None:
            renderable_count += 1
            if renderable.get("kind") == "mesh":
                mesh_prim_count += 1

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
                "childCount": count_child_prims(prim, Usd),
                "position": position,
                "quaternion": quaternion,
                "scale": scale,
                "bboxMin": bbox_min,
                "bboxMax": bbox_max,
                "renderable": renderable,
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
            "renderable_count": renderable_count,
            "mesh_prim_count": mesh_prim_count,
            "prims": prim_payloads,
        },
        tracked_paths,
    )


def resolve_session_asset_root(asset_path: Path) -> Path:
    for parent in [asset_path.parent, *asset_path.parents]:
        if parent.name == "assets":
            return parent
    return asset_path.parent


def parse_float_vector(raw: str | None, expected_size: int, default: list[float]) -> list[float]:
    if not raw:
        return list(default)

    tokens = raw.replace(",", " ").split()
    values: list[float] = []
    for token in tokens[:expected_size]:
        try:
            values.append(float(token))
        except ValueError:
            values.append(default[len(values)])

    while len(values) < expected_size:
        values.append(default[len(values)])

    return values


def quaternion_from_rpy(roll: float, pitch: float, yaw: float) -> dict[str, float]:
    half_roll = roll * 0.5
    half_pitch = pitch * 0.5
    half_yaw = yaw * 0.5

    cr = math.cos(half_roll)
    sr = math.sin(half_roll)
    cp = math.cos(half_pitch)
    sp = math.sin(half_pitch)
    cy = math.cos(half_yaw)
    sy = math.sin(half_yaw)

    return {
        "w": cr * cp * cy + sr * sp * sy,
        "x": sr * cp * cy - cr * sp * sy,
        "y": cr * sp * cy + sr * cp * sy,
        "z": cr * cp * sy - sr * sp * cy,
    }


def infer_asset_mesh_format(asset_path: str) -> str | None:
    extension = Path(asset_path).suffix.lower()
    if extension == ".dae":
        return "dae"
    if extension == ".stl":
        return "stl"
    if extension == ".obj":
        return "obj"
    return None


def normalize_asset_reference(value: str) -> list[str]:
    raw = value.strip().replace("\\", "/")
    if not raw:
        return []

    candidates = [raw]
    if "://" in raw:
        _scheme, remainder = raw.split("://", 1)
        candidates.append(remainder)
        if "/" in remainder:
            candidates.append(remainder.split("/", 1)[1])
    if raw.startswith("file:/"):
        candidates.append(raw.replace("file://", "", 1).replace("file:/", "", 1))

    normalized_candidates: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = candidate.replace("\\", "/").lstrip("/")
        normalized = str(Path(normalized))
        normalized = normalized.replace("\\", "/")
        if not normalized or normalized == "." or normalized in seen:
            continue
        seen.add(normalized)
        normalized_candidates.append(normalized)
    return normalized_candidates


def build_asset_index(asset_root: Path) -> list[str]:
    asset_paths: list[str] = []
    for file_path in asset_root.rglob("*"):
        if file_path.is_file():
            asset_paths.append(file_path.relative_to(asset_root).as_posix())
    return asset_paths


def resolve_urdf_asset_path(
    mesh_reference: str,
    urdf_path: Path,
    asset_root: Path,
    asset_index: list[str],
) -> str | None:
    candidates = normalize_asset_reference(mesh_reference)
    candidate_keys = {candidate.lower() for candidate in candidates}
    basenames = {Path(candidate).name.lower() for candidate in candidates if Path(candidate).name}

    for candidate in candidates:
        direct_paths = [
            (urdf_path.parent / candidate).resolve(),
            (asset_root / candidate).resolve(),
        ]
        for direct_path in direct_paths:
            if direct_path.exists() and direct_path.is_file():
                try:
                    return direct_path.relative_to(asset_root).as_posix()
                except ValueError:
                    continue

    for indexed_path in asset_index:
        lower_indexed_path = indexed_path.lower()
        if lower_indexed_path in candidate_keys:
            return indexed_path
        if any(lower_indexed_path.endswith(f"/{candidate}") for candidate in candidate_keys):
            return indexed_path

    for indexed_path in asset_index:
        if Path(indexed_path).name.lower() in basenames:
            return indexed_path

    return None


def derive_urdf_source_stem(stage_stem: str) -> str:
    normalized_stem = stage_stem
    for suffix in ("_base", "_physics", "_sensor", "_robot"):
        if normalized_stem.endswith(suffix) and len(normalized_stem) > len(suffix):
            normalized_stem = normalized_stem[: -len(suffix)]
            break

    for suffix in (".imported", "_imported"):
        if normalized_stem.endswith(suffix) and len(normalized_stem) > len(suffix):
            normalized_stem = normalized_stem[: -len(suffix)]
            break

    return normalized_stem


def resolve_urdf_visual_source(asset_path: Path, stage_asset_path: Path) -> Path | None:
    if is_urdf_asset(asset_path):
        return asset_path

    candidate_roots = [asset_path.parent]
    if stage_asset_path.parent.name.lower() == "configuration" and stage_asset_path.parent.parent.exists():
        candidate_roots.append(stage_asset_path.parent.parent)
    elif stage_asset_path.parent not in candidate_roots:
        candidate_roots.append(stage_asset_path.parent)

    candidate_stems: list[str] = []
    for raw_stem in (asset_path.stem, stage_asset_path.stem):
        normalized_stem = derive_urdf_source_stem(raw_stem)
        if normalized_stem and normalized_stem not in candidate_stems:
            candidate_stems.append(normalized_stem)

    for root in candidate_roots:
        for stem in candidate_stems:
            for extension in (".urdf", ".xml"):
                candidate = root / f"{stem}{extension}"
                if candidate.exists() and candidate.is_file():
                    return candidate

    return None


def find_link_parent_path(stage_manifest: dict[str, Any], link_name: str) -> str | None:
    candidates = [
        prim["path"]
        for prim in stage_manifest.get("prims", [])
        if prim.get("name") == link_name and prim.get("path")
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda value: (value.count("/"), len(value)), reverse=True)
    return candidates[0]


def increment_parent_child_count(stage_manifest: dict[str, Any], parent_path: str) -> None:
    for prim in stage_manifest.get("prims", []):
        if prim.get("path") == parent_path:
            prim["childCount"] = int(prim.get("childCount", 0)) + 1
            return


def is_visualized_stage_path(path: str) -> bool:
    normalized_path = path.lower()
    return "/collisions/" not in normalized_path and "_collision" not in normalized_path


def link_has_visible_renderable(stage_manifest: dict[str, Any], parent_path: str) -> bool:
    normalized_parent_path = parent_path.rstrip("/")
    child_prefix = f"{normalized_parent_path}/"

    for prim in stage_manifest.get("prims", []):
        prim_path = prim.get("path")
        if not isinstance(prim_path, str):
            continue
        if prim_path != normalized_parent_path and not prim_path.startswith(child_prefix):
            continue
        if not is_visualized_stage_path(prim_path):
            continue
        if prim.get("purpose") == "guide":
            continue
        if prim.get("renderable") is not None:
            return True

    return False


def build_urdf_visual_fallback_prims(
    urdf_path: Path,
    stage_manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    asset_root = resolve_session_asset_root(urdf_path)
    asset_index = build_asset_index(asset_root)

    try:
        tree = ET.parse(urdf_path)
    except ET.ParseError as error:
        emit_log(f"[urdf] could not parse {urdf_path.name}: {error}", stream=sys.stderr)
        return []

    robot = tree.getroot()
    if robot.tag != "robot":
        return []

    synthetic_prims: list[dict[str, Any]] = []
    synthetic_counts = {
        "geometry": 0,
        "renderable": 0,
        "mesh": 0,
    }

    for link in robot.findall("link"):
        link_name = link.get("name")
        if not link_name:
            continue

        parent_path = find_link_parent_path(stage_manifest, link_name)
        if not parent_path:
            continue
        if link_has_visible_renderable(stage_manifest, parent_path):
            continue

        visuals = link.findall("visual")
        for visual_index, visual in enumerate(visuals):
            geometry = visual.find("geometry")
            if geometry is None:
                continue

            origin = visual.find("origin")
            xyz = parse_float_vector(origin.get("xyz") if origin is not None else None, 3, [0.0, 0.0, 0.0])
            rpy = parse_float_vector(origin.get("rpy") if origin is not None else None, 3, [0.0, 0.0, 0.0])

            renderable: dict[str, Any] | None = None
            scale = unit_vec3()
            type_name = "UrdfVisual"

            mesh = geometry.find("mesh")
            if mesh is not None:
                mesh_filename = mesh.get("filename")
                if mesh_filename:
                    resolved_asset_path = resolve_urdf_asset_path(
                        mesh_filename,
                        urdf_path=urdf_path,
                        asset_root=asset_root,
                        asset_index=asset_index,
                    )
                    asset_format = infer_asset_mesh_format(mesh_filename)
                    if resolved_asset_path and asset_format:
                        mesh_scale = parse_float_vector(mesh.get("scale"), 3, [1.0, 1.0, 1.0])
                        scale = vec3_payload(mesh_scale)
                        renderable = {
                            "kind": "asset_mesh",
                            "assetPath": resolved_asset_path,
                            "format": asset_format,
                        }
                        type_name = "UrdfMesh"

            if renderable is None:
                box = geometry.find("box")
                if box is not None and box.get("size"):
                    size = parse_float_vector(box.get("size"), 3, [1.0, 1.0, 1.0])
                    renderable = {
                        "kind": "box",
                        "size": vec3_payload(size),
                    }
                    type_name = "UrdfBox"

            if renderable is None:
                sphere = geometry.find("sphere")
                if sphere is not None and sphere.get("radius"):
                    try:
                        radius = float(sphere.get("radius", "1"))
                    except ValueError:
                        radius = 1.0
                    renderable = {"kind": "sphere", "radius": radius}
                    type_name = "UrdfSphere"

            if renderable is None:
                cylinder = geometry.find("cylinder")
                if cylinder is not None:
                    try:
                        radius = float(cylinder.get("radius", "1"))
                    except ValueError:
                        radius = 1.0
                    try:
                        length = float(cylinder.get("length", "1"))
                    except ValueError:
                        length = 1.0
                    renderable = {
                        "kind": "cylinder",
                        "radius": radius,
                        "height": length,
                        "axis": "Z",
                    }
                    type_name = "UrdfCylinder"

            if renderable is None:
                continue

            synthetic_path = f"{parent_path}/__urdf_visual_{visual_index}"
            synthetic_prims.append(
                {
                    "path": synthetic_path,
                    "name": f"{link_name}_visual_{visual_index}",
                    "parentPath": parent_path,
                    "type": type_name,
                    "purpose": "render",
                    "visible": True,
                    "hasGeometry": True,
                    "childCount": 0,
                    "position": vec3_payload(xyz),
                    "quaternion": quaternion_from_rpy(rpy[0], rpy[1], rpy[2]),
                    "scale": scale,
                    "bboxMin": zero_vec3(),
                    "bboxMax": zero_vec3(),
                    "renderable": renderable,
                }
            )
            increment_parent_child_count(stage_manifest, parent_path)
            synthetic_counts["geometry"] += 1
            synthetic_counts["renderable"] += 1
            if renderable.get("kind") in {"mesh", "asset_mesh"}:
                synthetic_counts["mesh"] += 1

    if synthetic_prims:
        stage_manifest["prims"].extend(synthetic_prims)
        stage_manifest["prim_count"] = int(stage_manifest.get("prim_count", 0)) + len(synthetic_prims)
        stage_manifest["geometry_count"] = int(stage_manifest.get("geometry_count", 0)) + synthetic_counts["geometry"]
        stage_manifest["renderable_count"] = int(stage_manifest.get("renderable_count", 0)) + synthetic_counts["renderable"]
        stage_manifest["mesh_prim_count"] = int(stage_manifest.get("mesh_prim_count", 0)) + synthetic_counts["mesh"]

    return synthetic_prims


def open_stage_in_runtime_context(
    app: Any,
    stage_asset_path: Path,
    modules: dict[str, Any],
) -> Any:
    usd_context = modules["omni_usd"].get_context()
    resolved_stage_path = str(stage_asset_path.resolve())

    if hasattr(usd_context, "open_stage"):
        open_result = usd_context.open_stage(resolved_stage_path)
        if open_result is False:
            raise RuntimeError(f"Isaac runtime could not open {resolved_stage_path}.")
    else:
        raise RuntimeError("Isaac runtime does not expose omni.usd stage opening APIs.")

    stage = None
    matched_stage = None
    for _attempt in range(120):
        app.update()
        stage = usd_context.get_stage()
        if stage is None:
            continue

        try:
            root_layer = stage.GetRootLayer()
            stage_identifier = str(
                getattr(root_layer, "realPath", "")
                or getattr(root_layer, "resolvedPath", "")
                or root_layer.identifier
            )
        except Exception:
            stage_identifier = ""

        if not stage_identifier:
            continue

        normalized_identifier = stage_identifier.replace("\\", "/")
        normalized_target = resolved_stage_path.replace("\\", "/")
        if (
            normalized_identifier == normalized_target
            or normalized_identifier.endswith(f"/{stage_asset_path.name}")
            or normalized_identifier.endswith(f"\\{stage_asset_path.name}")
        ):
            matched_stage = stage
            break

    if matched_stage is None:
        raise RuntimeError(f"Isaac runtime stage did not become available for {resolved_stage_path}.")

    stage = matched_stage
    try:
        stage.Load()
    except Exception:
        pass

    return stage


def find_existing_physics_scene_path(stage: Any, modules: dict[str, Any]) -> str | None:
    Usd = modules["Usd"]
    UsdPhysics = modules["UsdPhysics"]

    for prim in iter_stage_prims(stage, Usd):
        type_name = prim.GetTypeName() or ""
        if type_name == "PhysicsScene":
            return prim.GetPath().pathString
        try:
            if prim.IsA(UsdPhysics.Scene):
                return prim.GetPath().pathString
        except Exception:
            continue

    return None


def ensure_physics_scene(stage: Any, modules: dict[str, Any]) -> str:
    existing_path = find_existing_physics_scene_path(stage, modules)
    if existing_path:
        return existing_path

    UsdPhysics = modules["UsdPhysics"]
    Sdf = modules["Sdf"]
    Gf = modules["Gf"]

    candidate_paths = ["/PhysicsScene"]
    default_prim = stage.GetDefaultPrim()
    if default_prim and default_prim.IsValid():
        candidate_paths.insert(0, f"{default_prim.GetPath().pathString}/PhysicsScene")
    if stage.GetPrimAtPath("/World").IsValid():
        candidate_paths.insert(0, "/World/PhysicsScene")

    scene_prim_path: str | None = None
    for candidate_path in candidate_paths:
        if stage.GetPrimAtPath(candidate_path).IsValid():
            scene_prim_path = candidate_path
            break
        try:
            physics_scene = UsdPhysics.Scene.Define(stage, Sdf.Path(candidate_path))
            physics_scene.CreateGravityDirectionAttr().Set(Gf.Vec3f(0.0, 0.0, -1.0))
            physics_scene.CreateGravityMagnitudeAttr().Set(9.81)
            scene_prim_path = candidate_path
            break
        except Exception:
            continue

    if not scene_prim_path:
        raise RuntimeError("Isaac runtime could not create a PhysicsScene for articulation stepping.")

    return scene_prim_path


def find_articulation_root_paths(stage: Any, modules: dict[str, Any]) -> list[str]:
    Usd = modules["Usd"]
    UsdPhysics = modules["UsdPhysics"]
    root_paths: list[str] = []

    for prim in iter_stage_prims(stage, Usd):
        try:
            if prim.HasAPI(UsdPhysics.ArticulationRootAPI):
                root_paths.append(prim.GetPath().pathString)
        except Exception:
            continue

    root_paths.sort(key=lambda value: (value.count("/"), len(value)))
    return root_paths


def flatten_float_array(values: Any) -> np.ndarray:
    return np.asarray(values, dtype=np.float64).reshape(-1)


def normalize_joint_limits(raw_limits: Any, dof_count: int) -> tuple[np.ndarray, np.ndarray]:
    flat_limits = np.asarray(raw_limits, dtype=np.float64)
    if flat_limits.size == 0:
        lower = np.full(dof_count, -math.inf, dtype=np.float64)
        upper = np.full(dof_count, math.inf, dtype=np.float64)
        return lower, upper

    if flat_limits.ndim == 3:
        flat_limits = flat_limits[0]
    if flat_limits.ndim == 2 and flat_limits.shape[1] >= 2:
        lower = flat_limits[:, 0].reshape(-1)
        upper = flat_limits[:, 1].reshape(-1)
        if lower.size >= dof_count and upper.size >= dof_count:
            return lower[:dof_count], upper[:dof_count]

    lower = np.full(dof_count, -math.inf, dtype=np.float64)
    upper = np.full(dof_count, math.inf, dtype=np.float64)
    return lower, upper


def select_driven_joint_indices(joint_names: list[str], max_joint_count: int = 3) -> list[int]:
    preferred_indices = [
        index
        for index, joint_name in enumerate(joint_names)
        if "finger" not in joint_name.lower() and "gripper" not in joint_name.lower()
    ]
    if not preferred_indices:
        preferred_indices = list(range(len(joint_names)))
    return preferred_indices[: max(1, min(max_joint_count, len(preferred_indices)))]


class ArticulationSineDriver:
    def __init__(
        self,
        stage: Any,
        stage_asset_path: Path,
        modules: dict[str, Any],
        physics_dt: float,
    ) -> None:
        World = modules["World"]
        SingleArticulation = modules["SingleArticulation"]

        self.physics_dt = max(physics_dt, 1.0 / 240.0)
        self._world_cls = World
        self.world: Any | None = None
        self.articulation: Any | None = None
        self.root_path: str | None = None
        self.driven_joint_indices = np.zeros(0, dtype=np.int32)
        self.driven_joint_names: list[str] = []
        self.base_joint_positions = np.zeros(0, dtype=np.float64)
        self.lower_joint_limits = np.zeros(0, dtype=np.float64)
        self.upper_joint_limits = np.zeros(0, dtype=np.float64)
        self.joint_amplitudes = np.zeros(0, dtype=np.float64)
        self.joint_frequencies_hz = np.zeros(0, dtype=np.float64)
        self.joint_phase_offsets = np.zeros(0, dtype=np.float64)
        self._articulation_action = modules["ArticulationAction"]

        articulation_root_paths = find_articulation_root_paths(stage, modules)
        if not articulation_root_paths:
            return

        if World.instance():
            World.instance().clear_instance()

        physics_scene_path = ensure_physics_scene(stage, modules)
        stage_units = float(modules["UsdGeom"].GetStageMetersPerUnit(stage) or 1.0)
        self.world = World(
            stage_units_in_meters=stage_units if stage_units > 0 else 1.0,
            physics_dt=self.physics_dt,
            rendering_dt=self.physics_dt,
        )

        self.root_path = articulation_root_paths[0]
        self.articulation = SingleArticulation(prim_path=self.root_path, name="stage_articulation")
        self.world.reset()
        self.articulation.initialize()
        try:
            self.articulation.disable_gravity()
        except Exception:
            pass
        self.world.play()

        joint_positions = flatten_float_array(self.articulation.get_joint_positions())
        dof_count = int(joint_positions.size)
        if dof_count <= 0:
            emit_log(
                f"[articulation] {self.root_path} has no controllable DOFs on {stage_asset_path.name}"
            )
            self._disable_runtime()
            return

        joint_names = list(getattr(self.articulation, "dof_names", []) or [])
        if len(joint_names) < dof_count:
            joint_names = [f"joint_{index}" for index in range(dof_count)]

        driven_joint_indices = select_driven_joint_indices(joint_names)
        if not driven_joint_indices:
            emit_log(
                f"[articulation] {self.root_path} has no eligible joints to drive on {stage_asset_path.name}"
            )
            self._disable_runtime()
            return

        try:
            raw_limits = self.articulation.get_dof_limits()
        except Exception:
            raw_limits = None
        lower_limits, upper_limits = normalize_joint_limits(raw_limits, dof_count)

        driven_joint_array = np.asarray(driven_joint_indices, dtype=np.int32)
        driven_joint_names = [joint_names[index] for index in driven_joint_indices]
        base_joint_positions = joint_positions[driven_joint_array].astype(np.float64, copy=True)
        lower_joint_limits = lower_limits[driven_joint_array]
        upper_joint_limits = upper_limits[driven_joint_array]

        amplitude_values: list[float] = []
        for lower_limit, upper_limit in zip(lower_joint_limits, upper_joint_limits, strict=False):
            if math.isfinite(lower_limit) and math.isfinite(upper_limit) and upper_limit > lower_limit:
                span = upper_limit - lower_limit
                amplitude_values.append(max(0.08, min(0.45, span * 0.18)))
            else:
                amplitude_values.append(0.22)

        self.driven_joint_indices = driven_joint_array
        self.driven_joint_names = driven_joint_names
        self.base_joint_positions = base_joint_positions
        self.lower_joint_limits = lower_joint_limits
        self.upper_joint_limits = upper_joint_limits
        self.joint_amplitudes = np.asarray(amplitude_values, dtype=np.float64)
        self.joint_frequencies_hz = np.linspace(
            0.35,
            0.85,
            num=len(driven_joint_indices),
            dtype=np.float64,
        )
        self.joint_phase_offsets = np.linspace(
            0.0,
            math.pi / 2.0,
            num=len(driven_joint_indices),
            endpoint=False,
            dtype=np.float64,
        )

        emit_log(
            f"[world] using physics scene {physics_scene_path} at dt={self.physics_dt:.4f}s"
        )
        emit_log(
            "[articulation] driving "
            f"{self.root_path} joints: {', '.join(self.driven_joint_names)}"
        )
        emit_log(f"[articulation] gravity disabled for {self.root_path}")

    @property
    def enabled(self) -> bool:
        return (
            self.world is not None
            and self.articulation is not None
            and self.driven_joint_indices.size > 0
        )

    def _disable_runtime(self) -> None:
        self.stop()
        if self._world_cls.instance():
            self._world_cls.instance().clear_instance()
        self.world = None
        self.articulation = None

    def step(self, simulation_time: float) -> float:
        if not self.enabled:
            return simulation_time

        next_time = simulation_time + self.physics_dt
        target_positions = self.base_joint_positions + (
            self.joint_amplitudes
            * np.sin((math.tau * self.joint_frequencies_hz * next_time) + self.joint_phase_offsets)
        )

        finite_lower = np.isfinite(self.lower_joint_limits)
        finite_upper = np.isfinite(self.upper_joint_limits)
        finite_limits = finite_lower & finite_upper & (self.upper_joint_limits > self.lower_joint_limits)
        if np.any(finite_limits):
            safety_margin = np.minimum(
                (self.upper_joint_limits - self.lower_joint_limits) * 0.08,
                0.08,
            )
            safety_margin = np.maximum(safety_margin, 0.01)
            target_positions = np.where(
                finite_limits,
                np.clip(
                    target_positions,
                    self.lower_joint_limits + safety_margin,
                    self.upper_joint_limits - safety_margin,
                ),
                target_positions,
            )

        self.articulation.apply_action(
            self._articulation_action(
                joint_positions=target_positions.astype(np.float64, copy=False),
                joint_indices=self.driven_joint_indices,
            )
        )
        self.world.step(render=False)
        return next_time

    def stop(self) -> None:
        if self.world is None:
            return
        try:
            self.world.stop()
        except Exception:
            return


def open_best_stage_candidate(
    stage_asset_paths: list[Path],
    modules: dict[str, Any],
) -> tuple[Any, Path, dict[str, Any], list[str], float, float, float, float, bool]:
    Usd = modules["Usd"]
    best_result: tuple[Any, Path, dict[str, Any], list[str], float, float, float, float, bool] | None = None
    best_score: tuple[int, int, int] | None = None
    open_failures: list[str] = []

    for stage_asset_path in stage_asset_paths:
        stage = Usd.Stage.Open(str(stage_asset_path.resolve()))
        if stage is None:
            open_failures.append(f"{stage_asset_path.resolve()} (open failed)")
            continue
        try:
            stage.Load()
        except Exception:
            pass

        (
            active_time_code,
            start_time_code,
            end_time_code,
            time_codes_per_second,
            has_animation,
        ) = resolve_initial_time_code(stage)
        stage_manifest, tracked_paths = build_stage_manifest(
            stage=stage,
            stage_path=stage_asset_path,
            active_time_code=active_time_code,
            modules=modules,
            prefer_runtime_pose=False,
        )
        articulation_root_count = len(find_articulation_root_paths(stage, modules))
        emit_log(
            "[stage] candidate "
            f"{stage_asset_path.resolve()} -> "
            f"{articulation_root_count} articulation roots, "
            f"{stage_manifest['geometry_count']} geometry prims, "
            f"{stage_manifest['renderable_count']} renderables, "
            f"{stage_manifest['prim_count']} prims"
        )

        score = (
            int(articulation_root_count > 0),
            int(stage_manifest["renderable_count"]),
            int(stage_manifest["geometry_count"]),
        )
        if best_result is None or best_score is None or score > best_score:
            best_score = score
            best_result = (
                stage,
                stage_asset_path,
                stage_manifest,
                tracked_paths,
                active_time_code,
                start_time_code,
                end_time_code,
                time_codes_per_second,
                has_animation,
            )

    if best_result is not None:
        return best_result

    failure_text = "; ".join(open_failures) if open_failures else "no stage candidates were produced"
    raise RuntimeError(f"Failed to open Isaac stage candidates: {failure_text}")


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

        position, quaternion = compute_runtime_local_pose(prim, modules)
        local_matrix = compute_local_matrix(prim, time_code, Gf, UsdGeom)
        _fallback_position, _fallback_quaternion, scale = matrix_to_pose(local_matrix, Gf)
        if position is None or quaternion is None:
            position = _fallback_position
            quaternion = _fallback_quaternion
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
    parser.add_argument(
        "--asset",
        type=Path,
        required=True,
        help="Path to an Isaac USDA/USD stage or URDF asset.",
    )
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Websocket host.")
    parser.add_argument("--port", type=int, default=8766, help="Websocket port.")
    parser.add_argument("--publish-hz", type=float, default=12.0, help="Frame publish frequency.")
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
    if not args.asset.exists():
        raise FileNotFoundError(f"Isaac asset not found: {args.asset}")

    app = None
    broadcaster: StageBroadcaster | None = None
    articulation_driver: ArticulationSineDriver | None = None

    try:
        emit_log(f"[isaac] starting bridge for {args.asset.resolve()}")
        app, modules = load_isaac_runtime()
        stage_asset_paths = resolve_runtime_stage_assets(app, args.asset)

        (
            stage,
            stage_asset_path,
            stage_manifest,
            tracked_paths,
            active_time_code,
            start_time_code,
            end_time_code,
            time_codes_per_second,
            has_animation,
        ) = open_best_stage_candidate(
            stage_asset_paths=stage_asset_paths,
            modules=modules,
        )
        stage = open_stage_in_runtime_context(app, stage_asset_path, modules)
        (
            active_time_code,
            start_time_code,
            end_time_code,
            time_codes_per_second,
            has_animation,
        ) = resolve_initial_time_code(stage)
        stage_manifest, tracked_paths = build_stage_manifest(
            stage=stage,
            stage_path=stage_asset_path,
            active_time_code=active_time_code,
            modules=modules,
            prefer_runtime_pose=True,
        )
        emit_log(
            "[stage] selected "
            f"{stage_asset_path.resolve()} with "
            f"{stage_manifest['prim_count']} prims "
            f"({stage_manifest['geometry_count']} geometry prims)"
        )
        urdf_visual_source = resolve_urdf_visual_source(args.asset, stage_asset_path)
        if urdf_visual_source is not None:
            synthetic_prims = build_urdf_visual_fallback_prims(
                urdf_path=urdf_visual_source,
                stage_manifest=stage_manifest,
            )
            if synthetic_prims:
                emit_log(
                    "[urdf] supplemented "
                    f"{len(synthetic_prims)} missing visuals from {urdf_visual_source.name}"
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
        physics_dt = min(publish_step, 1.0 / 60.0)
        articulation_driver = ArticulationSineDriver(
            stage=stage,
            stage_asset_path=stage_asset_path,
            modules=modules,
            physics_dt=physics_dt,
        )

        while args.duration <= 0.0 or elapsed < args.duration:
            cycle_started_at = time.perf_counter()
            if articulation_driver.enabled:
                target_sim_time = elapsed + publish_step
                while elapsed + 1e-9 < target_sim_time:
                    active_time_code = articulation_driver.step(elapsed)
                    elapsed = active_time_code
            else:
                app.update()
                elapsed += publish_step

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
            cycle_elapsed = time.perf_counter() - cycle_started_at
            remaining_sleep = publish_step - cycle_elapsed
            if remaining_sleep > 0:
                time.sleep(remaining_sleep)

            if not articulation_driver.enabled:
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
        if articulation_driver is not None:
            articulation_driver.stop()
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
