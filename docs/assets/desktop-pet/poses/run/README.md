# poses/run —— M2 `run`（跑步）批次 · 左向 6 帧

本目录交 **run 左向 6 帧（l1–l6）**，含 1 帧双脚离地的腾空帧（l4）与首末加减速帧（l1 起步前倾加速、l6 收步减速）。
**右向 6 帧本轮未做**，已写进 `manifest.review.deferredUntilApproval` 与本文第 9 节；`review.fullBatchComplete = false`，
不得把本批当成整批完成。结构、几何口径、工具与 `poses/walk/` 同构。

## 1. 目录与文件

| 类型 | 路径 | 说明 |
|---|---|---|
| 母版（运行时） | `run_<id>@2x.png` | 3072×3072，8bit RGBA、非隔行、straight alpha、sRGB chunk |
| 归一化图 | `source/run_<id>_native.png` | 1536×1536；所有编辑都发生在这层 |
| 生图直出 | `source/run_<id>_generated.png` | 1254×1254 透明底，仅溯源，不参与运行时 |
| 契约 | `manifest.json` | multi-frame schema；bytes/sha256/bbox/contactPoints 全部实测回填 |
| 门禁 | `tools/check-run.mjs` | 21 条断言（C1–C16），失败退出 1 |
| 构建 | `tools/build-run.mjs` | 直出 → native → 2× nearest 母版 |
| 复核图 | `qa/run_review.png` | 亮底 + 暗底双排、6 帧同尺度，标注帧号/相位/前倾量 |
| 编解码器 | `tools/png.mjs`、`tools/pixels.mjs` | **从 `poses/walk/tools/` 原样复制（字节一致）** |

## 2. 几何与归一化

| 项 | 值 | 理由 |
|---|---|---|
| 母版 / native | 3072×3072 / 1536×1536 | 沿用 walk 已验收口径（§4「按 bbox 落座」修订：bbox 宽 >2048 的侧视跨步走 3072） |
| 放大 | `masterScale 2`、kernel `nearest`、`addsDetail:false` | 母版 = native 的 2× 最近邻，C7 断言不一致块 = 0 |
| 锚点 | (1536, 2908) | 画布水平中线 + 脚底最低墨迹 y=2907 的正下方 1px；支撑帧实测最低像素 2907，偏差 1px |
| 统一缩放 | ×1.122249 | 6 帧墨迹高度中位数 1227 gen px → 站姿墨迹高 1377 native px。**6 帧共用一个系数**，团身/腾空帧不单独放大（否则腾空帧会突然变大） |
| 水平定位 | 躯干质心（蓝裙簇）固定 **native x=700** | 见 §2.1 |
| 落地线 | native y=1453（母版 2907） | 支撑帧最低墨迹落在此 |
| 腾空抬高 | l4 整体上抬 **48 native px**（母版 96） | 见 §4 C13 |
| alpha 清理 | a<8 清零、a≥248 提满、<4 native px 孤立块删除 | C2 |

### 2.1 为什么躯干不在画布中线（与 walk 的唯一几何差异）

walk 把躯干质心对齐到中线 x=768。run 照抄会**把尾巴顶出画布**：实测 run 躯干质心到墨迹右缘最远 **730 gen px**，
按 1.122 缩放后是 **819 native px**，而中线右侧只有 768 px 可用 —— 第一版构建因此右缘溢出 52 px，
且越界写入会「环绕」到下一行产生肉眼难见的脏点（已在 `build-run.mjs` 里加硬边界断言，越界直接抛错）。
改为固定 x=700 后：右缘最坏 1519（留白 16px）、左缘最坏 309（留白 309px），四边留白仍全部 ≥8px（C3a）。
代价是**身体相对锚点 x 左移约 68 native px（≈10 display px）**，与 walk 切帧时会有一次横向位移 —— 已列入第 9 节请裁决
（另一条路是把 run 统一缩到 0.93× walk，那样角色会在跑步时「变小」，作者判断更糟）。

## 3. 实测数据（全部由 `check-run.mjs` 从磁盘复算）

| 帧 | 角色 | 相位 | 支撑脚中心 x / 接触 y | 腾空间隙 | 母版 bbox | 母版字节 | 前倾(面部前伸) | 头相对高 |
|---|---|---|---|---|---|---|---|---|
| l1 | 起步加速（后脚蹬地） | rear | 1099.0 / 1452 | — | 560,142,3039,2907 | 1,762,302 | 225 | −1026 |
| l2 | 支撑落地（前脚承重） | front | 636.0 / 1451 | — | 610,174,3027,2907 | 1,666,125 | 181 | −1017 |
| l3 | 后脚蹬离 | rear | 1033.0 / 1451 | — | 644,146,2977,2907 | 1,665,958 | 168 | −1025 |
| l4 | **腾空（双脚离地）** | — | null | **48 native / 96 master** | 654,278,2995,2811 | 1,477,088 | 205 | −932 |
| l5 | 前脚落地缓冲 | front | 578.5 / 1451 | — | 690,154,2953,2907 | 1,680,836 | 156 | −1032 |
| l6 | 收步减速（接近直立） | rear | 875.0 / 1451 | — | 854,192,2843,2907 | 1,719,816 | 91 | −1023 |

- 锚点偏差：5 个支撑帧最低像素均为母版 y=2907（与锚点 2908 差 1px，C3b ≤2px）。
- 前倾 = **面部（虹膜质心）在躯干质心前方多少 native px**（正 = 朝前）。l1 最大 225、l6 最小 91，符合「起步前倾、收步接近直立」。
- 头相对高 = 头部带墨迹质心 y − 该帧最低墨迹 y（正负无关，只看幅度），腾空帧因整体上抬 + 团身最「高」。

## 4. 判据与阈值（每条都写清为什么）

### C9 体积
单帧 ≤2.5MB（编码红线）+ 合计 ≤ 帧数×1.65MB = **9.9MB**（§8 修订后的棘轮）。实测 **9,972,125 B = 9.51MB，占预算 96.1%**，单张最大 1.76MB。
6 帧 sha256 互不相同、无物理重复副本、`aliases` 为空。这条是余量很小的硬门禁：任何编码退化（例如退回固定 filter=0）都会立刻红。

### C11 支撑脚交替
支撑脚 = 底部 90px 带内 `contactY` 距地面线 ≤3 native px 的那一段；相位 = 支撑脚中心相对躯干质心的前后关系
（`facing=-1` 时 x 更小为 front）。断言相邻**支撑帧**相位必须交替、front/rear 各 ≥2；**腾空帧不参与交替**，但必须 `support=null`。
实测：l1 rear(−399) → l2 front(+64) → l3 rear(−333) → l4 腾空 → l5 front(+122) → l6 rear(−176)，交替成立，front 2 / rear 3。

### C13 腾空帧
要求：至少 1 帧 `support === null`；`airborneGap = 地面线 − 该帧最低墨迹 y` 必须 >0 且 ≥24 native px（≈3.7 display px，眼睛能看见）；
该帧宽扫描带（200px）里**每一段墨迹都高于地面线**；且该帧最低墨迹必须比其它帧的最低墨迹再高 10px 以上（否则只是「站着的帧上抬一点」）。
实测 l4：support=null、gap=48 native（96 master）、底部两段 `968@1403` 与 `757@1253` 都高于地面线 1453。

### C14 前倾与「不许拿 walk 冒充 run」
- 每帧前倾 > 60 native px（实测最小 91）；
- `lean(l1) ≥ 1.5 × lean(l6)`（实测 225 vs 91 = 2.48×）；
- run 前倾中位数 ≥ 1.15 × walk 前倾中位数（实测 175 vs 100 = 1.75×）；
- **run 支撑脚 x 跨距 ≥ 1.2 × walk**（实测 520.5 vs 332.5 = 1.57×）——步幅真的更大；
- **run 头部纵向位移幅度 ≥ 1.5 × walk**（实测 99.6 vs 19.0 = 5.23×）——跑步的上下起伏更大；
- 三条 walk 基准都从 `poses/walk/source/*_native.png` **现场复算**（不是写死常量；walk 不可读才退回常量），并额外断言基准值为正，
  防止「符号算反导致负数基准让断言假绿」——这个坑在首批实现里真的踩到过。

### C8 躯干横向零抖动（新增，不在任务清单里但必要）
6 帧躯干质心 x 的极差 ≤2 native px（实测 1.1）。不然逐帧轻微横向漂移会让整段动画「抖」，而这在静态截图上看不出来。

### C16 §6.1 schema
共同必备键 14 个 + multi-frame 追加 6 个 + `review` 三键齐全；`nativeSourceCanvas.width × masterScale === canvas.width`（height 同理）；
每帧 `native` 尺寸必须等于 `nativeSourceCanvas`；`review.fullBatchComplete === false`；`deferredUntilApproval` 非空。

## 5. 体积

| 项 | 值 | 预算 | 占比 |
|---|---|---|---|
| 6 帧母版合计 | 9,972,125 B（9.51MB） | 6 × 1.65MB = 9.9MB | 96.1% |
| 单张最大 | 1,762,302 B（l1） | 2.5MB | 67.2% |
| 重复副本 | 0（`aliases: []`，6 个 sha256 互不相同） | — | — |

## 6. 一眼辨伪（人看 `qa/run_review.png`）

1. 两排（亮底/暗底）同尺度（母版 3072 → 360，统一 0.11719），每格标签是 `帧号 + 相位 + 前倾量`：
   `F` = 支撑脚在躯干前方、`B` = 在后方、`AIR` = 腾空。
2. **L4 整格角色明显比其它格「高」**，脚下留白最大 —— 那是腾空帧 48 native px 的离地量；其余 5 帧脚底齐平在地面线。
3. 相位标签序列是 `B F B AIR F B`，相邻支撑帧不重复同一只脚 —— 不是「一套步态换个相位」。
4. L1 躯干最斜、L6 最直（前倾量 225 → 91），这是加减速的可见差别；L1–L5 步幅明显大于 walk 的 4 帧。

## 7. 校验命令

```
node docs/assets/desktop-pet/poses/run/tools/check-run.mjs      # 退出 0 = 21 条全 PASS
node docs/assets/desktop-pet/poses/run/tools/build-run.mjs      # 复算 native/母版（确定性，重跑字节一致）
node docs/assets/desktop-pet/poses/run/tools/make-review.mjs    # 重出 qa/run_review.png
```

## 8. 变异自检（5 例，实跑：变异必红 → 逐字节还原 → 回绿）

| 例 | 变异 | 变异后退出码 | 命中断言（原样节选） | 还原后 |
|---|---|---|---|---|
| M1 | 把腾空帧 l4 换成落地帧 l5 | 1 | `FAIL C13 ... 没有 support=null 的腾空帧`、`FAIL C11 ... l4:front l5:front 交替=否`、`FAIL C15 master distinct=5/6`、`FAIL C14 ...` | 逐字节一致，退出 0 |
| M2 | 把 l5 native 整体右移 2px | 1 | `FAIL C8 ... torsoX spread=2.6px`（阈值 ≤2） | 逐字节一致，退出 0 |
| M3 | 让 l2 变成 l1 的副本 | 1 | `FAIL C11 ... l1:rear l2:rear 交替=否 front=1 rear=4`、`FAIL C15 master distinct=5/6` | 逐字节一致，退出 0 |
| M4 | 篡改 manifest 里 l3 母版 sha256 一个字符 | 1 | `FAIL C4a frames[] ... l3.sha256` | 逐字节一致，退出 0 |
| M5 | 把 l4 的 airborneGap 谎报成 96（实际 48） | 1 | `FAIL C4c ... l4.airborneGap 96≠48`、`FAIL C13 l4.airborneGap 声明与实测不符` | 逐字节一致，退出 0 |

## 9. 与 walk 的关系、以及未决项

- run **不是** walk 拉伸/推动来的：6 帧全部独立生成（`reference_image_path = poses/walk/source/walk_l1_native.png` 保身份与左向），
  步幅、头部位移、前倾量三项都按 C14 与 walk 实测值对比，均显著更大。
- 母版画布、native、masterScale、锚点、bbox 约定与 walk 完全同口径，跨批切换不需要改引擎参数。

未决项：
1. **右向 6 帧未做**（已进 `deferredUntilApproval`）。
2. **躯干横向锚点 x=700（而非中线 768）** 是为了让尾巴不被裁掉，代价是与 walk 切帧时约 10 display px 的横向位移 —— 请裁决：
   接受（本批现方案）／允许 run 统一缩放 0.93× 回到中线（角色跑步时会变小）／其它。
3. **腾空间隙 48 native px（96 master，≈7.3 display px）是作者定的**，任务书只要求 >0；如果引擎有「腾空高度」参数，可以按引擎需要重出。
4. l6 是**第二次生成**：首版支撑脚落在躯干前方，与 l5 同为 front 导致 C11 交替不成立，已弃用重出（`source/run_l6_generated.png` 现在是第二版）。
5. 本轮生图调用用掉 7 次（6 帧 + l6 重出 1 次），剩余 3 次未使用。
