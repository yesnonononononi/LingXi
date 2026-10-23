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
| `.lingxi/tmp/visual/baseline/` | 基线图（`{dark,light}/*.png`），**本机渲染环境绑定，不入仓**（`.lingxi` 已 gitignore） |
| `.lingxi/tmp/visual/current/` | 本次截图 |
| `.lingxi/tmp/visual/diff/` | 差异图（变化像素涂红，用来人眼确认） |

**基线目录必须独占**：多个 agent/多人并行跑视觉基线时，必须各自用 `--out`/`--baseline` 指定独立目录，否则会互相覆盖并产生「当前截图缺失」的假红。

## 场景

| 场景 | 界面 | 是否需要后端 |
| --- | --- | --- |
| `settings-modal` | 设置弹窗（显式切到「通用设置」页签） | 否 |
| `settings-models` | 设置 · 模型页签 | 否（无后端时是错误态，仍可做回归对照） |
| `settings-agents` | 设置 · 智能体页签 | 否 |

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
| `component-scenes.cjs`（`visual:components:{baseline,check,selfcheck}`） | CardHeader / RequireChoiceCard / DropUpSelect 的静态态 | 目标存在且可见 + 明暗 computed style 逐属性相等 + 像素比对 |
| `hover-states.cjs`（`visual:hover:{baseline,check,selfcheck}`） | 5 处已折叠 hover（ChatMessageItem 复制、PlanCard 收起、Sidebar 工作区入口、RequireChoiceCard 折叠/关闭） | 目标可见 + hover 色 ≠ 基色 + hover 色 == 令牌计算色 |

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

