## 需求
- 开发 nextjs app，左边是 json，右边是根据 json 生成的手机 3d。json 的格式参考这样
```typescript
interface Phone {
    // 手机边框
    frame: {
        // 手机轮廓厚度
        thickness: number
        // 断缝
        seams: {
            width: number
            position: 'top' | 'left' | 'right' | 'bottom'
            distance: number
        }[]
    }
}
```
- 左边可以上传文件夹，需要读取其中的 obj 文件，结合 json 进行如下处理
  - 边框（frame）：把手机模型投影到 xy 平面上，把最外面的轮廓线内缩 phone.frame.thickness 再 extrude 成 3d。用原来的手机模型布尔减这部分，得到一圈边框
  - 断缝（seam）：根据 phone.frame.seams 确定在哪些位置将边框打断

## 建议实现方法
- 需要接近实时预览
- 布尔运算用 manifold-3d