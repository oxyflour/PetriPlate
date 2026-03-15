生成的 3dgs 有两个用途：
1. 沿着一个静态物体环绕拍摄，生成单个物体的 gs
2. 绕着一个静态场景拍摄，生成场景 gs

在测试 1 的时候静态物体周围有很多散点，怎么优化

## 处理方案

- 对单物体模式增加训练后清理，不改动默认场景模式。
- 清理规则：
  - 先按 `sigmoid(opacity)` 过滤明显接近透明的高斯
  - 再把剩余高斯体素化，只保留最大的连通主团簇
- 这样可以把单物体环拍时飘在主体外面的散点去掉，同时避免影响场景扫描用途

## 用法

```powershell
docker run --rm --gpus all `
  -e CLEANUP_MODE=object `
  -e CLEANUP_MIN_ALPHA=0.01 `
  -e CLEANUP_VOXEL_SIZE=0 `
  -e CLEANUP_MIN_VOXEL_POINTS=2 `
  -v "C:\Projects\PetriPlate\packages\asset-gen\data:/input" `
  -v "C:\Projects\PetriPlate\packages\asset-gen\output\03-cleanup-run1:/output" `
  petri-asset-gen /input/VID_20260315_110639.mp4 /output
```

## 当前验证

- 2026-03-15 已在 `packages/asset-gen/output/02-test-mp4-run4/point_cloud.ply` 上离线验证清理脚本
- 默认参数验证结果：
  - 输入顶点数：`34846`
  - 输出顶点数：`25179`
  - 原始包围盒：`[-26.39, -16.77, -15.05] -> [25.52, 12.99, 42.37]`
  - 清理后包围盒：`[-3.94, -1.10, 2.23] -> [2.54, 5.45, 5.26]`
- 清理后会输出：
  - `point_cloud.ply`: 清理后的结果
  - `point_cloud.raw.ply`: 清理前的最新原始结果
- 该模式只建议用于“环绕单个静态物体拍摄”的数据；场景扫描默认不要开启
