上传 `tmp/franka-official-flat.zip` 打开之后视图是全黑，解决这个问题

## 结论

- 已修复。
- 黑屏不是单一问题，实际叠了 3 层：
  - `isaac-stage-preview.tsx` 里写死了 `Fog(10, 30)`，而官方 Franka stage 的 `metersPerUnit = 0.01`，相机 fit 之后距离大约在 `95~107` stage units，整台机器人会被雾完全吞掉，看起来就是纯黑。
  - `isaac_stage_bridge.py` 生成首个 `stage_manifest` 时只读 authored xform，官方 Franka articulation 的 link 在 manifest 里全是单位变换，导致前端初始层级和取景都不可靠。
  - 前端只在 manifest 阶段做一次 `fitCamera()`，即使后续 websocket frame 把 link pose 更新正确，也不会重新取景。

## 已做修改

- `packages/robot-up/src/components/isaac-stage-preview.tsx`
  - 去掉固定 fog，避免大尺寸 / 小单位 USD 被整体雾化成黑屏。
  - 在首个 live `stage_frame` 到达后补一次 `fitCamera()`，让 articulation / animated stage 用实时姿态重新取景。
- `packages/robot-up/sim/isaac_stage_bridge.py`
  - 新增 runtime local pose 读取逻辑，在 runtime context 中构建 `stage_manifest` 时优先使用 `get_local_pose()`。
  - `stage_frame` 也复用同一套 pose 读取逻辑，减少 manifest / frame 的姿态来源偏差。
  - stage candidate 预选阶段仍然保留静态 authored transform，避免在 runtime context 外误读 pose。

## 验证

- 重新抓取官方 Franka 的 websocket manifest 后，`/FrankaPreview/panda_link1` 到 `/panda_link7`、`panda_hand`、`panda_leftfinger`、`panda_rightfinger` 等 prim 已在首个 manifest 中带有非单位姿态。
- 复现时 fit 后的相机距离约为 `107` stage units，已经明确超过旧 fog 的 `far = 30`，和黑屏现象一致。
- 已通过：
  - `npx pnpm --filter @petriplate/robot-up2 typecheck`
  - `uv run python -m py_compile sim/isaac_stage_bridge.py`
