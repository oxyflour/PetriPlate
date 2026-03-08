需求
- 加载 xml 之后，在后台启动 mujoco 仿真进程。需要从 mujoco 同步仿真状态

建议（细化后与我讨论确认）
- 控制 mujoco 进程的生命周期，页面刷新后记得清理进程。
- 使用 websocket 或者 stdio 进行双向通讯

细化方案

目标
- 选中 MuJoCo XML 之后，不再只做浏览器内静态预览，而是由 `robot-up2` 服务端创建一个 MuJoCo session。
- session 负责把资产落盘、启动 Python MuJoCo bridge、把实时仿真状态同步回前端。
- 前端基于实时 `pose_frame` 驱动模型，而不是只渲染一次解析结果。

范围
- 本阶段只实现 MuJoCo。
- Isaac Sim 仍然保留当前占位分支，不进入本 task。
- 通信优先使用 websocket。`stdio` 可以作为 Node 和 Python 之间的内部备选，但浏览器侧仍以 websocket 为主。

建议实现

1. 服务端 session 管理
- 新增一个 session manager，维护 `sessionId -> { pid, port, workdir, createdAt, lastSeenAt }`。
- 每次加载新的 XML，都创建新的 session。
- 同一个页面切换模型时，先销毁旧 session，再启动新 session。
- session 需要支持显式销毁和超时回收，避免页面异常关闭后留下孤儿进程。

2. 资产上传与落盘
- 当前 `robot-up2` 的上传解析在浏览器内完成，只适合静态预览；MuJoCo 后台进程不能直接读取浏览器里的 `Blob` / `objectUrl`。
- 因此需要把用户上传的 XML / zip 发给 Next.js 服务端，并解压到 session 临时目录。
- zip 中的相对路径需要完整保留，这样 MuJoCo 才能正确解析 `<include file="...">` 和 mesh 引用。
- 建议工作目录为 `packages/robot-up2/.runtime/sessions/<sessionId>/`。

3. Python MuJoCo bridge
- 直接 fork `packages/robot-up/sim/mujoco_ws_bridge.py` 的设计到 `robot-up2/sim/`，不要从零重新定义协议。
- `robot-up2` 自己增加 `pyproject.toml` 和 `uv.lock`，通过 `uv` 管理 Python 依赖。
- bridge 进程启动参数至少包含：
  - `--model <absolute xml path>`
  - `--host 127.0.0.1`
  - `--port <dynamic port>`
  - `--asset-url-prefix /api/mujoco/sessions/<sessionId>/assets`

4. 实时状态同步
- 浏览器连接 bridge 暴露的 websocket 地址。
- 前端建立连接后先发送 `{"type":"model_request"}`，拿到 `model_manifest`。
- 后续持续接收 `pose` / `pose_frame`，驱动 three.js 中 body transform 更新。
- 若后面需要浏览器控制仿真，再补充客户端到 bridge 的控制消息，例如：
  - `{"type":"simulation_control","action":"pause"}`
  - `{"type":"simulation_control","action":"resume"}`
  - `{"type":"simulation_control","action":"reset"}`

5. 生命周期与清理
- 页面加载 MuJoCo session 后，前端每隔 10 到 15 秒向服务端发送 heartbeat。
- 页面刷新、切换资产、组件卸载时，前端主动调用 session delete。
- 服务端增加定时 sweep，清理超过 TTL 且没有 heartbeat 的 session。
- 进程退出时需要同时清理：
  - Python 子进程
  - websocket 端口占用
  - session 临时目录

6. 前端改造
- 当前 `MujocoPreview` 只接收静态 `scene`，后面要扩展为：
  - 先根据 `model_manifest` 构建渲染树
  - 再根据 `pose_frame` 更新 body 节点变换
- 现有浏览器内 MJCF 解析可以保留，作为：
  - 上传后 session 启动前的本地预检
  - Python bridge 启动失败时的降级静态预览

建议接口

POST `/api/mujoco/sessions`
- 作用：创建新 session，上传并落盘资产，启动 MuJoCo bridge。
- 请求：
  - `multipart/form-data`
  - `file`: 用户上传的 xml / zip
  - `entryPath`: 可选，zip 中选中的 MuJoCo 入口 XML
- 返回：
  - `sessionId`
  - `wsUrl`
  - `assetBaseUrl`
  - `selectedEntryPath`
  - `expiresAt`

POST `/api/mujoco/sessions/:id/heartbeat`
- 作用：续期当前 session。
- 返回：
  - `ok: true`
  - `expiresAt`

DELETE `/api/mujoco/sessions/:id`
- 作用：主动销毁 session。

GET `/api/mujoco/sessions/:id/assets/[...path]`
- 作用：提供 mesh / 纹理等静态资产访问路径，供 `model_manifest` 中的资源 URL 使用。

验收标准
- 上传单个 MuJoCo XML 后，服务端成功启动 MuJoCo 进程，并返回可连接的 websocket 地址。
- 上传包含多个 XML 的 zip 后，可以按选中的 `entryPath` 启动正确的场景。
- 前端能从 websocket 收到 `model_manifest` 和持续的 `pose_frame`，场景有实时动画。
- 页面刷新或关闭后，旧 session 会在主动 delete 或 TTL 到期后被清理，不残留进程。
- 切换到另一个 MuJoCo 资产时，旧 session 被销毁，新 session 正常创建。
- bridge 启动失败时，前端能显示错误，并回退到当前静态 MJCF 预览。

实现备注
- 由于 Next.js route handler 不适合直接承载 websocket upgrade，本方案更简单的做法是：
  - Python bridge 自己监听一个本地随机端口。
  - Next.js 只负责创建 session 和返回 `wsUrl`。
- 这样浏览器会直接连 Python websocket，Node 只负责生命周期管理和静态资产代理。
