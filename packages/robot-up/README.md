## Status

This package now includes phase-1 implementation:

- `mujoco` headless simulation
- `websocket` pose broadcast (position + quaternion)
- `vite + react` frontend for real-time visualization

`isaacsim` and `ros` bridges are left for the next phase.

## Layout

- `sim/mujoco_ws_bridge.py`: headless simulation + websocket broadcaster
- `sim/models/free_body.xml`: default MJCF model
- `src/*`: React + three.js viewer
- `pyproject.toml`: Python dependencies managed by `uv`
- `package.json`: frontend dependencies managed by `pnpm`

## Message Schema

Websocket payload (`type = "pose"`):

```json
{
  "type": "pose",
  "source": "mujoco",
  "seq": 1,
  "body": "robot",
  "timestamp": "2026-03-01T07:00:00.000000+00:00",
  "sim_time": 0.0,
  "position": { "x": 0.55, "y": 0.0, "z": 0.4 },
  "quaternion": { "w": 0.98, "x": 0.0, "y": 0.19, "z": 0.0 }
}
```

Quaternion order is `wxyz` in the websocket payload.

For articulated bodies, bridge also pushes `type = "pose_frame"` with per-body
relative transforms under the subtree root:

```json
{
  "type": "pose_frame",
  "body": "link0",
  "body_count": 11,
  "bodies": [
    {
      "id": 12,
      "name": "link7",
      "position": { "x": 0.08, "y": 0.0, "z": 0.91 },
      "quaternion": { "w": 0.99, "x": 0.0, "y": 0.01, "z": 0.0 }
    }
  ]
}
```

Browser can request appearance data once via websocket:

```json
{ "type": "model_request" }
```

Then bridge responds with `type = "model_manifest"`:

```json
{
  "type": "model_manifest",
  "source": "mujoco",
  "body": "robot",
  "model_path": "C:/Projects/PetriPlate/packages/robot-up/sim/models/free_body.xml",
  "model_mtime_ns": 1764512788000000000,
  "mesh_count": 0,
  "geom_count": 2,
  "geoms": [
    {
      "id": 1,
      "name": "geom_1",
      "type": "box",
      "position": { "x": 0, "y": 0, "z": 0 },
      "quaternion": { "w": 1, "x": 0, "y": 0, "z": 0 },
      "size": { "x": 0.18, "y": 0.1, "z": 0.07 },
      "rgba": { "r": 0.25, "g": 0.85, "b": 0.55, "a": 1 }
    }
  ]
}
```

For mesh geoms, `geoms[i].mesh` also includes:

- `url`: browser fetch URL (default uses Vite `/@fs/...` path)
- `format`: `obj` or `stl`
- mesh-local `position`/`quaternion`/`scale`

This keeps mesh files as on-demand pulls, instead of pushing large binary payloads on every pose frame.

`body` now means a subtree root. Manifest includes visual geoms under this body and all descendants.
Each geom entry also contains `body_id` / `body_name`, so frontend can bind geoms to animated body nodes.

## Run

From repo root:

```bash
corepack pnpm install
```

From `packages/robot-up`:

```bash
uv lock
uv sync
uv run python sim/mujoco_ws_bridge.py --host 127.0.0.1 --port 8765
```

When streamed body has no freejoint but model has actuators, bridge auto-drives
actuators for demo motion. Disable it with:

```bash
uv run python sim/mujoco_ws_bridge.py --disable-demo-drive
```

Franka Panda appearance sync test:

```bash
uv run python sim/mujoco_ws_bridge.py \
  --model third_party/mujoco_menagerie/franka_emika_panda/scene.xml \
  --body-name link0
```

or:

```bash
corepack pnpm --filter @petriplate/robot sim:mujoco:panda
```

Start frontend in another terminal:

```bash
corepack pnpm --filter @petriplate/robot dev
```

Then open `http://localhost:5173`.

## Next

- Add `isaacsim` headless source
- Add `ros` publisher/subscriber bridge

## Open-Source Arm Demo

Model source: MuJoCo Menagerie `franka_emika_panda` (Apache-2.0), commit
`a03e87bf13502b0b48ebbf2808928fd96ebf9cf3`.

Asset path in this repo:

- `third_party/mujoco_menagerie/franka_emika_panda`

Run the demo and export GIF:

```bash
uv run python sim/run_open_source_arm_demo.py
```

or:

```bash
corepack pnpm --filter @petriplate/robot sim:arm-demo
```

Output files:

- `outputs/panda_demo.gif`
- `outputs/panda_hand_pose.csv`
