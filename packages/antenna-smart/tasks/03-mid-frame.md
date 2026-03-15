## 继续添加 3d 结构
- 在前面的流程里，手机轮廓是先 project，再往里 offset `thickness` 生成 frame。下一步实现再往里 offset `gap`，拉伸形成 mid-frame 部分。rib 连接到这个 mid-frame
- mid-frame 靠近屏幕的部分用 CNC 挖空。上半部分要给 pcb 留出空间，中间部分要给 battery 留出空间，下半部分要给 sub-pcb 留出空间。

跟我讨论确认你明白这个空间关系，我们再往下开发
