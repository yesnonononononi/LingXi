# jump 批次（左向 5 帧）

桌宠「跳跃」动作的母版资产与门禁。**本批只交左向 5 帧**，右向 5 帧与 play/edge/side/mini 全部 deferred，
详见文末「交付范围」。

```
jump/
├── jump_{anticipate,ascend,apex,descend,land}@2x.png   母版 3072×3072（运行时只用这 5 张）
├── source/jump_*_generated.png                         生图直出原图 1254×1254（不参与运行时）
├── source/jump_*_native.png                            native 层 1536×1536（所有几何编辑都在这一层）
├── manifest.json                                        声明 + 实测（门禁逐字段核对）
├── qa/jump_review.png                                   人脸复核图（亮底/暗底双排）
└── tools/                                               build / check / review / 共享判据模块
```

## 1. 五帧与相位角色

| # | id | 相位角色 | 支撑/腾空 | airborneGap（native px） | 朝向 |
|---|---|---|---|---|---|
| 1 | `anticipate` | 起跳蓄力：双膝深屈、重心压低、双臂后摆 | 支撑帧（双脚着地） | 0 | 左 |
| 2 | `ascend` | 上升：蹬地离地、身体开始收 | 腾空 | 76 | 左 |
| 3 | `apex` | 最高点：收腿抱膝、墨迹最矮 | 腾空 | 170 | 左 |
| 4 | `descend` | 下落：伸腿准备落地 | 腾空 | 64 | 左 |
| 5 | `land` | 落地缓冲：重心再次压低吸收冲击 | 支撑帧（双脚着地） | 0 | 左 |

轴向口径：母版 3072×3072（`masterScale=2`）＝ native 1536×1536 的 **2× nearest**（C7 逐像素复核），
`anchor={x:1536,y:2908}`（水平中线 + 支撑帧最低墨迹 2907 的下方 1px），`display` 宽高 234（系数 0.07619）。

## 2. 支撑帧与腾空帧怎么判

不用"看起来像"，全部从像素复算（`tools/check-jump.mjs` 的 `footRuns`）：

1. 取 native 墨迹框底部往上 **90px 带**（`footBandNative=90`，≈墨迹高 6%），按列扫描得到若干**脚段** `[left,right]`；
2. 段的 `contactY` = 该段内最低墨迹 y；
3. `contactY >= 地面线(1453) − 3px`（`contactDepthNative=3`）的段记为 **support（着地）**，否则 `lifted`；
4. 帧内**存在 support 段** ⇒ 支撑帧，`contactPoints.support` 必须声明该段且与实测差 ≤2px；
   帧内**没有任何 support 段** ⇒ 腾空帧，`contactPoints.support=null` 且必须给出 `airborneGap = 1453 − 墨迹底边`。

本批结果：`anticipate`（support 975.5@1451）、`land`（865.5@1452）为支撑帧；`ascend/apex/descend` 的墨迹底边分别在
1377 / 1283 / 1389，离地量 76 / 170 / 64，三帧脚段全部高于地面线。

## 3. airborneGap 的裁决（76 / 170 / 64）

- `apex ≥ 120 native px` **且** `apex ≥ run 腾空帧(48) + 72`：这条来自用户裁决——jump 的"腾空"必须一眼和 run 的
  "小碎步腾空"分开。170 native ≈ 13 display px，是 run 的 3.5 倍。门禁里写成两条显式断言
  （`apexMinGapNative=120`、`gapMarginOverRun=72`），不是只比一个魔法数。
- `ascend(76) < apex(170) > descend(64)`：形成上抛再回落，且 `airborneMinGapNative=16` 保证另外两帧真的离地。
- 取值还要让**头顶弧线**单调：画布 1536 高、角色墨迹约 1376 高、脚踩 1453 时头顶只剩 78px 余量，因此"整体上移"
  最多约 58 native px。若按 70/132/64 取，ascend 的头顶(y=39)会高于 apex(y=57)，最高点反而"变矮"；
  取 76/170/64 后头顶 y = 78 → 34 → 20 → 35 → 74，才是连贯的上抛再回落。
- 腾空靠**整幅竖直纯平移**实现（`lowestInkY = 1453 − gap`），不做任何逐帧缩放：C14 用"同批单一缩放系数
  （实测 1.1219~1.1226，极差 0.00075）"+"腾空帧不得比支撑帧更宽（maxAirW 1085 < maxSupportW 1195）"把缩放伪造堵死。

## 4. bodyAnchor 的裁决

`bodyAnchor={x:700, y:1454, groundLineNative:1453, facing:-1, spreadNative:1}`。

- **x=700 是实测躯干质心**，不是画布中线 768、也不是 bbox 中线：估计器取"蓝裙簇（b−r≥45 且 b≥150 且 g<b−20）在
  墨迹高度 45%~85% 中段"的质心 x；5 帧实测 699.8 / 700.5 / 700.0 / 699.8 / 700.8，均值 700.2，**spread 1.01px**。
  尾巴把 bbox 拉向右，用 768 会把角色整体左移，与 run 左向的布局对不上。
- **y=1454 是地面参考线，不随帧底走**：腾空帧墨迹底边抬到 1377/1283/1389，`bodyAnchor.y` 仍是 1454
  （C17 专门断言"腾空帧帧底 = y−1−gap"）。引擎按这个锚点贴地，跳跃高度才由 gap 表达而不是由锚点漂移表达。

## 5. 画布 / native / 母版口径

- 生图直出 1254×1254 透明底；native 层 1536×1536；母版 3072×3072 = native 的 2× nearest（禁止任何插值）。
- 缩放系数**固定沿用 run 左向交付值 1.122249**，不按 jump 自身墨迹中位数算：5 帧全是蹲伏/腾空姿态，
  用其中位数（1207 gen px）会得到 1.140845，角色比 run 大 1.7%，换动作时会忽大忽小。
- 水平定位：躯干质心固定到 native x=700（与 run 左向同一套布局）；竖直定位：整幅平移到 `lowestInkY=1453−gap`。
- alpha 口径：straight（非预乘），`alpha<8` 一律清零、`alpha>=248` 提满、`<4 native px` 孤立块删除。

## 6. 体积

| 项 | 实测 | 上限 | 占比 |
|---|---|---|---|
| 本批 5 张母版合计 | 8,876,649 B（8.47 MB） | 5 × 1.9 MB = 9.5 MB | 89.1% |
| 单帧最大 | 1,934,388 B | 2,621,440 B（2.5 MB） | 73.8% |
| 六批母版合计（sit/lie/sleep/walk/run/jump） | 62.39 MB | 96 MB | 65.0% |

（每帧 1.9MB 的预算来自 §8 第二次修订：walk 之后 14 个母版实测 1.48–1.76MB/帧；全局 96MB 来自 §8 第三次修订，
原 64MB 会让 play 批次必然破线。）
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

## 8. 判据（C1–C17）一览

| 判据 | 内容 | 阈值/口径 |
|---|---|---|
| C1a/C1b | 画布 3072×3072；8bit RGBA、非隔行 | — |
| C1c | sRGB 块存在（**逐块扫完整文件**的真实块序列） | 期望 IHDR → sRGB → IDAT → IEND |
| C2a | `alpha<8` 必须全透明 | 0 像素 |
| C2b | 无 `<4 native px` 孤立块 | 0 像素 |
| C2c | 半透明中性灰脏边占比 | ≤2%（见 §7） |
| C3a | 四边留白 | ≥8px |
| C3b | 支撑帧最低像素与 anchor.y 偏差 | ≤2px |
| C4a | frames[] 的母版/native bytes+sha256+bbox | 逐字段相等 |
| C4b | sources[] 直出图 bytes+sha256+**墨迹框**+**alpha 完整范围框** | 逐字段相等（两套口径都验） |
| C4c | contactPoints 与实测 | ≤2px；腾空帧 support=null + gap 对账 |
| C5 | 墨迹框在声明区间内 | **native 对 native**：w[900,1400] h[1100,1500]，且 `batchBboxRange.unit` 必须是 `native` |
| C7 | 母版 = native 的 2× nearest | 逐像素 0 差异 |
| C8 | 同批画布/锚点/朝向一致 + 躯干横向零抖动 | spread ≤2px（实测 1.01） |
| C9 | 体积：单帧 ≤2.5MB 且合计 ≤帧数×1.9MB | 见 §6 |
| C9b | 六批母版合计 ≤96MB | 62.39MB |
| C10 | 虹膜朝向：偏移符号=facing，偏移绝对值 >= 60 | 探测器 = `tools/iris.mjs`（与 run 同一掩膜） |
| C13 | 腾空判据（support=null + gap>0 + apex≥120 且 ≥run48+72 + ascend<apex>descend + 双脚高于地面线） | 见 §2/§3 |
| C14 | 禁整体缩放（单一缩放系数 / 腾空帧不得更宽 / 宽度不随 gap 增加） | 极差 ≤0.004 |
| C15 | 5 帧母版/native sha256 互不相同 | 无重复副本 |
| C16 | §6.1 必备键 + `nativeSourceCanvas×masterScale=canvas` + `mirrorSafe=false` + 四类不可镜像件 + deferred 清单 | 蝴蝶结/云朵发夹/内耳/尾巴 四类都必须声明到 |
| C17 | bodyAnchor（x=实测质心±2 / 同批 spread≤2 / y=地面线±2 / 腾空帧不跟帧底） | 见 §4 |

## 9. 工具与共享判据模块

```
tools/png.mjs      PNG 编解码（纯 Node，零依赖；只支持 8bit 非隔行，解码统一转 straight RGBA）
tools/ink.mjs      墨迹阈值 + bbox + 中性灰脏边判定 + alpha 卫生度量（build 与 check 共用）
tools/iris.mjs     虹膜连通块探测器 + 头部墨迹质心 + C10 阈值（build 实测与 check 判据共用）
tools/build-jump.mjs   generated → native → 母版；`--report=<file>` 可导出完整实测 JSON
tools/check-jump.mjs   门禁（22 条），全部断言从磁盘像素复算，不信任 build 输出
tools/make-review.mjs  生成 qa/jump_review.png（亮底/暗底，234px 引擎显示宽）
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
:: 重建母版 + native（4 帧逐字节可复现；descend 会顺带做脏边净化）
node docs\assets\desktop-pet\poses\jump\tools\build-jump.mjs
:: 额外导出完整实测（bbox/体积/朝向/净化像素数），用于同步 manifest
node docs\assets\desktop-pet\poses\jump\tools\build-jump.mjs --report=.lingxi\tmp\jumpcheck\build-report.json
:: 人脸复核图
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

## 12. 交付范围：只交左向，禁止翻转冒充右向

- 本批**只交左向 5 帧**（`facing=-1`，`mirrorSafe=false`）。
- 右向 5 帧、`play`（4 段）、`edge`（3 帧）、`side`（2 帧）、`mini` 资产：**全部 deferred**，`review.fullBatchComplete=false`。
- **禁止把左向帧水平翻转当作右向交付**：角色有四类不可镜像件——头部蓝蝴蝶结、云朵发夹与蓝色发夹条、
  **内耳**（近侧耳白绒毛）、粉白蓬松尾巴。翻转后发夹/蝴蝶结的偏侧、内耳露出的那一侧、尾巴甩向全部会左右错位，
  与 `run`/`walk` 的 C10b（右向帧必须与任何左向帧的镜像差异 ≥5%）口径冲突。右向必须独立重出。

## 13. 两个踩过的坑（写在这里，避免下一个人再死一次）

1. **`%ERRORLEVEL%` 在 cmd 同一行会被解析期提前展开**：`node x.mjs & echo %ERRORLEVEL%` 打印的是**上一条命令**的
   退出码（看起来永远是 0）。要么 `cmd /v:on /c "... & echo RC=!ERRORLEVEL!"`，要么 PowerShell 用 `$LASTEXITCODE`，
   要么先重定向输出再单独取。
2. **大图不要进对话上下文**：3072×3072 的母版一贴就把请求体顶到几十 MB，服务端会直接 `request_too_large` 掐断会话。
   要目视一律先缩到 ≤600px 宽另存再看（本目录 `qa/jump_review.png` 是 1282×620，也不能直接贴）；
   能用像素脚本回答的问题（bbox、占比、偏移量）就不要用眼睛数。

## 14. 本轮判据修改清单（原口径 → 新口径）

| 判据 | 原口径 | 新口径 | 强度为何没降 |
|---|---|---|---|
| C1c | 扫到 IHDR 就 return，`chunks` 恒为 `['IHDR']`，`hasSrgb` 永远是 false | 扫**完整文件**得到真实块序列，`hasSrgb = chunks.includes('sRGB')` | 判据从"永远红"变成"真缺才红"，输出里直接打印每帧块序列作为证据 |
| C4b | manifest 的直出图 bbox 按 `alpha>=8` 记录，check 按 `alpha>=1` 比 → 5 帧 ×4 字段全假红 | 单一常量 `INK_ALPHA_MIN=8`（`tools/ink.mjs`），build 与 check 共用；**另加** `alphaExtent`（`alpha>0`）逐字段核对 | 口径从两套变一套，且校验字段由 4 个变成 8 个（墨迹框 + alpha 完整范围框都要逐字段相等），没有跳过任何 bbox |
| C5 | 拿母版（3072，2×）bbox 去比 manifest 里按 native 声明的区间，量级差 2 倍 | 拿 **native** 墨迹框比 native 区间，并强制 `batchBboxRange.unit === 'native'` | 区间数值一个没动（w[900,1400] h[1100,1500]），只是把单位对齐；额外增加"单位必须声明为 native"的断言 |
| C10 | 虹膜掩膜 `b-r>=60 && b>=120`（把蓝裙/披风吃进来，n=28021），偏移量失真 | 与 run 完全相同的掩膜 `b>=120 && b-r>=70 && g<=165 && r<=120` + 4-邻接（`tools/iris.mjs`），阈值仍是 200/0.35/60 | 阈值一个没降（60 未动）；探测器用 run 的 12 帧交叉验证：实测 −229/−168/−193/−209/−175/−157、+253/+230/+246/+202/+195/+156，与公布值最大偏差 0.5px |
| C16 | manifest 写 `innerEarFluff（近侧耳白绒毛）`，字面不含「内耳」 | manifest 改写为 `内耳（innerEarFluff，近侧耳白绒毛，镜像后会左右错位）` | 判据本身一行未改，仍要求四类部件（蝴蝶结/云朵发夹/内耳/尾巴）全部声明到，没有退化成"数组非空" |
| C2c | 判据不动（阈值仍 2%） | 判据不动，改为**修图**：descend 帧净化 1803 个半透明中性灰像素 | 阈值没动；用同一份度量在 run/walk/jump 三批上交叉验证，descend 在三种口径下都是 3.53%~3.62% ⇒ 真缺陷 |
