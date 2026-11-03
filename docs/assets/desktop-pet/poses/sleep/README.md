# 趴睡批次（sleep）· v1 首帧

## 本批交付

| 文件 | 说明 |
| --- | --- |
| `sleep_neutral@2x.png` | 趴睡闭眼母版，3072×3072 |
| `source/sleep_neutral_generated.png` | 生图模型直出原图，1254×1254 |
| `source/sleep_neutral_native.png` | 归一化后的 native，1536×1536（母版的 1/2） |
| `source/eye_mask_native.png` | 蒙版（**完全透明区域 = 待编辑的眼区**） |
| `tools/build-sleep.mjs` | 生成链（native → 2× nearest → 母版） |
| `tools/check-sleep.mjs` | 门禁，零第三方依赖 |
| `qa/sleep_review.png` | 人眼复核图：亮底/暗底 × lie趴平/趴睡 四格 |
| `manifest.json` | 资产契约（canvas/anchor/contactPoints/normalization/files/sources） |

## 方法：蒙版局部编辑派生，不是重新生成

从 `poses/lie/source/lie_neutral_native.png`（趴平睁眼）出发，用生图工具的**蒙版编辑**模式只重绘眼区：

- 眼白／虹膜 → 眼睑肤色
- 加上眼睑弧线、睫毛、眼睑投影、下睑淡线

调用参数：`reference_image_path` + `mask_image_path` + `background:"transparent"` + `output_format:"png"`。

**其余像素逐字节未变**（见下表），所以不存在"两帧分别生成导致像素对不齐、动起来整个人在抖"的问题。

## 实测数据（可复算）

| 项 | 值 |
| --- | --- |
| 蒙版透明像素数 | 38608 |
| 蒙版透明区 bbox（native） | `{left:322, top:1116, right:644, bottom:1290}` |
| 变化像素总数 | 38095 |
| 蒙版**内**变化 | 38095 |
| 蒙版**外**变化 | **0，maxDelta 0** |
| 外轮廓 bbox（@2x） | `{42,1292,3047,2937}`，与 `lie_neutral` **逐值相同** |
| 2×2 块不一致数 | 0 |
| 母版体积 | 1,694,657 B（1.62 MB，远低于 §1.8 的 8MB 目标） |

## 运行校验

```
node tools/check-sleep.mjs
```

C1 画布/格式/sRGB、C2 alpha 洁净、C3 外轮廓与 lie 一致、C4 manifest 逐字节对账（含 sources）、C5 bbox 区间、C6 蒙版外零污染、C7 整数倍放大。

## 一眼辨伪

打开 `qa/sleep_review.png`：

- **左列** = `lie` 趴平（睁眼），**右列** = 本批趴睡（闭眼）
- 只有眼睛变了：**嘴、腮红、发丝、衣领花纹位置完全一致**
- 身体没动：外轮廓 bbox 与 lie 逐值相同
- 暗底那排无白边 ⇒ alpha 边缘干净

## 未完成（本批不是整批完成）

蜷睡（轮廓必须明显不同，须单独生成）、惊醒（睁眼+受惊）、睡眠呼吸 2 帧（须与趴睡同源，只对躯干做局部位移场）。`manifest.review.deferredUntilApproval` 已列出。

## 已知限制

- 母版 sRGB chunk 由 `tools/png.mjs` 写入。**首版曾漏写 sRGB 导致 C1c 失败，已修复**；`grep sRGB tools/png.mjs` 应能查到。
- canvas `3072×3072` 沿用 lie 的横向趴姿设定。
- `contactPoints` 从 lie 继承（身体姿态未变，接触点不变）。
