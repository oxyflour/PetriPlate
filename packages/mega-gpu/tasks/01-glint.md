0. 范围、约束与当前基线

这份计划只服务一个输入前提：

- 唯一输入是 `height field`
- 当前阶段的高度场来源是程序化 `height(p)` WGSL 代码

当前代码基线已经有这些能力：

- 平面金属板 + HDR IBL 渲染
- 相机轨道控制
- 基于高度函数的 slope moments 预计算
- footprint 估计
- 用 footprint-filtered slope moments 映射出 roughness / anisotropy，再走各向异性 GGX

也就是说，当前系统已经有一个“宏观近似”的可运行版本，但还没有真正的 `slope histogram glints`。这份文档的目标不是另起炉灶，而是在当前实现上演进出真正的 glint 路线。

1. 最终目标重新钉死

第一阶段交付不是“理论最完整”，而是一个 `height-only` 的可运行 glint demo：

- 输入程序化 `height field`
- 由 `height -> slope`
- 构建多尺度 `slope histogram`
- 在渲染阶段基于 `slope-space` 评估 glints
- 支持 HDR environment lighting
- 相机移动时结果基本稳定
- 有足够的 debug 视图能定位问题

第二阶段目标：

- importance sampling + MIS
- temporal accumulation
- 邻近 tile / 跨 mip 混合
- 更好的 masking / shadowing
- 局部各向异性

第三阶段目标：

- 超大 heightfield
- height tile streaming / cache
- 周期性 / 准周期性结构专门优化
- 可选 neural / FFT acceleration

2. 版本路线

不要直接从当前代码跳到完整 glint renderer，按 4 个版本推进。

Baseline：当前已存在

- 输入 `height(p)`
- 通过 SAT 预计算 slope moments
- 按 footprint 聚合得到 mean slope / variance
- 映射到各向异性 GGX 参数
- 已经能跑 HDRI 和基础 debug 视图

这个版本不要删，保留成：

- 对照基线
- 性能基线
- fallback shading path

v0：直方图闭环验证

目标是证明 `height -> slope -> histogram -> glint lookup` 这条链路跑通。

只做：

- 程序化 `height field` 输入
- `height -> slope` compute pass
- level 0 tile histogram
- 单 tile、单 mip 查询
- 单方向 light 下的 glint density 评估
- 关键 debug 视图

先不做：

- HDRI importance sampling
- MIS
- temporal accumulation
- streaming

验收标准：

- slope 可视化正确
- histogram heatmap 和高度场特征一致
- 改 light / camera 时响应方向正确
- 能看到 glint 密度跟 slope 分布联动

v1：可用 glint 版本

在 v0 基础上加入：

- histogram mip pyramid
- histogram PDF / CDF
- 每像素采样若干 slope bins
- HDR environment lighting
- env sampling + slope sampling 的 MIS
- 简化版 temporal accumulation

验收标准：

- 近处能看到 sparkles
- 远处收敛成更连续的 highlight
- HDRI 下比当前 SAT/GGX 路线更接近“闪”
- camera move 时闪烁可控

v2：高度场工程化版本

加入：

- height 分块
- tile streaming / cache
- only update changed tiles
- 异步 compute
- 周期结构 special handling

验收标准：

- 能跑真实尺寸的高度场
- 显存占用受控
- 统计结果和视觉结果都稳定

v3：结构先验增强版本

作为扩展方向预留：

- anisotropic slope domain
- position-normal joint moments
- per-tile FFT descriptor
- neural / FNO acceleration

3. 当前实现到目标实现的关系

当前代码不是废的，应该按下面的关系演进：

- 现有 SAT slope moments 路线继续保留，作为 `macro shading baseline`
- 新的 histogram 路线作为 `glint shading path`
- 二者共享：
  - `height(p)` 输入
  - plate / camera / footprint 逻辑
  - HDR 环境贴图加载
  - 调试框架

建议在实现上把渲染模式显式分成两条：

- `macro`: 现有 SAT moments -> anisotropic GGX
- `glint`: histogram / CDF / sampling -> glint estimator

这样可以直接做 A/B 对照，不会在替换过程中把已有结果搞没。

4. 总体架构

建议把系统分成 6 层。

A. Height Source Layer

输入只允许：

- procedural `height(p)` WGSL

输出：

- 统一的 height sampling 接口
- 物理单位信息：`mm per texel`、plate size、tile size

B. Preprocess Layer

WebGPU compute shader 负责：

- `height -> slope`
- per-tile histogram build
- histogram normalize / compact
- histogram mip pyramid
- 可选 CDF build

C. Shading Core

渲染阶段负责：

- 计算像素 footprint
- 选 tile / LoD
- 查询 histogram
- 计算 target slope
- importance sample slope bins
- 估计 glint contribution

D. Lighting Layer

负责：

- HDRI sampling
- directional light
- env sampling
- MIS

E. Stability Layer

负责：

- blue noise / scrambling
- tile / mip blending
- temporal accumulation
- LOD hysteresis

F. Debug Layer

必须提供：

- slope 可视化
- histogram heatmap
- target slope marker
- sampled bins overlay
- PDF / CDF 可视化
- mip / LoD heatmap
- temporal variance heatmap

5. 数据表示设计

这是第一优先级，需要在实现前定死。

5.1 高度场单位

统一约定：

- `p = (x, y)` 的单位是毫米
- `height(p)` 返回值单位也是毫米
- `slope = (dh/dx, dh/dy)` 是无量纲

这点必须严格执行，否则 footprint、slope domain、sampling 全会错。

5.2 slope map

由 height 转成：

- `p = ∂h / ∂x`
- `q = ∂h / ∂y`

建议存储：

- `rg16float` 存 `(p, q)`

只有在调试证明范围不够时才升级到：

- `rg32float`

第一版建议保留：

- 一个 `slopeScale` uniform
- 一个 `sMax` 参数用于 bin 映射

5.3 tile 划分

第一版固定：

- `tile = 16 x 16` slope texels

原因：

- 足够细，能先看出 glints 行为
- 资源规模可控
- workgroup 设计更直接

后续再考虑：

- `32 x 32` tile
- 稀疏 tile
- 按视角自适应 tile

5.4 histogram 分辨率

第一版固定：

- `16 x 16` bins

升级路径：

- `32 x 32` bins

不建议第一版直接做：

- `64 x 64` bins

原因很简单：WebGPU 下内存、带宽、构建开销都会明显上升，而且第一阶段的主要风险并不在这里。

5.5 slope domain

每个 tile 的 histogram 统计范围固定到：

- `p, q in [-sMax, sMax]`

第一版建议：

- `sMax = 4.0`

超出范围的处理：

- 先 `clamp`
- 同时额外记录 `overflowCount`

这样你能在 debug 里判断是 domain 选太小，还是确实有少量异常坡度。

5.6 histogram 的构建格式和采样格式必须分开

这里不要混。

构建阶段：

- 用 `u32` counts
- 放在 `storage buffer`

原因：

- compute 写入直接
- shared memory + atomic 好做
- prefix / normalize 更明确

采样阶段：

- 转成归一化后的 `f16` mass
- 再单独生成 `f16` CDF 或压缩 CDF

建议的资源分层：

- `histCountBuffer`: 原始计数，`u32`
- `histPdfBuffer`: 归一化质量，`f16`
- `histCdfBuffer`: 采样用 CDF，`f16`

不要直接拿 build buffer 去着色采样。

5.7 PDF 的语义要先定死

渲染时除以 `pdf`，所以这里必须先约定清楚：

- `histPdfBuffer` 存的是每个 bin 的 probability mass，不是连续密度
- bin 内 jitter 时，连续 slope pdf = `binMass / binArea`
- 如果后面做 MIS，所有采样分支都用连续 pdf 对齐

否则你会在 `pdf` 单位上反复返工。

5.8 mip hierarchy

每个 mip level 存：

- 合并后的 histogram mass
- 可选调试统计：均值 / 二阶矩 / overflow

结构：

- level 0：per-tile
- level 1：merge 2x2
- level 2：merge 4x4
- ...

第一版只保留必要 mip，不要默认铺满所有层。

6. 资源布局

建议分成 4 类资源。

输入资源：

- procedural height shader parameters
- 后续扩展的 height tile texture
- `envMap`
- `blueNoiseTex`

预处理资源：

- `slopeTex`
- `histCountBuffer`
- `histPdfBuffer`
- `histMipPdfBuffer`
- `histCdfBuffer`

渲染输出资源：

- `radianceTex`
- `debugTex`

历史资源：

- `historyRadianceTex`
- `historyMomentsTex` 或 `historyWeightTex`
- `prevFrameUniforms`

7. Temporal 的契约先写清楚

当前场景是平面，不是一般 mesh，所以 temporal 可以先做一个简化版：

- 当前像素先求出 plate 上的 world position
- 用上一帧相机参数把该 world position 投到上一帧屏幕
- 从 history 里取值做 accumulation

这意味着第一版 temporal 至少要有：

- 上一帧相机参数
- history color
- history weight / confidence
- 当前帧 world position 或可重建 world position 的能力

平面 demo 阶段先不需要 motion vector buffer。

但一旦扩展到一般 mesh，就必须换成：

- per-pixel motion vectors
- depth / disocclusion handling

8. 预处理 Pass 设计

Pass A：height -> slope

输入：

- `height field`

输出：

- `slopeTex`

方法：

- 中心差分
- 边界先做 `clamp`

注意：

- 必须用真实 `mm spacing`
- 不能把 `texel delta = 1` 当成物理距离

Pass B：tile histogram build

输入：

- `slopeTex`

输出：

- `histCountBuffer(level0)`

设计：

- 每个 workgroup 负责一个 tile
- shared memory 中先统计
- 再一次性写回 global buffer

Pass C：count -> pdf normalize

输入：

- `histCountBuffer`

输出：

- `histPdfBuffer`
- `overflow/debug metadata`

这里顺手做：

- tile sample count
- empty tile 标记

Pass D：histogram mip build

输入：

- 上一层 `histPdf`

输出：

- 下一层 `histPdf`

合并方式：

- 2x2 tile merge

Pass E：CDF build

输入：

- `histPdfBuffer`

输出：

- `histCdfBuffer`

建议直接做 2D sampling 结构：

- marginal CDF over `binY`
- conditional CDF over `binX`

v0 可以先偷懒：

- 运行时线性扫描

但 v1 之前要换掉。

9. 渲染核心设计

9.1 geometry scope

第一阶段只支持：

- 一个平面 plate

不要一开始就扩展到一般 mesh。

因为这个项目最大的难点根本不在 mesh，而在：

- histogram 表示
- footprint
- sampling
- temporal 稳定性

9.2 footprint

优先复用当前实现思路：

- 从当前像素和邻近像素射线与 plate 求交
- 估计 world-space footprint

等到要做一般 mesh 再切到：

- `dpdx / dpdy`
- G-buffer / derivatives

9.3 目标 slope

给定入射方向 `wi` 和出射方向 `wo`：

- 先求 half vector `wh`
- 再把 `wh` 映射到局部 slope target `(p_h, q_h)`

注意：

- 局部坐标必须和 height field 的切线坐标系一致
- 不能混 world normal 和 heightfield local slope frame

9.4 histogram 查询

v0：

- 单 tile
- 单 mip

v1：

- 邻近 tile blending
- 跨 mip blending

这两项对减少爆闪非常重要，不要拖到太后面。

9.5 采样策略

v0：

- 不做真正 importance sampling
- 只做 target slope 附近的 lookup / window evaluation

v1：

- 每像素采样 `K = 4` 或 `8` 个 slope bins
- bin 内 jitter slope
- 转成 micro normal
- 计算反射方向
- 评估 env contribution
- 用连续 pdf 做权重

9.6 lighting

v0：

- 单方向 light

v1：

- HDRI env sampling
- slope sampling
- MIS

10. 调试视图是必做项

如果没有这些视图，后面一定会在“为什么不闪 / 为什么乱闪 / 为什么糊”上浪费大量时间。

必须有：

- `slopeTex` 可视化：把 `(p, q)` 映射成颜色
- `histogram heatmap`：查看某个 tile 的 bin 分布
- `target slope marker`：当前像素的 `(p_h, q_h)`
- `sampled bins overlay`
- `pdf heatmap`
- `mip / LoD heatmap`
- `overflow heatmap`
- `temporal variance heatmap`

建议额外保留当前已有的：

- footprint
- coverage
- mean normal

因为它们对对照 histogram 路线很有用。

11. 里程碑

Milestone 1：1 到 2 周

做出：

- `height -> slope`
- level 0 histogram
- slope debug
- histogram debug
- 单方向 light 下的 glint density 显示

验收：

- slope 统计与高度场特征一致
- 改变 light / camera 时响应合理
- 能稳定定位 target slope 落在哪些 bins

Milestone 2：2 周

做出：

- histogram mip
- 单 tile / 单 mip glint lookup
- 基于 histogram 的多 bin sampling
- 平面上的实时 glints

验收：

- 近处有 sparkles
- 远处逐渐平滑
- 不出现明显错误高亮

Milestone 3：2 到 3 周

做出：

- HDRI lighting
- env MIS
- temporal accumulation
- debug overlays

验收：

- HDRI 下 glints 明显强于 macro baseline
- 噪声可接受
- 相机移动时稳定性尚可

Milestone 4：2 到 4 周

做出：

- heightfield 分块
- streaming / cache
- 周期结构专项测试
- profiling

验收：

- 能吃真实数据
- 显存不失控
- 性能和视觉都可接受

12. 内存预算先算清楚

以 `4096 x 4096` slope 图、`16 x 16` tile、`16 x 16` bins 为例：

- tile 数量：`256 x 256 = 65536`
- 每 tile bin 数：`256`
- `f16` mass 的 level 0 histogram：约 `32 MiB`
- 带 mip pyramid：约 `42.7 MiB`

如果 build 阶段用 `u32 counts`：

- level 0 transient buffer：约 `64 MiB`

所以第一版策略应当是：

- build 用 `u32`
- normalize 后转 `f16`
- 及时释放或复用 transient build buffer
- 只保留必要 mip

13. 风险点与应对

风险 1：内存爆

原因：

- tile 太小
- bins 太多
- mips 太多
- 同时保留 counts / pdf / cdf 多份副本

应对：

- 第一版固定 `16 x 16 tile`
- 第一版固定 `16 x 16 bins`
- build `u32`，sample `f16`
- 控制 mip 层数

风险 2：glints 太糊

原因：

- `sMax` 不对
- bin 太粗
- footprint 估计过大
- 过早跨 tile / 跨 mip 平滑

应对：

- 优先补 debug
- 单独观察 `target slope vs histogram`
- 单独观察 `mip / footprint` 热图

风险 3：闪烁太严重

原因：

- tile / mip 跳变
- 采样噪声
- temporal reprojection 不稳

应对：

- blue noise
- tile blending
- mip blending
- temporal accumulation
- LOD hysteresis

风险 4：规则结构渲染不对

原因：

- 普通 histogram 丢掉了空间相关性

应对：

- 作为 v2 / v3 扩展
- 增加 position-normal joint moments
- 增加局部 FFT / phase descriptor
- 给周期结构单独分支

14. 和当前代码的落地拆分

为了避免单文件继续膨胀，建议下一步按下面方式落代码。

优先修改：

- `src/renderer/MetalPlateRenderer.ts`

建议新增：

- `src/renderer/shaders/heightToSlope.wgsl`
- `src/renderer/shaders/buildHistogram.wgsl`
- `src/renderer/shaders/buildHistogramMip.wgsl`
- `src/renderer/shaders/buildHistogramCdf.wgsl`
- `src/renderer/shaders/renderGlint.wgsl`

继续保留：

- `src/renderer/defaultHeight.ts`

建议增加的运行时开关：

- `shadingMode = macro | glint`
- `debugView = existing + histogram debug views`

15. 下一步实现顺序

真正动手时按这个顺序，不要乱：

1. 保留当前 SAT 路线，抽出 `macro` 和 `glint` 两个 shading mode。
2. 加 `height -> slope` pass，并做 slope 可视化。
3. 加 level 0 histogram build，并做 histogram heatmap。
4. 做 target slope marker 和单方向 light glint density。
5. 做 mip 和 tile / mip 查询。
6. 做 histogram sampling、env sampling、MIS。
7. 最后再上 temporal 和 streaming。

这条顺序的核心是：每一步都必须可视化验证，不要一次性叠太多机制。
