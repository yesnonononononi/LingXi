# Live2D / 桌宠资源目录

桌宠资源统一放这里，运行时只通过自定义协议 `lxa://` 读取（`electron/lx-protocol.cjs`）。
`public/` 会被 Vite 原样复制到 `dist/`，打包时 `electron-builder files: dist/**/*` 自动打进 asar，
**打包配置零改动**。开发态 `main.cjs` 还会额外把 `public/live2d` 挂进解析链，改素材不必先 build。

## 当前内容（方案A：正立静态立牌）

```
live2d/
  pet-v3/                        # 当前运行时资产（由脚本生成，勿手改）
    composites/                  # 16 个完整帧 = 8 表情 × 2 密度
      neutral@1x.webp            # 160×240
      neutral@2x.webp            # 320×480
      blink@1x.webp … sleepy@2x.webp
```

**只有 `composites/` 一层。** 帧是美术母版（`canvas 2048×3072`）整张画布的完整立绘，
头、身体、尾巴全在一张图里，8 个表情各出一张，`@1x`/`@2x` 两套密度，共 16 个文件。

表情 id 固定为这 8 个：`neutral`、`blink`、`surprised`、`sad`、`angry`、`shy`、
`happy`、`sleepy`（文件名即 `<表情id>@<密度>.webp`）。

### 渲染走完整帧，不是叠贴片

换表情＝**换整张帧**（双缓冲两帧交替淡入 120ms），不是"立绘上再叠一张脸"。
这是美术契约的硬要求：*"不要把整头叠在完整立绘的半透明边缘上"*——立绘边缘本身带半透明
像素，叠上去会出暗边。所以清单里 `body` 为 `null`、`patches` 为空，
**渲染层没有任何 `background-position` 偏移算术，也没有零标定叠图**。

> 美术同时提供了另一条互斥路线（`body-without-head` + 整头 `expr/E*.png`），
> 仅在**没有** `composites/` 时才会被管线选为 `overlay` 模式；当前不缺完整帧，
> 走的是 `composite` 模式，该路线不启用。

### URL 与引用方式

渲染层引用方式（**渲染层不拼绝对路径**，URL 全部来自生成的资产清单
`src/pet/assets/manifest.ts`）：

- 帧：`lxa://pet-v3/composites/<表情id>@2x.webp`，例如
  `lxa://pet-v3/composites/neutral@2x.webp`
  （解码失败/超时自动降级到同表情的 `@1x`；`@1x` 也失败才降级为纯 CSS 占位）
- 密度按 `devicePixelRatio` 选：`>= 2` 用 `@2x`，否则 `@1x`
- **没有独立的"表情贴片"URL**——表情就是帧本身，见上一节

生成命令（在 `frontend/` 下）：`npm run build:pet-assets`（详见
`docs/assets/desktop-pet/v3/README.md`）。

> v3 立绘是**正立图**（头朝上、脚朝下），渲染只用 `object-fit: contain` 等比缩放，
> **没有 rotate、没有宽高对调、禁止 cover**——右侧尾巴留白很窄，裁了就是切尾巴。
> 立绘箱按画布 2:3 比例定（156×234），由 `frontend/pet-geometry.json` 单一真源推导。
> 母版 2048×3072 是原生 1024×1536 的最近邻 2× 放大（`addsDetail=false`），
> **没有额外细节**，别把它当"2× 高清母版"宣传。

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
