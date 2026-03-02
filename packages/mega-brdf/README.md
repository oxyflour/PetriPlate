# mega-brdf (Next.js)

一个基于 Next.js 的 WGSL 高度场编辑与实时预览示例：
- 左侧是 Monaco Editor，可编辑 `fn height(p: vec2<f32>)`。
- 右侧是原生 WebGPU 渲染结果，在 shader 里通过 height 实时计算 normal 进行渲染，代码变更后会实时编译更新。
- WGSL 编译错误会展示在底部日志面板，不会中断上一帧成功渲染。
- **注意 `height` 函数的渲染范围会非常大，必须考虑建立某种快速查询结构**

## 开发

```bash
npx pnpm --filter mega-brdf dev
```

## 构建

```bash
npx pnpm --filter mega-brdf build
```

## 生产启动

```bash
npx pnpm --filter mega-brdf start
```

## WGSL 约定

编辑器代码需要定义函数：

```wgsl
fn height(p: vec2<f32>) -> f32
```

- `p` 是平面坐标
