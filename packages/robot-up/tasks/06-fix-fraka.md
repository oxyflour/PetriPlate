找一下有没有开源的 fraka arm 的 usd/usda 资源测试一下 isaacsim 前端显示，通过 urdf 转换的似乎缺少一些信息

## 进展
- 已确认 Isaac Sim 官方 Franka 资产路径来自 `isaacsim.robot.manipulators.examples`：
  `https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd`
- 本机 `get_assets_root_path()` 返回的也是同一个公开 S3 根：
  `https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1`
- 用一个本地 wrapper USDA 引用上面的 `franka.usd` 后，`isaac_stage_bridge.py` 已验证可正常打开并驱动前 3 个关节：
  - `selected ... official-franka-wrapper.usda with 376 prims (11 geometry prims)`
  - `driving /FrankaPreview joints: panda_joint1, panda_joint2, panda_joint3`

## 当前结论
- `tmp/cogimon-gazebo-models-master/franka/model.imported.usda` 可以打开并驱动 articulation，但 Isaac 日志里有 unresolved reference 警告，转换产物并不干净。
- 原始 `model.urdf` 里缺失的 link（例如 `world`、`panda_link8`）本身没有 visual，所以单靠 URDF fallback 不能补齐所有显示差异。
- 现在更适合直接用官方 Franka USD 作为前端显示基准，而不是继续把验证建立在这份 URDF 转换产物上。

## 已产出测试包
- 本地扁平化 stage：
  `tmp/official-franka-package/franka-official-flat.usda`
- 可直接上传测试的 zip：
  `tmp/franka-official-flat.zip`
- zip 内文件：
  - `franka-official-flat.usda`
  - `SOURCE.txt`
