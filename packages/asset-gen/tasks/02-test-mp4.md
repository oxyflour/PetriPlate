## 目标

用 `packages\asset-gen\data\VID_20260315_110639.mp4` 这个文件测试，沿着功能可以生成 `ply`。

## 结果

- 2026-03-15 已验证通过
- 产物输出目录：`packages/asset-gen/output/02-test-mp4-run4`
- 关键产物：
  - `packages/asset-gen/output/02-test-mp4-run4/point_cloud.ply`
  - `packages/asset-gen/output/02-test-mp4-run4/cameras.json`
  - `packages/asset-gen/output/02-test-mp4-run4/model/point_cloud/iteration_50/point_cloud.ply`

## 复现命令

```powershell
docker run --rm --gpus all `
  -e FRAME_FPS=5 `
  -e MAX_FRAMES=54 `
  -e TRAIN_ITERS=3000 `
  -e RESIZE_IMAGES=0 `
  -e KEEP_WORKDIR=1 `
  -e WORK_ROOT=/output/_work `
  -v "C:\Projects\PetriPlate\packages\asset-gen\data:/input" `
  -v "C:\Projects\PetriPlate\packages\asset-gen\output\02-test-mp4-run4:/output" `
  petri-asset-gen /input/VID_20260315_110639.mp4 /output
```

## 这次补的兼容性修复

- headless 容器里默认让 COLMAP 自动回退到 CPU，避免 Qt / OpenGL 上下文初始化失败
- 抽帧时强制输出 8-bit RGB PNG，避免手机 HDR / 10-bit 视频生成的 16-bit PNG 被 COLMAP 拒绝读取
