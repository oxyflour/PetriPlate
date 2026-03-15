#!/usr/bin/env python3
from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np


PLY_DTYPES = {
    "char": "i1",
    "uchar": "u1",
    "short": "i2",
    "ushort": "u2",
    "int": "i4",
    "uint": "u4",
    "float": "f4",
    "double": "f8",
}

CONNECTIVITY_RADIUS = 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter a Gaussian Splatting PLY by keeping the largest object cluster."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--mode", choices=("object",), default="object")
    parser.add_argument(
        "--min-alpha",
        type=float,
        default=0.01,
        help="Minimum sigmoid(opacity) to consider a gaussian part of the object.",
    )
    parser.add_argument(
        "--max-scale",
        type=float,
        default=0.0,
        help="Optional max exp(scale_*) threshold. 0 disables this filter.",
    )
    parser.add_argument(
        "--voxel-size",
        type=float,
        default=0.0,
        help="Voxel size for connectivity. 0 enables an automatic size based on the robust bounding box.",
    )
    parser.add_argument(
        "--min-voxel-points",
        type=int,
        default=2,
        help="Ignore occupied voxels with fewer points than this threshold.",
    )
    parser.add_argument(
        "--min-keep-points",
        type=int,
        default=1024,
        help="Fail instead of over-filtering if fewer points than this remain.",
    )
    return parser.parse_args()


def read_binary_ply(path: Path) -> tuple[list[bytes], np.ndarray]:
    with path.open("rb") as handle:
        header_lines: list[bytes] = []
        vertex_count: int | None = None
        properties: list[tuple[str, str]] = []
        format_name: str | None = None

        while True:
            line = handle.readline()
            if not line:
                raise ValueError(f"{path} ended before end_header")
            header_lines.append(line)

            text = line.decode("ascii").strip()
            if text.startswith("format "):
                _, format_name, _version = text.split()
            elif text.startswith("element vertex "):
                vertex_count = int(text.split()[-1])
            elif text.startswith("property list "):
                raise ValueError("list properties are not supported")
            elif text.startswith("property "):
                _, kind, name = text.split()
                if kind not in PLY_DTYPES:
                    raise ValueError(f"unsupported PLY property type: {kind}")
                properties.append((name, PLY_DTYPES[kind]))
            elif text == "end_header":
                break

        if format_name != "binary_little_endian":
            raise ValueError(f"unsupported PLY format: {format_name}")
        if vertex_count is None:
            raise ValueError("vertex count is missing from the PLY header")

        dtype = np.dtype([(name, "<" + kind) for name, kind in properties])
        data = np.fromfile(handle, dtype=dtype, count=vertex_count)
        if data.shape[0] != vertex_count:
            raise ValueError(
                f"expected {vertex_count} vertices, found {data.shape[0]} in {path}"
            )
        return header_lines, data


def write_binary_ply(path: Path, header_lines: list[bytes], data: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    updated_header: list[bytes] = []
    for line in header_lines:
        if line.startswith(b"element vertex "):
            updated_header.append(f"element vertex {data.shape[0]}\n".encode("ascii"))
        else:
            updated_header.append(line)

    with path.open("wb") as handle:
        for line in updated_header:
            handle.write(line)
        data.tofile(handle)


def sigmoid(values: np.ndarray) -> np.ndarray:
    clamped = np.clip(values, -60.0, 60.0)
    return 1.0 / (1.0 + np.exp(-clamped))


def auto_voxel_size(points: np.ndarray) -> float:
    if points.shape[0] < 2:
        return 0.1

    low = np.quantile(points, 0.01, axis=0)
    high = np.quantile(points, 0.99, axis=0)
    diagonal = float(np.linalg.norm(high - low))
    if not np.isfinite(diagonal) or diagonal <= 0.0:
        return 0.1
    return float(np.clip(diagonal * 0.005, 0.02, 0.25))


def largest_component_mask(
    points: np.ndarray, voxel_size: float, min_voxel_points: int
) -> tuple[np.ndarray, int]:
    voxel_coords = np.floor(points / voxel_size).astype(np.int32)
    unique_voxels, inverse, counts = np.unique(
        voxel_coords, axis=0, return_inverse=True, return_counts=True
    )
    valid_indices = np.flatnonzero(counts >= min_voxel_points)
    if valid_indices.size == 0:
        return np.zeros(points.shape[0], dtype=bool), 0

    voxel_lookup = {tuple(unique_voxels[index]): int(index) for index in valid_indices}
    visited: set[int] = set()
    best_component: list[int] = []
    best_component_points = 0
    # A slightly wider neighborhood bridges small holes inside the main object
    # cluster without requiring an overly large voxel size.
    neighbor_offsets = [
        (dx, dy, dz)
        for dx in range(-CONNECTIVITY_RADIUS, CONNECTIVITY_RADIUS + 1)
        for dy in range(-CONNECTIVITY_RADIUS, CONNECTIVITY_RADIUS + 1)
        for dz in range(-CONNECTIVITY_RADIUS, CONNECTIVITY_RADIUS + 1)
    ]

    for start_index in valid_indices:
        if int(start_index) in visited:
            continue

        queue = deque([int(start_index)])
        visited.add(int(start_index))
        component: list[int] = []
        component_points = 0

        while queue:
            current_index = queue.popleft()
            component.append(current_index)
            component_points += int(counts[current_index])

            current_voxel = unique_voxels[current_index]
            for dx, dy, dz in neighbor_offsets:
                neighbor = (
                    int(current_voxel[0] + dx),
                    int(current_voxel[1] + dy),
                    int(current_voxel[2] + dz),
                )
                neighbor_index = voxel_lookup.get(neighbor)
                if neighbor_index is None or neighbor_index in visited:
                    continue
                visited.add(neighbor_index)
                queue.append(neighbor_index)

        if component_points > best_component_points:
            best_component = component
            best_component_points = component_points

    keep_unique = np.zeros(unique_voxels.shape[0], dtype=bool)
    keep_unique[np.asarray(best_component, dtype=np.int32)] = True
    return keep_unique[inverse], best_component_points


def build_object_mask(
    data: np.ndarray,
    min_alpha: float,
    max_scale: float,
    voxel_size: float,
    min_voxel_points: int,
) -> tuple[np.ndarray, float, int, int]:
    required = {"x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2"}
    missing = required.difference(data.dtype.names or ())
    if missing:
        raise ValueError(f"missing required PLY properties: {', '.join(sorted(missing))}")

    alpha = sigmoid(data["opacity"].astype(np.float64))
    candidate_mask = alpha >= min_alpha

    if max_scale > 0.0:
        scale_logs = np.stack(
            [data["scale_0"], data["scale_1"], data["scale_2"]], axis=1
        ).astype(np.float64)
        max_scales = np.exp(np.clip(scale_logs.max(axis=1), -20.0, 20.0))
        candidate_mask &= max_scales <= max_scale

    candidate_indices = np.flatnonzero(candidate_mask)
    if candidate_indices.size == 0:
        raise ValueError("cleanup removed all candidates before clustering")

    candidate_points = np.stack(
        [data["x"][candidate_indices], data["y"][candidate_indices], data["z"][candidate_indices]],
        axis=1,
    ).astype(np.float64)

    resolved_voxel_size = voxel_size if voxel_size > 0.0 else auto_voxel_size(candidate_points)
    component_mask, kept_points = largest_component_mask(
        candidate_points, resolved_voxel_size, min_voxel_points
    )
    if kept_points == 0:
        raise ValueError("no connected component survived cleanup")

    keep_indices = candidate_indices[component_mask]
    keep_mask = np.zeros(data.shape[0], dtype=bool)
    keep_mask[keep_indices] = True
    return keep_mask, resolved_voxel_size, candidate_indices.size, kept_points


def main() -> int:
    args = parse_args()
    header_lines, data = read_binary_ply(args.input)

    if args.mode != "object":
        raise ValueError(f"unsupported cleanup mode: {args.mode}")

    keep_mask, resolved_voxel_size, candidate_count, kept_count = build_object_mask(
        data,
        min_alpha=args.min_alpha,
        max_scale=args.max_scale,
        voxel_size=args.voxel_size,
        min_voxel_points=args.min_voxel_points,
    )

    if kept_count < args.min_keep_points:
        raise ValueError(
            f"cleanup kept only {kept_count} points, below the safety threshold {args.min_keep_points}"
        )

    filtered = data[keep_mask]
    write_binary_ply(args.output, header_lines, filtered)

    print(
        "cleanup "
        f"mode={args.mode} "
        f"input={data.shape[0]} "
        f"candidates={candidate_count} "
        f"kept={filtered.shape[0]} "
        f"voxel_size={resolved_voxel_size:.6f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
