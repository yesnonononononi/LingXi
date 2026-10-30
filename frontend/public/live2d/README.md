# Live2D / 桌宠资源目录

桌宠资源统一放这里，运行时只通过自定义协议 `lxa://` 读取（`electron/lx-protocol.cjs`）。
`public/` 会被 Vite 原样复制到 `dist/`，打包时 `electron-builder files: dist/**/*` 自动打进 asar，
**打包配置零改动**。开发态 `main.cjs` 还会额外把 `public/live2d` 挂进解析链，改素材不必先 build。

## 当前内容（渲染层 v0：静态立绘）

```
live2d/
  pet-v1/
    front-master.png    # 全身立绘，1312×1199 横构图（头在右、脚在左），展示时 CSS 逆时针转 90°
    expressions.png     # 六格表情图 1536×1024，3 列 × 2 行，每格 512×512，透明底
```

渲染层引用方式（**渲染层不拼绝对路径**）：

- 立绘：`lxa://pet-v1/front-master.png`
- 表情：`lxa://pet-v1/expressions.png`（`background-size: 300% 200%` + `background-position` 切六格）

六格对应表情（阅读顺序 左→右、上→下）：默认 / 眨眼 / 开心 / 惊讶 / 困倦 / 委屈。
切换接口是 `src/pet/main.ts` 导出的 `setExpression(name)`，本轮不接调度逻辑。

> 素材当前是**横构图**：`pet.css` 里把立绘元素设成「转过来之后的横×竖」再 `rotate(-90deg)`。
> 等美术交付正立的立绘后，删掉 rotate 与宽高对调即可，其余排版不用动。

## 将来接 Live2D 时的目录约定

```
live2d/
  <模型名>/
    <模型名>.model3.json     ← 入口清单，运行时从这里加载
    <模型名>.moc3
    textures/…  motions/…  expressions/…
```

- 一个模型一个子目录，目录名与 `model3.json` 同名；`lxa://` 的 host 就是该目录名，
  所以**目录名必须小写**（standard scheme 会把 host 规范化成小写）。
- 只放模型资源与清单，不放脚本；加载逻辑写进 `src/pet/`。
- Cubism Core（`live2dcubismcore.min.js`）另行随包本地引入并附 NOTICE，不走 CDN。
- **示例模型（官方 Sample）只允许在开发期引用，不得打进安装包**；发布前必须换成自研或已购授权模型。
