from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

import mujoco
import numpy as np
from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run an open-source Franka Panda model from MuJoCo Menagerie and export a GIF."
        )
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "third_party"
        / "mujoco_menagerie"
        / "franka_emika_panda"
        / "scene.xml",
        help="Path to MJCF scene XML.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=6.0,
        help="Simulation duration in seconds.",
    )
    parser.add_argument(
        "--sim-hz",
        type=float,
        default=240.0,
        help="Simulation stepping frequency.",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=30,
        help="Rendered frames per second.",
    )
    parser.add_argument("--width", type=int, default=640, help="Render width.")
    parser.add_argument("--height", type=int, default=480, help="Render height.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "outputs" / "panda_demo.gif",
        help="Output GIF path.",
    )
    parser.add_argument(
        "--pose-csv",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "outputs" / "panda_hand_pose.csv",
        help="Output CSV for end-effector pose.",
    )
    return parser.parse_args()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def find_body_id(model: mujoco.MjModel, names: list[str]) -> int:
    for name in names:
        body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, name)
        if body_id >= 0:
            return int(body_id)
    raise ValueError(f"None of the bodies exists in model: {names}")


def main() -> None:
    args = parse_args()
    if not args.model.exists():
        raise FileNotFoundError(f"Model not found: {args.model}")

    ensure_parent(args.output)
    ensure_parent(args.pose_csv)

    model = mujoco.MjModel.from_xml_path(str(args.model))
    data = mujoco.MjData(model)

    max_width = int(model.vis.global_.offwidth)
    max_height = int(model.vis.global_.offheight)
    render_width = min(int(args.width), max_width)
    render_height = min(int(args.height), max_height)
    if render_width != args.width or render_height != args.height:
        print(
            f"[demo] clamp render size to offscreen framebuffer: "
            f"{render_width}x{render_height} (model max {max_width}x{max_height})"
        )

    key_home = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "home")
    if key_home >= 0:
        mujoco.mj_resetDataKeyframe(model, data, key_home)
    else:
        mujoco.mj_resetData(model, data)

    arm_actuators = [
        int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, f"actuator{i}"))
        for i in range(1, 8)
    ]
    if any(idx < 0 for idx in arm_actuators):
        raise ValueError("Could not locate panda arm actuators actuator1..actuator7")

    gripper_actuator = int(
        mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, "actuator8")
    )
    hand_body = find_body_id(model, ["hand", "link7"])

    base_ctrl = np.array(data.ctrl, copy=True)
    renderer = mujoco.Renderer(model, height=render_height, width=render_width)

    sim_dt = 1.0 / args.sim_hz
    frame_dt = 1.0 / args.fps
    total_steps = int(args.duration * args.sim_hz)
    frame_every = max(1, int(args.sim_hz / args.fps))

    phase = np.array([0.0, 0.4, 0.8, 1.2, 1.5, 1.9, 2.2], dtype=float)
    amp = np.array([0.35, 0.30, 0.35, 0.30, 0.25, 0.30, 0.20], dtype=float)
    freq = np.array([0.6, 0.55, 0.7, 0.5, 0.65, 0.6, 0.75], dtype=float)

    frames: list[Image.Image] = []
    pose_rows: list[list[float]] = []

    for step in range(total_steps):
        t = step * sim_dt
        offsets = amp * np.sin(2 * math.pi * freq * t + phase)

        for i, actuator_id in enumerate(arm_actuators):
            low, high = model.actuator_ctrlrange[actuator_id]
            target = float(base_ctrl[actuator_id] + offsets[i])
            data.ctrl[actuator_id] = clamp(target, float(low), float(high))

        if gripper_actuator >= 0:
            low, high = model.actuator_ctrlrange[gripper_actuator]
            target = 140.0 + 80.0 * (0.5 + 0.5 * math.sin(2 * math.pi * 0.25 * t))
            data.ctrl[gripper_actuator] = clamp(float(target), float(low), float(high))

        mujoco.mj_step(model, data)

        if step % frame_every == 0:
            renderer.update_scene(data)
            frame = renderer.render()
            frames.append(Image.fromarray(frame))

            pos = data.xpos[hand_body]
            quat = data.xquat[hand_body]
            pose_rows.append(
                [
                    float(data.time),
                    float(pos[0]),
                    float(pos[1]),
                    float(pos[2]),
                    float(quat[0]),
                    float(quat[1]),
                    float(quat[2]),
                    float(quat[3]),
                ]
            )

    if not frames:
        raise RuntimeError("No frames were rendered.")

    gif_ms = max(1, int(round(frame_dt * 1000)))
    frames[0].save(
        args.output,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=gif_ms,
        loop=0,
    )

    with args.pose_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["sim_time", "px", "py", "pz", "qw", "qx", "qy", "qz"]
        )
        writer.writerows(pose_rows)

    last = pose_rows[-1]
    print(f"[demo] source model: {args.model}")
    print(f"[demo] rendered frames: {len(frames)}")
    print(f"[demo] gif: {args.output}")
    print(f"[demo] pose csv: {args.pose_csv}")
    print(
        "[demo] last hand pose: "
        f"p=({last[1]:.3f}, {last[2]:.3f}, {last[3]:.3f}) "
        f"q=({last[4]:.3f}, {last[5]:.3f}, {last[6]:.3f}, {last[7]:.3f})"
    )


if __name__ == "__main__":
    main()
