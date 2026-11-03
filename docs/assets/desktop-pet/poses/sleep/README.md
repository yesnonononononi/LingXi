# sleep 批次资产（M2）

趴睡 / 呼吸 / 惊醒 / 蜷睡共 5 个关键帧。全部落在 3072×3072 母版画布、native 1536×1536、锚点 `(2578, 2909)`（与 `lie` 同口径）。

**状态：`awaiting-static-review`**。`manifest.review.approvedBy` 为 `null`，未自封通过。

## 1. 交付清单

| 帧 | 母版 | bytes | sha256（前 12） | native bbox（母版坐标） |
| --- | --- | --- | --- | --- |
| 趴睡闭眼 | `sleep_neutral@2x.png` | 1,694,657 | `d645872051ad…` | `{42,1292,3047,2937}` |
| 呼吸·吸气 | `sleep_breath_in_neutral@2x.png` | 1,681,561 | 见 manifest | `{42,1292,3047,2937}` |
| 呼吸·呼气 | `sleep_breath_out_neutral@2x.png` | 1,682,630 | 见 manifest | `{42,1292,3047,2937}` |
| 惊醒 | `sleep_startle_neutral@2x.png` | 1,717,656 | 见 manifest | `{42,1292,3047,2937}` |
| 蜷睡 | `sleep_curled@2x.png` | 1,130,741 | 见 manifest | `{88,1726,2987,2935}` |

> 完整 bytes / sha256 / bbox 以 `manifest.json` 为准，并由 `check-sleep.mjs` 逐值复算（C4）。母版合计 **7,907,245 B ≈ 7.54 MB**，未超 §1.8 的 8 MB；5 帧像素各不相同，**没有任何 aliases 复用**（不做假去重）。

```
sleep/
├── sleep_neutral@2x.png              趴睡闭眼（本批基准帧）
├── sleep_breath_in_neutral@2x.png    吸气（派生）
├── sleep_breath_out_neutral@2x.png   呼气（派生）
├── sleep_startle_neutral@2x.png      惊醒（派生）
├── sleep_curled@2x.png               蜷睡（重新生成）
├── manifest.json                     帧/源/方法/接触点/状态
├── README.md
├── qa/sleep_review.png               亮底+暗底复核图（2491×1189）
├── source/                           直出图 + native + 蒙版
└── tools/                            build-sleep / derive-sleep / build-curled / check-sleep / make-review / png / pixels
```

`source/` 里只放「生图直出 + native 归一化图 + 蒙版」，**不放参考图/垫图/中间拼接**（§1.8 第 2 条）。`tools/` 下 4 个脚本是**可复现构建链**，不是一次性过程脚本，保留并在此说明用途：

| 脚本 | 用途 |
| --- | --- |
| `tools/build-sleep.mjs` | 趴睡帧：lie 原像素 + 眼区贴片确定性合成 |
| `tools/derive-sleep.mjs` | 呼吸 2 帧（躯干位移场）+ 惊醒帧（虹膜收缩/小开口嘴/汗滴） |
| `tools/build-curled.mjs` | 蜷睡帧：直出图归一化 + 质心对齐 + 2× nearest 出母版 |
| `tools/check-sleep.mjs` | 门禁 C1–C13 |
| `tools/make-review.mjs` | 生成 `qa/sleep_review.png` |

## 2. 每帧是怎么来的（可机验，不靠口头）

| 帧 | 做法 | 关键证据 |
| --- | --- | --- |
| 趴睡 | 对 `lie/source/lie_neutral_native.png` 只重绘眼区（参考图 + 眼区蒙版模式），其余像素原样 | 与 lie native 逐像素差异 **38,095 px 全部落在眼区并集 `[322,1116,644,1290]` 内，眼区外 0 px / maxDelta 0** |
| 呼吸 2 帧 | 只对躯干带 `x 830..1350` 做**局部竖直位移场**（位移场峰值：吸气 +14 / 呼气 −10 native px；墨迹上沿实测只有 +2 / −10，原因见 `manifest.method.breath`），横向余弦窗两端归零、纵向 smoothstep、腹部落地侧位移恒为 0 | 带外 0 px / maxDelta 0；四帧 alpha 外轮廓逐值相同（不是整体缩放）；234px 显示尺度上两帧差 **9.01%** 墨迹 |
| 惊醒 | 眼区整块取 lie native 恢复睁眼 → 虹膜掩膜距离变换后**半径腐蚀 15%**、腾出环带补眼白（眼白取环外亮像素均值）→ 小开口嘴 → 泪滴汗滴 | 眼区/嘴/汗滴三块各自有变化（19041 / 19054 / 416 / 802 px）；眼区蓝色像素比 **0.775**（≈缩 15%） |
| 蜷睡 | 唯一重新生成的帧：`reference_image_path=sleep_neutral_native.png` 保身份；直出 1774×887（墨迹 1737×725，比例 2.396）→ 预乘 alpha 重采样到 native 1450×605 → 落地线 y=1468 → 2× nearest | 与趴睡 **IoU 0.684**，native bbox 由 1503×823 变 **1450×605**（母版 bbox `{88,1726,2987,2935}`）；母版 2×2 块不一致 0 |

**为什么惊醒帧不套用「蒙版外零变化」**：汗滴落在首帧蒙版右边界之外（嘴 x474..503、汗滴 x667..696，而 `eye_mask_native.png` 透明区只到 x644）。正确做法是**显式声明作者区域并集**，而不是放宽阈值：

```
allowedRegions(startle) = eyeLeft{322,1140,448,1290} ∪ eyeRight{518,1116,644,1268}
                        ∪ mouth{474,1264,503,1287} ∪ sweat{660,1150,703,1207}
```

C6b 断言的就是「并集之外 outsidePixels=0 且 outsideMaxDelta=0」——**没有放宽，也没有跳过**。`manifest.method.maskScope` 里也写明该蒙版是**首帧专属**，不代表整批共用。

## 3. 怎么一眼复核（`qa/sleep_review.png`）

图分三排，**同一尺度**：第 1 排亮底（#F2F3F5）、第 2 排暗底（#1A1C22）、第 3 排是脸部同框放大（裁剪框统一 `{640,2200,1440,2620}` 母版坐标）。数字徽标对应：

```
1 lie 睁眼基准   2 趴睡闭眼   3 吸气   4 呼气   5 惊醒   6 蜷睡
7 趴睡脸  8 惊醒脸  9 蜷睡脸
```

一眼要看的三件事：

1. **2 vs 1**：只有眼睛从睁变闭，耳朵、发丝、衣摆、尾巴、轮廓一点没动 → 这才是「趴睡」而不是「lie 换个表情」。
2. **3 vs 4**：盯背部/胸腹上缘那条线，吸气的轮廓明显比呼气高一截（母版 28px），肚子贴地那条线两帧一样。
3. **6 vs 2**：6 是侧躺、尾巴裹到身前、整体压低并变窄；IoU 0.684 说明它不是趴平帧改出来的。**5** 则是睁眼 + 小开口嘴 + 汗滴，缩略图就能看出「被吓到」。

## 4. 门禁

```
node docs/assets/desktop-pet/poses/sleep/tools/check-sleep.mjs
```

14 条断言，退出码 0/1：

| ID | 断言 |
| --- | --- |
| C1 | 母版 3072×3072 / native 1536×1536，8bit RGBA、非隔行（直接解析 IHDR） |
| C2 | `0<alpha<8` 一律清零、`248<=alpha<255` 一律提到 255（无灰边）、无 <4px 孤岛 |
| C3 | 可见 bbox 四边留白 ≥8px |
| C4 | manifest 的 bytes/sha256/bbox 与磁盘逐值一致（母版与 native 都查） |
| C5 | 母版 = native 的 2× 最近邻：每个 2×2 块四像素相同且等于 native 对应像素 |
| C6 | neutral / breathIn / breathOut / startle 四帧 alpha 外轮廓**逐值相同**（防整体缩放、防偷偷改轮廓） |
| C6b | 每帧在「作者声明区域并集」之外与 neutral **逐像素零变化**（outsidePixels=0 且 outsideMaxDelta=0） |
| C7 | 呼吸两帧带内变化 >5000px，且带中央列平均背部上沿吸气高于呼气 >4px（方向对、幅度非零） |
| C8 | 呼吸两帧在 **234px 显示尺度**差异 ≥8% 墨迹（实测 9.01%） |
| C9 | 蜷睡与趴睡 IoU<0.75 且 bbox 至少两处不同（实测 IoU 0.684） |
| C10 | `source/` 直出图+native+蒙版齐全，manifest.sources 与磁盘一致 |
| C11 | `status === 'awaiting-static-review'` 且 `review.approvedBy === null` |
| C12 | 惊醒帧虹膜蓝色像素比落在 0.65–0.92（对照 lie 睁眼帧），实测 0.775 |
| C13 | 惊醒帧 眼左/眼右/嘴/汗滴 四块各自都有变化 |

### 变异自检（证明门禁真会变红）

| 变异 | 改坏了什么 | 退出码 | 命中断言 | 还原后 |
| --- | --- | --- | --- | --- |
| M1 | 在 startle 声明区域之外（native 100,100）点 1 个像素 | 1 | C2, C4, C6, **C6b** | 退出码 0 ✅ |
| M2 | 把吸气帧整帧替换成中性帧（等于呼吸振幅归零） | 1 | C4, **C6b, C7, C8** | 退出码 0 ✅ |
| M3 | 把蜷睡帧整帧替换成趴睡帧（等于没蜷起来） | 1 | C4, **C9** | 退出码 0 ✅ |

还原后逐字节比对三次变异的 8 个文件，全部与备份相同（`restored-all-identical=true`）。C4 同时变红是正确行为：文件一变，manifest 记录就漂了。

## 5. 切帧摆放规则（蜷睡帧的 anchor 说明）

- `anchor (2578, 2909)` 是**画布级/批级定位点**（继承自 `lie`，五个帧共用；该点本身不在墨迹上）。**但「切帧时角色不位移」并不成立**：各帧姿态不同，墨迹在画布内的分布也不同。实测（定义：最底 3 行 alpha>128 的墨迹 x 范围的取中）趴睡接地带中心 `x=482`，蜷睡 `x=1028`，**右移 546 native px ≈ 84 display px**（按 234 宽换算）。因此切帧必须按 `frames[].contactPoints` 摆放，不能假设「角色位置不变」。（与主理人邮件里的 549 native px 差 3px，差异来自取值行数/alpha 阈值，此处按本仓实测 546 写入。）
- 蜷睡是紧凑侧躺，接地位置与趴姿不同。**为了把横向跳动压到最小**，蜷睡帧按 **alpha 质心对齐趴睡帧**摆放：趴睡质心 native x=698.1，蜷睡实测 698.0（Δ0.1px）；但质心对齐不等于接地带对齐，见上一条。
- 接地支撑带仍不同（趴睡最底 3 行 `x442..522`，蜷睡 `x992..1064`），因此 `manifest.frames[curled].contactPoints` **单独声明**了该帧实测接触点：`belly(2068,2908) / palmFront(1846,2908) / foot(2290,2908)`（母版坐标）。
- 引擎约定：**摆放用 `anchor`，落点/特效挂点用「当前帧的 `contactPoints`」**。若引擎只能读批级 `contactPoints`，蜷睡帧的接触点会偏，这一点写在「未决项」里等拍板。

## 6. 体积（§1.8）

| 项 | 值 |
| --- | --- |
| 5 个母版合计 | 7,907,245 B = **7.54 MB**（目标 ≤8 MB ✅） |
| 重复存储 | 0（5 帧像素互不相同，没有相同 sha256 的文件，不需要 aliases） |
| `source/` 合计 | 1,111,666 + 14,104 + 1,534,971 + 各 native ≈ 5.4 MB（直出图与 native 是 C10 要求，未额外压） |

> 蜷睡直出图为 1774×887（模型返回尺寸），与 `sleep_neutral_generated.png` 的 1254×1254 不同，属正常：两者都由同一模型直出，只是构图比例不同。

## 7. 未决项

1. **蜷睡帧的 `anchor` 落在该帧透明区内**（质心已对齐，视觉不跳，但该点不在墨迹上）。若引擎用 `anchor` 做落地判定，蜷睡帧会「悬空」；两种解法：a) 引擎按帧切 `contactPoints`；b) 主理人批准把蜷睡帧整体右移，让 anchor 落在墨迹上（会牺牲质心对齐）。请拍板。
2. `qa/sleep_review.png` 由 `tools/make-review.mjs` 确定性生成，并已用像素探针自检（底板色正确、9 个格位墨迹率 24.7%–98.7%、放大条不越界、下边距 32px）；但**本轮看图配额已用尽，人眼终检未做**，请主理人过目一眼。
3. `manifest.review.deferredUntilApproval` 已清空（三项均已产出）；`fullBatchComplete` 置 `true`（本批 5 帧齐），但 `approvedBy` 保持 `null` —— 生产完成 ≠ 已验收。
