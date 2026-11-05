# jump 批次（左向 5 帧 + 右向 5 帧）

桌宠「跳跃」动作的母版资产与门禁。本批交 **左右向各 5 帧**（`facing=-1` 左向 `anticipate/ascend/apex/descend/land`、
`facing=+1` 右向 `r_anticipate/r_ascend/r_apex/r_descend/r_land`）；`play`/`edge`/`side`/`mini` 仍 deferred，详见文末「交付范围」。
右向 5 帧**全部独立重画**，没有一帧来自左向帧的镜像（C10b 实证：翻转后并集墨迹差异 84.9%~90.0%，阈值 5%）。

```
jump/
├── jump_{anticipate,ascend,apex,descend,land}@2x.png     左向母版 3072×3072（facing=-1）
├── jump_r_{anticipate,ascend,apex,descend,land}@2x.png   右向母版 3072×3072（facing=+1，本轮新增）
├── source/jump_*_generated.png                           生图直出原图 1254×1254（不参与运行时）
├── source/jump_*_native.png                              native 层 1536×1536（所有几何编辑都在这一层）
├── manifest.json                                         声明 + 实测（门禁逐字段核对）
├── qa/jump_review.png                                    人眼复核图（亮底/暗底 × 左向/右向四排，同尺度）
└── tools/                                                build / check / review / 共享判据模块
```

## 1. 十帧与相位角色

| # | id（左 / 右） | 相位角色 | 支撑/腾空 | airborneGap（native px） | 朝向 |
|---|---|---|---|---|---|
| 1 | `anticipate` / `r_anticipate` | 起跳蓄力：双膝深屈、重心压低、双臂后摆 | 支撑帧（双脚着地） | 0 | 左 / 右 |
| 2 | `ascend` / `r_ascend` | 上升：蹬地离地、身体开始收 | 腾空 | 76 | 左 / 右 |
| 3 | `apex` / `r_apex` | 最高点：收腿抱膝、墨迹最矮 | 腾空 | 170 | 左 / 右 |
| 4 | `descend` / `r_descend` | 下落：伸腿准备落地 | 腾空 | 64 | 左 / 右 |
| 5 | `land` / `r_land` | 落地缓冲：重心再次压低吸收冲击 | 支撑帧（双脚着地） | 0 | 左 / 右 |

**左右同相位必须落在同一套数字上**（C18）：离地量不是"看起来差不多"，而是硬阈值 ±2 native px ——
否则左右转身时同一个跳跃动作会一高一低。

轴向口径：母版 3072×3072（`masterScale=2`）＝ native 1536×1536 的 **2× nearest**（C7 逐像素复核，10/10 mismatch=0），
`anchor={x:1536,y:2908}`（水平中线 + 支撑帧最低墨迹 2907 的下方 1px），`display` 宽高 234（系数 0.07619）。

## 2. 支撑帧与腾空帧怎么判

不用"看起来像"，全部从像素复算（`tools/check-jump.mjs` 的 `footRuns`）：

1. 取 native 墨迹框底部往上 **90px 带**（`footBandNative=90`，≈墨迹高 6%），按列扫描得到若干**脚段** `[left,right]`；
2. 段的 `contactY` = 该段内最低墨迹 y；
3. `contactY >= 地面线(1453) − 3px`（`contactDepthNative=3`）的段记为 **support（着地）**，否则 `lifted`；
4. 帧内**存在 support 段** ⇒ 支撑帧，`contactPoints.support` 必须声明该段且与实测差 ≤2px；
   帧内**没有任何 support 段** ⇒ 腾空帧，`contactPoints.support=null` 且必须给出 `airborneGap = 1453 − 墨迹底边`。

本批结果（左 / 右）：`anticipate`（support 975.5@1451）/ `r_anticipate`（761.5@1451）、`land`（865.5@1452）/
`r_land`（652@1451）为支撑帧；`ascend/apex/descend` 与 `r_ascend/r_apex/r_descend` 的墨迹底边分别在
1377 / 1283 / 1389（左右完全相同），离地量 76 / 170 / 64，六帧脚段全部高于地面线。

## 3. airborneGap 的裁决（76 / 170 / 64）

- `apex ≥ 120 native px` **且** `apex ≥ run 腾空帧(48) + 72`：这条来自用户裁决——jump 的"腾空"必须一眼和 run 的
  "小碎步腾空"分开。170 native ≈ 13 display px，是 run 的 3.5 倍。门禁里写成两条显式断言
  （`apexMinGapNative=120`、`gapMarginOverRun=72`），不是只比一个魔法数。
- `ascend(76) < apex(170) > descend(64)`：形成上抛再回落，且 `airborneMinGapNative=16` 保证另外两帧真的离地。
- 取值还要让**头顶弧线**单调：画布 1536 高、角色墨迹约 1376 高、脚踩 1453 时头顶只剩 78px 余量，因此"整体上移"
  最多约 58 native px。若按 70/132/64 取，ascend 的头顶(y=39)会高于 apex(y=57)，最高点反而"变矮"；
  取 76/170/64 后头顶 y = 78 → 34 → 20 → 35 → 74，才是连贯的上抛再回落。
- 腾空靠**整幅竖直纯平移**实现（`lowestInkY = 1453 − gap`），不做任何逐帧缩放：C14 用"10 帧单一缩放系数
  （实测 1.1218~1.1227，极差 0.00086）"+"腾空帧不得比支撑帧更宽（左 maxAirW 1085 < maxSupportW 1195 / 右 1157 < 1250）"
  把缩放伪造堵死；C14b 再按朝向组各算一遍。
- 右向 5 帧的 gap **直接取左向同相位的值**（不是重新调的）：C18 用 ±2 native 断言左右同相位的底边与离地量互相对齐，
  否则角色转身时同一个跳跃会一高一低。

## 4. bodyAnchor 的裁决

`bodyAnchor={x:700, y:1454, groundLineNative:1453, facing:-1, byFacing:{"-1":{x:700,y:1454},"1":{x:836,y:1454}}, spreadNative:1}`。

- **x=700 是实测躯干质心**（左向），不是画布中线 768、也不是 bbox 中线：估计器取"蓝裙簇（b−r≥45 且 b≥150 且 g<b−20）在
  墨迹高度 45%~85% 中段"的质心 x；左向 5 帧实测 699.8 / 700.5 / 700.0 / 699.8 / 700.8（均值 700.2，spread 1.01px），
  右向 5 帧实测 836.2 / 836.8 / 836.2 / 836.6 / 836.7（均值 836.5，spread 0.54px）。
  尾巴把 bbox 拉向右（左向），用 768 会把角色整体左移，与 run 左向的布局对不上。
- **右向 x=836 = 1536 − 700，严格镜像对称**（C17 断言 `x_left + x_right = 1536`，容差 0，因为是算术关系不是测量）。
  **不接受压成批级单值**：左向 5 帧已验收且字节冻结，其质心实测就是 700；取 700 则右向 5 帧各差 136.5（>2px 容差），
  取 836 则左向全错，且"镜像"这条断言直接不成立。（附：jump 的墨迹包络本来允许 [739,770] 的公共 x，
  但那是"重排已验收帧"的方案，本轮明令禁止 —— 详见 manifest `bodyAnchor.whyNotSingleX`。）
- **y=1454 是地面参考线，不随帧底走**：腾空帧墨迹底边抬到 1377/1283/1389（左右向相同），`bodyAnchor.y` 仍是 1454
  （C17 专门断言"腾空帧帧底 = y−1−gap"）。引擎按这个锚点贴地，跳跃高度才由 gap 表达而不是由锚点漂移表达。

## 5. 画布 / native / 母版口径

- 生图直出 1254×1254 透明底；native 层 1536×1536；母版 3072×3072 = native 的 2× nearest（禁止任何插值）。
- 缩放系数**固定沿用 run 左向交付值 1.122249**，不按 jump 自身墨迹中位数算：5 帧全是蹲伏/腾空姿态，
  用其中位数（1207 gen px）会得到 1.140845，角色比 run 大 1.7%，换动作时会忽大忽小。
- 水平定位：躯干质心固定到 native x=700（左向）/ x=836（右向，=1536−700）；竖直定位：整幅平移到 `lowestInkY=1453−gap`。
- alpha 口径：straight（非预乘），`alpha<8` 一律清零、`alpha>=248` 提满、`<4 native px` 孤立块删除。

## 6. 体积

| 项 | 实测 | 上限 | 占比 |
|---|---|---|---|
| 本批 10 张母版合计 | 17,142,528 B（16.35 MB） | 10 × 1.9 MB = 19 MB | 86.0% |
| 左向 5 帧 / 右向 5 帧 | 8.47 MB / 7.88 MB | 各 5 × 1.9 MB = 9.5 MB | 89.1% / 82.9% |
| 单帧最大 | 1,934,388 B（`anticipate`） | 2,621,440 B（2.5 MB） | 73.8% |
| 六批母版合计（sit/lie/sleep/walk/run/jump） | 70.27 MB | 96 MB | 73.2% |

（每帧 1.9MB 的预算来自 §8 第二次修订：walk 之后 14 个母版实测 1.48–1.76MB/帧；全局 96MB 来自 §8 第三次修订，
原 64MB 会让 play 批次必然破线。单朝向上限由 C9c 单独断言，防止"左向贴线、右向再贴一次"把批次顶穿。）
## 7. C2c 口径（半透明中性灰脏边）

判据：**半透明像素里"中性灰且偏暗"的占比 ≤ 2%**。

- "半透明" = `8 <= alpha < 255`；
- "中性灰" = 三通道互差均 ≤6；
- "偏暗" = 加权亮度 `0.299r+0.587g+0.114b <= 210`；
- 实现只有一份：`tools/ink.mjs` 的 `isDirtyNeutralGray()` / `alphaHygiene()`，build 的净化与 check 的度量共用。

为什么是这条口径：生成图在角色轮廓外侧会留一圈半透明的灰白晕（不是阴影、也不是描边，是背景与主体的混色残留），
它在暗底上会显出一圈脏边；不透明像素不受影响，所以用"占半透明像素比例"而不是"占全图比例"来衡量。

本轮交叉验证（同一份 `alphaHygiene` 跑不同批的 native 帧）：

| 批 | 本批 check 公布的 worst | 用本批（jump）门禁口径复算 |
|---|---|---|
| run | 1.692% | 1.733%（r2） |
| walk | 1.049% | 0.815%（r4） |
| jump | — | 修复前 descend 3.538% → 修复后 0.00% |

三个口径的差别只在"半透明上界（248 还是 255）"和"亮度用 max 通道还是加权"上，量级差 <0.1pp，**不改变任何判定**。
descend 帧在三种口径下分别是 3.534% / 3.621% / 3.538%，全部超过 2% ⇒ 判为**真缺陷**，处置是净化而不是调阈值：

- 只对 `descend` 一帧做 alpha 边缘净化（`tools/ink.mjs` 的 `clearDirtyNeutralGray`，清 1803 个像素），
  其余 4 帧逐字节未变；
- 墨迹 bbox **变化 0px**（净化前后都是 1070×1355，left/top/right/bottom 四个方向 delta 全 0）；
- 净化后 `descend` 母版 sha256 `ec069cd5…` → `f43195b4…`，native `625b8eee…` → `f7715eda…`（体积 1,663,207 → 1,655,936 B）；
- C2a / C2b / C7 / C9 与其余 4 帧指标全部仍绿（见门禁输出）。

## 8. 判据（C1–C18 + C9b/C9c/C10b/C14b 共 26 条）一览

| 判据 | 内容 | 阈值/口径 |
|---|---|---|
| C1a/C1b | 画布 3072×3072；8bit RGBA、非隔行 | — |
| C1c | sRGB 块存在（**逐块扫完整文件**的真实块序列） | 期望 IHDR → sRGB → IDAT → IEND（10 帧逐帧打印块序列） |
| C2a | `alpha<8` 必须全透明 | 0 像素 |
| C2b | 无 `<4 native px` 孤立块 | 0 像素 |
| C2c | 半透明中性灰脏边占比 | ≤2%（见 §7） |
| C3a | 四边留白 | ≥8px（10 帧实测最小 40 master px） |
| C3b | 支撑帧最低像素与 anchor.y 偏差 | ≤2px（4 个支撑帧全部 diff=1） |
| C4a | frames[] 的母版/native bytes+sha256+bbox | 逐字段相等（10 帧） |
| C4b | sources[] 直出图 bytes+sha256+**墨迹框**+**alpha 完整范围框** | 逐字段相等（两套口径都验，10 张） |
| C4c | contactPoints 与实测 | ≤2px；腾空帧 support=null + gap 对账 |
| C5 | 墨迹框在声明区间内 | **native 对 native**：w[900,1400] h[1100,1500]，且 `batchBboxRange.unit` 必须是 `native` |
| C7 | 母版 = native 的 2× nearest | 逐像素 0 差异（10/10 mismatch=0） |
| C8 | 同批画布/锚点一致 + **左右两组各 5 帧且朝向纯一** + **组内**躯干横向零抖动 | 每组 spread ≤2px（左 1.01 / 右 0.54） |
| C9 | 体积：单帧 ≤2.5MB 且合计 ≤帧数×1.9MB | 见 §6 |
| C9b | 六批母版合计 ≤96MB | 70.27MB |
| C9c | **单朝向体积**：左右各 5 帧 ≤5×1.9MB=9.5MB | 左 8.47MB / 右 7.88MB（本轮新增） |
| C10 | 虹膜朝向：偏移符号=facing，偏移绝对值 >= 60（左右两部分别验） | 探测器 = `tools/iris.mjs`（与 run 同一掩膜，阈值一个没降） |
| C10b | **右向帧不是左向帧的镜像**：每帧 vs **任一**左向帧水平翻转，并集墨迹差异 ≥5% | 与 run 的 C10b 同一口径；实测最小 84.9%（本轮新增） |
| C13 | 腾空判据（**左右两组同口径**：support=null + gap>0 + apex≥120 且 ≥run48+72 + ascend<apex>descend + 双脚高于地面线） | 见 §2/§3 |
| C14 | 禁整体缩放（单一缩放系数 / 腾空帧不得更宽 / 宽度不随 gap 增加） | 极差 ≤0.004（10 帧实测 0.00086） |
| C14b | 禁整体缩放（**逐朝向组**再算一遍腾空/支撑宽度与 apex/land 宽度） | 本轮新增 |
| C15 | 10 帧母版/native sha256 互不相同 | 无重复副本（10/10） |
| C16 | §6.1 必备键 + `nativeSourceCanvas×masterScale=canvas` + `mirrorSafe=false` + 四类不可镜像件 + deferred 清单 + **frames 数=10 且左右各 5** + **deferred 里不许再挂「右向」** + `fullBatchComplete=true` | 蝴蝶结/云朵发夹/内耳/尾巴 四类都必须声明到 |
| C17 | bodyAnchor（**按朝向取值** / x=实测质心±2 / **组内** spread≤2 / y=地面线±2 / 腾空帧不跟帧底 / **左右严格镜像 x_L+x_R=1536** / x 落在躯干墨迹内） | 见 §4 |
| C18 | **相位几何左右同帧对齐**（anticipate/land 底 1453·gap 0；ascend 76 / apex 170 / descend 64） | ±2 native px，左右互相对齐（本轮新增） |

## 9. 工具与共享判据模块

```
tools/png.mjs      PNG 编解码（纯 Node，零依赖；只支持 8bit 非隔行，解码统一转 straight RGBA）
tools/ink.mjs      墨迹阈值 + bbox + 中性灰脏边判定 + alpha 卫生度量（build 与 check 共用）
tools/iris.mjs     虹膜连通块探测器 + 头部墨迹质心 + C10 阈值（build 实测与 check 判据共用）
tools/build-jump.mjs   generated → native → 母版；`--report=<file>` 导出完整实测 JSON；`--facing=1` 只重建右向（不动左向字节）
tools/check-jump.mjs   门禁（26 条），全部断言从磁盘像素复算，不信任 build 输出
tools/make-review.mjs  生成 qa/jump_review.png（亮底/暗底 × 左向/右向 四排，234px 引擎显示宽，同尺度）
```

**为什么要抽 `ink.mjs` / `iris.mjs`**：上一版 build 用 `alpha>=8` 记录直出图 bbox、check 却用 `alpha>=1` 去比，
5 帧 ×4 字段全部假红；虹膜探测器被放宽成 `b-r>=60 && b>=120`，把蓝色裙摆并进"虹膜"（面积 28021），
偏移量失真。抽成单一实现后，门禁、build 实测、跨批交叉验证脚本共用同一份代码，口径不可能再漂移。
## 10. 复跑命令（含真实退出码）

```bat
:: 门禁（ALL PASS 退出 0，任一 FAIL 退出 1）
cd /d D:\Code\LingXi
cmd /v:on /c "node docs\assets\desktop-pet\poses\jump\tools\check-jump.mjs & echo RC=!ERRORLEVEL!"
```
PowerShell 下等价写法：`node <path>; $LASTEXITCODE`。

```bat
:: 重建母版 + native（左向 5 帧逐字节可复现；descend 会顺带做脏边净化）
node docs\assets\desktop-pet\poses\jump\tools\build-jump.mjs --facing=-1
:: 只重建右向 5 帧（绝不重写左向文件）
node docs\assets\desktop-pet\poses\jump\tools\build-jump.mjs --facing=1
:: 额外导出完整实测（bbox/体积/朝向/净化像素数），用于同步 manifest
node docs\assets\desktop-pet\poses\jump\tools\build-jump.mjs --facing=1 --report=.lingxi\tmp\jumpcheck\build-report.json
:: 人眼复核图（左右向并排）
node docs\assets\desktop-pet\poses\jump\tools\make-review.mjs
```

```bat
:: 五批回归（证明没有把公共口径改坏；jump 只改自己 tools 里的三份文件）
for %b in (run walk sleep lie sit) do @cmd /v:on /c "node docs\assets\desktop-pet\poses\%b\tools\check-%b.mjs >nul & echo %b RC=!ERRORLEVEL!"
:: 前端宠物门禁
cd /d D:\Code\LingXi\frontend && npm run gate:pet
```

## 11. 变异自检（4 例，必红 → 逐字节还原 → 必绿）

做法：注入变异 → 跑门禁（取真实退出码，见 §10 的 `!ERRORLEVEL!` 写法）→ 用内存留底还原并比对 sha256 → 再跑门禁。

| 例 | 变异 | 期望命中的断言 | 实测 |
|---|---|---|---|
| M1 | 把 `jump_apex@2x.png` 换成 `jump_land@2x.png` | C4a / C15（顺带 C7） | RC=1，19/22 PASS；`apex.bytes/apex.sha256/apex.bbox.*`、`C7 apex:4315128`、`C15 master=4/5` |
| M2 | 谎报 apex 的 airborneGap（`contactPoints.airborneGap` 与 `normalization.airborneGapNative.apex` 都写成 60） | C4c | RC=1，21/22 PASS；`apex.airborneGap=60 vs 实测170` |
| M3 | 篡改 `frames[0].sha256` 一个字符 | C4a | RC=1，21/22 PASS；`anticipate.sha256` |
| M4 | `bodyAnchor.x` 改成 768 | C17 | RC=1，21/22 PASS；`bodyAnchor.x=768 vs 实测均值700.2` |

四例还原后 `manifest.json` 与 5 张母版 sha256 全部逐字节一致，门禁回到 `ALL PASS` / RC=0。
（变异脚本是一次性工具，不入库。）

### 11.1 本轮（右向交付）追加的 4 例

| 例 | 变异 | 期望命中的断言 | 实测（原样节选） |
|---|---|---|---|
| M1 | **把右向 `r_apex` 换成左向 `apex` 的水平镜像**（native + 母版一起换） | C10b（连带 C4a / C14） | RC=1；`r_apex:min=0.0%(vs mirror apex) 同相位=0.0% \| 未通过: r_apex vs mirror(apex)=0.00%`、`C4a r_apex.bytes/sha256/bbox.*`、`C14 缩放系数极差=0.04208` |
| M2 | `bodyAnchor.byFacing["1"].x` 改成 768（画布中线） | C17 | RC=1；`r_*.torsoCx=836.x 与声明 768 差 68.x`、`左右 bodyAnchor.x 不是严格镜像：700+768≠1536` |
| M3 | 谎报 apex 的 airborneGap（`contactPoints.airborneGap` 与 `normalization.airborneGapNative.apex` 都写成 120） | C4c | RC=1；`apex.airborneGap=120 vs 实测170`（像素没动，所以只管像素的 C18 仍绿 —— 两条判据分工正确） |
| M4 | **把 `r_ascend` 整体下移 10 native px**（母版下移 20），制造"左右一高一低" | C18（连带 C4a / C4c） | RC=1；`C18 ascend 右向=66 应为 76; ascend 右向 帧底=1387 应为 1377; ascend 左右不齐：76 vs 66` |

四例还原后 `node tools/check-jump.mjs` 均回到 `26/26 PASS` / `ALL PASS` / RC=0，变异备份文件与临时脚本已一并删除。

## 12. 交付范围：左右向交齐，仍禁止翻转冒充右向

- 本批交 **左向 5 帧（`facing=-1`）+ 右向 5 帧（`facing=+1`）**，`mirrorSafe=false`。
- `play`（4 段）、`edge`（3 帧）、`side`（2 帧）、`mini` 资产：**仍 deferred**。
  `review.fullBatchComplete=true` 只表示 jump 左右 10 帧交齐，**不代表 M2 整批完成**。
- **禁止把左向帧水平翻转当作右向交付**：角色有四类不可镜像件——头部蓝蝴蝶结、云朵发夹与蓝色发夹条、
  **内耳**（近侧耳白绒毛）、粉白蓬松尾巴。翻转后发夹/蝴蝶结的偏侧、内耳露出的那一侧、尾巴甩向全部会左右错位，
  与 `run`/`walk` 的 C10b（右向帧必须与任何左向帧的镜像差异 ≥5%）口径冲突。
  本轮右向的取证：C10b 实测每帧与"任一左向帧镜像"的最小差异 84.9%~90.0%（同相位配对 85.4%~90.2%），
  说明它们不是翻转来的。
- **右向怎么画出来的**（下一轮照这个做，别重新发明）：`generate_image` + 双参考图
  （同相位左向 native 保身份/笔触/姿态 + `run_r1_native.png` 给朝向示例）+ 提示词逐条压朝向
  （面部朝画布右、虹膜偏画布右、蝴蝶结与后脑在画布左、尾巴甩向画布左、四边留 8% 空白不许切边）。
  若生成结果里**虹膜落不进头部 40% 扫描带**（C10 会测不到），正确处置是**重出这一帧的构图**（把脸放在剪影上三分之一），
  不是放宽 C10 的带或阈值——本轮 `r_apex` 就是这样重出的（第一版虹膜 cy 落在 0.427 被截断，重出后回到带内、n=1023）。

## 13. 三个踩过的坑（写在这里，避免下一个人再死一次）

1. **`%ERRORLEVEL%` 在 cmd 同一行会被解析期提前展开**：`node x.mjs & echo %ERRORLEVEL%` 打印的是**上一条命令**的
   退出码（看起来永远是 0）。要么 `cmd /v:on /c "... & echo RC=!ERRORLEVEL!"`，要么 PowerShell 用 `$LASTEXITCODE`，
   要么先重定向输出再单独取。
2. **大图不要进对话上下文**：3072×3072 的母版一贴就把请求体顶到几十 MB，服务端会直接 `request_too_large` 掐断会话。
   要目视一律先缩到 ≤600px 宽另存再看（本目录 `qa/jump_review.png` 现在左右向四排共 1282×1236，也不能直接贴）；
   能用像素脚本回答的问题（bbox、占比、偏移量）就不要用眼睛数。
3. **生图配额要省着用**：一帧一图、逐帧看、逐帧判断；`generate_image` 拒绝写已存在的路径（"生图目标文件已存在"），
   重出稿必须先落到 `.lingxi/` 下的临时路径，验收后再替换正式文件，别指望原地覆盖。

## 14. 本轮判据修改清单（原口径 → 新口径）

| 判据 | 原口径 | 新口径 | 强度为何没降 |
|---|---|---|---|
| C1c | 扫到 IHDR 就 return，`chunks` 恒为 `['IHDR']`，`hasSrgb` 永远是 false | 扫**完整文件**得到真实块序列，`hasSrgb = chunks.includes('sRGB')` | 判据从"永远红"变成"真缺才红"，输出里直接打印每帧块序列作为证据 |
| C4b | manifest 的直出图 bbox 按 `alpha>=8` 记录，check 按 `alpha>=1` 比 → 5 帧 ×4 字段全假红 | 单一常量 `INK_ALPHA_MIN=8`（`tools/ink.mjs`），build 与 check 共用；**另加** `alphaExtent`（`alpha>0`）逐字段核对 | 口径从两套变一套，且校验字段由 4 个变成 8 个（墨迹框 + alpha 完整范围框都要逐字段相等），没有跳过任何 bbox |
| C5 | 拿母版（3072，2×）bbox 去比 manifest 里按 native 声明的区间，量级差 2 倍 | 拿 **native** 墨迹框比 native 区间，并强制 `batchBboxRange.unit === 'native'` | 区间数值一个没动（w[900,1400] h[1100,1500]），只是把单位对齐；额外增加"单位必须声明为 native"的断言 |
| C10 | 虹膜掩膜 `b-r>=60 && b>=120`（把蓝裙/披风吃进来，n=28021），偏移量失真 | 与 run 完全相同的掩膜 `b>=120 && b-r>=70 && g<=165 && r<=120` + 4-邻接（`tools/iris.mjs`），阈值仍是 200/0.35/60 | 阈值一个没降（60 未动）；探测器用 run 的 12 帧交叉验证：实测 −229/−168/−193/−209/−175/−157、+253/+230/+246/+202/+195/+156，与公布值最大偏差 0.5px |
| C16 | manifest 写 `innerEarFluff（近侧耳白绒毛）`，字面不含「内耳」 | manifest 改写为 `内耳（innerEarFluff，近侧耳白绒毛，镜像后会左右错位）` | 判据本身一行未改，仍要求四类部件（蝴蝶结/云朵发夹/内耳/尾巴）全部声明到，没有退化成"数组非空" |
| C2c | 判据不动（阈值仍 2%） | 判据不动，改为**修图**：descend 帧净化 1803 个半透明中性灰像素 | 阈值没动；用同一份度量在 run/walk/jump 三批上交叉验证，descend 在三种口径下都是 3.53%~3.62% ⇒ 真缺陷 |

## 15. 右向交付时对门禁的改动（左向严格度只增不减）

本轮**只改 `tools/check-jump.mjs`（+ `build-jump.mjs` 的 `--facing` 与右向配置、`make-review.mjs` 的排版）**，
没有新增第 6 份判据实现：`png.mjs` / `pixels.mjs` / `ink.mjs` / `iris.mjs` 全部照旧被 require 复用，阈值常量一个没动。

| 判据 | 改动 | 为什么不是"放宽左向" |
|---|---|---|
| C8 | 从"全批朝向必须同为 −1"改成"左右两组各 5 帧、各自朝向纯一、**组内** spread ≤2" | 左向组判据与原来等价（5 帧，spread 仍是 ≤2）；新增了右向组、组帧数、非法 facing 三条 |
| C10 | 从"全部为负"改成"符号 = 各自 facing"，另打印左右计数 | 阈值 60 / 面积 200 / 填充率 0.35 全部未动；左向仍是"必须为负" |
| C13 | 断言集合原样复制到两个朝向组，逐相位逐条跑 | 左向断言一条没删；右向同口径追加 |
| C16 | `fullBatchComplete` 由"必须 false"改"必须 true"，deferred 由"必须含右向"改"不许含右向"，另加 frames=10、左右各 5 | 都是**等值断言**，只是期望值跟着真实交付状态走；同时新增 3 条（frames 数 / facing 分布 / sources 数） |
| C17 | 从"全批共用一个 x"改成"按朝向取 byFacing"，另加严格镜像、右向 x 落在躯干墨迹内、组内 spread | 左向 x=700 与 ±2 容差原封不动；新增的镜像断言是算术（容差 0），比原来更硬 |
| C9c/C10b/C14b/C18 | 全新判据 | 纯新增（单朝向体积 / 镜像差异 / 逐组缩放 / 相位几何左右对齐），不影响任何左向判定 |

## 16. 左向零改动的证据（sha256 前后对照）

`git diff` 只显示新增文件；左向 15 个文件的 sha256 在交付前后逐字节相同（右向重建用 `--facing=1`，脚本根本没打开左向输出）：

| 文件 | sha256（交付前 = 交付后） |
|---|---|
| `jump_anticipate@2x.png` | `a57ea847fb147df7f9baf544650b68162eee9431b2c7d79aff7355811da14926` |
| `jump_ascend@2x.png` | `a105c4134632644daa7b6c3c3faeb7ab75c63c9e335c5442dcda7c7245f5f344` |
| `jump_apex@2x.png` | `e739da909ec6cefad5aa7bd4df25115e8a045562af630f88572d548436900daf` |
| `jump_descend@2x.png` | `f43195b4714bafab11e13637659506a071ea8640fd6697b0d567cff1ccad6e14` |
| `jump_land@2x.png` | `37ca6ba6dfa749d0f7f6032789c5559db02fde1a4b90f8bd2fe3012a62cb04b6` |
| `source/jump_anticipate_native.png` | `b8838fb12bd078853f39983e700140f16e8f0f2b528f3a9b32a45e8f265a4d31` |
| `source/jump_ascend_native.png` | `cf6bda9268b1e38c1077cd2ed27b92ddbe409337e1ff41bd8fe1d24a26eb0e8b` |
| `source/jump_apex_native.png` | `1565712a3950209684bb110eef357ee0b963e938acae9384e7971746465952fd` |
| `source/jump_descend_native.png` | `f7715eda3d9ed74fe2e826c56ff3fcaf475a170f02def720144d90996e32ee72` |
| `source/jump_land_native.png` | `3aa82de18be6c582fafc5315f504171e26970fdf8cbccafe09a14bf613bbdf94` |
| `source/jump_anticipate_generated.png` | `b2500e902a6af57d5b3a1f22ee999763c8033297c66e563013527bf763ccc714` |
| `source/jump_ascend_generated.png` | `ab1da80ce236f6df27521b7682a7659944ef91c6269054b1ef7615856ba280a1` |
| `source/jump_apex_generated.png` | `d518961e30f1b98d65d9adcf534dadfeba70e2325da1ce1a7f48ecabc8211aaf` |
| `source/jump_descend_generated.png` | `d0903a5bfa2b5da7af4c060266c0c7ec3542edc51798e3f6b31e02c24690862e` |
| `source/jump_land_generated.png` | `234541277e54c2ee040ff737b04d860191e3df454a288e6b8fc5add539cbf185` |
