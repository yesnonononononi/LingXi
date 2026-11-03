# 桌宠 M1 逐档验收台账（E01–E08 + wink）

> 依据：`docs/desktop-pet-m1-design.zh-CN.md` §5（E01–E08 入口表）、§11.1（R1–R9）、§11.2（P1–P6）、§11.3（M1–M8）。
> 被测提交：`7c4cf70b`（分支 `feature/desktop-pet-visual`，工作树 = 本台账同批新增的 T05 测试脚本与文档）。
> 验收日期：2026-11-03。环境：Windows 11 / Node v24.20.0 / Vite 7.3.6 / Electron（仓库内 `frontend/node_modules/electron`）。

## 1. 验收口径（不许降级的三条）

1. **真实入口**：每一档都从真实用户操作走起（身体点击 / 头部抚摸 / 连点 / 长拖拽 / 闲置），
   **没有一处调用 `petDebug.forceState()`**；闲置 60s / 90s 用**预注入虚拟时钟**（`Date.now` 缩放 + `advance(ms)`）
   让状态机"真的"认为过去了 60s / 90s，行为层一行未改。
2. **像素 + 来源双证**：每档都要求「脸区 ROI 像素变化 ≥ 阈值」+「隐藏 face 层后同一入口的变化归零」+
   `.pet-art-frame` 的 `opacity=0`、face 层 `opacity=1`、`getClientRects()>0`。
   不接受"指令已委托给 fallback"这类自证。
3. **渲染环境**：Electron **offscreen**（`webContents.sendInputEvent` 派发真实指针事件）。
   浏览器里 `page.mouse.click` 不可信——穿透态由主进程 IPC `reconcileFromMain` 驱动，浏览器无 IPC 会退化。

守卫命令：`npm run guard:pet:face`（= `electron scripts/pet-face-visual-guard.cjs`）。
截图落 `.lingxi/tmp/pet-face-guard/<commit>/<档位>.png`（ROI 裁片）与 `<档位>-window.png`（整窗）。

## 2. 逐档结论表

ROI 固定复算（不读被测代码的渲染结果）：窗口 196×348 CSS px，脸区 ROI = `62.66,177.05 60.33×30.47`，
头部点击点 `93,192`，身体点击点 `98,283`。

| 档位 | 真实入口 | 触发事件 → 状态 | 下发指令 | 截图 | 实测 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| S0 稳定性 | 两帧对照 | — | — | — | 同状态两次截图逐字节一致（0.00%） | PASS（测量可信） |
| E01 neutral | 冷启动 | `boot` → `idle` | `expression neutral base prio0` | `E01`/`neutral.png` | roiDelta 0.00%（基线） | PASS |
| E07 happy | 身体单击 | `pointerdown`→tap → `behavior:tap` | `expression happy base prio0` | `happy.png` | roiDelta **39.28%** | PASS |
| E05 angry | 身体连点 ×3（220ms） | `tapStreak≥2` → `behavior:angry` | `expression angry base prio0` | `angry.png` | roiDelta **31.89%** | PASS |
| E05 对照 | 同上 + 隐藏 face 层 | 同上 | 同上 | `angry-face-hidden-control.png` | roiDelta **0.00%**、faceOpacity=0 | PASS（来源对照成立） |
| E06 shy | 头部连点 ×2（300ms） | `pet`（抚摸优先）→ `behavior:pet` | `expression shy base prio0` | `shy.png` | roiDelta **44.06%** | PASS |
| E02 wink | 头部连点 ×2 后静置 | `pet` 收场 → 回礼 | `expression wink base prio0` | `wink.png` | roiDelta **15.83%** | PASS |
| E02 对照 | 自然眨眼 | `BlinkDriver` 随机定时 | `expression blink` | `blink.png` | wink vs blink 差异 **16.28%** | PASS（wink 未被双眼闭顶替） |
| E01 回落 | wink 后静置 | 一次性状态自收场 | `expression neutral` | — | roiDelta **0.00%**（逐字节回基线） | PASS |
| E08 sleepy | 无交互 60s（虚拟时钟 ×60） | 闲置阈值 → `behavior:sleepy` | `expression sleepy + motion sleepy(loop)` | `sleepy.png` | roiDelta **32.28%** | PASS |
| E08 sleeping | 无交互 90s（虚拟时钟 ×60） | 再闲 30s → `behavior:sleep` | `expression sleepy（无 TTL）` | `sleeping.png` | roiDelta **32.28%** | PASS（单档可见） |
| E08 两档差异 | 60s vs 90s 静态帧 | — | — | 同上两图 | roiDelta **0.00%** | **FAIL（见 §5 已知问题）** |
| E08 两档差异（时间维度） | 60s / 90s 各观察 10s | `BlinkDriver` 睡眠抑制 | — | — | 10s 内眨眼：困倦 **2** 次 / 真睡 **0** 次 | PASS（真睡确实抑制眨眼） |
| E03 surprised | 睡着时点醒 | `behavior:wake` | `expression surprised base prio0` | `surprised.png` | roiDelta **38.72%** | PASS |
| E03 回落 | 唤醒后 700ms | 一次性状态自收场 | `expression neutral` | — | roiDelta **0.00%** | PASS |
| E04 sad | 长拖拽 ≥1200ms 松手 | `drag` 松手计时 → `behavior:sad` | `expression sad base prio0` | `sad.png` | roiDelta **30.67%** | PASS |

每一行 PASS 的判定同时包含：`compositeMode=layered`、`faceOpacity=1`（对照组为 0）、
`frameOpacity=[0,0]`、`faceSrc` 含 `face/<expr>@`、`faceRects>0`、以及 `document.elementFromPoint` 命中的是层元素本身
而不是穿透到宿主。

## 3. P1–P6 对照（§11.2）

| 编号 | 判据 | 对应实现/证据 | 结论 |
| --- | --- | --- | --- |
| P1 | layered 下 E01–E08 每档脸区 ROI 变化 ≥0.8% | 上表 8 档最小 15.83%（wink） | PASS |
| P2 | wink ≠ blink（像素必须不同） | `blink.png` vs `wink.png` 差异 16.28% | PASS |
| P3 | 唤醒后同像素回基线 | E01/E03 回落两行均为 0.00% | PASS |
| P4 | 60s 档 `sleepy`、90s 档进入 `sleeping`，**两档 ROI 不一致** | 单档均达标；两档静态帧一致 | **FAIL**（已知问题 1） |
| P5 | 隐藏 face 层后变化消失（来源对照） | `angry-face-hidden-control` 0.00%、faceOpacity=0 | PASS |
| P6 | `.pet-art-frame` opacity=0 且 face opacity=1 / clientRects>0 | 每一行都记录并断言 | PASS |

## 4. 对抗组 Q1 / Q2（主理人额外要求：抚摸优先 vs 连点生气）

同一份 offscreen 环境，同一头部/身体坐标，**每点一下立刻读状态**（生气只维持约 1200ms，点完再采样必错过）。

| 组 | 命令入口 | 逐次表情序列 | 结论 |
| --- | --- | --- | --- |
| Q1 头部连点 ×3 | `head-tap×3(250ms)` | `happy → shy → happy`，全程无 `angry`；shy 脸区 ROI 变化 44.06% | **PASS**：抚摸优先成立 |
| Q2 身体连点 ×3 | `body-tap×3(250ms)` | `happy → angry → happy`（第 2 或第 3 下必出 `angry`） | **PASS**：身体连点仍能生气 |

结论：主理人手工点 angry 没反应，**不是**"抚摸优先把生气吞掉"，而是浏览器里点击不保真（穿透态没有 IPC 驱动）
+ 生气只有约 1200ms 窗口；真实入口在 offscreen 里稳定复现。

## 5. 已知问题（未修复项，按口径不许放宽断言）

1. **E08 两档静态帧逐像素一致**：`state-machine.ts` 的 `enterSleepy()` 与 `enterSleeping()` 下发**完全相同**的
   `expression sleepy + motion sleepy`，且脸贴片只有 `sleepy`（`public/live2d/pet-p1/face/` 下无 `sleeping@1x.webp`）。
   硬证据：`.lingxi/tmp/pet-face-guard/7c4cf70b/sleepy.png` 与 `sleeping.png` 的 SHA256 完全相同
   （`54B8D56EE0B1BFAC…`），ROI 差异 0.00%。
   ⇒ §11.2 P4 的"两档 ROI 不一致（困倦 ≠ 闭眼）"字面口径不满足；两档唯一的可区分依据是时间维度（真睡抑制眨眼，
   实测 10s 内 2 次 vs 0 次）。设计 §5 的触发表自身写的是"sleeping 沿用现有闭眼/困倦表现"，与 P4 互相矛盾，需架构师裁定：
   补 `sleeping` 贴片（或把 sleeping 映射到闭眼贴片），或修订 P4 口径。
   因此整条验收链 `gate:pet && test:pet && build && check-pet-not-shipped && guard:pet:face` 目前**止步于守卫**
   （前四步全绿，守卫 17/18），在裁定前不放宽该断言。
2. E08 的眨眼观察依赖真实 10s 窗口，两档各 +10s，整轮守卫因此约 90s。

## 6. 变异验证（§11.3 M1–M8）

命令：`npm run test:pet:mutate`（`frontend/scripts/pet-dev-mutation-selfcheck.mjs`，逐字节还原 + 还原后重跑必须重绿）。

| §11.3 编号 | 变异体 id | 抓手 | 结果 |
| --- | --- | --- | --- |
| M1 隐藏 face 层 | `face-layer-hidden` | R2 + P5 | 变红 ✓ |
| M2 取消回落 | `fallback-removed` | R3 | 变红 ✓ |
| M3 混淆 rect / pivot | `face-placement-dropped` | R1（`data-placement`）+ P1 | 变红 ✓ |
| M4 wink 顶替 blink | `wink-takes-blink` | R4 + P2 | 变红 ✓ |
| M5 关闭 faceTile 资源选择 | `face-tile-selection-off`（**本次新增**） | R2（贴片 URL ≠ 整帧 URL） | 变红 ✓ |
| M6 half 回收 sleepy | `half-back-to-sleepy` | R4 + R7 | 变红 ✓ |
| M7 门禁恒真 | `gate-always-enabled` / `pet-window-ungated` | T06 门禁断言 | 变红 ✓ |
| M8 pet 入口回流构建 | `pet-entry-back-in-build` / `pet-data-back-in-build-files` | `check-pet-not-shipped` | 变红 ✓ |

M5 之前没有变异体覆盖：新增变异体第一次跑是**全绿**（测试守不住），因此补了一条 R2 用例
（`petFaceLayer.test.ts`："贴片与整帧两套 URL 同时存在时，脸层必须取贴片"），把 整帧 URL 与贴片 URL 都设成
同一 id 的不同值，之后变异体才变红——这就是"假绿"被抓到的过程记录。

## 8. 附录：跨 DPI / 多显示器窗口位置取证（只出结论，未改代码）

现象（主理人报告）：桌宠窗口物理 297×527，位置在副屏 `X=3042 Y=-80`；而 `pet-window-state.json`
里持久化的是 248×399，与 150% DPI 下的 196×348 逻辑尺寸都不一致。

实测与实验（本次复核）：

1. **显示器为"混 DPI"**：Electron 侧 `screen.getAllDisplays()`
   - `id=1102200686`（主）`scaleFactor=1`，bounds `0,0 1920×1080`，workArea `0,0 1920×1032`；
   - `id=1129001747`（副）`scaleFactor=1.5`，bounds `1920,-238 1707×961`，workArea `1920,-238 1707×913`。
2. **HEAD 代码建出来的窗口就是 196×348（DIP）**：用 `pet-geometry.json` 推导出的尺寸，按 `pet-window.cjs`
   完全相同的窗口参数建一个隐藏窗口，`getBounds()`/`getContentBounds()` 都返回 `196×348`，
   渲染层 `devicePixelRatio=1`（在主屏上）；`win.getBounds()` 全程是 **DIP**，不是物理像素。
3. **297×527 与 196×348 是同一扇窗**：两者比值 1.5153 / 1.5144，**比值一致**（≈ 副屏 1.5 缩放 + 边框/阴影），
   属于**合法 DPI 换算**（物理 = DIP × scaleFactor），不是错位。
4. **248×399 不可能由当前代码产生**：比例 1.265 / 1.147 **不一致**，非同一次 DPI 换算；
   而 `resolveInitialBounds()` 恢复时**只取 saved.x / saved.y**，尺寸一律用当前几何（`normalizeDimension(size.width, PET_WIDTH)`），
   所以状态文件里的旧 width/height 根本不会被采用 ⇒ "尺寸跨 DPI 恢复错位"这条路径在代码上不存在。
5. **位置不会被推出屏幕**：`pickDisplay()` 按面积比例选屏，`visibleRatio < MIN_VISIBLE_RATIO(0.4)` 才回默认角落，
   否则 `clampRectToWorkArea()` 把窗口整体夹进那块 workArea；`display-removed` / `display-metrics-changed`
   还会 `reclampIntoDisplays()`。DIP 域内比较，不存在"状态存物理像素、恢复按 DIP 读"的换算缺口。
6. **脚底对不上工作区**：副屏 workArea 底边 = `-238 + 913 = 675`（DIP）。窗口若停在 y=-53（= 物理 -80 / 1.5），
   底边只有 295 DIP，离工作区底边还有 380 DIP——桌宠悬在半空。这**不是换算缺陷**，而是"上次拖到哪就恢复哪"
   的设计（代码只保证"可见"，不吸附底边）。

未解释项（需工程师确认，非本次可证伪）：当前在跑的实例（PID 54428）实测物理 289×478、`GetDpiForWindow=96`，
其 `pet-window-state.json` 也是 `289×478`。按 HEAD 代码该窗口只能是 196×348（且 `pet-window.cjs` 里
**没有任何** `setBounds`/`setSize`，建窗后尺寸不可变），所以这个实例的几何来源与当前工作树不一致，
最可能是**存量实例/存量状态文件**（启动于 16:32，状态文件 updatedAt 17:03）。
建议（不改代码）：停掉该实例、删掉 `pet-window-state.json` 后重启，尺寸应回到 196×348；若仍是 289×478，
则说明还有第二条改尺寸的路径，需要单独排查。

## 9. 复现

```bash
cd .lingxi/work/desktop-pet-visual/frontend
npm run gate:pet && npm run test:pet && npm run build && node scripts/check-pet-not-shipped.mjs
npm run guard:pet:face            # 全档画面守卫（约 90s）
npm run test:pet:mutate           # 18 个变异体（约 70s）
```
