需求
- 写一个 nextjs app，作为一个 mujoco / isaacsim 可视化前端
- 根据用户提供的资产类型确认仿真器，用户可能上传 zip。如果用户上传文件包含 mujoco xml 就启动 mujuco，如果用户上传 usda 就启动 isaacsim

建议实现步骤（与我讨论确认）
- 用 threejs / babylonjs 作为渲染器
- 先实现 mujoco
- 自己去网络上获取开源资产
