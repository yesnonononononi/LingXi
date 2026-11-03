# 正立桌宠素材 v2

> **⚠️ 本批次已被 v3 取代（历史记录，勿据此接入）**
>
> **v2 已被 v3 取代。** 当前运行时资产看：
> - 美术产物：`docs/assets/desktop-pet/v3/`
> - 前端清单与加载：`frontend/src/pet/assets/`（数据真源 `frontend/pet-assets.json`）
> - 实际入库帧：`frontend/public/live2d/pet-v3/composites/`（16 个完整帧）
>
> `frontend/public/live2d/pet-v2/` 目录**已不存在**，`docs/assets/desktop-pet/v2/front-standing.png`
> 也不再被运行时引用。**本文件仅记录 2026-10-30 那一批的历史产出，不复述当前管线，
> 文内出现的一切路径一律视为「历史」，不要照抄执行。**

日期：2026-10-30。使用内置 imagegen，以首批原始竖直立绘为参考重新生成并清理边缘。

## 交付

- `front-standing.png`：1024 × 1536，正面站姿，头朝上、双脚朝下，保留 PNG alpha 通道。作为静态桌宠的默认立绘。
- `preview.png`：Electron 中实际合成的深浅背景预览，包含 100、150、450px 三种显示高度。
- `alpha-report.json`：浏览器解码后逐像素统计的尺寸、透明像素和可见边界。
- `prompts.md`：生成与清理提示词。

## 验收记录

已目视确认角色正立、耳尖与呆毛在上、双脚在下；在深浅背景与三种高度下检查了完整轮廓。四角 alpha 均为 0，可见像素边界（alpha ≥ 128）为 x=18..1019、y=80..1454。右侧尾巴留白较窄，使用时须按整张画布等比缩放，禁止裁成铺满容器。

单图预览可能显示全透明像素中保留的底色，透明效果以实际合成为准。本图仍保留生成器提供的半透明像素，未进行逐像素手工修整。

## 接入边界

路线采用先静态 v1、再继续 Live2D 分层与绑定。本批仅完成美术文件，未修改桌宠运行代码。

### 运行时资产由脚本生成（勿手改）〔历史批次做法，已被 v3 取代〕

`front-standing.png` 是**母版**，只在 `docs/` 留档，**不进 `public/`**。运行时用的是降采样 WebP：

```
# 【历史】以下产物目录已随 v3 切换删除，实际不再存在，仅留档说明当时的做法
frontend/public/live2d/pet-v2/          ← 【历史】目录已不存在
  front-standing@1x.webp   # 160×240    ← 【历史】
  front-standing@2x.webp   # 320×480    ← 【历史】
```

生成命令（在 `frontend/` 下）：

```
# 【历史】下面第一条的「默认源目录就是本目录(v2)」已不成立；
# 现默认源目录是 docs/assets/desktop-pet/v3，产物是 public/live2d/pet-v3/composites/。
npm run build:pet-assets                       # 【历史】默认源目录曾是本目录
npm run build:pet-assets -- --source <dir>     # 仍然有效（源目录可配置这点没变）
```

脚本会同时回写资产清单 `frontend/src/pet/assets/manifest.ts`（尺寸/体积/URL），
并断言 2:3 比例与体积预算。**改图后必须重跑**，否则 `npm run test:pet` 会因清单与磁盘不一致而红。

`sharp` 是可选构建期依赖：装了就用它转码；没装则只校验已有产物并给出安装提示（不静默跳过）。

静态 v1 应保留整张 PNG 的比例与方向。首批六表情仍是头像参考，需要裁切和对齐后再用于切换；独立尾巴也需要对齐，并消除原画自带尾巴后才能叠加，不能直接多贴一条。

Live2D 仍需共用画布的完整分层、遮挡补绘与 Cubism 绑定。本图不是 PSD 或可运行模型。

## v1 方向差异

本次检查发现 v1 的 `front-master.png` 存在未提交修改，当前文件横向显示；保留的原始生成文件为 1199 × 1312 的竖直站姿。未覆盖该工作区修改，v2 使用独立路径交付。
