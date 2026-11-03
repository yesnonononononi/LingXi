# 趴下 / 起身 · 第一批候选

按任务书第8节及最新反馈，先交 lie 一批，等主理人确认后再做其余8批。坐姿已暴露的画风漂移与脚部结构含混均列为本批人工复核重点；不把 sit 的机验通过当成人眼批准。本包状态保持 `awaiting-static-review`。

## 交付内容

| 帧位 | 文件 | 实际画面 |
| --- | --- | --- |
| 趴下1 | `lie_down_01_neutral@2x.png` | 既有站姿复刻 |
| 趴下2 | `lie_down_02_neutral@2x.png` | 新绘半趴支撑 |
| 趴下3 | `lie_down_03_neutral@2x.png` | 新绘趴姿 |
| 中性趴姿 | `lie_neutral@2x.png` | 复用趴下3端点 |
| 起身1 | `lie_up_01_neutral@2x.png` | 复用中性趴姿 |
| 起身2 | `lie_up_02_neutral@2x.png` | 反向复用半趴 |
| 起身3 | `lie_up_03_neutral@2x.png` | 回到站姿 |

共7个帧位、3张独立画面，2种姿态本轮新绘。端点与反向序列共享画面是明确的复用关系，写在 `manifest.aliases` 中，不声称独立补绘7张。没有定义动画时长、速度、概率或停留配置。

- `preview.html`：站姿对照、深浅底逐帧放大与手动切帧。
- `qa/lie_review.png`：上排亮底、下排暗底；每排从左到右为站姿、半趴、趴姿，同像素密度。
- `qa/validation.txt`：校验脚本原样输出与退出码。
- `source/`：生成原图、归一化原生图及实际用到的姿态参考。原图保留低alpha噪点，仅用于溯源，不是成品。
- `manifest.json`：每帧画布、实测bbox/字节数/SHA256、接触点、语义区域、归一化参数与来源。
- `prompts.json`：内置 image_gen 的选用提示词及参考路径。生成本身不保证逐像素复现；保存的原图可以确定性复算成品。
- `delivery-files.txt`：目录树式相对路径、每文件字节数及SHA256；清单自身不自哈希。

## 几何

母版采用3072×3072，原生1536×1536，2倍最近邻导出，8bit RGBA、非隔行、sRGB、straight alpha。扩大横向透明画布是为了同时容纳横向趴姿与原密度站姿，不强套站姿2:3比例。

既有站姿按原生2倍策略复刻，水平补边512px并统一再清理alpha；半趴和趴姿的新绘原图不缩放，只平移补边。不是旋转或压扁站姿，也没有用放大制造细节。每个成品像素可与其原生图的2×2像素块当场核对。

顶层 `anchor` / `contactPoints` 对应中性趴姿；过渡帧使用各自 `files[].anchor`。后脚基线统一为y=2909，各脚最低可见行相对该基线偏差≤2px。站姿基准原锚点y=2908，与新画布基线差1px；没有为了凑整改画脚底。

原图到母版的换算是：原图坐标乘 `uniformScaleToNative`，加 `translationNative`，再乘2。最低行取2倍像素块的下沿，最终坐标由像素扫描实测，不能仅靠换算猜测。

`contactPoints.footImageLeft/Right` 是图像左右两只靴底；`palmFrontImageLeft/Right` 是可见手掌。`belly` 明确使用腹部对应衣摆下缘的接地代理点，因为衣物遮住了腹部本身。前掌、衣摆和后脚有透视深度差，不要求它们位于同一像素行。代理点是否符合趴卧观感仍需人工确认。

`mirrorSafe=false`，发侧蝴蝶结、云朵发夹和尾巴不允许直接镜像；没有声称交付反向姿态。

## 校验

在仓库根目录运行，无需 npm install：

```powershell
node docs/assets/desktop-pet/poses/lie/tools/build-lie.mjs
node docs/assets/desktop-pet/poses/lie/tools/build-preview.mjs
node docs/assets/desktop-pet/poses/lie/tools/check-lie.mjs --self-test
```

正式检查退出0。脚本复算C1–C6和C9–C11；C7非mini不适用，C8纯Node零依赖。C6检查7个帧位和顺序，不代替人工批准。PNG是否错误预乘无法单凭文件头证明，导出使用straight alpha，仍须对照深浅底观察边缘。

正对照包括末行末列的低alpha与单像素孤岛、错误画布/位深、错误哈希/字节数/bbox、脚底锚点错位、边缘无留白和缺少关键帧。C11通过实际写入被改动的PNG并启动独立检查进程，确认成品替换会触发C3和非0退出；临时变异图随后删除。

验收未完成时，以下命令必须退出1，防止把机验通过等同于主理人批准：

```powershell
node docs/assets/desktop-pet/poses/lie/tools/check-lie.mjs --approved
```

## 人工复核与未决项

1. 画风：以v3站姿为准，核对头脸比例、虹膜、暖色轮廓、发丝明暗和服装细节。新绘图仍可能存在生成式细节漂移，不自行宣称完全一致。
2. 结构：半趴是双手支撑、双膝弯曲、腹部离地；趴姿髋部放低、后腿屈膝平躺，两只靴子有分开的轮廓，不能看成站着后腿的俯身姿态。不能只数出两只靴子就判定结构合格。
3. 接地：确认腹部衣摆代理点合理，手掌与后靴支撑关系自然；脚底坐标只能证明数值对齐，不能证明解剖正确。
4. 连续性：确认站→半趴→趴及反向复用能够作为工程侧补间的关键帧；本包没有交付连续中间画。

本包等待上述人工验收，`humanApproved=false`、`fullBatchComplete=false`。其余8批尚未启动；sit 的抱云/眨眼等遗留项不包含在本批内。未修改历史资产、任务书或前端工程。
