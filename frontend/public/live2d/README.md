# Live2D / 桌宠资源目录

桌宠资源统一放这里，运行时只通过自定义协议 `lxa://` 读取（`electron/lx-protocol.cjs`）。
`public/` 会被 Vite 原样复制到 `dist/`，打包时 `electron-builder files: dist/**/*` 自动打进 asar，
**打包配置零改动**。开发态 `main.cjs` 还会额外把 `public/live2d` 挂进解析链，改素材不必先 build。

## 当前内容（方案A：正立静态立牌）

```
live2d/
  pet-v1/                 # 旧代资产，仅保留作对照/兜底，渲染层已不再引用
    front-master.png      # 1312×1199 横构图（头在右、脚在左）
    expressions.png       # 六格表情图 1536×1024（旧 sprite sheet）
  pet-v2/                 # 当前运行时资产（由脚本生成，勿手改）
    front-standing@1x.webp  # 160×240
    front-standing@2x.webp  # 320×480
```

渲染层引用方式（**渲染层不拼绝对路径**，URL 全部来自生成的资产清单
`src/pet/assets/manifest.ts`）：

- 立绘：`lxa://pet-v2/front-standing@2x.webp`（解码失败/超时自动降级到 `@1x`）
- 表情贴片：`lxa://pet-v2/expressions/<id>.webp`（**美术未交付时清单留空**，
  表现层自动降级为"只改状态、保持立绘自带脸"）

生成命令（在 `frontend/` 下）：`npm run build:pet-assets`（详见
`docs/assets/desktop-pet/v2/README.md`）。

> v2 立绘是**正立图**（头朝上、脚朝下），渲染只用 `object-fit: contain` 等比缩放，
> **没有 rotate、没有宽高对调、禁止 cover**——v2 右侧尾巴留白仅 5px，裁了就是切尾巴。
> 立绘箱按画布 2:3 比例定（156×234），由 `frontend/pet-geometry.json` 单一真源推导。

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
