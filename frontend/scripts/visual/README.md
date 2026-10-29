# 视觉回归门禁（明暗双态像素比对）

> 用途：主题令牌化改造期间，`gate:theme` 只能证明「色值等价」，看不见**布局位移、圆角、字距、模糊、发光退化**。
> 本目录补上这一层：启动 dev server → 无头浏览器截图（明/暗各一套）→ 与基线逐像素比对 → 超阈值退出码 1。

## 依赖

零 npm 依赖。脚本用**本机已有的 Playwright 浏览器缓存**里的 `chrome-headless-shell` + 原生 CDP（Node 24 内置 WebSocket）。

- 若本机没有该缓存，`capture.mjs` 会报「找不到 chrome-headless-shell」——需要先装 Playwright 的浏览器（或改 `cdp.mjs` 里的浏览器发现逻辑），**不要**因此给项目加运行时依赖。

## 用法

```bat
cd /d D:\Code\LingXi\frontend
npm run visual:baseline      :: 重建基线（会用当前代码覆盖基线图，慎用）
npm run visual:check         :: 门禁：截图并与基线比对，有差异退出码 1
```

底层参数（需要时直接调脚本）：

```bat
node scripts/visual/capture.mjs --mode baseline --scenes settings-agents --themes dark
node scripts/visual/capture.mjs --mode check --out .lingxi/tmp/visual/current
node scripts/visual/compare.mjs --baseline <dir> --current <dir> --pixel-delta 6 --threshold 0.001 --ignore 0,0,264,900
```

## 目录约定

| 路径 | 说明 |
| --- | --- |
| `.lingxi/tmp/visual/baseline/` | 基线图（`{dark,light}/scene-<场景>.png` + `{dark,light}/<目标>-roi.png`），**本机渲染环境绑定，不入仓**（`.lingxi` 已 gitignore） |
| `.lingxi/tmp/visual/current/` | 本次截图 |
| `.lingxi/tmp/visual/diff/` | 差异图（变化像素涂红，用来人眼确认） |
| `frontend/scripts/theme-spec/visual-baseline-md5.json` | **基线完整性 oracle（入仓）**：三套基线（`settings` / `components` / `hover`）每张 PNG 的 MD5 指纹。基线本体不入仓，此文件回答「本机基线应该长什么样」 |

**为什么基线不入仓、但指纹必须入仓（技术债 G-4 的根治方式）**：像素结果与机器 / DPI / 字体 / 浏览器版本强绑定（见下方维护规则第 4 条），把 PNG 入仓会让「换个环境 clone 就一片红」，团队最终会无视这个门禁。但基线**只**放在 gitignore 目录里又会蒸发：`compare.mjs` 的 `compareDirectories` 以「基线目录里的文件」为遍历源，基线丢一半后只剩几张图参与比对，`failed=0` ⇒ **退出码 0 的静默假绿**。因此三道门禁在 `--mode check` 时**先按 oracle 校验完整性**，不通过一律 **exit 2**（基础设施故障，区别于视觉回归的 exit 1）：

- `missing`（清单有、磁盘无）⇒ 基线被删 / `.lingxi/tmp` 被清
- `extra`（磁盘有、清单无）⇒ 陈旧图混进来，「这台机器的基线是哪一版」不可判定
- `mismatched`（MD5 不符）⇒ 图被手工改过或被别的采集覆盖
- `suite 为空` ⇒ 没有可校验的期望值，一律算失败（不许「没有期望 = 通过」）

**基线目录必须独占**：多个 agent/多人并行跑视觉基线时，必须各自用 `--out`/`--baseline` 指定独立目录，否则会互相覆盖并产生「当前截图缺失」的假红。

## 场景

| 场景 | 界面 | 是否需要后端 |
| --- | --- | --- |
| `settings-modal` | 设置弹窗（显式切到「通用设置」页签） | 否 |
| `settings-models` | 设置 · 模型页签 | 否（无后端时是错误态，仍可做回归对照） |
| `settings-agents` | 设置 · 智能体页签 | 否 || `settings-agents` | 设置 · 智能体页签 | 否 |
| `settings-compaction` | 设置 · 模型 → 压缩模型配置子页 | 否 |

主题切换（源码依据：`index.html` 内联脚本 + `useTheme.ts` 的 `THEME_STORAGE_KEY`）：写入 `localStorage['lingxi-theme']`（`dark`/`light`），首帧落到 `html.dark` / `html.light` + `data-theme` + `colorScheme`。截图前脚本会断言 `html.class` 与 `body` 背景色确实切过去了。

**故意没有聊天场景**：聊天气泡的数据只存在 `ChatView` 的局部 ref 里（不经 pinia、无 URL 入口），无后端时只能截到欢迎态，而欢迎态有光标/打字动画造成噪声。要覆盖聊天气泡，需要 mock 后端（`/session`、`/tool-call` 等）或走 Electron `capturePage()`，属待办。

## 判定参数与实测能力

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `pixelDelta` | 6 | 单通道差超过它才算「像素变了」（吸收抗锯齿抖动；12 会放过 1~2px 级位移） |
| `threshold` | 0.001 | 变化像素占比上限 |
| `strongDelta` / `strongPixels` | 24 / 40 | 强差异的面积判据（抓小面积阴影变化） |
| `sharpnessDrop` | 0.02 | 平均梯度下降上限（抓模糊/发光退化） |

**实测结论（本机，1440×900）**：

- ✅ 可见区域内 2px 布局位移 → 差异 3.76%，**必红**
- ✅ 圆角归零 / 字距变化 → 1.5%~2.9%，必红
- ✅ 两次独立采集的自比 → 6 张图差异 0（噪声稳定）
- ⚠️ **暗色态阴影变化抓不到**：暗底黑影本就不可见，实测差异 0.0012%，**不要对暗色态承诺阴影覆盖**
- ⚠️ 全局位移只改变很小面积时（例如只在可视区外），可能低于阈值 → 阈值下调前必须先跑两次自比确认噪声仍为 0

## 组件级 / 交互态 harness（Electron offscreen）

设置弹窗之外的两层补充，都复用 `scene-kit.cjs`（令牌解析 + 主题断言 + 迷你 App 构建，只实现一次）：

| 脚本 | 覆盖 | 关键断言 |
| --- | --- | --- |
| `component-scenes.cjs`（`visual:components:{baseline,check,selfcheck}`） | 15 个静态场景（CardHeader / RequireChoiceCard / DropUpSelect / ChatInputArea ×2 / Sidebar ×4 / ChatMessageItem / SettingsModal / AgentsTab / SubAgentSidePanel / TeamModal） | 目标存在且可见 + 明暗 computed style 逐属性相等 + 像素比对 |
| `hover-states.cjs`（`visual:hover:{baseline,check,selfcheck}`） | 6 处已折叠 hover（ChatMessageItem 复制、PlanCard 收起、Sidebar 工作区入口、RequireChoiceCard 折叠/关闭、TeamModal 表单取消） | 目标可见 + hover 色 ≠ 基色 + hover 色 == 令牌计算色 |

### G-5：每场景独立 page（场景解耦）

**问题**：共用一页时，任何一个场景的增删都会改变文档高度/宽度与截图的裁切源，于是「新增一个场景」= 「既有场景的基线字节全部失效」。更糟的是 `webContents.capturePage()` 在 offscreen 下高度恒被夹到 **1032 px**（请求 1180/1400/3100 一律 1032，且小尺寸还会抛 `UnknownVizError`），页面下方的场景**从来没进过基线**。

**做法**：

- **一场景一页**：`kit.openScene(work, { query: { scene: key } })` 打开只挂载该场景的页面，新增场景只多开一页，谁也不会挤谁。
- **固定画布**：每个场景页都注入 `html { overflow: hidden; }`（`SCENE_CANVAS_CSS`）。滚动条占位会改变布局宽度（800 或 780），进而让 `main` 的居中偏移落在不同像素上 —— 那会让「同一份代码」的 ROI 字节随页面内容漂移。固定画布 = 布局几何与页内内容完全无关。
- **容器图走 CDP `Page.captureScreenshot({clip})`**：正好是容器矩形，高度真实（不再被夹到 1032）。
- **ROI 一律从整页图裁**（`capturer.fullPage()`）：单一规则，元素画在哪都在图里，不会因落到 1032 以下而裁出空白。
- **采集前两道稳定化**：`document.fonts.ready`（字体未就位会让行盒高度出现亚像素差）+ 容器 DOM 连续两次采样一致（异步取数的组件必须落定，否则会截到「加载中 → 空态」的中间帧）。场景里的接口用固定 fixture 应答，不连后端。
- **基线形态**：容器图按场景命名（`{theme}/scene-<key>.png`），ROI 路径保持不变（`{theme}/<key>-roi.png`），hover 基线由扁平 `<theme>-<key>.png` 改为分层 `{theme}/<key>.png`。旧形态的 `light.png` / `dark.png` 全屏图已删除。
- **形态守卫**：oracle 顶层新增 `forms`（`{settings, components, hover}` → `per-scene-v1` 等）。形态不匹配或缺失 ⇒ **exit 2**，绝不落到 exit 1 —— 代码与基线没配对不是视觉回归，去 diff 图里找变化是白费功夫。


要点：

- **hover 用 CDP `CSS.forcePseudoState` 强制**（offscreen 下 `sendInputEvent` 鼠标命中测试不可靠）；不要改成真鼠标。
- 必须**挂载真实组件并点真实按钮进入状态**（工具行要展开两级、「增加 Tip」要先点），不接受在测试页里复刻类名——那样测的是类名不是组件。
- 主题必须写 `data-theme`（tokens.css 是 `:root` 暗色默认 + `html[data-theme=light]` 覆盖），且每次切换后调用 `kit.assertThemeApplied` 四路校验（根标记位 / 变量原文 / Tailwind 映射计算色 / `var()` 计算色）。变异验证：
  `visual:components:selfcheck:theme` 两种破坏方式（丢标记位、亮色仍取暗令牌）都必须报红。
- `hover-states.cjs` 会注入一段**场景稳定性 CSS**（禁光标闪烁/动画/过渡）：Tip 输入框的闪烁光标会让同一份代码两次截图不一致，产生假红。它只作用于隔离场景，不改生产样式。
- 两套 harness 的基线同样**不入仓**（`.lingxi/tmp/visual/**`）。

## 维护规则


1. **基线变更必须单独提交**，commit message 写清「为什么这组像素差异是预期变化」，并附 diff 图路径。
2. 出现红时先看 `.lingxi/tmp/visual/diff/` 的差异图，确认是**真实回归**还是**预期改动**；禁止用 `visual:baseline` 直接覆盖来「消除」红。
3. 换了机器/DPI/字体/浏览器缓存版本后，基线必须重生成（像素结果不可跨机器比较）。
4. 跨机器或 CI 复用前，需要固定浏览器版本与字体，并把基线图入仓或放对象存储。
5. **基线重建会自动刷新 oracle**：`--mode baseline` 全量跑完即重写 `visual-baseline-md5.json` 对应 suite 一节与 `forms` 形态标记并重算 `counts`，必须与该次重建**同批提交**（否则下一个人 check 立刻红）。带 `--scenes` / `--themes` / `--only` 的部分采集**不会**写 oracle（会把整节指纹削成残缺），会打印警告 —— 指纹要同步就再跑一次全量。
6. **禁止手工编辑基线 PNG 或用外部工具覆盖**：任何非 `--mode baseline` 产生的字节变化都会在下一次 check 被 `mismatched` 抓住（这是「基线悄悄被换掉」的唯一防线）。
7. 门禁绿灯的含义变了：`exit 0` 现在同时意味着「基线形态匹配 + 基线完整 + 比对无差异」。看到 `exit 2` 先读报错里的 `形态 / missing / extra / mismatched` 分类，别当成视觉回归去调阈值；`exit 3` 是基础设施故障（例如 `visual:check` 冷启动超时 —— 慢机器上设 `LX_VISUAL_READY_TIMEOUT_MS=60000` 重跑，默认仍是 30s）。
8. **改了场景注册表就必须重跑全量基线**：新增/删除场景或目标只会多/少自己的图，但 `visual-baseline-md5.json` 的 `counts` 与指纹会随之变化，两部分必须同批提交。

