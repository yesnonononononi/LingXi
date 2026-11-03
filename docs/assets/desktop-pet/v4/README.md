# 桌宠表情母版 v4（M1「可见表情闭环」）

本目录只放 **M1 新增的那一张母版**，其余表情母版一律沿用 v3，不在这里重复交付。

## 1. v4 = v3 + wink（没有别的差别）

| 项 | 内容 |
| --- | --- |
| 资产 id | `lingxi-pet-p0-v4`（`manifest.json` 的 `assetId`） |
| 取代关系 | `supersedes: lingxi-pet-p0-v3`，画布、锚点、色彩空间与 v3 **完全一致** |
| 新增母版 | `expr/E9_wink.png`（2048×3072、straight alpha、sRGB、锚点 1024,2908） |
| 沿用 v3 | `neutral / blink / surprised / sad / angry / shy / happy / sleepy`（E1–E8）共 8 档，**不复制到 v4** |
| 未交付 | `blinkHalf`（见 §4） |

`manifest.json` 的 `expressionAssets` 直接指向 `../v3/expr/E<n>_<id>.png`，**v4 目录里出现 v3 母版的副本就是违规**（源与衍生不同库会立刻失去可复现性）。构建脚本按这份映射读文件，不需要第二份清单。

## 2. 硬规矩（违反任何一条，生成物都是废的）

1. **脸区不再画整头。** `face/` 下的贴片是母版在脸区矩形内的**原样裁切**：
   - `faceRegionNative = { left: 280, top: 532, width: 396, height: 200 }`（1024×1536 坐标系）
   - `faceRegionMaster = { left: 560, top: 1064, width: 792, height: 400 }`（2048×3072 坐标系）
   - 产物尺寸严格 `@2x = 396×200`、`@1x = 198×100`。
   脸区里**不得**出现耳朵、发夹/蝴蝶结、呆毛、前景盖片的任何可见像素：那些层会转，转起来就会与贴片撕边。整头贴片直接当脸贴片会把耳朵和发夹重复盖一遍，一样是错的。
2. **母版只追加、不改历史。** v3 的文件一个像素都不许动（包括 `v3/manifest.json` 的字段）；语义修正只在 v4 的清单里声明——例如 `blink.half` 在 v4 被显式置空，而 v3 里的 `half: 'sleepy'` 保持原样留作历史。
3. **一张母版只解决一个表情。** 不许用「整头重绘 + 滤镜」冒充新表情：`check-wink.mjs` 会拿差异像素总量（上限 90000）与差异落点（必须全部落在单侧眼区）卡住这种做法。
4. **衍生贴片不手改。** `frontend/public/live2d/pet-p1/face/*.webp` 与 `frontend/pet-face-tiles.json` 全部由 `npm run build:pet-face` 生成；改母版后必须重跑构建并把母版与生成物**同批提交**。

## 3. 校验（每次改母版都跑）

```bash
# wink 母版门禁：单眼闭合、睁眼侧与 E1 逐像素一致、不新增 alpha 空洞、差异不出脸区
node docs/assets/desktop-pet/v4/tools/check-wink.mjs
```

退出码 `0` = 全部通过；`1` = 有断言失败（逐条打印原因）。
`--wink=<path>` 可指向任意候选图（做变异自检时用，不会覆盖正式交付物）。

配套命令（在 `frontend/` 下）：

```bash
npm run build:pet-face                  # 从 v3 母版裁 face 贴片，wink/blinkHalf 走 degraded
npm run build:pet-face -- --include-deferred   # 母版已入库后把 wink（以及未来的 blinkHalf）转正
npm run gate:pet                        # C1–C9 全量门禁（含 C2 脸区墨迹=0、C3 neutral 与底图 maxDelta≤2）
```

## 4. `blinkHalf` 保持 degraded 的原因（不是遗漏）

`manifest.json` 的 `notDelivered` 与 `blink.half = null` 就是这个决定的机器可读形式：

- 半闭帧的正确做法是「眼睑半闭、**嘴型与 neutral 一致**」的独立一档；
- M1 未要求交付该档，因此 `frontend/pet-face-tiles.json` 的 `degraded` 仍含 `blinkHalf`，
  `BlinkDriver` 走**两态降级**（睁 → 闭 → 睁），一次眨眼只下发 1 条 `blink`；
- **任何情况下都不得回落到 `sleepy`**：那是困倦整脸（含困倦嘴型），每逢眨眼嘴型抖一下，
  正是 M1 要消灭的表现缺陷。等美术交付 `expr/E10_blinkHalf.png` 后，
  跑 `npm run build:pet-face -- --include-deferred` 即可转正，代码无需改动。

## 5. 目录内容

| 路径 | 说明 |
| --- | --- |
| `manifest.json` | v4 母版清单真源：`expressionAssets` 映射、`blink` 字段、`faceRegion`、wink 实测数据、`files[]` 校验对账 |
| `expr/E9_wink.png` | 唯一新增母版（单眼闭合） |
| `tools/build-wink.mjs` | 由 E1 + E2 单侧笔迹合成 E9（纯 Node，自带 PNG 编解码，无外部依赖） |
| `tools/check-wink.mjs` | 母版门禁（§3） |
| `tools/measure.mjs` | 差异/包围盒/alpha 统计的测量工具 |
| `tools/png.mjs` | PNG 读写的共享实现 |
| `preview.html` | 人工肉眼复核用的预览页（不属于构建输入） |
| `README.md` | 本文件 |
