# 过程区技术债 · 无 Electron 验证记录

> 本轮（过程区技术债清算）的质量门槛只用三类命令：`node --test`、`npx tsx --test`、
> `npx vue-tsc -b --force`（外加 `npm run build` 证明所有新 SFC 可编译）。
> **Electron smoke 一律未执行**（用户明确要求绕过客户端），受影响脚本只加标注、不改断言。

---

## 1. 验证矩阵

| 断言目标 | 手段 | 落点 | 本轮结果 |
|---|---|---|---|
| 模式判据语义（8 条判定表） | 纯函数单测 | `tests/processSegments.test.ts`（6 例） | pass |
| 判定表经视图模型仍然成立 | 纯函数单测 | `tests/processViewModel.test.ts`（10 例） | pass |
| 失效分频（只翻 `ongoing` 不重算摘要） | 调用计数桩 | `tests/processViewModel.test.ts` | pass |
| 段渲染结果（标题/预览/状态/`data-process-mode`/扫光类） | 真实组件挂载（`createRenderer`） | `tests/chatProcessCollapse.test.cjs`（36 例） | pass |
| 协作式委派成员行与色点 | 真实组件挂载 | `tests/chatAsyncDelegationStatus.test.cjs`（11 例）+ `tests/qaAsyncDelegationAdversarial.test.cjs`（3 例） | pass |
| 扫光样式类只出现在模板、`mode` 绑定名不变 | 源码字面断言 | `tests/loadingSweep.test.cjs` | pass |
| DOM / testid / class 等价 | 挂载后遍历内存树 | `tests/processDetailsSplit.test.cjs`（6 例） | pass |
| 工具行纯函数（meta/diff/状态灯/可展开/diff 块/路径清洗/思考标题） | 纯函数单测 | `tests/toolRowUi.test.ts`（9 例） | pass |
| 工具行箭头列恒定占位 | 源码字面断言（锚点已随文件迁移） | `tests/toolRowIconAlignment.test.cjs`（2 例） | pass |
| 类型契约（props 收窄后的所有调用点） | 类型检查 | `npx vue-tsc -b --force` | pass（exit 0） |
| 所有新 SFC 可编译 | 构建 | `npm run build` | pass（vite 产物正常产出） |

### 1.1 本轮实测数字

```
node --test tests/chatProcessCollapse.test.cjs tests/loadingSweep.test.cjs \
  tests/chatAsyncDelegationStatus.test.cjs tests/qaAsyncDelegationAdversarial.test.cjs \
  tests/collapseTransitionClip.test.cjs tests/processDetailsSplit.test.cjs \
  tests/toolRowIconAlignment.test.cjs
→ tests 68 / pass 68 / fail 0

npx tsx --test tests/processSegments.test.ts tests/processHeadline.test.ts \
  tests/processViewModel.test.ts tests/toolRowUi.test.ts
→ tests 41 / pass 41 / fail 0

npx vue-tsc -b --force        → exit 0，无输出
npm run build                 → vite 构建成功（built in 1m 45s）
```

基线对照：改造前 `chatProcessCollapse` 35 例、`loadingSweep + chatAsyncDelegationStatus` 17 例、
`processSegments` 11 例全绿。T01（harness 改造）完成时结果与基线逐条一致（35 → 35，随后新增
1 条金丝雀 → 36）。

---

## 2. test harness 的白名单策略变更

| 维度 | 改造前 | 改造后 |
|---|---|---|
| 规则方向 | **白名单**：只列举要真实加载的 `.vue`，其余一律桩成只透传 slots 的空壳 | **目录前缀递归真实加载 + 显式桩名单**：`src/components/chat/**`（含 `chat/process/`）默认真实加载 |
| 新增 renderer | 必须改 3 份白名单，漏改就静默吞成空壳（断言表现为「找不到节点」，甚至数量不变而假绿） | 零改动，自动真实加载 |
| stub 清单 | 三份，各自漂移 | 一份：`tests/support/chatProcessHarness.cjs` 的 `EXPLICIT_VUE_STUBS` + `PROCESS_AREA_REAL_PREFIXES` |
| `components/` 之外（如 `common/CollapseTransition.vue`） | 默认桩 | 仍默认桩（保持既有套件行为不变） |

### 2.1 金丝雀断言

`tests/chatProcessCollapse.test.cjs` 的
`★ harness 金丝雀：过程区组件真实加载，桩掉即无节点` 显式断言两个**只有真实 renderer 才会产出**
的节点：

1. `.thinking-content`（思考贴底框，只有真实 `ThoughtStepRenderer` 渲染才有）；
2. `class` 含 `w-full my-0.5` 的工具行根元素。

同一条用例里再把 `ProcessDetails` 通过 `extraStubs` 显式桩掉重挂一次，断言这两个节点**必须消失** ——
金丝雀自己证明自己对「被吞成空壳」敏感，不依赖人工临时改代码。
`tests/processDetailsSplit.test.cjs` 另有注册表级金丝雀：`resolveRenderer` 必须返回具体的 renderer 组件，
禁止 `undefined`，且顺序必须为 `thought → sub_agent → image_group → tool → unknown`。

---

## 3. 不可替代断言清单（只能在真实渲染环境验证）

| 断言类别 | 为什么 node 侧不可测 | 载体 |
|---|---|---|
| 真实布局几何（行高、`getBoundingClientRect()`、`scrollWidth > innerWidth` 溢出） | `createRenderer` 的内存树没有布局引擎；`jsdom` 同样不布 layout | `tests/processSegments.smoke.cjs` |
| 计算样式与主题令牌解析（`getComputedStyle(body).backgroundColor`） | 需要 CSS 层叠与变量解析 | `tests/processSegments.smoke.cjs`、`npm run gate:theme*`、视觉基线 |
| CSS 动画 / 扫光视觉呈现（`background-clip: text` 是否真的裁到字上） | node 侧上限是「类名在、规则在」（`tests/loadingSweep.test.cjs` 已是该层级） | 视觉基线 / 人工 |
| Electron 主进程行为（窗口、托盘、通知、文件预览 native、更新签名） | 无主进程 | `filePreview.native.test.cjs`、`electronPackaging.test.cjs` 等 |
| 真实合成器下的滚动/合成时序 | 现有 ★ 用例测的是判定逻辑，不是合成器时序 | 人工 / 录屏 |

---

## 4. 本轮未验证项（如实登记）

| 项 | 状态 | 说明 |
|---|---|---|
| `tests/processSegments.smoke.cjs` | **未执行** | 用户要求绕过 Electron。它锁的是真实布局与计算样式（见 §3）。已在文件头加标注注释，断言一行未改。**合并前需有 Electron 环境的人补跑一次并回填结论。** |
| `tests/sessionRecovery.smoke.cjs` / `subSessionContextUsage.smoke.cjs` / `suspensionNotification.smoke.cjs` / `taskProgress.smoke.cjs` | **未执行** | 它们只挂 `ChatMessageItem`/列表，不触碰段内部与 `ProcessDetails`；同样只加标注注释、不改断言。 |
| 其余 Electron smoke（`chatMessageSlots` / `chatImages` / `choiceQuestionGroup` / `commandApprovalGroup` / `modelRetry` / `modelVision` / `mermaid` / `filePreview` / `backgroundTasks` / `chatExecutionControls` / `chatInputSlots` / `electronTitleBar`） | **未执行** | 与本轮改动无交集；登记为「本轮未验证面」。 |
| 视觉基线（`visual:components:check` / `visual:check`） | **未执行** | renderer 根 class 已逐字保留（`processDetailsSplit.test.cjs` 断言），但仍可能有组件实例边界导致的样式作用域差异，需要真实合成器。 |
| `npm test` 全量 | 未跑 | 只跑了与本轮相关的套件 + 受影响的两个源码级断言套件。 |

### 4.1 明确不同意的做法

把 Electron smoke「降级成 node 可跑」再宣称已验证：它们断言的是真实布局与计算样式，降级后只能测到
「元素存在」，那是另一种形式的假绿。降级只在一个方向上值得做：把**结构断言**从 smoke 抽成 node 用例
（例如 details 数量、toggle 数量），几何断言留在 smoke —— 本轮 `processDetailsSplit.test.cjs` 做的正是这件事。

---

## 5. 长期分层策略（本轮不升级为仓库级约定）

- **结构 / 语义 / 类型** → node（`createRenderer` + 纯函数单测 + `vue-tsc`）；
- **几何 / 计算样式 / 主进程 / 合成时序** → Electron（smoke 与视觉基线），并给每个 Electron 用例标注
  它锁的是 §3 里的哪一类不可替代断言。

是否把这条策略写进仓库级约定（`AGENTS.md`）超出本次任务范围，需主理人裁决。
---

## 6. 「过程段摘要行在运行态消失」回归复核（本轮，只读验证）

### 6.1 结论

b7f8460 引入的回归（摘要行改成 `v-if="canSummarize"`，段未 `closed` 时整行消失，只剩裸细节）
其修复已落在基线提交 **b4e4f0a**（`fix(chat): 过程段摘要行常驻，实时段展示最新一步`），
并在后续两次重构（37fe2db 呈现模式下沉、2b48473 ProcessDetails 拆分）中逐字保留：

| 新契约条目 | 落点 | 现状 |
|---|---|---|
| 摘要行永远存在（无 `v-if` 门禁） | `ChatProcessSegment.vue`：`<button type="button" data-testid="process-segment-toggle"` 无 `v-if` | 满足 |
| 单一 `mode`，无 `canSummarize` 双关布尔 | `mode = computed(() => props.view.mode)`；`resolveProcessSegmentMode` 在 `utils/processSegments.ts` | 满足（全仓 `canSummarize` 仅出现在 `tests/loadingSweep.test.cjs` 的反向断言里） |
| `summary` 用整段概览 / `live` 用最新一步 | `processViewModel.deriveProcessViews` → `formatProcessHeadline(summary, { active: mode === 'live' })` | 满足（`processHeadline.ts` 导出面未改） |
| 细节区默认折叠，点标题展开 | `expanded = ref(false)` + `CollapseTransition` / `v-if="visible && expanded"` | 满足 |
| `lx-sweep-text` 只出现在模板、只在 `live` | 模板 `:class="{ 'lx-sweep-text': mode === 'live' }"`；script setup 内无该类名 | 满足（`loadingSweep` 两条断言分别锁「类名位置」与「不进 script」） |
| 预览 `previewIsText` 排版 | text → `flex justify-end` + `shrink-0 min-w-full text-left`；value → `block truncate` | 满足 |
| `data-testid` / `data-process-mode` 值域不变 | 5 个 testid + `live|summary` | 满足 |

本轮不需改动源码：回归点已被既有测试锁死，实跑全绿（见 6.3）。若后续再把 `mode` 回退成组件内布尔
表达式，`loadingSweep.test.cjs` 的「摘要行始终存在：live 模式带扫光，summary 模式不带」会立刻变红。

### 6.2 `resolveProcessSegmentMode` 判定表

实现顺序即优先级：先判「可汇总」，再判「整轮是否仍在进行」，否则实时一步。

| `closed` | `ongoing` | `runningCount` | `pendingCount` | → `mode` | 理由 |
|---|---|---|---|---|---|
| `true` | 任意 | `0` | `0` | `summary` | 段边界已确定且无未完成步骤，事实不再变化 |
| `true` | 任意 | `>0` | 任意 | `live` | running 一票否决：摘要会淹没「正在跑的那一步」 |
| `true` | 任意 | 任意 | `>0` | `live` | pending 一票否决：等确认的步骤仍是当前焦点 |
| `false` | `true` | 任意 | 任意 | `live` | 段随时可追加，概览会把「会变的事实」当结论 |
| `false` | `false` | 任意 | 任意 | `summary` | 轮次终态权威：最后一段永远等不到下一段 text，且不再变化 |

### 6.3 本轮实跑证据

| 命令 | 结果 |
|---|---|
| `cd frontend && node --test tests/chatProcessCollapse.test.cjs tests/loadingSweep.test.cjs tests/chatAsyncDelegationStatus.test.cjs tests/qaAsyncDelegationAdversarial.test.cjs tests/collapseTransitionClip.test.cjs` | **tests 60 / pass 60 / fail 0** |
| `cd frontend && npx tsx --test tests/processSegments.test.ts tests/processHeadline.test.ts` | **tests 22 / pass 22 / fail 0**（含 6 条 `resolveProcessSegmentMode` 用例：四类事实组合 + running/pending 否决 + 纯函数幂等） |
| `cd frontend && npx vue-tsc -b --force` | **exit 0** |
| `tests/processSegments.smoke.cjs` | **本轮未执行**（需要 Electron 主进程，用户明确要求绕过）。该文件已含新契约断言 `liveSweep` / `summarySweep` / `liveCount`，合并前需人工补跑。 |

